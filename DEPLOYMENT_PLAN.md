# AWS ECS Lambda/OpenCode Integration and Tenant-Isolated Chatbot Deployment Plan

## Executive Summary

Deploy the OpenCode web frontend in AWS with Cognito-based tenant isolation, allowing authenticated users to spin up isolated OpenCode ECS sessions and interact with their S3 bucket contents via a chatbot interface.

**Architecture**: Cognito Auth → Frontend (CloudFront + S3) → API Gateway → Lambda functions → ECS OpenCode Sessions + S3 bucket contents

---

## 1. Architecture Overview

### Components

```
┌─────────────────────────────────────────────────────────────────┐
│ AWS Cloud                                                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────┐  ┌──────────────┐  ┌────────────────┐   │
│  │  CloudFront +    │  │   Cognito    │  │  API Gateway   │   │
│  │   S3 Frontend    │→ │  (Auth)      │→ │  (Routes)      │   │
│  └──────────────────┘  └──────────────┘  └────────────────┘   │
│         ↓                                        ↓              │
│    (Static assets)                    ┌──────────────────┐    │
│                                       │  Lambda Handlers │    │
│                                       │ • Session mgmt   │    │
│                                       │ • Job tracking   │    │
│                                       │ • Cognito auth   │    │
│                                       └──────────────────┘    │
│                                              ↓                  │
│                          ┌────────────────────┴─────────────┐  │
│                          ↓                                  ↓   │
│                    ┌──────────────┐              ┌──────────────┐
│                    │ ECS Fargate  │              │  S3 Bucket   │
│                    │ OpenCode     │              │ (per tenant) │
│                    │ Container    │              └──────────────┘
│                    └──────────────┘                             │
│                           ↓                                     │
│                    [WebSocket/SSE                             │
│                     session data]                              │
│                                                                │
└─────────────────────────────────────────────────────────────────┘
```

### Authentication Flow

1. User lands on frontend → redirected to Cognito login
2. Cognito returns JWT token → frontend stores in localStorage
3. All API requests include `Authorization: Bearer {token}`
4. Lambda validates JWT → extracts tenantId + userId
5. Tenant isolation enforced at Lambda + ECS container level

### Session Lifecycle

1. **User initiates session**: Clicks "New Session" on frontend
2. **Frontend calls Lambda** (`POST /opencode/sessions`):
   - Validates Cognito JWT
   - Resolves tenant from user record
   - Verifies tenant has provisioned S3 bucket + IAM role
   - Retrieves completed `repos_clone` job to locate repo files
   - Launches ECS Fargate task with:
     - Tenant isolation IAM role
     - S3 bucket prefix for that tenant
     - One-time session password (ephemeral, not stored server-side)
     - PM files prefix (if enabled)
3. **ECS task starts**, mounts:
   - `/workspace` → repo files from S3 (read-only)
   - `/workspace/pm` → PM files from S3 (if enabled)
   - Credentials from tenant workload role → can access S3
4. **Frontend opens WebSocket/SSE** to OpenCode session
5. **User interacts** → chatbot pulls repo + S3 bucket context
6. **Session terminates** → ECS task stops, credentials revoked

---

## 2. Frontend Deployment (AWS)

### Option A: CloudFront + S3 (Recommended)

**Pros**: Cheap, global CDN, automatic caching, scales infinitely
**Cons**: Static assets only (need API Gateway for dynamic endpoints)

#### Steps

1. **Create S3 bucket for frontend**:
   ```bash
   aws s3 mb s3://autodoc-frontend-prod
   aws s3api put-bucket-versioning \
     --bucket autodoc-frontend-prod \
     --versioning-configuration Status=Enabled
   ```

2. **Build and upload**:
   ```bash
   npm run build
   aws s3 sync dist/ s3://autodoc-frontend-prod --delete
   ```

