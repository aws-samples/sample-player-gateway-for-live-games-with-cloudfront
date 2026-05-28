#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { GamingGatewayStack } from '../lib/stacks/gaming-gateway-stack';
import { ObservabilityStack } from '../lib/stacks/observability-stack';
import { NetworkStack } from '../lib/stacks/network-stack';
import { ComparisonStack } from '../lib/stacks/comparison-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// Network foundation (VPC, PrivateLink, connectivity)
const networkStack = new NetworkStack(app, 'GamingGateway-Network', {
  env,
  description: 'Gaming Gateway Blueprint - Network Foundation (VPC, PrivateLink, Hybrid Connectivity)',
});

// Core gateway stack (CloudFront + ALB + Lambda cells)
const gatewayStack = new GamingGatewayStack(app, 'GamingGateway-Core', {
  env,
  vpc: networkStack.vpc,
  description: 'Gaming Gateway Blueprint - Core Serverless Gateway (CloudFront + ALB + Lambda)',
});
gatewayStack.addDependency(networkStack);

// Observability stack (dashboards, alarms, anomaly detection)
const observabilityStack = new ObservabilityStack(app, 'GamingGateway-Observability', {
  env,
  gatewayAlb: gatewayStack.alb,
  distribution: gatewayStack.distribution,
  routerFunction: gatewayStack.routerFunction,
  description: 'Gaming Gateway Blueprint - Observability (Dashboards, Alarms, Anomaly Detection)',
});
observabilityStack.addDependency(gatewayStack);

// A/B Comparison stack (Lambda vs NGINX/EC2 side-by-side)
const comparisonStack = new ComparisonStack(app, 'GamingGateway-Comparison', {
  env,
  vpc: networkStack.vpc,
  lambdaAlb: gatewayStack.alb,
  routerFunction: gatewayStack.routerFunction,
  wafAclArn: gatewayStack.wafAclArn,
  lambdaWeight: 50, // 50/50 split for fair comparison
  description: 'Gaming Gateway Blueprint - A/B Comparison (Lambda vs NGINX/EC2 with metrics dashboard)',
});
comparisonStack.addDependency(gatewayStack);

app.synth();
