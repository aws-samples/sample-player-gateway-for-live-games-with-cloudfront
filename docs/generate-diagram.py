"""Generate architecture diagrams for each pattern."""
from diagrams import Diagram, Cluster, Edge
from diagrams.aws.network import CloudFront, ELB, Route53
from diagrams.aws.compute import Lambda, EC2Instances
from diagrams.aws.security import WAF, Shield
from diagrams.aws.database import ElastiCache
from diagrams.aws.management import Cloudwatch
from diagrams.aws.mobile import APIGateway
from diagrams.aws.general import Users, Client

graph_attr = {
    "fontsize": "14",
    "bgcolor": "white",
    "pad": "0.5",
    "nodesep": "0.8",
    "ranksep": "1.0",
}

# Pattern 1: CloudFront + ALB + NGINX/EC2
with Diagram(
    "Pattern 1: CloudFront + ALB + NGINX/EC2",
    filename="docs/pattern1-nginx-ec2",
    show=False,
    direction="LR",
    graph_attr=graph_attr,
    outformat="png",
):
    players = Users("Game Clients")
    servers = Client("Game Servers")

    with Cluster("Edge Layer"):
        cf = CloudFront("CloudFront\n(Anycast IPs)")
        waf = WAF("WAF\nJA4 Fingerprint\nRate Limiting\nBot Control")
        shield = Shield("Shield\nAdvanced")
        healthcheck = Route53("Route53\nHealth Check")

    with Cluster("Compute Layer"):
        alb = ELB("ALB")
        with Cluster("Auto Scaling Group"):
            nginx1 = EC2Instances("NGINX")
            nginx2 = EC2Instances("NGINX")

    with Cluster("Observability"):
        cw = Cloudwatch("CloudWatch\nDashboard")

    players >> Edge(label="HTTPS") >> cf >> waf >> shield
    healthcheck >> cf
    cf >> alb >> [nginx1, nginx2]
    servers >> Edge(label="PrivateLink", style="dashed") >> alb
    waf >> Edge(style="dotted") >> cw


# Pattern 2: CloudFront + ALB + Lambda
with Diagram(
    "Pattern 2: CloudFront + ALB + Lambda",
    filename="docs/pattern2-lambda",
    show=False,
    direction="LR",
    graph_attr=graph_attr,
    outformat="png",
):
    players = Users("Game Clients")
    servers = Client("Game Servers")

    with Cluster("Edge Layer"):
        cf = CloudFront("CloudFront\n(Anycast IPs)")
        waf = WAF("WAF\nJA4 Fingerprint\nRate Limiting\nBot Control")
        shield = Shield("Shield\nAdvanced")
        healthcheck = Route53("Route53\nHealth Check")

    with Cluster("Compute Layer"):
        alb = ELB("ALB")
        with Cluster("Lambda Cells (Blast Radius Isolation)"):
            cell0 = Lambda("Cell 0")
            cell1 = Lambda("Cell 1")

    with Cluster("Supporting Services"):
        redis = ElastiCache("ElastiCache\n(Rate Limiter)")
        cw = Cloudwatch("CloudWatch\nDashboard")

    players >> Edge(label="HTTPS") >> cf >> waf >> shield
    healthcheck >> cf
    cf >> alb >> [cell0, cell1]
    servers >> Edge(label="PrivateLink", style="dashed") >> alb
    cell0 >> Edge(style="dotted") >> redis
    cell1 >> Edge(style="dotted") >> redis
    waf >> Edge(style="dotted") >> cw


# Pattern 3: CloudFront + API Gateway + Lambda
with Diagram(
    "Pattern 3: CloudFront + API Gateway + Lambda",
    filename="docs/pattern3-apigateway",
    show=False,
    direction="LR",
    graph_attr=graph_attr,
    outformat="png",
):
    players = Users("Game Clients")
    servers = Client("Game Servers")

    with Cluster("Edge Layer"):
        cf = CloudFront("CloudFront\n(Anycast IPs)")
        waf = WAF("WAF\nJA4 Fingerprint\nRate Limiting\nBot Control")
        shield = Shield("Shield\nAdvanced")
        healthcheck = Route53("Route53\nHealth Check")

    with Cluster("API Layer"):
        apigw = APIGateway("HTTP API\n(Throttling, Auth)")

    with Cluster("Compute Layer"):
        fn = Lambda("Lambda")

    with Cluster("Observability"):
        cw = Cloudwatch("CloudWatch\nDashboard")

    players >> Edge(label="HTTPS") >> cf >> waf >> shield
    healthcheck >> cf
    cf >> apigw >> fn
    servers >> Edge(label="PrivateLink", style="dashed") >> apigw
    waf >> Edge(style="dotted") >> cw