3. **Create CloudFront distribution**:
   - **Origin**: S3 bucket (`s3://autodoc-frontend-prod`)
   - **Origin Access Control**: Create OAC, update bucket policy
   - **Default Root Object**: `index.html`
   - **Error responses**:
     - 404 → `index.html` (SPA routing)
     - 403 → `index.html`
   - **CNAME**: `chatbot.yourdomain.com`
   - **Viewer protocol**: Redirect HTTP → HTTPS
   - **Cache**: 
     - HTML files: 1 minute (for updates)
     - Assets: 1 year (versioned)

4. **Update DNS**:
   ```
   chatbot.yourdomain.com CNAME d111111abcdef8.cloudfront.net
   ```

5. **Cognito domain setup** (see Section 3)

### Option B: ECS for Frontend (if custom backend needed)

Skip this unless you need dynamic server-side logic.

---

## 3. Cognito Integration (Core for Tenant Isolation)

### Tenant Setup in Cognito

1. **User Pool**:
   - Name: `autodoc-users`
   - Custom attributes:
     - `tenantId` (String, required for signup)
     - `tenantRole` (String, e.g., "admin", "user")

2. **App Client**:
   ```bash
   aws cognito-idp create-user-pool-client \
     --user-pool-id us-east-1_xxxxx \
     --client-name autodoc-web-app \
     --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
     --callback-urls "https://chatbot.yourdomain.com/" \
     --allowed-o-auth-flows code implicit \
     --allowed-o-auth-scopes email openid profile
   ```

3. **Cognito Domain**:
   ```bash
   aws cognito-idp create-user-pool-domain \
     --domain autodoc-auth \
     --user-pool-id us-east-1_xxxxx
   ```

### Frontend Auth Integration

Already partially ready. Update [src/App.tsx](src/App.tsx) to add:

```typescript
import * as AmazonCognitoIdentity from "amazon-cognito-identity-js";

interface AuthConfig {
  userPoolId: string;
  clientId: string;
  region: string;
  domain: string;
}

export function initAuth(config: AuthConfig) {
  const userPool = new AmazonCognitoIdentity.CognitoUserPool({
    UserPoolId: config.userPoolId,
    ClientId: config.clientId,
  });
  
  const currentUser = userPool.getCurrentUser();
  if (!currentUser) {
    // Redirect to login
    const loginUrl = `https://${config.domain}.auth.${config.region}.amazoncognito.com/login?` +
      `response_type=code&client_id=${config.clientId}&redirect_uri=https://chatbot.yourdomain.com/`;
    window.location.href = loginUrl;
  }
  
  return currentUser;
}
```

Add environment variable to [.env.example](.env.example):

```
VITE_COGNITO_DOMAIN=autodoc-auth
VITE_COGNITO_CLIENT_ID=<client-id>
VITE_USER_POOL_ID=us-east-1_xxxxx
VITE_API_ENDPOINT=https://api.yourdomain.com
```

---

## 4. API Gateway + Lambda Layer

### API Structure

```
POST   /opencode/sessions              → opencode_session_start
GET    /opencode/sessions/{sessionId}  → opencode_session_status
DELETE /opencode/sessions/{sessionId}  → opencode_session_stop

POST   /repos/clone                    → repos_clone
GET    /repos/{jobId}/status           → repos_clone_status

POST   /s3/upload-presign              → pm_upload_presign
GET    /s3/list                        → list tenant S3 objects

POST   /jobs/list                      → jobs_list
```

### Lambda Middleware for Auth

Add auth enforcement to all routes (already partially in `opencode_session_start`):

**common/auth.py** (new file):
```python
import json
import boto3
from jose import jwt
from jose.exceptions import JWTClaimsError, JWTError

COGNITO_REGION = os.environ["COGNITO_REGION"]
USER_POOL_ID = os.environ["COGNITO_USER_POOL_ID"]

cognito_client = boto3.client("cognito-idp", region_name=COGNITO_REGION)

