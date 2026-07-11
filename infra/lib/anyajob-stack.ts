import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpIamAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
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

    // HTTP API with AWS_IAM auth on every route (decision D1): only SigV4-signed
    // callers with execute-api:Invoke reach the Lambda during the dark soak, so
    // the raw endpoint never serves the résumé to an anonymous URL.
    // scripts/smoke.mjs signs automatically. Cloudflare fronts this at M5 — that
    // flip revisits the auth model (Cloudflare can't SigV4-sign).
    const httpApi = new apigwv2.HttpApi(this, "WebApi", {
      apiName: "anyajob-web",
      defaultIntegration: new HttpLambdaIntegration("WebFnIntegration", webFn),
      defaultAuthorizer: new HttpIamAuthorizer(),
    });

    // Cap runaway Anthropic/S3 spend from a stuck client or abuse (the reason we
    // chose an HTTP API over a bare Function URL). Modest single-user limits.
    const stage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    stage.defaultRouteSettings = {
      throttlingBurstLimit: 20,
      throttlingRateLimit: 10,
    };

    new cdk.CfnOutput(this, "Ec2InstanceProfile", { value: ec2Profile.ref });
    new cdk.CfnOutput(this, "DataBucketName", { value: dataBucket.bucketName });
    new cdk.CfnOutput(this, "DocsBucketName", { value: docsBucket.bucketName });
    new cdk.CfnOutput(this, "DeployRoleArn", { value: deployRole.roleArn });
    new cdk.CfnOutput(this, "WebApiUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "WebFnName", { value: webFn.functionName });
  }
}
