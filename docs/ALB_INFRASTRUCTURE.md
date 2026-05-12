# ALB Infrastructure Overview

## Architecture

```
User Browser
    ↓ (sign in)
Vercel Frontend (opencode-web-gamma.vercel.app)
    ↓ (redirect after auth)
AWS Application Load Balancer (ALB)
    ↓ (routes to port 3000)
ECS Fargate Task (OpenCode Server)
    ↓ (access tenant resources)
Tenant S3 Bucket + IAM Role
```

## Key Components

### 1. Application Load Balancer (ALB)
- **DNS:** `autodoc-opencode-alb-1424128421.ca-central-1.elb.amazonaws.com`
- **Port:** 80 (HTTP) - public facing
- **Target Group:** `autodoc-opencode-tg` - routes to port 3000
- **Health Check:** `GET /` expecting 200 response
- **Idle Timeout:** 300s (5 min) for SSE streaming support
- **Stack:** `autodoc-control-plane-opencode-workloads`

### 2. ECS Fargate Service
- **Cluster:** `autodoc-cluster` (shared across all workloads)
- **Service Name:** `autodoc-opencode`
- **Desired Count:** 1 (single shared instance)
- **Task Definition:** `autodoc-opencode` (2 vCPU, 4GB RAM)
- **Container:** Runs OpenCode server on port 3000
- **Subnets:** Private subnets (no public IP)
- **Stack:** `autodoc-control-plane-opencode-workloads`

### 3. OpenCode Container
- **Image:** From ECR repo `autodoc-opencode`
- **Port:** 3000 (internal)
- **Environment Variables:**
  - `OPENCODE_CONFIG_CONTENT` - LLM provider config (MiniMax)
  - AWS credentials (from task role)
- **Permissions:** Full access to tenant S3 buckets via IAM role

### 4. Tenant Context
- **S3 Bucket:** Per-tenant bucket for code/data
- **IAM Role:** Per-tenant workload role
- **How It Works:** Container assumes tenant role to access resources
- **Isolation:** Each user's session uses their tenant's credentials

## Deployment

Deploy entire stack with:
```bash
cd C:\Users\Sineth\autodoc-control-plane-cdk
cdk deploy --all --require-approval=never --profile autodoc-prod
```

Key stacks:
- `autodoc-control-plane-opencode-workloads` - ALB + ECS service
- `autodoc-control-plane-api` - API Gateway + Lambdas (mostly unchanged)

## How It Works

1. **User Signs In**
   - Vercel frontend redirects to ALB after Cognito auth
   - URL: `http://alb-dns/`

2. **ALB Routes Request**
   - ALB listens on port 80
   - Routes to target group on port 3000
   - Target group has 1 healthy ECS task

3. **OpenCode Server Responds**
   - Task serves OpenCode IDE on port 3000
   - Browser loads the UI
   - User can create/edit projects and chat with AI

4. **LLM Integration**
   - Uses MiniMax free model (OpenAI-compatible API)
   - No AWS credentials needed for LLM calls
   - Configured in container env var `OPENCODE_CONFIG_CONTENT`

## Important Notes

- **Single Shared Instance:** Only 1 ECS task running (not per-session)
- **No HTTPS:** ALB uses HTTP (not HTTPS) in this setup
- **No Session Isolation:** All users connect to same OpenCode instance
- **MiniMax Model:** `abab6.5-chat` - free tier LLM
- **Health Check:** ALB checks `/` expecting 200 OK

## Troubleshooting

**ALB not responding:**
- Check ECS task is RUNNING: `aws ecs list-tasks --cluster autodoc-cluster --profile autodoc-prod`
- Check health: `aws elbv2 describe-target-health --target-group-arn <arn>`

**404 errors:**
- OpenCode might still be starting (health check takes ~30s)
- Check ECS task logs: `aws logs tail <log-group> --profile autodoc-prod`

**Chat not working:**
- MiniMax API key needs to be set in container
- Check container env vars in CloudFormation

## Related Files

- CDK Stack: `stacks/workloads_opencode_stack.py`
- Frontend Config: `vercel.json` (ALB URL)
- Frontend Redirect Logic: `src/App.tsx`
