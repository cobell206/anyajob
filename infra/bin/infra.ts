import * as cdk from "aws-cdk-lib";
import { AnyaJobStack } from "../lib/anyajob-stack.ts";

const app = new cdk.App();
new AnyaJobStack(app, "AnyaJobStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
