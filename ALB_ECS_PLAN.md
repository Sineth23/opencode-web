# Plan: ALB + ECS Architecture for OpenCode Web UI

## Goal
Make the OpenCode web UI work like local `opencode serve + npm run dev`

## Current Problem
- Lambda proxy can't reach ECS tasks (security group blocks port 4096)
- Lambda 29s timeout breaks SSE streaming  
- Complex proxy logic

## Solution: Replace Lambda Proxy with ALB → ECS Service

```
Frontend → ALB (public subnets, port 80) → ECS Service (private subnets, port 4096)
```

---

## Implementation Steps

### Step 1: Update `stacks/workloads_opencode_stack.py`

Add to the stack:
1. **ALB Security Group** — allow inbound 80/443 from 0.0.0.0/0
2. **Update `tasks_sg`** — add inbound TCP 4096 from ALB security group
3. **Application Load Balancer** — internet-facing, in public subnets
4. **Target Group** — HTTP port 4096, health check on `/health` (mark 401 as healthy)
5. **ALB Listener** — HTTP 80 → target group
6. **ECS FargateService** — desired count 1, private subnets, register with ALB
7. **Export ALB DNS** to SSM parameter

**Key config:**
- ALB idle timeout: 300s (for SSE streaming)
- Health check: `/health` with expected status 401 (OpenCode returns 401 without password)
- Service desired count: 1 (single shared instance)

### Step 2: Update `stacks/api_stack.py`

Remove these Lambda proxy routes:
- `DELETE /session/{sessionId}/message`
- `GET /session/{sessionId}`  
- `GET /config/{proxy+}`
- `GET /agent`
- `GET /app/agents`
- `GET /event`

Keep only:
- `POST /session` — for session creation (stays as Lambda)

### Step 3: Update `opencode-web/.env.local`

```
VITE_API_DEFAULT=http://<alb-dns-from-output>
VITE_COGNITO_CLIENT_ID=5hbjt7mmj7f1ninb7l7q6eq79v
VITE_COGNITO_USER_POOL_ID=ca-central-1_BSotcgUgw
VITE_COGNITO_REGION=ca-central-1
```

### Step 4: Deploy

```bash
cd C:\Users\Sineth\autodoc-control-plane-cdk
cdk deploy --all --require-approval never --profile autodoc-prod
```

Get the ALB DNS name from CloudFormation outputs, update `.env.local`.

---

## Architecture Comparison

| Aspect | Current (Lambda Proxy) | New (ALB + Service) |
|--------|----------------------|-------------------|
| Request path | Frontend → Lambda → ECS | Frontend → ALB → ECS |
| Timeout | 29s (Lambda limit) | Unlimited (ALB) |
| SSE Streaming | ❌ Breaks | ✅ Works |
| Security Groups | 🔴 Blocks port 4096 | ✅ Fixed |
| Session isolation | ✅ Per-user tasks | ⚠️ Shared instance |
| Complexity | Proxy logic in Lambda | Standard AWS pattern |

---

## Why This Works

1. **Single shared OpenCode instance** — OpenCode already supports multiple sessions internally
2. **ALB is standard AWS** — proven pattern for ECS services
3. **No Lambda proxy** — removes timeout issues, network complexity
4. **Matches local setup** — exactly like `opencode serve + npm run dev`

---

## Testing

1. Deploy CDK
2. Check ALB target shows "Healthy"
3. Update `.env.local` with ALB DNS
4. Run `npm run dev`
5. Create session from UI
6. Send message → should get Claude response
7. Check SSE streaming (real-time message updates)

---

## Files to Modify

- `stacks/workloads_opencode_stack.py` — Add ALB infrastructure
- `stacks/api_stack.py` — Remove proxy routes
- `.env.local` — Point to ALB
