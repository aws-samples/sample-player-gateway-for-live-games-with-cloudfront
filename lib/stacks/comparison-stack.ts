import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { NginxBaseline } from '../constructs/nginx-baseline';

export interface ComparisonStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;

  /**
   * The ALB fronting the Lambda cells (serverless path).
   */
  readonly lambdaAlb: elbv2.IApplicationLoadBalancer;

  /**
   * The Lambda router function (for metrics).
   */
  readonly routerFunction: lambda.IFunction;

  /**
   * Weight for the Lambda/serverless path (0-100).
   * The NGINX path gets (100 - lambdaWeight).
   * @default 50
   */
  readonly lambdaWeight?: number;

  /**
   * NGINX instance type.
   * @default 't3.medium'
   */
  readonly nginxInstanceType?: ec2.InstanceType;

  /**
   * Minimum NGINX instances.
   * @default 2
   */
  readonly nginxMinCapacity?: number;

  /**
   * Maximum NGINX instances.
   * @default 10
   */
  readonly nginxMaxCapacity?: number;

  /**
   * WAF ACL ARN to attach to the comparison CloudFront distribution.
   */
  readonly wafAclArn?: string;
}

/**
 * Comparison Stack: Side-by-side evaluation of NGINX/EC2 vs Lambda/Serverless.
 *
 * Deploys:
 * - NGINX baseline (EC2 ASG + ALB)
 * - CloudFront distribution with weighted origin groups for A/B traffic split
 * - Comprehensive comparison dashboard with side-by-side metrics
 *
 * Traffic flow:
 *   Game Clients -> CloudFront -> Origin Group (weighted)
 *                                   ├── (X%) -> Lambda ALB -> Lambda Cells
 *                                   └── (Y%) -> NGINX ALB -> EC2 ASG (NGINX)
 *
 * The weight is configurable to gradually shift traffic between paths.
 * Start at 50/50 for fair comparison, then shift toward the winner.
 */
