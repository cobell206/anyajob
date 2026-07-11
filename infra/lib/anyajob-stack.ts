import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwactions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { Construct } from "constructs";

const GITHUB_REPO = "cobell206/anyajob";

// infra/ is ESM (type-stripped), so __dirname isn't defined — derive it.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// AnyaJob serverless infrastructure (see SERVERLESS-TRANSITION.md).
//
// Built incrementally alongside the migration:
//   M1 (now) — the data bucket: the JSON "database" as one object per file.
//   M3       — a docs bucket for uploaded resumes/covers.
//   M4/M5    — the API Lambda + API Gateway HTTP API, EventBridge schedules,
//              and a GitHub OIDC deploy role.
export class AnyaJobStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The data store. Each data/*.json file is one object with the same key
    // (see src/store.js), so migrating is a plain `aws s3 sync data/ s3://…`.
    // This bucket is the source of truth, so it must never be auto-deleted:
    // RETAIN keeps it even if the stack is destroyed. Versioning is our backup
    // (replacing the old `aws s3 sync` in scripts/backup.js).
    // Noncurrent versions are our rollback history; expire them after 30 days
    // so old/dev versions don't accumulate forever (current versions kept).
    const noncurrentExpiry: s3.LifecycleRule[] = [
      { noncurrentVersionExpiration: cdk.Duration.days(30) },
    ];

    const dataBucket = new s3.Bucket(this, "DataBucket", {
      bucketName: "anyajob-data",
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: noncurrentExpiry,
    });

    // Uploaded application materials (résumés / cover letters). Binaries keyed
    // {fingerprint}/{file} (see src/docstore.js). Same guarantees as the data
    // bucket — source of truth, so RETAIN + versioned.
    const docsBucket = new s3.Bucket(this, "DocsBucket", {
      bucketName: "anyajob-docs",
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: noncurrentExpiry,
    });

    // GitHub Actions OIDC role — lets CI assume a role with no stored keys.
    // Used now for the one-shot prod->S3 data migration, and by M4/M5 for the
    // frontend/data-plane deploys. The account-level OIDC provider already
    // exists (created by the espresso stack in this account), so reference it
    // by ARN rather than creating a second one (which would conflict).
    const oidcProvider =
      iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
        this,
        "GithubOidc",
        `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
      );
    const deployRole = new iam.Role(this, "GithubDeployRole", {
      roleName: "anyajob-github-deploy", // fixed name -> ARN known before deploy
      assumedBy: new iam.WebIdentityPrincipal(
        oidcProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          },
          StringLike: {
            "token.actions.githubusercontent.com:sub": `repo:${GITHUB_REPO}:*`,
          },
        },
      ),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    dataBucket.grantReadWrite(deployRole);
    docsBucket.grantReadWrite(deployRole);

    // M5 Part A — let CI run `cdk deploy`. cdk does the real work through the
    // account's bootstrap roles, so this role only needs to *assume* those
    // (not broad CFN/Lambda/IAM perms). Plus read the Anthropic key param at
    // deploy so the workflow can pass it as the noEcho stack parameter.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [
          `arn:aws:iam::${this.account}:role/cdk-hnb659fds-deploy-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-hnb659fds-file-publishing-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-hnb659fds-lookup-role-${this.account}-${this.region}`,
        ],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/anyajob/anthropic-api-key`,
        ],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"], // the account's default aws/ssm key
        conditions: {
          StringEquals: { "kms:ViaService": `ssm.${this.region}.amazonaws.com` },
        },
      }),
    );

    // EC2 app role: the instance currently has NO credentials, so it can't run
    // on the S3 backend. Attach this (S3 on both buckets + SES for the existing
    // email) so EC2 can be flipped to STORAGE=s3 — running production on S3
    // before Lambda (M3.5). Associate with the instance:
    //   aws ec2 associate-iam-instance-profile \
    //     --instance-id i-0fb0c9e04b10c9993 \
    //     --iam-instance-profile Name=anyajob-ec2-app
    const ec2Role = new iam.Role(this, "Ec2AppRole", {
      roleName: "anyajob-ec2-app",
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
    });
    dataBucket.grantReadWrite(ec2Role);
    docsBucket.grantReadWrite(ec2Role);
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: ["*"],
      }),
    );
    const ec2Profile = new iam.CfnInstanceProfile(this, "Ec2AppProfile", {
      instanceProfileName: "anyajob-ec2-app",
      roles: [ec2Role.roleName],
    });

    // ---- M4: web Lambda + HTTP API (deployed dark; parity-tested vs EC2 on
    // the same live S3 before any traffic — see SERVERLESS-TRANSITION.md) ----
    //
    // The entire Express app as one zip ("lambdalith"), driven by serverless-http
    // (src/lambda.js). The asset is prebuilt by scripts/build-lambda-bundle.sh
    // into infra/.app-bundle — production deps PLUS the linux @napi-rs/canvas
    // native binary that npm can't install on a mac (résumé-scoring PDF text
    // extraction needs it). Run `npm run bundle:lambda` before `cdk deploy`.
    // Anthropic key: CloudFormation does NOT allow {{resolve:ssm-secure:…}} in a
    // Lambda env var, so we take it as a noEcho stack parameter instead and pass
    // it from the SSM SecureString at deploy time (kept out of source & console):
    //   npx cdk deploy --parameters AnthropicApiKey="$(aws ssm get-parameter \
    //     --name /anyajob/anthropic-api-key --with-decryption --region us-east-1 \
    //     --query Parameter.Value --output text)"
    const anthropicApiKey = new cdk.CfnParameter(this, "AnthropicApiKey", {
      type: "String",
      noEcho: true,
      minLength: 1,
      description:
        "Anthropic API key for the web Lambda. Pass from SSM at deploy; not stored in source.",
    });

    // Shared code asset (CDK dedupes it) and env for both the web Lambda and the
    // scoring worker — same app, same live S3. ANTHROPIC_API_KEY comes from the
    // noEcho parameter above; AWS_REGION is reserved (the runtime provides it).
    const appAsset = lambda.Code.fromAsset(
      path.join(__dirname, "..", ".app-bundle"),
    );
    const commonEnv: Record<string, string> = {
      STORAGE: "s3",
      S3_BUCKET: dataBucket.bucketName,
      DOCS_BUCKET: docsBucket.bucketName,
      NODE_ENV: "production",
      LOG_LEVEL: "info",
      MAX_DAILY_SPEND: "2.00",
      NOTIFY_FROM: "AnyaJob <alerts@anyalawgirly.com>",
      PUBLIC_URL: "https://jobs.anyalawgirly.com",
      ANTHROPIC_API_KEY: anthropicApiKey.valueAsString,
    };

    // M4.5 — background scoring worker. Résumé scoring (~54s) exceeds API
    // Gateway's 30s integration cap, so the web Lambda async-invokes this off
    // the SAME asset (handler src/worker.handler); it runs the Claude call and
    // persists the result to S3, and the client polls GET. Long timeout, no SES.
    const scoringWorkerFn = new lambda.Function(this, "ScoringWorkerFn", {
      functionName: "anyajob-scoring-worker",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.X86_64,
      handler: "src/worker.handler",
      code: appAsset,
      timeout: cdk.Duration.seconds(300),
      memorySize: 512,
      environment: commonEnv,
    });
    dataBucket.grantReadWrite(scoringWorkerFn);
    docsBucket.grantReadWrite(scoringWorkerFn);

    const webFn = new lambda.Function(this, "WebFn", {
      functionName: "anyajob-web",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.X86_64, // matches canvas-linux-x64-gnu
      handler: "src/lambda.handler",
      code: appAsset,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        ...commonEnv,
        // Presence of this flips POST /resume/feedback to async: mark pending,
        // invoke the worker, return 202. Unset on EC2/local → inline scoring.
        SCORING_WORKER_FN: scoringWorkerFn.functionName,
      },
    });
    dataBucket.grantReadWrite(webFn);
    docsBucket.grantReadWrite(webFn);
    webFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: ["*"],
      }),
    );
    // Let the web Lambda async-invoke the scoring worker.
    scoringWorkerFn.grantInvoke(webFn);

    // M5 Part C — auth is now Cloudflare Access (replacing the dark-soak AWS_IAM
    // authorizer). Cloudflare Access injects a signed Cf-Access-Jwt-Assertion
    // header; the gateway validates it against the Access team domain (issuer)
    // and this app's AUD. A request straight to the execute-api URL (no Access
    // JWT) gets 401 at the gateway — zero app code, and it locks the origin to
    // "came through Access". (Cloudflare can't SigV4-sign, which is why IAM auth
    // couldn't stay once Cloudflare fronts the origin.)
    const accessAuthorizer = new HttpJwtAuthorizer(
      "AccessJwtAuthorizer",
      "https://anyalawgirly.cloudflareaccess.com",
      {
        authorizerName: "cloudflare-access",
        jwtAudience: [
          "462fb46b785402e6f15358091d1087cee76b8c319132ccc85c2a58823e12f189",
        ],
        // Cloudflare puts the JWT here (not Authorization), raw (no "Bearer ").
        identitySource: ["$request.header.Cf-Access-Jwt-Assertion"],
      },
    );

    const httpApi = new apigwv2.HttpApi(this, "WebApi", {
      apiName: "anyajob-web",
      defaultIntegration: new HttpLambdaIntegration("WebFnIntegration", webFn),
      defaultAuthorizer: accessAuthorizer,
    });

    // Cap runaway Anthropic/S3 spend from a stuck client or abuse (the reason we
    // chose an HTTP API over a bare Function URL). Modest single-user limits.
    const stage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    stage.defaultRouteSettings = {
      throttlingBurstLimit: 20,
      throttlingRateLimit: 10,
    };

    // M5 Part C (C-1) — TLS cert for the API Gateway custom domain that
    // Cloudflare will proxy to. DNS validation, but the domain's DNS is on
    // Cloudflare (not Route53), so CDK can't auto-create the record: the deploy
    // BLOCKS until the emitted validation CNAME is added to Cloudflare by hand
    // and ACM issues. Must be in us-east-1 (same region as the regional HTTP
    // API). Used by the custom domain in C-2.
    const siteCert = new acm.Certificate(this, "SiteCert", {
      domainName: "jobs.anyalawgirly.com",
      validation: acm.CertificateValidation.fromDns(),
    });
    new cdk.CfnOutput(this, "SiteCertArn", { value: siteCert.certificateArn });

    // C-2 — API Gateway custom domain that Cloudflare proxies to. At the C-3
    // flip, Cloudflare CNAMEs jobs.anyalawgirly.com -> this regional target
    // (WebApiRegionalDomain output), proxied, with Access still in front.
    const apiDomain = new apigwv2.DomainName(this, "ApiDomain", {
      domainName: "jobs.anyalawgirly.com",
      certificate: siteCert,
    });
    new apigwv2.ApiMapping(this, "ApiMapping", {
      api: httpApi,
      domainName: apiDomain,
      stage: httpApi.defaultStage!,
    });
    new cdk.CfnOutput(this, "WebApiRegionalDomain", {
      value: apiDomain.regionalDomainName,
    });

    // ---- M6: scheduled cron Lambda (daily / discover / weekly) ----
    // Replaces the EC2 crontab. One function off the same asset; three
    // EventBridge schedules pass { job } (see src/cron.js). 900 s timeout (daily's
    // worst run was ~12.8 min), 1024 MB for the scrape+score. Same env as the web
    // path plus the Greenhouse source list (USAJobs/Lever aren't configured).
    const cronFn = new lambda.Function(this, "CronFn", {
      functionName: "anyajob-cron",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.X86_64,
      handler: "src/cron.handler",
      code: appAsset,
      timeout: cdk.Duration.seconds(900),
      memorySize: 1024,
      environment: {
        ...commonEnv,
        GREENHOUSE_BOARDS: "cravath,davispolk,sullcrom",
      },
    });
    dataBucket.grantReadWrite(cronFn);
    docsBucket.grantReadWrite(cronFn);
    cronFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: ["*"],
      }),
    );

    // EventBridge Scheduler → cron Lambda. Timezone America/New_York fixes the
    // old UTC crons' DST drift (they'd shift an hour twice a year).
    const schedulerRole = new iam.Role(this, "CronSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    cronFn.grantInvoke(schedulerRole);
    // ENABLED as of M6-3 (the EC2 crontab was removed in the same step, so no
    // double-run). See disable-ec2-crons.yml.
    const schedule = (id: string, expr: string, job: string) =>
      new scheduler.CfnSchedule(this, id, {
        state: "ENABLED",
        flexibleTimeWindow: { mode: "OFF" },
        scheduleExpression: expr,
        scheduleExpressionTimezone: "America/New_York",
        target: {
          arn: cronFn.functionArn,
          roleArn: schedulerRole.roleArn,
          input: JSON.stringify({ job }),
        },
      });
    schedule("CronDaily", "cron(0 6 * * ? *)", "daily"); // 6am ET daily
    schedule("CronDiscover", "cron(0 7 ? * MON,THU *)", "discover"); // 7am ET Mon/Thu
    // No weekly schedule: weekly.js only sends the digest email (unused), and the
    // weekly reflection it would send is already generated by daily.js on Sundays.
    // The 'weekly' dispatch stays in cron.js so it's a one-liner to re-enable.

    // Alarm (→ email) if the cron errors or a run nears the 15-min cap — that's
    // the signal daily has outgrown Lambda and should move to Fargate.
    const cronAlarms = new sns.Topic(this, "CronAlarmTopic", {
      topicName: "anyajob-cron-alarms",
    });
    cronAlarms.addSubscription(new snsSubs.EmailSubscription("cobell206@gmail.com"));
    const alarmAction = new cwactions.SnsAction(cronAlarms);
    const cronErrors = new cloudwatch.Alarm(this, "CronErrorsAlarm", {
      alarmName: "anyajob-cron-errors",
      metric: cronFn.metricErrors({ period: cdk.Duration.days(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    cronErrors.addAlarmAction(alarmAction);
    const cronDuration = new cloudwatch.Alarm(this, "CronDurationAlarm", {
      alarmName: "anyajob-cron-duration-near-cap",
      metric: cronFn.metricDuration({
        period: cdk.Duration.days(1),
        statistic: "Maximum",
      }),
      threshold: cdk.Duration.minutes(13).toMilliseconds(),
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    cronDuration.addAlarmAction(alarmAction);
    new cdk.CfnOutput(this, "CronFnName", { value: cronFn.functionName });

    new cdk.CfnOutput(this, "Ec2InstanceProfile", { value: ec2Profile.ref });
    new cdk.CfnOutput(this, "DataBucketName", { value: dataBucket.bucketName });
    new cdk.CfnOutput(this, "DocsBucketName", { value: docsBucket.bucketName });
    new cdk.CfnOutput(this, "DeployRoleArn", { value: deployRole.roleArn });
    new cdk.CfnOutput(this, "WebApiUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "WebFnName", { value: webFn.functionName });
  }
}
