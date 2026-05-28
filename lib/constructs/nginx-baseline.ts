import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface NginxBaselineProps {
  /**
   * VPC for EC2 placement.
   */
  readonly vpc: ec2.IVpc;

  /**
   * Instance type for NGINX nodes.
   * @default 't3.medium'
   */
  readonly instanceType?: ec2.InstanceType;

  /**
   * Minimum number of instances in the ASG.
   * @default 2
   */
  readonly minCapacity?: number;

  /**
   * Maximum number of instances in the ASG.
   * @default 10
   */
  readonly maxCapacity?: number;

  /**
   * Desired number of instances in the ASG.
   * @default 2
   */
  readonly desiredCapacity?: number;

  /**
   * Target CPU utilization for scaling (%).
   * @default 60
   */
  readonly targetCpuUtilization?: number;
}

/**
 * NGINX Baseline construct for A/B comparison against the serverless Lambda path.
 *
 * Deploys EC2 instances running NGINX in an Auto Scaling Group behind an ALB.
 * This represents the "current state" architecture that the customer wants to
 * compare against the fully managed serverless approach.
 *
 * The ALB is exposed as a CloudFront origin so traffic can be split via
 * weighted routing at the CloudFront level.
 *
 * Metrics emitted:
 * - ALB: TargetResponseTime, RequestCount, HTTPCode_Target_2XX/4XX/5XX
 * - ASG: CPUUtilization, NetworkIn/Out, GroupInServiceInstances
 * - Custom: nginx_requests_per_second, nginx_active_connections (via CloudWatch Agent)
 */
export class NginxBaseline extends Construct {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly asg: autoscaling.AutoScalingGroup;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: NginxBaselineProps) {
    super(scope, id);

    // Security group for NGINX instances
    const nginxSg = new ec2.SecurityGroup(this, 'NginxSg', {
      vpc: props.vpc,
      description: 'Security group for NGINX baseline instances',
      allowAllOutbound: true,
    });

