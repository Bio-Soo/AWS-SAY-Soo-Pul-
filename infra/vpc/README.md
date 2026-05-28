# VPC / Network Configuration

The original deployment uses VPC `vpc-06dd0ad1f2335ea74` (10.0.0.0/24) in `ap-northeast-2`. The actual VPC/subnet/SG JSON is saved in `infra/aws-state/` for reference.

## Required topology

```
VPC (10.0.0.0/24)
│
├─ Internet Gateway (igw-...)
│
├─ NAT Gateway (in PUBLIC subnet, EIP attached)
│
├─ PUBLIC subnet (NAT lives here, EC2 FastAPI also here for direct internet)
│   └─ Route table: 0.0.0.0/0 → IGW
│
├─ PRIVATE subnet AZ-a (Lambda ENIs land here)
│   └─ Route table: 0.0.0.0/0 → NAT gateway
│   └─                10.0.0.0/24 → local
│   └─                S3 service → VPC endpoint (gateway)
│
├─ PRIVATE subnet AZ-c (second AZ for HA)
│   └─ Same route table as above
│
└─ PRIVATE subnet (RDS/Aurora)
    └─ No internet route needed
```

## Security groups

| SG | Inbound | Outbound | Used by |
|---|---|---|---|
| `sg-aurora` | 5432 from `sg-lambda-data` only | (none — Aurora doesn't initiate) | Aurora cluster |
| `sg-lambda-data` | (none — Lambda doesn't accept inbound) | 5432 → sg-aurora; 443 → 0.0.0.0/0 | Phase 3/4/5/RAG Lambdas (DB-touching) |
| `sg-lambda-public` | (none) | 443 → 0.0.0.0/0 | Phase 1 (no DB) |
| `sg-ec2-api` | 80/443 from CloudFront IPs; 22 from your IP | 5432 → sg-aurora; 443 → 0.0.0.0/0 | FastAPI EC2 |

The Lambda VPC config in `lambdas/*/template.yaml` should reference `sg-lambda-data` for Phase 3/4/5/RAG, `sg-lambda-public` (or none) for Phase 1.

## VPC endpoints (recommended, optional)

For cost savings + reduced NAT traffic:
- `com.amazonaws.ap-northeast-2.s3` (gateway endpoint) — Lambda → S3 directly
- `com.amazonaws.ap-northeast-2.secretsmanager` (interface) — eliminates NAT for `boto3.client('secretsmanager').get_secret_value()`
- `com.amazonaws.ap-northeast-2.bedrock-runtime` (interface, where available) — eliminates NAT for Bedrock

Currently only S3 gateway is provisioned in the original deployment. Secrets Manager endpoint would have avoided the 5-min Lambda hang issue described in `docs/RUNBOOK.md`.

## Bootstrap

`scripts/bootstrap-infra.sh` provisions the entire VPC + subnets + SGs from a CloudFormation template (`infra/vpc/cfn-vpc.yaml` — TBD; for now use AWS Console or terraform module).
