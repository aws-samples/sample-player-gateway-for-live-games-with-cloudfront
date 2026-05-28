import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface GatewayCellProps {
  /**
   * Cell index for identification and routing.
   */
  readonly cellIndex: number;

  /**
   * VPC for Lambda placement.
   */
  readonly vpc: ec2.IVpc;

  /**
   * Router function that handles request routing logic.
   */
  readonly routerFunction: lambda.IFunction;

  /**
   * Memory size for the cell handler function.
   * @default 512
   */
  readonly memorySize?: number;

  /**
   * Maximum concurrent executions for this cell.
   * @default 200
   */
  readonly reservedConcurrency?: number;
}

/**
 * A Gateway Cell represents an isolated unit of the gateway architecture.
 *
 * Cell-based architecture benefits:
 * - Blast radius isolation: failures in one cell don't affect others
 * - Independent scaling: each cell scales based on its traffic
 * - Canary deployments: route small % of traffic to new cell versions
 * - Game-specific routing: assign specific games/clients to cells
 *
 * Each cell contains:
 * - A Lambda handler function for request processing
 * - Independent concurrency limits
 * - Cell-specific environment configuration
 * - Isolated logging and metrics
 */
export class GatewayCell extends Construct {
  public readonly handlerFunction: lambda.Function;
  public readonly cellIndex: number;

  constructor(scope: Construct, id: string, props: GatewayCellProps) {
    super(scope, id);

    this.cellIndex = props.cellIndex;

    // Cell-specific log group
    const cellLogGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Cell-specific Lambda handler
    this.handlerFunction = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/cell-handler'),
      memorySize: props.memorySize ?? 512,
      timeout: cdk.Duration.seconds(29),
      architecture: lambda.Architecture.ARM_64,
      environment: {
        CELL_INDEX: props.cellIndex.toString(),
        ROUTER_FUNCTION_NAME: props.routerFunction.functionName,
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },
      tracing: lambda.Tracing.ACTIVE,
      logGroup: cellLogGroup,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      reservedConcurrentExecutions: props.reservedConcurrency ?? 200,
      insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_229_0,
    });

    // Allow cell handler to invoke the router function
    props.routerFunction.grantInvoke(this.handlerFunction);

    // Custom metrics namespace for cell-level monitoring
    this.handlerFunction.addEnvironment(
      'METRICS_NAMESPACE',
      'GamingGateway/Cells',
    );
  }
}
