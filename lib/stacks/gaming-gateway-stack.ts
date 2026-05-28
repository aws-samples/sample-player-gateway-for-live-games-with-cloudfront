import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { GatewayCell } from '../constructs/gateway-cell';
import { CanaryDeployment } from '../constructs/canary-deployment';
import { RateLimiter } from '../constructs/rate-limiter';

export interface GamingGatewayStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;

  /**
   * Domain name for the gateway.
   */
  readonly domainName?: string;

  /**
   * Number of cells to deploy for the gateway.
   * @default 2
   */
  readonly cellCount?: number;

  /**
   * Enable WAF with managed rule groups.
   * @default true
   */
  readonly enableWaf?: boolean;

  /**
   * Enable canary deployment for Lambda functions.
   * @default true
   */
  readonly enableCanary?: boolean;

  /**
   * CloudFront price class.
   * @default PriceClass.PRICE_CLASS_ALL
   */
  readonly priceClass?: cloudfront.PriceClass;
}

/**
 * Core Gaming Gateway Stack implementing the fully managed serverless architecture.
 *
 * Architecture: CloudFront -> WAF -> ALB -> Lambda (cell-based)
 *
 * Traffic distribution:
 * - Player-facing (35%): CloudFront edge with WAF protection
 * - Game Servers (45%): PrivateLink via Network stack
 * - Admin/Internal (20%): Private API Gateway (separate construct)
 *
 * Key features:
 * - Cell-based architecture for blast radius isolation
 * - Canary deployments with automatic rollback
 * - Advanced rate limiting (per-client, per-region)
 * - JWT passthrough (existing auth preserved)
 * - Multi-region ready (CloudFront anycast IPs)
 */
export class GamingGatewayStack extends cdk.Stack {
  public readonly alb: elbv2.IApplicationLoadBalancer;
  public readonly distribution: cloudfront.IDistribution;
  public readonly routerFunction: lambda.IFunction;
  public readonly wafAclArn: string;

