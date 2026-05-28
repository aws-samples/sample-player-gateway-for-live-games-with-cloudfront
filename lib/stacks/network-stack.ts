import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as route53resolver from 'aws-cdk-lib/aws-route53resolver';
import { Construct } from 'constructs';

export interface NetworkStackProps extends cdk.StackProps {
  /**
   * CIDR block for the VPC.
   * @default '10.0.0.0/16'
   */
  readonly vpcCidr?: string;

  /**
   * On-premises CIDR blocks for hybrid connectivity.
   */
  readonly onPremCidrs?: string[];

  /**
   * Enable Route53 Resolver endpoints for hybrid DNS.
   * @default true
   */
  readonly enableHybridDns?: boolean;
}

/**
 * Network foundation stack providing VPC, PrivateLink endpoints,
 * and hybrid connectivity for the gaming gateway.
 *
 * Supports:
 * - S2S traffic via VPC endpoints and PrivateLink (45% of traffic)
 * - Hybrid DNS resolution (Route53 Resolver)
 * - Multi-AZ deployment for resilience
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props?: NetworkStackProps) {
    super(scope, id, props);

    // VPC with isolated subnets for Lambda and private subnets for ALB
    this.vpc = new ec2.Vpc(this, 'GatewayVpc', {
      ipAddresses: ec2.IpAddresses.cidr(props?.vpcCidr ?? '10.0.0.0/16'),
      maxAzs: 3,
      natGateways: 2,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 22,
        },
        {
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
      flowLogs: {
        'vpc-flow-logs': {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(),
          trafficType: ec2.FlowLogTrafficType.ALL,
        },
      },
    });

    // VPC Endpoints for AWS services (reduces data transfer costs)
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    this.vpc.addGatewayEndpoint('DynamoDBEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    this.vpc.addInterfaceEndpoint('LambdaEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.LAMBDA,
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('SQSEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SQS,
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      privateDnsEnabled: true,
    });

    // Security group for PrivateLink connections (S2S traffic from partner ecosystem)
    const privateLinkSg = new ec2.SecurityGroup(this, 'PrivateLinkSg', {
      vpc: this.vpc,
      description: 'Security group for PrivateLink S2S connections',
      allowAllOutbound: false,
    });

    // Allow HTTPS inbound from on-premises CIDRs
    for (const cidr of props?.onPremCidrs ?? []) {
      privateLinkSg.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(443),
        'Allow HTTPS from on-premises',
      );
    }

    // Route53 Resolver for hybrid DNS (on-prem <-> AWS resolution)
    if (props?.enableHybridDns !== false) {
      const resolverSg = new ec2.SecurityGroup(this, 'ResolverSg', {
        vpc: this.vpc,
        description: 'Security group for Route53 Resolver endpoints',
      });
      resolverSg.addIngressRule(
        ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
        ec2.Port.udp(53),
        'Allow DNS from VPC',
      );
      resolverSg.addIngressRule(
        ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
        ec2.Port.tcp(53),
        'Allow DNS TCP from VPC',
      );

      // Inbound resolver endpoint (on-prem -> AWS DNS resolution)
      new route53resolver.CfnResolverEndpoint(this, 'InboundResolver', {
        direction: 'INBOUND',
        ipAddresses: this.vpc.selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        }).subnets.slice(0, 2).map(subnet => ({
          subnetId: subnet.subnetId,
        })),
        securityGroupIds: [resolverSg.securityGroupId],
        name: 'gaming-gateway-inbound-resolver',
      });

      // Outbound resolver endpoint (AWS -> on-prem DNS resolution)
      new route53resolver.CfnResolverEndpoint(this, 'OutboundResolver', {
        direction: 'OUTBOUND',
        ipAddresses: this.vpc.selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        }).subnets.slice(0, 2).map(subnet => ({
          subnetId: subnet.subnetId,
        })),
        securityGroupIds: [resolverSg.securityGroupId],
        name: 'gaming-gateway-outbound-resolver',
      });
    }

    // Outputs
    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
  }
}
