# Plan: ALB + ECS Architecture for OpenCode Web UI

## Goal
Make the OpenCode web UI work like local `opencode serve + npm run dev`

## Current Problem
- Lambda proxy can't reach ECS tasks (security group blocks port 4096)
- Lambda 29s timeout breaks SSE streaming
- Complex proxy logic

## Solution
Replace Lambda proxy with ALB → ECS Service

```
Frontend → ALB (public) → ECS Service (private)
```

## Implementation

### Step 1: Update workloads_opencode_stack.py
Add:
- ALB security group (allow 80/443 inbound)
- Update tasks_sg to allow TCP 4096 from ALB
- Application Load Balancer (internet-facing)
- Target Group (HTTP 4096, health check on /health with 401 as healthy)
- ECS FargateService (desired count 1, private subnets)

### Step 2: Update api_stack.py
- Remove ALL Lambda proxy routes (/session/{id}/message, /config/*, /agent, /event)
- Keep only /session POST for session management

### Step 3: Update .env.local
```
VITE_API_DEFAULT=http://<alb-dns-name>
```

### Step 4: Deploy
```bash
cdk deploy --all --profile autodoc-prod
```

## Why This Works
- One shared OpenCode instance (OpenCode handles multiple sessions internally)
- ALB handles SSE streaming natively
- Stable URL for frontend
- Exactly mimics local setup
- No Lambda timeouts

## Files to Change
1. C:\Users\Sineth\autodoc-control-plane-cdk\stacks\workloads_opencode_stack.py
2. C:\Users\Sineth\autodoc-control-plane-cdk\stacks\api_stack.py
3. c:\Users\Sineth\opencode-web\.env.local

