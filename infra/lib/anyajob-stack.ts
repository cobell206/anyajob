import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

const GITHUB_REPO = "cobell206/anyajob";

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
    const dataBucket = new s3.Bucket(this, "DataBucket", {
      bucketName: "anyajob-data",
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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

    new cdk.CfnOutput(this, "DataBucketName", { value: dataBucket.bucketName });
    new cdk.CfnOutput(this, "DocsBucketName", { value: docsBucket.bucketName });
    new cdk.CfnOutput(this, "DeployRoleArn", { value: deployRole.roleArn });
  }
}
