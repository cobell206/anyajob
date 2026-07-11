import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

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

    new cdk.CfnOutput(this, "DataBucketName", { value: dataBucket.bucketName });
  }
}