def verify_jwt(token: str) -> dict:
    """
    Verify Cognito JWT and return decoded claims.
    
    Returns:
        {
            "sub": "user-uuid",
            "email": "user@example.com",
            "custom:tenantId": "tenant-uuid",
            "custom:tenantRole": "admin|user",
            ...
        }
    """
    try:
        # Get public keys from Cognito
        keys_url = f"https://cognito-idp.{COGNITO_REGION}.amazonaws.com/{USER_POOL_ID}/.well-known/jwks.json"
        import urllib.request
        with urllib.request.urlopen(keys_url) as response:
            jwks = json.loads(response.read())
        
        # Verify signature using public key
        unverified_headers = jwt.get_unverified_header(token)
        kid = unverified_headers.get("kid")
        
        key = next((k for k in jwks["keys"] if k["kid"] == kid), None)
        if not key:
            raise JWTError("Key not found")
        
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=os.environ["COGNITO_CLIENT_ID"],
        )
        return claims
    except (JWTError, JWTClaimsError) as e:
        raise Exception(f"Invalid JWT: {str(e)}")

def get_user_from_event(event: dict) -> dict:
    """Extract and verify user from Authorization header."""
    auth_header = event.get("headers", {}).get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise Exception("Missing or invalid Authorization header")
    
    token = auth_header[7:]  # Remove "Bearer "
    claims = verify_jwt(token)
    
    return {
        "userId": claims.get("sub"),
        "email": claims.get("email"),
        "tenantId": claims.get("custom:tenantId"),
        "tenantRole": claims.get("custom:tenantRole"),
    }
