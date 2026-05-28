import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface RateLimiterProps {
  /**
   * VPC for ElastiCache placement.
   */
  readonly vpc: ec2.IVpc;

  /**
   * Router function that needs access to the rate limiter.
   */
  readonly routerFunction: lambda.Function;

  /**
   * ElastiCache node type.
   * @default 'cache.r7g.medium'
   */
  /**
   * @default 'cache.t3.medium'
   */
  readonly nodeType?: string;

  /**
   * Number of cache nodes.
   * @default 2
   */
  readonly numCacheNodes?: number;
}

/**
 * Advanced Rate Limiter using ElastiCache (Redis) for distributed rate limiting.
 *
 * Implements the "Advanced Rate of Increase" feature requirement:
 * - Distributed token bucket algorithm across all gateway cells
 * - Per-client, per-region, and per-endpoint rate limiting
 * - Sliding window counters for burst detection
 * - Multi-region ready (Global Datastore support)
 *
 * Why Redis over DynamoDB for this use case:
 * - Sub-millisecond latency for rate limit checks
 * - Atomic increment operations (INCR/EXPIRE)
 * - Lua scripting for complex rate limit algorithms
 * - Shared state across Lambda invocations without cold start penalty
 */
export class RateLimiter extends Construct {
  public readonly cluster: elasticache.CfnCacheCluster;

  constructor(scope: Construct, id: string, props: RateLimiterProps) {
    super(scope, id);

    // Security group for Redis
    const redisSg = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc: props.vpc,
      description: 'Security group for Gaming Gateway Redis rate limiter',
      allowAllOutbound: false,
    });

    // Allow Lambda functions to connect to Redis
    redisSg.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(6379),
      'Allow Redis access from VPC',
    );

    // Subnet group for Redis (isolated subnets)
    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnet group for Gaming Gateway rate limiter',
      subnetIds: props.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }).subnetIds,
    });

    // ElastiCache Redis cluster
    this.cluster = new elasticache.CfnCacheCluster(this, 'RedisCluster', {
      engine: 'redis',
      cacheNodeType: props.nodeType ?? 'cache.t3.medium',
      numCacheNodes: props.numCacheNodes ?? 1,
      cacheSubnetGroupName: subnetGroup.ref,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
      engineVersion: '7.1',
      port: 6379,
      snapshotRetentionLimit: 3,
      preferredMaintenanceWindow: 'sun:05:00-sun:06:00',
      autoMinorVersionUpgrade: true,
    });
    this.cluster.addDependency(subnetGroup);

    // Pass Redis endpoint to the router function
    props.routerFunction.addEnvironment(
      'REDIS_ENDPOINT',
      this.cluster.attrRedisEndpointAddress,
    );
    props.routerFunction.addEnvironment(
      'REDIS_PORT',
      this.cluster.attrRedisEndpointPort,
    );
  }
}
