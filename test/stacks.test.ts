import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/stacks/network-stack';
import { GamingGatewayStack } from '../lib/stacks/gaming-gateway-stack';
import { ObservabilityStack } from '../lib/stacks/observability-stack';
import { ComparisonStack } from '../lib/stacks/comparison-stack';

describe('CDK Stacks', () => {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };

  const networkStack = new NetworkStack(app, 'TestNetwork', { env });
  const gatewayStack = new GamingGatewayStack(app, 'TestCore', { env, vpc: networkStack.vpc });
  const observabilityStack = new ObservabilityStack(app, 'TestObservability', {
    env,
    gatewayAlb: gatewayStack.alb,
    distribution: gatewayStack.distribution,
    routerFunction: gatewayStack.routerFunction,
  });
  const comparisonStack = new ComparisonStack(app, 'TestComparison', {
    env,
    vpc: networkStack.vpc,
    lambdaAlb: gatewayStack.alb,
    routerFunction: gatewayStack.routerFunction,
    wafAclArn: gatewayStack.wafAclArn,
  });

  test('Network stack synthesizes', () => {
    const template = Template.fromStack(networkStack);
    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.resourceCountIs('AWS::EC2::NatGateway', 2);
    template.resourceCountIs('AWS::Route53Resolver::ResolverEndpoint', 2);
  });

  test('Core stack synthesizes with expected resources', () => {
    const template = Template.fromStack(gatewayStack);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
    template.resourceCountIs('AWS::Shield::Protection', 1);
    template.resourceCountIs('AWS::Route53::HealthCheck', 1);
    template.resourceCountIs('AWS::ElastiCache::CacheCluster', 1);
  });

  test('Core stack WAF has JA4 fingerprint rules', () => {
    const template = Template.fromStack(gatewayStack);
    const webAcls = template.findResources('AWS::WAFv2::WebACL');
    const rules = Object.values(webAcls)[0].Properties.Rules;
    const ruleNames = rules.map((r: any) => r.Name);
    expect(ruleNames).toContain('JA4FingerprintRateLimit');
    expect(ruleNames).toContain('JA4PlusIPRateLimit');
  });

  test('Core stack WAF has player reconnection rules', () => {
    const template = Template.fromStack(gatewayStack);
    const webAcls = template.findResources('AWS::WAFv2::WebACL');
    const rules = Object.values(webAcls)[0].Properties.Rules;
    const ruleNames = rules.map((r: any) => r.Name);
    expect(ruleNames).toContain('PlayerReconnectionAllowance');
    expect(ruleNames).toContain('NonPlayerRateLimit');
  });

  test('Observability stack creates dashboard and alarms', () => {
    const template = Template.fromStack(observabilityStack);
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    template.resourceCountIs('AWS::CloudWatch::CompositeAlarm', 1);
    template.resourceCountIs('AWS::SNS::Topic', 1);
  });

  test('Comparison stack deploys all 3 patterns', () => {
    const template = Template.fromStack(comparisonStack);
    // NGINX ASG
    template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
    // API Gateway
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    // CloudFront distribution
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    // Comparison dashboard
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });

  test('Network stack snapshot', () => {
    expect(Template.fromStack(networkStack).toJSON()).toMatchSnapshot();
  });

  test('Core stack snapshot', () => {
    expect(Template.fromStack(gatewayStack).toJSON()).toMatchSnapshot();
  });

  test('Observability stack snapshot', () => {
    expect(Template.fromStack(observabilityStack).toJSON()).toMatchSnapshot();
  });

  test('Comparison stack snapshot', () => {
    expect(Template.fromStack(comparisonStack).toJSON()).toMatchSnapshot();
  });
});