```

### Update existing Lambda handlers to use this

All handlers in `lambdas/*/handler.py` should call:

```python
from common.auth import get_user_from_event

def main(event, context):
    try:
        user = get_user_from_event(event)
        tenant_id = user["tenantId"]
        # ... rest of logic
    except Exception as e:
        return resp(401, {"ok": False, "error": str(e)})
```

---

## 5. S3 Bucket Integration for Tenant Content

### Tenant S3 Bucket Setup

Each tenant has a provisioned S3 bucket with structure:

```
s3://tenant-{tenantId}/
├── projects/
│   ├── default/
│   │   ├── repos/
│   │   │   └── (cloned repo files from repos_clone job)
│   │   └── pm/
│   │       ├── documents/
│   │       ├── diagrams/
│   │       └── jira-sync/
│   └── {projectId}/
│       └── (same structure)
└── data/
    └── (user-uploaded files, notes, etc.)
```

### New Lambda: List S3 Content

**Lambda: `s3_list_contents`** (new)

```python
def main(event, context):
    user = get_user_from_event(event)
    tenant_id = user["tenantId"]
    
    prefix = event.get("queryStringParameters", {}).get("prefix", "")
    
    s3 = boto3.client("s3")
    bucket = f"tenant-{tenant_id}"
    
    response = s3.list_objects_v2(
        Bucket=bucket,
        Prefix=prefix,
        MaxKeys=100,
    )
    
    items = []
    for obj in response.get("Contents", []):
        items.append({
            "key": obj["Key"],
            "size": obj["Size"],
            "modified": obj["LastModified"].isoformat(),
        })
    
    return resp(200, {
        "ok": True,
        "bucket": bucket,
        "prefix": prefix,
        "items": items,
        "continuationToken": response.get("NextContinuationToken"),
    })
```

### Frontend: S3 Browser Component

Add new component `src/components/S3Browser.tsx`:

```typescript
import { createSignal, For, Show } from "solid-js";
import type { OpenCodeClient } from "../api/client";

interface S3BrowserProps {
  api: OpenCodeClient | null;
  onSelect: (key: string) => void;
}

export default function S3Browser(props: S3BrowserProps) {
  const [items, setItems] = createSignal<any[]>([]);
  const [prefix, setPrefix] = createSignal("");
  const [loading, setLoading] = createSignal(false);

  const loadContents = async () => {
    if (!props.api) return;
    setLoading(true);
    try {
      const { data } = await props.api.s3.listContents({
        query: { prefix: prefix() },
      });
      setItems(data?.items || []);
    } catch (e) {
      console.error("Failed to load S3 contents:", e);
    }
    setLoading(false);
  };

  return (
    <div class="space-y-2">
      <h3 class="font-bold">S3 Bucket Contents</h3>
      <div class="flex gap-2">
        <input
          type="text"
          class="input input-sm flex-1"
          placeholder="Folder prefix..."
          value={prefix()}
          onInput={(e) => setPrefix(e.currentTarget.value)}
        />
        <button class="btn btn-sm btn-primary" onClick={loadContents}>
          Browse
        </button>
      </div>
      
      <Show when={loading()}>
        <div class="loading loading-spinner"></div>
      </Show>

      <ul class="space-y-1">
        <For each={items()}>
          {(item) => (
            <li class="p-2 bg-base-200 rounded cursor-pointer hover:bg-base-300"
                onClick={() => props.onSelect(item.key)}>
              <span class="text-sm">{item.key}</span>
              <span class="text-xs opacity-50 ml-2">
                {(item.size / 1024).toFixed(1)} KB
              </span>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
```

---

## 6. ECS OpenCode Container Isolation

The existing `opencode_session_start` Lambda already handles tenant isolation via:

1. **IAM Role** (`TENANT_ROLE_ARN`):
   ```yaml
   TrustRelationship:
     Service: ecs-tasks.amazonaws.com
   Permissions:
     - s3:GetObject
     - s3:ListBucket
     - s3:GetObjectVersion
   Resource: arn:aws:s3:::tenant-${TENANT_ID}/*
   ```

2. **Environment variables** passed to container:
   - `TENANT_BUCKET` → `/workspace` mount
   - `REPO_PREFIX` → repo files location
   - `PM_S3_PREFIX` → PM files location
   - `SESSION_PASSWORD` → ephemeral auth (not stored)

3. **Container security context** (in task definition):
   ```json
   {
     "readonlyRootFilesystem": true,
     "privileged": false,
     "user": "opencode:opencode"
   }
   ```

### No changes needed to `opencode_session_start` handler

It already enforces:
- Cognito JWT validation
- Tenant resolution from user record
- Tenant status check (ACTIVE)
- Workload role + bucket provisioning check
- Single-use session password
- ECS task isolation

---

## 7. Frontend-to-ECS Session Connection

### WebSocket/SSE Bridge

The frontend needs to connect to the OpenCode ECS session. Options:

#### Option A: SSM Port Forwarding (Recommended for private ECS)

```bash
# Lambda returns these to frontend
taskId: "1abc23de4567f89g01234hi"
clusterName: "autodoc-cluster"
sessionPassword: "..." (ephemeral, 32 char)

# User runs locally (or frontend auto-runs via Lambda):
aws ecs describe-tasks --cluster autodoc-cluster --tasks 1abc23de4567f89g01234hi \
  --query 'tasks[0].containers[0].runtimeId' --output text

# → output: "abcd1234-efgh5678-ijkl9012"

aws ssm start-session \
  --target "ecs:autodoc-cluster_1abc23de4567f89g01234hi_abcd1234-efgh5678-ijkl9012" \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["4096"],"localPortNumber":["4096"]}'
```

#### Option B: ALB + Security Groups (Better for web)

If ECS is in public subnet with ALB:

```yaml
NetworkConfiguration:
  awsvpcConfiguration:
    subnets: [private-subnet-1, private-subnet-2]
    securityGroups: [sg-opencode]
    assignPublicIp: DISABLED
```

Add ALB listener rule:
```
Path: /opencode/session/{sessionId}/* → ECS task (dynamic target group)
```

### Frontend Connection Logic

Add to [src/components/SessionConnection.tsx](src/components/SessionConnection.tsx) (new):

```typescript
import { createSignal, Show, onMount, onCleanup } from "solid-js";

interface SessionConnectionProps {
  sessionId: string;
  taskId: string;
  password: string;
  port: number;
}

export default function SessionConnection(props: SessionConnectionProps) {
  const [connected, setConnected] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [ws, setWs] = createSignal<WebSocket | null>(null);

  onMount(async () => {
    try {
      // Attempt direct connection (assumes port-forward or ALB is set up)
      const wsUrl = `ws://localhost:${props.port}/`;
      const socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        setConnected(true);
        setError(null);
        // Send auth packet
        socket.send(JSON.stringify({
          type: "auth",
          sessionId: props.sessionId,
          password: props.password,
        }));
      };

      socket.onerror = (evt) => {
        setError(`WebSocket error: ${evt.type}`);
        setConnected(false);
      };

      socket.onclose = () => {
        setConnected(false);
      };

      setWs(socket);
    } catch (e) {
      setError(`Connection failed: ${String(e)}`);
    }
  });

  onCleanup(() => {
    ws()?.close();
  });

  return (
    <div class="alert">
      <Show
        when={connected()}
        fallback={<span class="loading loading-spinner"></span>}
      >
        <span>✓ Connected to OpenCode session {props.sessionId}</span>
      </Show>

      <Show when={error()}>
        <span class="text-error">{error()}</span>
      </Show>
    </div>
  );
}
```

---

## 8. Complete Deployment Steps

### Phase 1: Pre-Deployment (Week 1)

1. **Cognito setup**:
   - Create User Pool: `autodoc-users`
   - Add custom attributes: `tenantId`, `tenantRole`
   - Create App Client with OIDC settings
   - Create Cognito domain

2. **Lambda layer for shared code**:
   ```bash
   mkdir -p lambda-layer/python
   cp common/*.py lambda-layer/python/
   cd lambda-layer && zip -r ../lambda-layer.zip . && cd ..
   aws lambda publish-layer-version \
     --layer-name autodoc-common \
     --zip-file fileb://lambda-layer.zip \
     --compatible-runtimes python3.10 python3.11
   ```

3. **Update existing Lambda handlers**:
   - Add `get_user_from_event()` calls
   - Add Cognito JWT verification
   - Add audit logging

4. **Update environment variables in Lambda**:
   ```
   COGNITO_USER_POOL_ID=us-east-1_xxxxx
   COGNITO_REGION=us-east-1
   COGNITO_CLIENT_ID=<client-id>
   ```

### Phase 2: Frontend Deployment (Week 1)

1. **Add Cognito dependencies**:
   ```bash
   npm install amazon-cognito-identity-js @types/amazon-cognito-identity-js
   ```

2. **Update frontend environment**:
   ```bash
   cp .env.example .env.production
   # Update with your values
   VITE_COGNITO_DOMAIN=autodoc-auth
   VITE_COGNITO_CLIENT_ID=xxxxx
   VITE_USER_POOL_ID=us-east-1_xxxxx
   VITE_API_ENDPOINT=https://api.yourdomain.com
   ```

3. **Add Auth wrapper to App.tsx**:
   ```typescript
   import AuthProvider from "./components/AuthProvider";
   
   export default function App() {
     return (
       <AuthProvider>
         {/* existing app code */}
       </AuthProvider>
     );
   }
   ```

4. **Build and deploy**:
   ```bash
   npm run build
   aws s3 sync dist/ s3://autodoc-frontend-prod --delete --cache-control "max-age=3600"
   # Invalidate CloudFront
   aws cloudfront create-invalidation \
     --distribution-id EXXXXXXXXXX \
     --paths "/*"
   ```

### Phase 3: S3 & Tenant Infrastructure (Week 2)

1. **Provision tenant S3 buckets**:
   ```bash
   for tenant in tenant-001 tenant-002; do
     aws s3 mb s3://$tenant --region us-east-1
     aws s3api put-bucket-versioning --bucket $tenant --versioning-configuration Status=Enabled
     aws s3api put-bucket-encryption --bucket $tenant \
       --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
   done
   ```

2. **Create tenant workload IAM roles**:
   ```bash
   cat > trust-policy.json <<'EOF'
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Service": "ecs-tasks.amazonaws.com"
         },
         "Action": "sts:AssumeRole"
       }
     ]
   }
   EOF
   
   aws iam create-role \
     --role-name tenant-workload-001 \
     --assume-role-policy-document file://trust-policy.json
   
   aws iam put-role-policy \
     --role-name tenant-workload-001 \
     --policy-name s3-access \
     --policy-document '{
       "Version": "2012-10-17",
       "Statement": [
         {
           "Effect": "Allow",
           "Action": ["s3:GetObject","s3:ListBucket"],
           "Resource": ["arn:aws:s3:::tenant-001","arn:aws:s3:::tenant-001/*"]
         }
       ]
     }'
   ```

3. **Seed tenant records in DynamoDB**:
   ```python
   dynamodb = boto3.resource("dynamodb")
   tenants_table = dynamodb.Table("TENANTS_TABLE")
   
   tenants_table.put_item(Item={
       "tenantId": "tenant-001",
       "status": "ACTIVE",
       "bucketName": "tenant-001",
       "tenantWorkloadRoleArn": "arn:aws:iam::ACCOUNT:role/tenant-workload-001",
       "createdAt": "2026-05-06T00:00:00Z",
   })
   
   # Seed user-tenant mapping
   user_tenants_table = dynamodb.Table("USER_TENANTS_TABLE")
   user_tenants_table.put_item(Item={
       "userId": "user-uuid-from-cognito",
       "tenantId": "tenant-001",
       "role": "admin",
   })
   ```

### Phase 4: Testing (Week 2)

1. **Test auth flow**:
   - Navigate to frontend
   - Cognito login should redirect
   - Token stored in localStorage
   - API calls include Authorization header

2. **Test session creation**:
   - Click "New Session"
   - Lambda creates ECS task
   - SessionId returned
   - Task appears in ECS cluster

3. **Test S3 integration**:
   - S3 browser shows tenant bucket contents
   - Can select files to include in chatbot context
   - Chatbot can access selected files

4. **Performance test** (this is your primary test):
   - Send large query with code blocks (5000+ chars)
   - **Verify UI remains responsive** (debouncing + rendering work)
   - Check browser DevTools Performance tab
   - Markdown should render smoothly without lag

### Phase 5: Production Hardening (Week 3)

1. **Enable WAF on CloudFront**:
   ```bash
   aws wafv2 create-ip-set \
     --name autodoc-allowed-ips \
     --scope CLOUDFRONT \
     --ip-address-version IPV4 \
     --addresses '["0.0.0.0/0"]'  # Restrict as needed
   ```

2. **Add request signing to Lambda calls**:
   ```typescript
   // Frontend should sign requests to API Gateway
   import { SignatureV4 } from "@aws-sdk/signature-v4";
   import { Sha256 } from "@aws-crypto/sha256-js";
   ```

3. **Set CloudFront security headers**:
   - `Strict-Transport-Security: max-age=31536000`
   - `X-Content-Type-Options: nosniff`
   - `X-Frame-Options: DENY`
   - `Content-Security-Policy: default-src 'self' https://cognito-idp.region.amazonaws.com`

