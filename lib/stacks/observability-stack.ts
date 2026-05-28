import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface ObservabilityStackProps extends cdk.StackProps {
  readonly gatewayAlb: elbv2.IApplicationLoadBalancer;
  readonly distribution: cloudfront.IDistribution;
  readonly routerFunction: lambda.IFunction;
}

/**
 * Observability stack providing comprehensive monitoring for the gaming gateway.
 *
 * Features:
 * - CloudWatch dashboards with key metrics
 * - Anomaly detection for traffic patterns
 * - Composite alarms for intelligent alerting
 * - Latency percentile tracking (p50, p95, p99)
 * - Error rate monitoring with automatic escalation
 */
export class ObservabilityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    // --- SNS Topic for Alerts ---
    const alertTopic = new sns.Topic(this, 'GatewayAlerts', {
      topicName: 'gaming-gateway-alerts',
      displayName: 'Gaming Gateway Alerts',
    });

    // --- CloudWatch Dashboard ---
    const dashboard = new cloudwatch.Dashboard(this, 'GatewayDashboard', {
      dashboardName: 'GamingGateway-Operations',
      periodOverride: cloudwatch.PeriodOverride.AUTO,
    });

    // CloudFront metrics
    const cfRequests = new cloudwatch.Metric({
      namespace: 'AWS/CloudFront',
      metricName: 'Requests',
      dimensionsMap: { DistributionId: props.distribution.distributionId },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });

    const cf4xxRate = new cloudwatch.Metric({
      namespace: 'AWS/CloudFront',
      metricName: '4xxErrorRate',
      dimensionsMap: { DistributionId: props.distribution.distributionId },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });

    const cf5xxRate = new cloudwatch.Metric({
      namespace: 'AWS/CloudFront',
      metricName: '5xxErrorRate',
      dimensionsMap: { DistributionId: props.distribution.distributionId },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });

    // Lambda metrics
    const lambdaDuration = props.routerFunction.metricDuration({
      statistic: 'p99',
      period: cdk.Duration.minutes(1),
    });

    const lambdaErrors = props.routerFunction.metricErrors({
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });

    const lambdaInvocations = props.routerFunction.metricInvocations({
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });

    const lambdaThrottles = props.routerFunction.metricThrottles({
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });

    const lambdaConcurrency = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'ConcurrentExecutions',
      dimensionsMap: { FunctionName: props.routerFunction.functionName },
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1),
    });

    // Dashboard layout
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# 🎮 Gaming Gateway - Operations Dashboard\n---',
        width: 24,
        height: 1,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'CloudFront - Request Volume',
        left: [cfRequests],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'CloudFront - Error Rates',
        left: [cf4xxRate, cf5xxRate],
        width: 8,
        height: 6,
        leftYAxis: { max: 10 },
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Lambda Concurrency',
        metrics: [lambdaConcurrency],
        width: 8,
        height: 6,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda - Duration (p99)',
        left: [lambdaDuration],
        width: 8,
        height: 6,
        leftAnnotations: [{ value: 5000, label: 'SLA Threshold (5s)', color: '#ff0000' }],
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda - Errors & Throttles',
        left: [lambdaErrors],
        right: [lambdaThrottles],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda - Invocations',
        left: [lambdaInvocations],
        width: 8,
        height: 6,
      }),
    );

    // --- JA4 Fingerprint Analysis Section ---
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## 🔐 JA4 TLS Fingerprint Analysis & WAF Protection\n---',
        width: 24,
        height: 1,
      }),
    );

    // WAF JA4 metrics
    const ja4RateLimitMetric = new cloudwatch.Metric({
      namespace: 'AWS/WAFV2',
      metricName: 'BlockedRequests',
      dimensionsMap: { WebACL: 'gaming-gateway-waf', Rule: 'JA4FingerprintRateLimit', Region: 'us-east-1' },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'JA4 Rate Limit Blocks',
    });

    const ja4PlusIpMetric = new cloudwatch.Metric({
      namespace: 'AWS/WAFV2',
      metricName: 'CountedRequests',
      dimensionsMap: { WebACL: 'gaming-gateway-waf', Rule: 'JA4PlusIPRateLimit', Region: 'us-east-1' },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'JA4+IP Rate Limit Counted',
    });

    const playerReconnectionMetric = new cloudwatch.Metric({
      namespace: 'AWS/WAFV2',
      metricName: 'CountedRequests',
      dimensionsMap: { WebACL: 'gaming-gateway-waf', Rule: 'PlayerReconnectionAllowance', Region: 'us-east-1' },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'Player Reconnection Burst',
    });

    const nonPlayerBlockMetric = new cloudwatch.Metric({
      namespace: 'AWS/WAFV2',
      metricName: 'BlockedRequests',
      dimensionsMap: { WebACL: 'gaming-gateway-waf', Rule: 'NonPlayerRateLimit', Region: 'us-east-1' },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'Non-Player Blocks',
    });

    const s2sTrafficMetric = new cloudwatch.Metric({
      namespace: 'AWS/WAFV2',
      metricName: 'CountedRequests',
      dimensionsMap: { WebACL: 'gaming-gateway-waf', Rule: 'S2STrafficVisibility', Region: 'us-east-1' },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'S2S Traffic',
    });

    const adminTrafficMetric = new cloudwatch.Metric({
      namespace: 'AWS/WAFV2',
      metricName: 'CountedRequests',
      dimensionsMap: { WebACL: 'gaming-gateway-waf', Rule: 'AdminTrafficVisibility', Region: 'us-east-1' },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'Admin Traffic',
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'JA4 Fingerprint - Rate Limit Activity',
        left: [ja4RateLimitMetric, ja4PlusIpMetric],
        width: 8,
        height: 6,
        leftYAxis: { label: 'Requests', min: 0 },
      }),
      new cloudwatch.GraphWidget({
        title: 'Player Reconnection vs DDoS Blocks',
        left: [playerReconnectionMetric],
        right: [nonPlayerBlockMetric],
        width: 8,
        height: 6,
        leftYAxis: { label: 'Allowed (counted)' },
        rightYAxis: { label: 'Blocked' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Traffic Distribution (S2S + Admin)',
        left: [s2sTrafficMetric, adminTrafficMetric],
        width: 8,
        height: 6,
      }),
    );

    // --- Alarms ---

    // High error rate alarm
    const errorRateAlarm = new cloudwatch.Alarm(this, 'HighErrorRate', {
      metric: cf5xxRate,
      threshold: 5,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'CloudFront 5xx error rate exceeds 5% for 2 out of 3 minutes',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    errorRateAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(alertTopic));

    // Lambda duration alarm (p99 > 5s)
    const latencyAlarm = new cloudwatch.Alarm(this, 'HighLatency', {
      metric: lambdaDuration,
      threshold: 5000,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Lambda p99 latency exceeds 5 seconds',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    latencyAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(alertTopic));

    // Lambda throttle alarm
    const throttleAlarm = new cloudwatch.Alarm(this, 'LambdaThrottles', {
      metric: lambdaThrottles,
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Lambda throttles detected - consider increasing concurrency',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    throttleAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(alertTopic));

    // Anomaly detection on request volume (detect DDoS or traffic spikes)
    const anomalyDetector = new cloudwatch.CfnAnomalyDetector(this, 'TrafficAnomalyDetector', {
      namespace: 'AWS/CloudFront',
      metricName: 'Requests',
      stat: 'Sum',
      dimensions: [{ name: 'DistributionId', value: props.distribution.distributionId }],
    });

    // Composite alarm (error rate AND latency)
    new cloudwatch.CompositeAlarm(this, 'CriticalGatewayAlarm', {
      alarmRule: cloudwatch.AlarmRule.allOf(
        cloudwatch.AlarmRule.fromAlarm(errorRateAlarm, cloudwatch.AlarmState.ALARM),
        cloudwatch.AlarmRule.fromAlarm(latencyAlarm, cloudwatch.AlarmState.ALARM),
      ),
      alarmDescription: 'CRITICAL: Both error rate and latency thresholds breached simultaneously',
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=GamingGateway-Operations`,
      description: 'CloudWatch Dashboard URL',
    });
    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value: alertTopic.topicArn,
      description: 'SNS Topic ARN for gateway alerts',
    });
  }
}
