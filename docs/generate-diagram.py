"""Generate the architecture diagram for the Player Gateway Blueprint."""
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
    "ranksep": "1.2",
}

with Diagram(
    "Player Gateway - Edge Security & DDoS Protection",
    filename="docs/architecture",
    show=False,
    direction="LR",
    graph_attr=graph_attr,
    outformat="png",
):
    # Clients
    players = Users("Game Clients\n(35% traffic)")
    s2s = Client("Game Servers\n(55% traffic)")
    admin = Client("Admin/Ops\n(10% traffic)")

    with Cluster("Edge Layer (CloudFront + WAF + Shield)"):
        cf = CloudFront("CloudFront\n(Anycast IPs)")
        waf = WAF("WAF\nJA4 Fingerprint\nRate Limiting\nBot Control")
        shield = Shield("Shield\nAdvanced")
        healthcheck = Route53("Route53\nHealth Check")

    with Cluster("Pattern 1: NGINX/EC2"):
        nginx_alb = ELB("ALB")
        nginx_asg = EC2Instances("EC2 ASG\n(NGINX)")

    with Cluster("Pattern 2: Serverless"):
        lambda_alb = ELB("ALB")
        with Cluster("Lambda Cells"):
            cell0 = Lambda("Cell 0")
            cell1 = Lambda("Cell 1")

    with Cluster("Pattern 3: API Gateway"):
        apigw = APIGateway("HTTP API")
        apigw_lambda = Lambda("Lambda")

    with Cluster("Supporting Services"):
        redis = ElastiCache("ElastiCache\n(Rate Limiter)")
        cw = Cloudwatch("CloudWatch\n(JA4 Dashboard)")

    # Player traffic flow
    players >> Edge(label="HTTPS") >> cf
    cf >> waf >> shield
    healthcheck >> cf

    # Path routing
    cf >> Edge(label="/nginx/*") >> nginx_alb >> nginx_asg
    cf >> Edge(label="/lambda/*") >> lambda_alb >> [cell0, cell1]
    cf >> Edge(label="/apigw/*") >> apigw >> apigw_lambda

    # S2S and Admin
    s2s >> Edge(label="PrivateLink", style="dashed") >> nginx_alb
    admin >> Edge(label="Private", style="dashed") >> apigw

    # Supporting
    cell0 >> Edge(style="dotted") >> redis
    cell1 >> Edge(style="dotted") >> redis
    waf >> Edge(style="dotted") >> cw