4. **Enable VPC logging** for ECS tasks:
   ```yaml
   logging:
     logDriver: awslogs
     options:
       awslogs-group: /ecs/autodoc-opencode
       awslogs-region: us-east-1
       awslogs-stream-prefix: ecs
   ```

---

## 9. Cost Estimates

| Component | Monthly Cost | Notes |
|-----------|--------------|-------|
| CloudFront | $0.085/GB | Typical: ~100 GB/month = $8.50 |
| S3 (frontend) | ~$1 | Storage + requests negligible |
| S3 (tenant buckets) | $0.023/GB | Varies by tenant data volume |
| API Gateway | $3.50 | Per 1M requests |
| Lambda | ~$20-50 | Depends on request volume |
| ECS Fargate | $0.04638/vCPU/hr | 0.5 vCPU, 1 GB RAM per session |
| Cognito | Free | Up to 50k MAU |
| DynamoDB | ~$10-20 | On-demand pricing |
| **Total** | **~$45-100/month** | Excluding tenant-specific ECS costs |

---

## 10. Monitoring & Debugging

### CloudWatch Dashboards

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name opencode-session-failures \
  --alarm-description "Alert on session creation failures" \
  --metric-name Errors \
  --namespace AWS/Lambda \
  --statistic Sum \
  --period 300 \
  --threshold 5 \
  --comparison-operator GreaterThanThreshold