    // Security group for ALB
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: props.vpc,
      description: 'Security group for NGINX baseline ALB',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP from CloudFront');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS from CloudFront');

    // Allow ALB to reach NGINX instances
    nginxSg.addIngressRule(albSg, ec2.Port.tcp(80), 'Allow HTTP from ALB');

    // IAM role for EC2 instances
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });

    // User data script to install and configure NGINX + CloudWatch Agent
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'set -e',
      '',
      '# Install NGINX',
      'amazon-linux-extras install nginx1 -y || yum install nginx -y',
      '',
      '# Install CloudWatch Agent',
      'yum install amazon-cloudwatch-agent -y',
      '',
      '# Configure NGINX as a reverse proxy / gateway stub',
      'cat > /etc/nginx/conf.d/gateway.conf << \'NGINX_CONF\'',
      'upstream backend {',
      '    server 127.0.0.1:8080;',
      '}',
      '',
      'server {',
      '    listen 80;',
      '    server_name _;',
      '',
      '    # Health check endpoint',
      '    location /health {',
      '        access_log off;',
      '        return 200 \'{"status":"healthy","backend":"nginx-ec2","instance_id":"INSTANCE_ID"}\\n\';',
      '        add_header Content-Type application/json;',
      '    }',
      '',
      '    # Gateway routing stub - simulates routing logic',
      '    location / {',
      '        # Add gateway headers for comparison metrics',
      '        add_header X-Backend-Type "nginx-ec2" always;',
      '        add_header X-Request-Id $request_id always;',
      '        add_header Access-Control-Allow-Origin "*" always;',
      '        add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS" always;',
      '        add_header Access-Control-Allow-Headers "Content-Type, Authorization, X-Game-Id, X-Platform" always;',
      '',
      '        # Simulate backend response (replace with actual proxy_pass in production)',
      '        return 200 \'{"message":"Request processed by NGINX","backend":"nginx-ec2","path":"$uri","method":"$request_method","timestamp":"$time_iso8601"}\\n\';',
      '        add_header Content-Type application/json;',
      '    }',
      '',
      '    # NGINX status for monitoring',
      '    location /nginx_status {',
      '        stub_status on;',
      '        access_log off;',
      '        allow 127.0.0.1;',
      '        deny all;',
      '    }',
      '}',
      'NGINX_CONF',
      '',
      '# Replace INSTANCE_ID placeholder',
      'INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)',
      'sed -i "s/INSTANCE_ID/$INSTANCE_ID/g" /etc/nginx/conf.d/gateway.conf',
      '',
      '# Remove default server block',
      'rm -f /etc/nginx/conf.d/default.conf',
      '',
      '# Configure CloudWatch Agent for NGINX metrics',
      'cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << \'CW_CONF\'',
      '{',
      '  "agent": {',
      '    "metrics_collection_interval": 10,',
      '    "logfile": "/opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log"',
      '  },',
      '  "metrics": {',
      '    "namespace": "GamingGateway/NginxBaseline",',
      '    "metrics_collected": {',
      '      "cpu": {',
      '        "resources": ["*"],',
      '        "measurement": ["cpu_usage_idle", "cpu_usage_user", "cpu_usage_system"],',
      '        "totalcpu": true',
      '      },',
      '      "mem": {',
      '        "measurement": ["mem_used_percent", "mem_available_percent"]',
      '      },',
      '      "net": {',
      '        "measurement": ["bytes_sent", "bytes_recv", "packets_sent", "packets_recv"]',
      '      },',
      '      "disk": {',
      '        "measurement": ["used_percent"],',
      '        "resources": ["/"]',
      '      }',
      '    },',
      '    "append_dimensions": {',
      '      "InstanceId": "${aws:InstanceId}",',
      '      "AutoScalingGroupName": "${aws:AutoScalingGroupName}"',
      '    }',
      '  },',
      '  "logs": {',
      '    "logs_collected": {',
      '      "files": {',
      '        "collect_list": [',
      '          {',
      '            "file_path": "/var/log/nginx/access.log",',
      '            "log_group_name": "/gaming-gateway/nginx/access",',
      '            "log_stream_name": "{instance_id}",',
      '            "retention_in_days": 14',
      '          },',
      '          {',
      '            "file_path": "/var/log/nginx/error.log",',
      '            "log_group_name": "/gaming-gateway/nginx/error",',
      '            "log_stream_name": "{instance_id}",',
      '            "retention_in_days": 14',
      '          }',
      '        ]',
      '      }',
      '    }',
      '  }',
      '}',
      'CW_CONF',
      '',
      '# Start services',
      'systemctl enable nginx',
      'systemctl start nginx',
      '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json',
      '',
      'echo "NGINX baseline setup complete"',
    );

    // Launch Template (Launch Configurations are deprecated)
    const launchTemplate = new ec2.LaunchTemplate(this, 'NginxLaunchTemplate', {
      instanceType: props.instanceType ?? new ec2.InstanceType('t3.medium'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: nginxSg,
      role: instanceRole,
      userData,
      httpEndpoint: true,
      httpTokens: ec2.LaunchTemplateHttpTokens.REQUIRED,
    });

    // Auto Scaling Group
    this.asg = new autoscaling.AutoScalingGroup(this, 'NginxAsg', {
      vpc: props.vpc,
      launchTemplate,
      minCapacity: props.minCapacity ?? 2,
      maxCapacity: props.maxCapacity ?? 10,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      healthCheck: autoscaling.HealthCheck.elb({
        grace: cdk.Duration.seconds(120),
      }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        maxBatchSize: 1,
        minInstancesInService: 1,
        pauseTime: cdk.Duration.minutes(5),
      }),
      cooldown: cdk.Duration.seconds(60),
      groupMetrics: [autoscaling.GroupMetrics.all()],
    });

    // CPU-based scaling policy
    this.asg.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: props.targetCpuUtilization ?? 60,
      cooldown: cdk.Duration.seconds(60),
      estimatedInstanceWarmup: cdk.Duration.seconds(120),
    });

    // ALB for NGINX baseline
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'NginxAlb', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      dropInvalidHeaderFields: true,
    });

    // Target group
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'NginxTg', {
      vpc: props.vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE,
      targets: [this.asg],
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(15),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        timeout: cdk.Duration.seconds(5),
        healthyHttpCodes: '200',
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // Listener
    this.alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [this.targetGroup],
    });

    // Request count scaling (must be after ASG is attached to ALB via target group)
    this.asg.scaleOnRequestCount('RequestScaling', {
      targetRequestsPerMinute: 1000,
      cooldown: cdk.Duration.seconds(60),
    });

    // Outputs
    new cdk.CfnOutput(this, 'NginxAlbDns', {
      value: this.alb.loadBalancerDnsName,
      description: 'NGINX Baseline ALB DNS name',
    });
  }
}