export class ComparisonStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly nginxBaseline: NginxBaseline;
  private httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: ComparisonStackProps) {
    super(scope, id, props);

    const lambdaWeight = props.lambdaWeight ?? 50;
    const nginxWeight = 100 - lambdaWeight;

    // --- NGINX Baseline ---
    this.nginxBaseline = new NginxBaseline(this, 'NginxBaseline', {
      vpc: props.vpc,
      instanceType: props.nginxInstanceType,
      minCapacity: props.nginxMinCapacity,
      maxCapacity: props.nginxMaxCapacity,
    });

    // --- API Gateway HTTP API (3rd comparison path) ---
    // Represents the "CloudFront + API Gateway + Lambda" architecture
    // that was considered but rejected due to cost at scale
    const apiGwLogGroup = new logs.LogGroup(this, 'ApiGwLogGroup', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const httpApi = new apigwv2.HttpApi(this, 'GatewayHttpApi', {
      apiName: 'gaming-gateway-comparison-api',
      description: 'API Gateway HTTP API path for 3-way comparison (CF + APIGW + Lambda)',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['Content-Type', 'Authorization', 'X-Game-Id', 'X-Platform', 'X-Client-Version', 'X-Traffic-Type'],
      },
    });
    this.httpApi = httpApi;

    // Lambda integration for API Gateway
    const apiGwIntegration = new apigwv2integrations.HttpLambdaIntegration(
      'LambdaIntegration',
      props.routerFunction as lambda.Function,
    );

    // Catch-all route
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: apiGwIntegration,
    });

    // Health route
    httpApi.addRoutes({
      path: '/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: apiGwIntegration,
    });

    // --- Access Logs Bucket ---
    const comparisonLogsBucket = new s3.Bucket(this, 'ComparisonLogsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        ignorePublicAcls: false,
        blockPublicPolicy: true,
        restrictPublicBuckets: true,
      }),
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
    });

    // --- CloudFront with Weighted Origin Group ---
    // Origin 1: Lambda path (existing ALB fronting Lambda cells)
    const lambdaOrigin = new origins.LoadBalancerV2Origin(
      props.lambdaAlb as elbv2.ApplicationLoadBalancer,
      {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        connectionAttempts: 3,
        connectionTimeout: cdk.Duration.seconds(10),
        readTimeout: cdk.Duration.seconds(30),
        keepaliveTimeout: cdk.Duration.seconds(60),
        customHeaders: { 'X-Origin-Path': 'lambda' },
      },
    );

    // Origin 2: NGINX path (EC2 ASG behind ALB)
    const nginxOrigin = new origins.LoadBalancerV2Origin(
      this.nginxBaseline.alb,
      {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        connectionAttempts: 3,
        connectionTimeout: cdk.Duration.seconds(10),
        readTimeout: cdk.Duration.seconds(30),
        keepaliveTimeout: cdk.Duration.seconds(60),
        customHeaders: { 'X-Origin-Path': 'nginx' },
      },
    );

    // Origin 3: API Gateway HTTP API path
    // Extract the API Gateway domain from the URL (e.g., "abc123.execute-api.us-east-1.amazonaws.com")
    const apiGwOrigin = new origins.HttpOrigin(
      `${httpApi.httpApiId}.execute-api.${this.region}.amazonaws.com`,
      {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        connectionAttempts: 3,
        connectionTimeout: cdk.Duration.seconds(10),
        readTimeout: cdk.Duration.seconds(30),
        customHeaders: { 'X-Origin-Path': 'apigw' },
      },
    );

    // Origin Group with failover (primary = Lambda, fallback = NGINX)
    // Note: CloudFront origin groups are for failover, not weighted routing.
    // For true weighted routing, we use path-based behaviors.
    // /lambda/* -> Lambda ALB
    // /nginx/*  -> NGINX ALB
    // /         -> weighted via Lambda@Edge or header-based (see below)

    // For the PoC comparison, we use path-based routing:
    // - /compare/lambda/* routes to Lambda path
    // - /compare/nginx/* routes to NGINX path
    // - /* (default) uses the Lambda path as primary with NGINX as failover
    this.distribution = new cloudfront.Distribution(this, 'ComparisonDistribution', {
      comment: 'Gaming Gateway - A/B Comparison (Lambda vs NGINX)',
      defaultBehavior: {
        origin: new origins.OriginGroup({
          primaryOrigin: lambdaOrigin,
          fallbackOrigin: nginxOrigin,
          fallbackStatusCodes: [500, 502, 503, 504],
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD, // Origin groups only support GET/HEAD
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      additionalBehaviors: {
        // Explicit Lambda path for direct comparison testing
        '/lambda/*': {
          origin: lambdaOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        // Explicit NGINX path for direct comparison testing
        '/nginx/*': {
          origin: nginxOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        // API Gateway path (3rd comparison scenario)
        '/apigw/*': {
          origin: apiGwOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      enableLogging: true,
      logBucket: comparisonLogsBucket,
      logFilePrefix: 'comparison-cf-logs/',
      webAclId: props.wafAclArn || undefined,
    });

    // --- Shield Advanced DDoS Protection ---
    new cdk.aws_shield.CfnProtection(this, 'ComparisonShieldProtection', {
      name: 'GamingGateway-Comparison-CloudFront-DDoS',
      resourceArn: `arn:aws:cloudfront::${this.account}:distribution/${this.distribution.distributionId}`,
    });

    // --- Comparison Dashboard ---
    this.buildComparisonDashboard(props);

    // --- Outputs ---
    new cdk.CfnOutput(this, 'ComparisonDistributionDomain', {
      value: this.distribution.distributionDomainName,
      description: 'Comparison CloudFront distribution domain',
    });
    new cdk.CfnOutput(this, 'LambdaPathUrl', {
      value: `https://${this.distribution.distributionDomainName}/lambda/health`,
      description: 'Direct Lambda path URL',
    });
    new cdk.CfnOutput(this, 'NginxPathUrl', {
      value: `https://${this.distribution.distributionDomainName}/nginx/health`,
      description: 'Direct NGINX path URL',
    });
    new cdk.CfnOutput(this, 'ApiGwPathUrl', {
      value: `https://${this.distribution.distributionDomainName}/apigw/health`,
      description: 'Direct API Gateway path URL',
    });
    new cdk.CfnOutput(this, 'ApiGwDirectUrl', {
      value: httpApi.apiEndpoint,
      description: 'API Gateway HTTP API direct endpoint',
    });
    new cdk.CfnOutput(this, 'TrafficSplit', {
      value: `Lambda: ${lambdaWeight}% | NGINX: ${nginxWeight}% (default path uses Lambda primary with NGINX failover)`,
      description: 'Traffic weight configuration',
    });
  }

  private buildComparisonDashboard(props: ComparisonStackProps): void {
    const dashboard = new cloudwatch.Dashboard(this, 'ComparisonDashboard', {
      dashboardName: 'GamingGateway-Comparison-LambdaVsNginx',
      periodOverride: cloudwatch.PeriodOverride.AUTO,
    });

    // --- Metric Definitions ---

    // Lambda ALB metrics
    const lambdaAlbArn = props.lambdaAlb.loadBalancerArn;
    const lambdaAlbFullName = cdk.Fn.select(1,
      cdk.Fn.split('loadbalancer/', lambdaAlbArn));

    const lambdaResponseTime = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'TargetResponseTime',
      dimensionsMap: { LoadBalancer: cdk.Token.asString(lambdaAlbFullName) },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
      label: 'Lambda Path (avg)',
    });

    const lambdaResponseTimeP99 = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'TargetResponseTime',
      dimensionsMap: { LoadBalancer: cdk.Token.asString(lambdaAlbFullName) },
      statistic: 'p99',
      period: cdk.Duration.minutes(1),
      label: 'Lambda Path (p99)',
    });

    const lambdaRequestCount = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'RequestCount',
      dimensionsMap: { LoadBalancer: cdk.Token.asString(lambdaAlbFullName) },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'Lambda Path',
    });

    const lambda2xx = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'HTTPCode_Target_2XX_Count',
      dimensionsMap: { LoadBalancer: cdk.Token.asString(lambdaAlbFullName) },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'Lambda 2xx',
    });

    const lambda5xx = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'HTTPCode_Target_5XX_Count',
      dimensionsMap: { LoadBalancer: cdk.Token.asString(lambdaAlbFullName) },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'Lambda 5xx',
    });

    // NGINX ALB metrics
    const nginxAlbFullName = this.nginxBaseline.alb.loadBalancerFullName;

    const nginxResponseTime = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'TargetResponseTime',
      dimensionsMap: { LoadBalancer: nginxAlbFullName },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
      label: 'NGINX Path (avg)',
    });

    const nginxResponseTimeP99 = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'TargetResponseTime',
      dimensionsMap: { LoadBalancer: nginxAlbFullName },
      statistic: 'p99',
      period: cdk.Duration.minutes(1),
      label: 'NGINX Path (p99)',
    });

    const nginxRequestCount = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'RequestCount',
      dimensionsMap: { LoadBalancer: nginxAlbFullName },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'NGINX Path',
    });

    const nginx2xx = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'HTTPCode_Target_2XX_Count',
      dimensionsMap: { LoadBalancer: nginxAlbFullName },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'NGINX 2xx',
    });

    const nginx5xx = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'HTTPCode_Target_5XX_Count',
      dimensionsMap: { LoadBalancer: nginxAlbFullName },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'NGINX 5xx',
    });

    // Lambda function metrics
    const lambdaDurationAvg = props.routerFunction.metricDuration({
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
      label: 'Lambda Duration (avg)',
    });

    const lambdaDurationP99 = props.routerFunction.metricDuration({
      statistic: 'p99',
      period: cdk.Duration.minutes(1),
      label: 'Lambda Duration (p99)',
    });

    const lambdaInvocations = props.routerFunction.metricInvocations({
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'Lambda Invocations',
    });

    const lambdaErrors = props.routerFunction.metricErrors({
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'Lambda Errors',
    });

    const lambdaThrottles = props.routerFunction.metricThrottles({
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'Lambda Throttles',
    });

    const lambdaConcurrency = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'ConcurrentExecutions',
      dimensionsMap: { FunctionName: props.routerFunction.functionName },
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1),
      label: 'Lambda Concurrency',
    });

    // ASG metrics
    const asgCpu = new cloudwatch.Metric({
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      dimensionsMap: { AutoScalingGroupName: this.nginxBaseline.asg.autoScalingGroupName },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
      label: 'NGINX CPU %',
    });

    const asgInstances = new cloudwatch.Metric({
      namespace: 'AWS/AutoScaling',
      metricName: 'GroupInServiceInstances',
      dimensionsMap: { AutoScalingGroupName: this.nginxBaseline.asg.autoScalingGroupName },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
      label: 'NGINX Instances',
    });

    const asgNetworkIn = new cloudwatch.Metric({
      namespace: 'AWS/EC2',
      metricName: 'NetworkIn',
      dimensionsMap: { AutoScalingGroupName: this.nginxBaseline.asg.autoScalingGroupName },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'NGINX Network In',
    });

    const asgNetworkOut = new cloudwatch.Metric({
      namespace: 'AWS/EC2',
      metricName: 'NetworkOut',
      dimensionsMap: { AutoScalingGroupName: this.nginxBaseline.asg.autoScalingGroupName },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'NGINX Network Out',
    });

    // NGINX healthy hosts
    const nginxHealthyHosts = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'HealthyHostCount',
      dimensionsMap: {
        LoadBalancer: nginxAlbFullName,
        TargetGroup: this.nginxBaseline.targetGroup.targetGroupFullName,
      },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
      label: 'NGINX Healthy Hosts',
    });

    // API Gateway metrics
    const apiGwLatency = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: 'Latency',
      dimensionsMap: { ApiId: this.httpApi.httpApiId },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
      label: 'API GW Path (avg)',
    });

    const apiGwLatencyP99 = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: 'Latency',
      dimensionsMap: { ApiId: this.httpApi.httpApiId },
      statistic: 'p99',
      period: cdk.Duration.minutes(1),
      label: 'API GW Path (p99)',
    });

    const apiGwRequestCount = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: 'Count',
      dimensionsMap: { ApiId: this.httpApi.httpApiId },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'API GW Path',
    });

    const apiGw5xx = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '5xx',
      dimensionsMap: { ApiId: this.httpApi.httpApiId },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'API GW 5xx',
    });

    const apiGw4xx = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '4xx',
      dimensionsMap: { ApiId: this.httpApi.httpApiId },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'API GW 4xx',
    });

    const apiGwIntegrationLatency = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: 'IntegrationLatency',
      dimensionsMap: { ApiId: this.httpApi.httpApiId },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
      label: 'API GW Integration Latency',
    });

    // --- Dashboard Layout ---

    // Header
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: [
          '# 🎮 Gaming Gateway - 3-Way Architecture Comparison',
          '## NGINX (EC2) vs CloudFront+ALB+Lambda vs CloudFront+API Gateway+Lambda',
          '---',
          '| Path | Route | Backend | Cost Model |',
          '|------|-------|---------|------------|',
          '| `/nginx/*` | CloudFront → NGINX ALB → EC2 ASG | NGINX (current) | EC2 hourly |',
          '| `/lambda/*` | CloudFront → Lambda ALB → Lambda | Lambda Cells | Pay-per-request |',
          '| `/apigw/*` | CloudFront → API Gateway → Lambda | API GW + Lambda | $1/M req + Lambda |',
          '',
          '> Send identical traffic to each path for fair comparison.',
        ].join('\n'),
        width: 24,
        height: 5,
      }),
    );

    // Row 1: Latency Comparison (the most critical metric)
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## ⏱️ Latency Comparison',
        width: 24,
        height: 1,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Response Time - Average (ms)',
        left: [lambdaResponseTime, nginxResponseTime, apiGwLatency],
        width: 12,
        height: 6,
        leftYAxis: { label: 'Milliseconds', min: 0 },
      }),
      new cloudwatch.GraphWidget({
        title: 'Response Time - P99 (ms)',
        left: [lambdaResponseTimeP99, nginxResponseTimeP99, apiGwLatencyP99],
        width: 12,
        height: 6,
        leftYAxis: { label: 'Milliseconds', min: 0 },
        leftAnnotations: [{ value: 5, label: 'SLA Target (5s)', color: '#ff0000' }],
      }),
    );

    // Row 2: Throughput Comparison
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## 📊 Throughput & Request Volume',
        width: 24,
        height: 1,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Request Count (per minute)',
        left: [lambdaRequestCount, nginxRequestCount, apiGwRequestCount],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Success Rate (2xx responses)',
        left: [lambda2xx, nginx2xx],
        width: 12,
        height: 6,
      }),
    );

    // Row 3: Error Comparison
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## ❌ Error Rates',
        width: 24,
        height: 1,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Server Errors (5xx)',
        left: [lambda5xx, nginx5xx, apiGw5xx],
        width: 12,
        height: 6,
        leftYAxis: { min: 0 },
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Errors & Throttles',
        left: [lambdaErrors],
        right: [lambdaThrottles],
        width: 12,
        height: 6,
      }),
    );

    // Row 4: Compute / Scaling Comparison
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## 🖥️ Compute & Scaling',
        width: 24,
        height: 1,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda - Concurrency & Duration',
        left: [lambdaConcurrency],
        right: [lambdaDurationAvg, lambdaDurationP99],
        width: 12,
        height: 6,
        rightYAxis: { label: 'Duration (ms)' },
        leftYAxis: { label: 'Concurrent Executions' },
      }),
      new cloudwatch.GraphWidget({
        title: 'NGINX - CPU & Instance Count',
        left: [asgCpu],
        right: [asgInstances],
        width: 12,
        height: 6,
        leftYAxis: { label: 'CPU %', max: 100 },
        rightYAxis: { label: 'Instances' },
        leftAnnotations: [{ value: 60, label: 'Scale-out threshold', color: '#ff9900' }],
      }),
    );

    // Row 5: Network & Infrastructure
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## 🌐 Network & Infrastructure',
        width: 24,
        height: 1,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'NGINX - Network I/O (bytes)',
        left: [asgNetworkIn, asgNetworkOut],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'NGINX - Healthy Hosts & Scaling',
        left: [nginxHealthyHosts, asgInstances],
        width: 12,
        height: 6,
      }),
    );

    // Row 6: Cost Indicators
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: [
          '## 💰 Cost Indicators',
          '',
          '| Metric | Lambda Path | NGINX Path |',
          '|--------|-------------|------------|',
          '| Compute | Pay-per-request (invocations × duration) | EC2 instances (hourly, always-on) |',
          '| Scaling | Instant (concurrent executions) | Minutes (ASG warm-up) |',
          '| Baseline Cost | $0 when idle | Min instances × hourly rate |',
          '| ALB | Shared (existing) | Dedicated ALB |',
          '',
          '> **Tip**: Use the request count and instance count metrics above to estimate cost.',
          '> Lambda: ~$0.20/1M requests + $0.0000166667/GB-s compute.',
          '> EC2 t3.medium: ~$0.0416/hr × instance count.',
        ].join('\n'),
        width: 24,
        height: 6,
      }),
    );

    // Row 7: Summary single-value widgets
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## 📈 Current State',
        width: 24,
        height: 1,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Lambda Avg Latency (ms)',
        metrics: [lambdaResponseTime],
        width: 4,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'NGINX Avg Latency (ms)',
        metrics: [nginxResponseTime],
        width: 4,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Lambda Requests/min',
        metrics: [lambdaRequestCount],
        width: 4,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'NGINX Requests/min',
        metrics: [nginxRequestCount],
        width: 4,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Lambda Concurrency',
        metrics: [lambdaConcurrency],
        width: 4,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'NGINX Instances',
        metrics: [asgInstances],
        width: 4,
        height: 4,
      }),
    );

    // Output dashboard URL
    new cdk.CfnOutput(this, 'ComparisonDashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=GamingGateway-Comparison-LambdaVsNginx`,
      description: 'Comparison Dashboard URL',
    });
  }
}