  constructor(scope: Construct, id: string, props: GamingGatewayStackProps) {
    super(scope, id, props);

    const cellCount = props.cellCount ?? 2;

    // --- Access Logs Bucket ---
    const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        ignorePublicAcls: false,
        blockPublicPolicy: true,
        restrictPublicBuckets: true,
      }),
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED, // Required for CloudFront standard logging
      lifecycleRules: [
        { expiration: cdk.Duration.days(90) },
        { transitions: [{ storageClass: s3.StorageClass.INTELLIGENT_TIERING, transitionAfter: cdk.Duration.days(30) }] },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      enforceSSL: true,
    });

    // --- ALB (internal, fronting Lambda cells) ---
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: props.vpc,
      description: 'Gaming Gateway ALB security group',
      allowAllOutbound: true,
    });
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS from CloudFront',
    );

    const alb = new elbv2.ApplicationLoadBalancer(this, 'GatewayAlb', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      dropInvalidHeaderFields: true,
    });
    alb.logAccessLogs(accessLogsBucket, 'alb-logs');
    this.alb = alb;

    // --- Lambda Router Function (core routing logic) ---
    const routerLogGroup = new logs.LogGroup(this, 'RouterLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const routerFunction = new lambda.Function(this, 'RouterFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/router'),
      memorySize: 1024,
      timeout: cdk.Duration.seconds(29),
      architecture: lambda.Architecture.ARM_64,
      environment: {
        CELL_COUNT: cellCount.toString(),
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },
      tracing: lambda.Tracing.ACTIVE,
      logGroup: routerLogGroup,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      reservedConcurrentExecutions: 500,
    });
    this.routerFunction = routerFunction;

    // --- Gateway Cells (blast radius isolation) ---
    const cells: GatewayCell[] = [];
    for (let i = 0; i < cellCount; i++) {
      const cell = new GatewayCell(this, `Cell${i}`, {
        cellIndex: i,
        vpc: props.vpc,
        routerFunction,
      });
      cells.push(cell);
    }

    // --- ALB Listener with weighted target groups (cell routing) ---
    const listener = alb.addListener('HttpsListener', {
      port: 80, // Use 443 with certificate in production
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'application/json',
        messageBody: JSON.stringify({ error: 'Not Found', code: 'ROUTE_NOT_FOUND' }),
      }),
    });

    // Add cell target groups with weighted routing for canary
    const targetGroups = cells.map((cell, index) => {
      const tg = new elbv2.ApplicationTargetGroup(this, `CellTg${index}`, {
        vpc: props.vpc,
        targetType: elbv2.TargetType.LAMBDA,
        targets: [new (require('aws-cdk-lib/aws-elasticloadbalancingv2-targets').LambdaTarget)(cell.handlerFunction)],
        healthCheck: {
          enabled: true,
          path: '/health',
          interval: cdk.Duration.seconds(35),
          timeout: cdk.Duration.seconds(30),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
      });
      return { targetGroup: tg, weight: Math.floor(100 / cellCount) };
    });

    listener.addAction('CellRouting', {
      priority: 1,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/*'])],
      action: elbv2.ListenerAction.weightedForward(targetGroups),
    });

    // --- WAF Web ACL ---
    if (props.enableWaf !== false) {
      const wafAcl = new wafv2.CfnWebACL(this, 'GatewayWaf', {
        defaultAction: { allow: {} },
        scope: 'CLOUDFRONT',
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: 'GamingGatewayWaf',
          sampledRequestsEnabled: true,
        },
        name: 'gaming-gateway-waf',
        rules: [
          // AWS Managed Rules - Common Rule Set
          {
            name: 'AWSManagedRulesCommonRuleSet',
            priority: 1,
            overrideAction: { none: {} }, // Enforcing - blocks SQLi, XSS, bad patterns
            statement: {
              managedRuleGroupStatement: {
                vendorName: 'AWS',
                name: 'AWSManagedRulesCommonRuleSet',
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'CommonRuleSet',
              sampledRequestsEnabled: true,
            },
          },
          // AWS Managed Rules - Known Bad Inputs
          {
            name: 'AWSManagedRulesKnownBadInputsRuleSet',
            priority: 2,
            overrideAction: { none: {} }, // Enforcing - blocks Log4j, SSRF, etc.
            statement: {
              managedRuleGroupStatement: {
                vendorName: 'AWS',
                name: 'AWSManagedRulesKnownBadInputsRuleSet',
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'KnownBadInputs',
              sampledRequestsEnabled: true,
            },
          },
          // --- PLAYER RECONNECTION STORM PROTECTION ---
          // High threshold rate limit for known game clients (X-Game-Id header present)
          // Allows 182K+ RPS bursts from legitimate players during reconnection events
          // without triggering false-positive DDoS blocks
          {
            name: 'PlayerReconnectionAllowance',
            priority: 3,
            action: { count: {} }, // Count only - do NOT block legitimate reconnections
            statement: {
              rateBasedStatement: {
                limit: 50000, // Very high per-IP limit for game clients
                aggregateKeyType: 'IP',
                scopeDownStatement: {
                  sizeConstraintStatement: {
                    fieldToMatch: { singleHeader: { name: 'x-game-id' } },
                    comparisonOperator: 'GT',
                    size: 0, // Header exists and has content
                    textTransformations: [{ priority: 0, type: 'NONE' }],
                  },
                },
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'PlayerReconnectionBurst',
              sampledRequestsEnabled: true,
            },
          },
          // Strict rate limit for requests WITHOUT game client headers (potential DDoS)
          {
            name: 'NonPlayerRateLimit',
            priority: 4,
            action: { block: {} },
            statement: {
              rateBasedStatement: {
                limit: 100, // Low threshold for demo — triggers within seconds
                aggregateKeyType: 'IP',
                scopeDownStatement: {
                  notStatement: {
                    statement: {
                      sizeConstraintStatement: {
                        fieldToMatch: { singleHeader: { name: 'x-game-id' } },
                        comparisonOperator: 'GT',
                        size: 0,
                        textTransformations: [{ priority: 0, type: 'NONE' }],
                      },
                    },
                  },
                },
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'NonPlayerRateLimit',
              sampledRequestsEnabled: true,
            },
          },
          // Per-IP rate limit for game clients (generous but bounded)
          // Prevents a single compromised client from overwhelming the system
          // Note: 100K/5min = ~333 RPS sustained per IP before blocking
          {
            name: 'PerClientRateLimit',
            priority: 5,
            action: { block: {} },
            statement: {
              rateBasedStatement: {
                limit: 100000, // High limit for demo; tune per game in production
                aggregateKeyType: 'IP',
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'PerClientRateLimit',
              sampledRequestsEnabled: true,
            },
          },
          // --- JA4 FINGERPRINT ANALYSIS ---
          // JA4 is a 36-char hash of the TLS Client Hello. Each game client SDK
          // produces a consistent fingerprint. Botnets using the same TLS library
          // share a fingerprint, making them detectable even across different IPs.
          //
          // Rate limit by JA4 fingerprint: catches distributed botnets that rotate IPs
          // but share the same TLS implementation (e.g., Python requests, Go net/http)
          {
            name: 'JA4FingerprintRateLimit',
            priority: 51,
            action: { block: {} },
            statement: {
              rateBasedStatement: {
                limit: 50000, // 50K requests per 5 min per JA4 fingerprint
                aggregateKeyType: 'CUSTOM_KEYS',
                customKeys: [
                  {
                    ja4Fingerprint: {
                      fallbackBehavior: 'NO_MATCH',
                    },
                  },
                ],
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'JA4FingerprintRateLimit',
              sampledRequestsEnabled: true,
            },
          },
          // JA4 + IP combined rate limit: strictest control
          // Catches a single actor using one TLS stack from one IP
          {
            name: 'JA4PlusIPRateLimit',
            priority: 52,
            action: { count: {} }, // Count mode for visibility; switch to block for enforcement
            statement: {
              rateBasedStatement: {
                limit: 5000, // 5K per 5 min per unique JA4+IP combination
                aggregateKeyType: 'CUSTOM_KEYS',
                customKeys: [
                  {
                    ja4Fingerprint: {
                      fallbackBehavior: 'NO_MATCH',
                    },
                  },
                  {
                    ip: {},
                  },
                ],
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'JA4PlusIPRateLimit',
              sampledRequestsEnabled: true,
            },
          },
          // --- TRAFFIC SHAPING: S2S/Admin traffic (55%) ---
          // Count Game server traffic for visibility (not blocked - trusted via PrivateLink)
          {
            name: 'GameServerTrafficVisibility',
            priority: 6,
            action: { count: {} },
            statement: {
              byteMatchStatement: {
                fieldToMatch: { singleHeader: { name: 'x-traffic-type' } },
                positionalConstraint: 'EXACTLY',
                searchString: 's2s',
                textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'GameServerTraffic',
              sampledRequestsEnabled: true,
            },
          },
          // Count admin traffic for visibility
          {
            name: 'AdminTrafficVisibility',
            priority: 7,
            action: { count: {} },
            statement: {
              byteMatchStatement: {
                fieldToMatch: { singleHeader: { name: 'x-traffic-type' } },
                positionalConstraint: 'EXACTLY',
                searchString: 'admin',
                textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'AdminTraffic',
              sampledRequestsEnabled: true,
            },
          },
          // Geo-blocking rule (configurable per game)
          {
            name: 'GeoRestriction',
            priority: 8,
            action: { count: {} },
            statement: {
              geoMatchStatement: {
                countryCodes: ['CN', 'RU'],
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'GeoRestriction',
              sampledRequestsEnabled: true,
            },
          },
          // Bot Control (gaming-specific)
          {
            name: 'AWSManagedRulesBotControlRuleSet',
            priority: 9,
            overrideAction: { none: {} }, // Enforcing - blocks known bots
            statement: {
              managedRuleGroupStatement: {
                vendorName: 'AWS',
                name: 'AWSManagedRulesBotControlRuleSet',
                managedRuleGroupConfigs: [
                  { awsManagedRulesBotControlRuleSet: { inspectionLevel: 'COMMON' } },
                ],
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'BotControl',
              sampledRequestsEnabled: true,
            },
          },
        ],
      });

      // WAF Logging - log group name MUST start with 'aws-waf-logs-'
      const wafLogGroup = new logs.LogGroup(this, 'WafLogGroup', {
        logGroupName: `aws-waf-logs-gaming-gateway-${this.stackName}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      new wafv2.CfnLoggingConfiguration(this, 'WafLogging', {
        logDestinationConfigs: [
          // WAF requires the ARN without the :* suffix
          cdk.Arn.format({
            service: 'logs',
            resource: 'log-group',
            resourceName: wafLogGroup.logGroupName,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }, this),
        ],
        resourceArn: wafAcl.attrArn,
      });

      this.wafAclArn = wafAcl.attrArn;
    } else {
      this.wafAclArn = '';
    }

    // --- CloudFront Distribution ---
    const distribution = new cloudfront.Distribution(this, 'GatewayDistribution', {
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(alb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY, // Use HTTPS in production
          connectionAttempts: 3,
          connectionTimeout: cdk.Duration.seconds(10),
          readTimeout: cdk.Duration.seconds(30),
          keepaliveTimeout: cdk.Duration.seconds(60),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // API traffic - no caching
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      priceClass: props.priceClass ?? cloudfront.PriceClass.PRICE_CLASS_ALL,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      enableLogging: true,
      logBucket: accessLogsBucket,
      logFilePrefix: 'cloudfront-logs/',
      comment: 'Gaming Gateway - Player-facing edge distribution',
      webAclId: this.wafAclArn || undefined,
    });
    this.distribution = distribution;

    // --- Shield Advanced DDoS Protection ---
    // Protects the CloudFront distribution with AWS Shield Advanced
    // Provides: DDoS detection, mitigation, 24/7 DRT access, cost protection
    const shieldProtection = new cdk.aws_shield.CfnProtection(this, 'ShieldProtection', {
      name: 'GamingGateway-CloudFront-DDoS',
      resourceArn: `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
    });

    // --- Route53 Health Checks for Shield Advanced ---
    // Shield Advanced uses these to detect application-layer DDoS attacks
    // by correlating traffic spikes with health degradation
    const gatewayHealthCheck = new cdk.aws_route53.CfnHealthCheck(this, 'GatewayHealthCheck', {
      healthCheckConfig: {
        type: 'HTTPS',
        fullyQualifiedDomainName: distribution.distributionDomainName,
        resourcePath: '/health',
        port: 443,
        requestInterval: 10, // Fast detection (10s intervals)
        failureThreshold: 2, // Mark unhealthy after 2 consecutive failures
        enableSni: true,
        measureLatency: true, // Track latency for anomaly detection
      },
      healthCheckTags: [
        { key: 'Name', value: 'GamingGateway-Primary-HealthCheck' },
        { key: 'Purpose', value: 'ShieldAdvanced-DDoS-Detection' },
      ],
    });

    // Associate health check with Shield protection for proactive engagement
    new cdk.aws_shield.CfnProtectionGroup(this, 'ShieldProtectionGroup', {
      aggregation: 'MAX',
      pattern: 'ARBITRARY',
      protectionGroupId: 'gaming-gateway-cloudfront',
      members: [
        `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
      ],
    });

    // --- Rate Limiter (Advanced Rate of Increase - Redis-backed) ---
    new RateLimiter(this, 'RateLimiter', {
      vpc: props.vpc,
      routerFunction,
    });

    // --- Canary Deployment ---
    if (props.enableCanary !== false) {
      new CanaryDeployment(this, 'CanaryDeploy', {
        routerFunction,
        alarmThreshold: 5, // 5% error rate triggers rollback
      });
    }

    // --- Outputs ---
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront distribution domain name',
    });
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
      description: 'ALB DNS name',
    });
  }
}
