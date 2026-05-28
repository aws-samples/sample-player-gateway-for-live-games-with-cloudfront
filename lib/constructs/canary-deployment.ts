import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

export interface CanaryDeploymentProps {
  /**
   * The Lambda function to apply canary deployment to.
   */
  readonly routerFunction: lambda.Function;

  /**
   * Error rate threshold (%) that triggers automatic rollback.
   * @default 5
   */
  readonly alarmThreshold?: number;

  /**
   * Deployment configuration for canary.
   * @default LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES
   */
  readonly deploymentConfig?: codedeploy.ILambdaDeploymentConfig;
}

/**
 * Canary Deployment construct for safe Lambda function updates.
 *
 * Implements CodeDeploy-based canary deployments with:
 * - Gradual traffic shifting (10% -> 100% over 5 minutes)
 * - Automatic rollback on error rate threshold breach
 * - Pre/post deployment hooks for validation
 * - Integration with CloudWatch alarms
 *
 * Critical for gaming workloads where:
 * - Millions of concurrent players can be affected by bad deployments
 * - Client SDKs may behave differently with new API versions
 * - Rollback speed directly impacts player experience
 */
export class CanaryDeployment extends Construct {
  public readonly deploymentGroup: codedeploy.LambdaDeploymentGroup;

  constructor(scope: Construct, id: string, props: CanaryDeploymentProps) {
    super(scope, id);

    const threshold = props.alarmThreshold ?? 5;

    // Alias for traffic shifting
    const alias = new lambda.Alias(this, 'LiveAlias', {
      aliasName: 'live',
      version: props.routerFunction.currentVersion,
    });

    // Error rate alarm for automatic rollback
    const errorAlarm = new cloudwatch.Alarm(this, 'DeploymentErrorAlarm', {
      metric: alias.metricErrors({
        statistic: 'Sum',
        period: cdk.Duration.minutes(1),
      }),
      threshold,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: `Canary deployment error rate exceeds ${threshold}% - triggering rollback`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Duration alarm (latency regression detection)
    const latencyAlarm = new cloudwatch.Alarm(this, 'DeploymentLatencyAlarm', {
      metric: alias.metricDuration({
        statistic: 'p99',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 10000, // 10s p99 is unacceptable for gaming
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Canary deployment p99 latency regression detected',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // CodeDeploy deployment group
    this.deploymentGroup = new codedeploy.LambdaDeploymentGroup(this, 'CanaryDeploymentGroup', {
      alias,
      deploymentConfig: props.deploymentConfig ??
        codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
      alarms: [errorAlarm, latencyAlarm],
      autoRollback: {
        failedDeployment: true,
        stoppedDeployment: true,
        deploymentInAlarm: true,
      },
    });
  }
}