```

### Logs to Monitor

1. **Lambda logs** (`/aws/lambda/*`):
   - Session creation failures
   - Auth validation errors
   - S3 access issues

2. **ECS logs**:
   - Container startup errors
   - Repo mount failures
   - S3 access from within container

3. **CloudFront logs**:
   - 4xx/5xx error rates
   - Cache hit ratios
   - Origin latency

### Performance Benchmarks

After deployment, measure:

```bash
# Frontend rendering on large responses
# Expected: <500ms markdown parse + render (with debouncing)

# Session creation
# Expected: <15s from button click to WebSocket ready

# S3 listing
# Expected: <2s for 100 objects

# Repo clone
# Expected: <2min for typical 50MB repo
```

---

## 11. Security Checklist

- [ ] Cognito JWT verified on every Lambda request
- [ ] Tenant ID validated against user's allowed tenants
- [ ] S3 bucket access scoped to tenant-specific role
- [ ] ECS task runs as non-root user
- [ ] Session passwords are one-time, ephemeral
- [ ] CloudFront HTTPS enforced
- [ ] WAF rules enabled on API Gateway
- [ ] VPC logging enabled for ECS
- [ ] Secrets (API keys, passwords) never logged
- [ ] CORS configured on API Gateway (frontend domain only)

---

## 12. Future Enhancements

1. **Real-time collaboration**: Multiple users in same session
2. **Session persistence**: Save/resume sessions across days
3. **Advanced S3 search**: Full-text search across tenant bucket
4. **Audit trail**: All actions logged to CloudTrail
5. **Cost allocation**: Track per-tenant ECS spend
6. **Auto-scaling**: Spin down idle sessions after 1 hour
7. **Batch operations**: Clone multiple repos in parallel
8. **Custom models**: Per-tenant Bedrock model selection

---

## Appendix: Key File Changes Summary

### New Files to Create

```
src/
  components/
    AuthProvider.tsx          # Cognito login wrapper
    SessionConnection.tsx     # WebSocket to ECS session
    S3Browser.tsx             # S3 bucket file browser
  stores/
    auth.ts                   # Auth state management
  utils/
    cognito.ts                # Cognito helper functions

lambdas/
  common/
    auth.py                   # JWT verification
  s3_list_contents/
    handler.py                # New Lambda for S3 listing
```

### Files to Modify

- `src/App.tsx` - Add AuthProvider wrapper
- `src/components/ChatView.tsx` - Integrate S3 context
- `src/stores/config.ts` - Add auth config
- `.env.example` - Add Cognito variables
- All existing Lambda handlers - Add auth middleware

### Infrastructure as Code (CDK/CloudFormation)

Create `infra/` directory with:
- `cognito-stack.ts` - User Pool, Domain, App Client
- `s3-stack.ts` - Frontend + tenant buckets
- `lambda-stack.ts` - API Gateway + handlers
- `ecs-stack.ts` - Fargate cluster, task definitions

---

## Questions & Next Steps

1. **Domain availability**: Do you own `yourdomain.com`?
2. **AWS account setup**: Production account ready?
3. **ECS cluster**: Already provisioned or build from scratch?
4. **Testing**: Can you test local port-forward setup first?
5. **Timeline**: What's your deployment deadline?

**Next meeting**: Review this plan, identify blockers, start Phase 1.

---

*Generated: 2026-05-06*
*For updates or questions, see Architecture Review section.*
