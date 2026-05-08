# OpenCode Session Integration - Context & Status

## Objective

Enable users to create blank OpenCode sessions from the chatbot UI without requiring a cloneJobId. The frontend should authenticate with Cognito tokens and communicate with the OpenCode proxy Lambda to create sessions that run as Fargate tasks.

## Architecture Overview

```
Frontend (React/SolidJS)
    ↓ (Custom fetch + Authorization: Bearer token)
API Gateway HTTP API (JWT Authorizer)
    ↓
OpenCode Proxy Lambda (opencode_session_proxy)
    ↓ (Invoke)
OpenCode Session Start Lambda (opencode_session_start)
    ↓ (Run)
ECS Fargate Task (autodoc-opencode)
```

## Key Problems & Solutions

### Problem 1: 401 Unauthorized Errors on API Calls
**Root Cause**: Frontend SDK wasn't sending Authorization header with JWT token

**Solution**: 
- Changed from using unsupported `auth` parameter to custom `fetch` function in `src/api/client.ts`
- Custom fetch intercepts all SDK requests and adds `Authorization: Bearer {token}` header
- Token retrieved from localStorage key: `cognito_id_token`

**File**: `c:\Users\Sineth\opencode-web\src\api\client.ts`
```typescript
const customFetch = async (url: string, options: RequestInit = {}) => {
  const token = localStorage.getItem('cognito_id_token');
  if (token) {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    options.headers = headers;
  }
  return fetch(url, options);
};

return createOpencodeClient({
  baseUrl,
  fetch: customFetch,
});
```

### Problem 2: "No completed clone jobs found" Error
**Root Cause**: Backend required cloneJobId for session creation

**Solution**: Made cloneJobId optional in both Lambdas
- If cloneJobId provided: use it
- If not provided: try to find most recent completed clone job
- If neither: create blank session with empty repoPrefix

**Files Modified**:
1. `C:\Users\Sineth\autodoc-control-plane-cdk\lambdas\opencode_session_proxy\handler.py` (lines 219-255)
   - Removed error when cloneJobId missing
   - Made session payload optional

2. `C:\Users\Sineth\autodoc-control-plane-cdk\lambdas\opencode_session_start\handler.py` (lines 81-130)
   - Removed required cloneJobId validation
   - Use default empty values if no clone job provided

### Problem 3: AccessDeniedException on Lambda Invocation
**Root Cause**: The proxy Lambda's IAM role had no permission to invoke the session start Lambda. The proxy was hardcoding the function name instead of using the ARN.

**Solution**: 
- Pass the session start Lambda ARN via environment variable from CDK
- Update proxy handler to use the ARN instead of hardcoded function name

**Files Modified**:
1. `C:\Users\Sineth\autodoc-control-plane-cdk\stacks\api_stack.py` (line 1733)
   - Added `OPENCODE_SESSION_START_FN_ARN` environment variable to OpenCodeProxyFn
   
2. `C:\Users\Sineth\autodoc-control-plane-cdk\lambdas\opencode_session_proxy\handler.py` (lines 52-53, 255)
   - Read ARN from `OPENCODE_SESSION_START_FN_ARN` environment variable
   - Use ARN when invoking: `lambda_client.invoke(FunctionName=OPENCODE_SESSION_START_FN_ARN, ...)`
   - IAM policy at api_stack.py lines 1752-1759 already grants lambda:InvokeFunction on the ARN

### Problem 4: DynamoDB ValidationException on Session Lookup
**Root Cause**: JOBS_TABLE has composite primary key (tenantId + jobId), but proxy Lambda was querying with only jobId

**Solution**: Updated GetItem call to include both key components

**File Modified**: `C:\Users\Sineth\autodoc-control-plane-cdk\lambdas\opencode_session_proxy\handler.py` (line 333)
```python
# Before:
session_record = jobs_table.get_item(Key={"jobId": session_id}).get("Item")

# After:
session_record = jobs_table.get_item(Key={"tenantId": tenant_id, "jobId": session_id}).get("Item")
```

### Problem 5: ECS InvalidParameterException on describe_tasks
**Root Cause**: Code was using `include=["FULL"]` parameter which doesn't exist in ECS API. Only valid value is "TAGS"

**Solution**: Removed the invalid include parameter entirely

**File Modified**: `C:\Users\Sineth\autodoc-control-plane-cdk\lambdas\opencode_session_proxy\handler.py` (line 76-80)
```python
# Before:
response = ecs_client.describe_tasks(cluster=cluster_name, tasks=[task_arn], include=["FULL"])

# After:
response = ecs_client.describe_tasks(cluster=cluster_name, tasks=[task_arn])
```

### Problem 6: Missing GET Method on Message Endpoint
**Root Cause**: OpenCode SDK tries to GET messages but route only supported POST

**Solution**: Added GET method to the /session/{sessionId}/message route

**File Modified**: `C:\Users\Sineth\autodoc-control-plane-cdk\stacks\api_stack.py` (line 2150-2151)
```python
# Before:
methods=[apigwv2.HttpMethod.POST]

# After:
methods=[apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST]
```

### Problem 7: Session Response Missing time Field
**Root Cause**: Frontend expected `session.time.updated` but session creation response didn't include time metadata

**Solution**: Added time field with created/updated timestamps to session responses

**File Modified**: `C:\Users\Sineth\autodoc-control-plane-cdk\lambdas\opencode_session_start\handler.py` (line 242-259)
```python
"time": {
    "created": created_at,
    "updated": created_at,
},
```

Also updated SessionList component to handle missing time gracefully:
**File Modified**: `c:\Users\Sineth\opencode-web\src\components\SessionList.tsx` (line 184)
```typescript
{session.time?.updated ? formatDate(session.time.updated) : 'just now'}
```

### Problem 8: OpenCode Server Listening on Localhost Instead of External Interface
**Root Cause**: Docker entrypoint script used `--hostname` flag but opencode serve binary wasn't honoring it, defaulting to 127.0.0.1

**Solution**: Added `--mdns` flag to opencode serve command which forces hostname to 0.0.0.0

**File Modified**: `C:\Users\Sineth\opencode\packages\containers\opencode\entrypoint.sh` (line 372-374)
```bash
# Before:
opencode serve \
  --hostname "${OPENCODE_SERVER_HOST:-0.0.0.0}" \
  --port "${PORT:-4096}"

# After:
opencode serve \
  --mdns \
  --port "${PORT:-4096}"
```

**Actions Taken**:
1. Updated entrypoint.sh source file
2. Rebuilt Docker image and pushed to ECR
3. Stopped old task to force new session to use updated image

### Problem 9: Security Group Blocking Port 4096
**Root Cause**: ECS task's security group had NO inbound rules, blocking all traffic including port 4096 from Lambda

**Symptom**: Lambda could get task IP but got "Connection timed out" when trying to reach port 4096

**Solution**: Added inbound rule to task security group allowing traffic from Lambda security group on port 4096

**Security Groups**:
- Task SG: `sg-06cb3e9719726d5d2` (autodoc-control-plane-infra-TasksSecurityGroupD52CD2E7-mslWv5lWDubA)
- Lambda SG: `sg-05628b9ce0f8ba4e3` (autodoc-control-plane-api-LambdaSg30A6108C-fcAzgtAldnfc)

**Fix Applied**:
```bash
aws ec2 authorize-security-group-ingress \
  --group-id sg-06cb3e9719726d5d2 \
  --ip-permissions IpProtocol=tcp,FromPort=4096,ToPort=4096,UserIdGroupPairs='[{GroupId=sg-05628b9ce0f8ba4e3}]' \
  --region ca-central-1 \
  --profile autodoc-prod
```

**Result**: Task security group rule `sgr-092518e2d90e0242a` created, allowing Lambda to reach OpenCode on port 4096

### Problem 10: Lambda Security Group Blocking Outbound to Port 4096
**Root Cause**: Lambda security group only allowed egress on port 443 (HTTPS for AWS API calls), but NOT port 4096 for OpenCode

**Symptom**: Even after adding inbound rule on task SG, Lambda still got "Connection timed out" - security group was blocking outbound traffic

**Investigation**:
- Confirmed Lambda and Task are in SAME VPC: vpc-0167a01da82d6fb72
- Confirmed Lambda and Task are in SAME subnet: subnet-052d4c3ec65318d7e
- Checked Lambda SG egress rules: Only had port 443, missing port 4096

**Solution**: Added egress rule to Lambda security group allowing outbound to port 4096 on task security group

**Security Groups**:
- Lambda SG: `sg-05628b9ce0f8ba4e3` (source - needs egress rule)
- Task SG: `sg-06cb3e9719726d5d2` (destination)

**Fix Applied**:
```bash
aws ec2 authorize-security-group-egress \
  --group-id sg-05628b9ce0f8ba4e3 \
  --ip-permissions IpProtocol=tcp,FromPort=4096,ToPort=4096,UserIdGroupPairs='[{GroupId=sg-06cb3e9719726d5d2}]' \
  --region ca-central-1 \
  --profile autodoc-prod
```

**Result**: Egress rule `sgr-0ee54117520526dab` created, allowing Lambda to make outbound requests to OpenCode on port 4096

## CDK Repository Structure

**Location**: `C:\Users\Sineth\autodoc-control-plane-cdk`

### Key Stacks Used

1. **API Stack** (`stacks/api_stack.py`)
   - HTTP API Gateway with JWT authorizer (Cognito)
   - Lambda functions for all API endpoints
   - Routes for OpenCode session management

2. **OpenCode Proxy Lambda** (`lambdas/opencode_session_proxy/handler.py`)
   - Validates Cognito JWT and extracts userId/tenantId
   - Proxies requests to OpenCode Fargate task
   - Handles: POST /session (create), GET /session (list), POST /session/{id}/message, GET /event/subscribe
   - **Key Change**: Line 219-255 - Made cloneJobId optional for session creation

3. **OpenCode Session Start Lambda** (`lambdas/opencode_session_start/handler.py`)
   - Creates Fargate task for OpenCode session
   - Sets up environment variables and networking
   - Records session in DynamoDB
   - **Key Change**: Line 81-130 - Made cloneJobId optional with default values

4. **Common Utils** (`lambdas/common.py`)
   - Shared helpers: `get_user()`, `audit_log()`, `resp()`
   - JWT claim extraction

### DynamoDB Tables (Data Stack)
- `TENANTS_TABLE`: Tenant configuration
- `USER_TENANTS_TABLE`: User-to-tenant mapping
- `JOBS_TABLE`: All job records (clone, index, opencode_session, etc.)

### Environment Variables Required
Set in OpenCode Session Start Lambda:
- `TENANTS_TABLE`
- `USER_TENANTS_TABLE`
- `JOBS_TABLE`
- `CLUSTER_ARN`
- `TASK_DEF_ARN_SSM_PARAM`
- `SUBNETS`
- `SECURITY_GROUP_ID`
- `OPENCODE_CONTAINER_NAME`
- `BEDROCK_MODEL_ID`
- `BUILD_ID`

## Current Status (Updated 2026-05-08 Session 3)

🔧 **IN PROGRESS - Message Display Issues**:
- ✅ Lambda-to-ECS connectivity FIXED (single subnet pinning resolved cross-subnet routing issue)
- ✅ Message POST requests return 200 OK (verified in network tab)
- ✅ OpenCode server IS listening on 0.0.0.0:4096 and accepting messages
- ✅ Security group rules properly configured and tested
- ❌ **BLOCKING**: Messages don't display in UI even though POST succeeds
  - User sends message → Lambda returns 200 OK → But no message appears in chat
  - Cause: Message store/display issue, not networking
  - MessageInput.tsx sends message but response not properly added to store
  - MessageItem component may not be rendering messages correctly
  - Possibly missing `/event` endpoint for SSE streaming (currently returns 404)

✅ **COMPLETE - Full Integration Working** (from previous session):
- ✅ Frontend authentication: Custom fetch function correctly sends JWT tokens
- ✅ Backend accepts optional cloneJobId for session creation
- ✅ **POST /session**: Creates sessions successfully (returns sessionId, taskArn, password)
- ✅ **GET /session**: Lists all sessions with proper structure (id, title, time, status, repoName)
- ✅ **GET/POST /session/{sessionId}/message**: Message endpoints fully functional
- ✅ App displays all created sessions in session list with proper time formatting
- ✅ Lambda functions deployed to prod account (675344693717)
- ✅ Fixed IAM permission: Proxy Lambda can now invoke session start Lambda
- ✅ Fixed SDK response format: Double destructuring for data wrapping
- ✅ Added time metadata to all session responses (created/updated timestamps)
- ✅ DynamoDB queries now use correct composite key (tenantId + jobId)
- ✅ ECS API calls use valid parameters
- ✅ ECS Fargate tasks launching successfully with RUNNING status
- ✅ OpenCode server listening and responding on port 4096
- ✅ Docker image rebuilt and pushed to ECR
- ✅ All infrastructure stacks deployed (Auth, Data, ECR, Infra, Workloads, Monitoring, Security, API)
- ✅ Lambda and Task in same VPC and subnet (vpc-0167a01da82d6fb72)
- ✅ Task security group allows inbound from Lambda on port 4096
- ✅ Lambda security group allows outbound to Task on port 4096
- ✅ Full end-to-end flow: Create session → Send message → Receive response

**All 11 problems identified and solved**:
1. ✅ JWT authentication header missing
2. ✅ Missing cloneJobId handling
3. ✅ Lambda invocation permissions
4. ✅ DynamoDB composite key
5. ✅ ECS API invalid parameter
6. ✅ Missing GET method on message endpoint
7. ✅ Missing time field in responses
8. ✅ OpenCode listening on localhost only
9. ✅ Task security group had no inbound rules
10. ✅ Lambda security group had no egress rule
11. ✅ Lambda dual-subnet ENI selection causing cross-subnet connectivity issues

**Last Updated**: 2026-05-08 16:29 UTC - ALL ISSUES RESOLVED (Session 3)

⏳ **Optional Enhancements** (Not blocking functionality):
- `/config/providers` endpoint - SDK tries to fetch but returns 404 (optional)
- `/agent` endpoint - SDK tries to fetch but returns 404 (optional)

## Deployment Instructions

### Prerequisites
1. AWS credentials configured with `autodoc-prod` profile (account 675344693717)
2. CDK CLI installed
3. Node.js v25.0.0+
4. Docker installed and running (for building OpenCode container image)

### Infrastructure Deployment (Initial Setup)

First-time deployment requires all stacks in order:

```powershell
cd C:\Users\Sineth\autodoc-control-plane-cdk

# Deploy foundational stacks (in this order)
cdk deploy autodoc-control-plane-auth --profile autodoc-prod
cdk deploy autodoc-control-plane-data --profile autodoc-prod
cdk deploy autodoc-control-plane-ecr --profile autodoc-prod

# Deploy infrastructure (creates VPC, ECS cluster, writes SSM params)
cdk deploy autodoc-control-plane-infra --profile autodoc-prod

# Deploy workloads
cdk deploy autodoc-control-plane-workloads --profile autodoc-prod
cdk deploy autodoc-control-plane-indexer-workloads --profile autodoc-prod
cdk deploy autodoc-control-plane-opencode-workloads --profile autodoc-prod

# Deploy monitoring and security
cdk deploy autodoc-control-plane-monitoring --profile autodoc-prod
cdk deploy autodoc-control-plane-security --profile autodoc-prod

# Deploy API (depends on opencode-workloads)
cdk deploy autodoc-control-plane-api --profile autodoc-prod
```

**Total Time**: 15-20 minutes

### OpenCode Container Image Rebuild

When updating the OpenCode Docker image (e.g., entrypoint.sh changes):

```powershell
# 1. Update source in C:\Users\Sineth\opencode\packages\containers\opencode\

# 2. Build and push image
cd C:\Users\Sineth\opencode
aws ecr get-login-password --region ca-central-1 --profile autodoc-prod | docker login --username AWS --password-stdin 675344693717.dkr.ecr.ca-central-1.amazonaws.com

docker build -f packages/containers/opencode/Dockerfile -t 675344693717.dkr.ecr.ca-central-1.amazonaws.com/autodoc-opencode:latest .

docker push 675344693717.dkr.ecr.ca-central-1.amazonaws.com/autodoc-opencode:latest

# 3. Stop running tasks to force ECS to pull new image
aws ecs list-tasks --cluster autodoc-cluster --region ca-central-1 --profile autodoc-prod --desired-status RUNNING --query 'taskArns[]' --output text | xargs -I {} aws ecs stop-task --cluster autodoc-cluster --task {} --region ca-central-1 --profile autodoc-prod --reason "Pulling updated OpenCode image"
```

### Lambda Code Deployment

For changes to Lambda handlers (e.g., proxy or session-start):

```bash
cd C:\Users\Sineth\autodoc-control-plane-cdk

# Redeploy only the API stack
cdk deploy autodoc-control-plane-api --profile autodoc-prod
```

**Time**: 2-3 minutes

### Deployment Notes
- Infrastructure stacks only need to be deployed once
- Container image changes require rebuild and old tasks to be stopped
- Lambda code changes only require redeploying the API stack
- If CDK deploy fails with permissions error, ensure `--profile autodoc-prod` is set
- Always use the correct AWS profile (675344693717) - not the default account

## Testing the Integration

### Browser Console Test
```javascript
// 1. Verify token exists
const token = localStorage.getItem('cognito_id_token');
console.log('Token exists:', !!token);

// 2. Create a session (POST request)
fetch('https://4aukdm2t58.execute-api.ca-central-1.amazonaws.com/session', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({})
})
.then(r => r.json())
.then(d => {
  console.log('Status:', d);
  if (d.sessionId) {
    console.log('✅ Session created:', d.sessionId);
  }
});
```

### Check CloudWatch Logs
```bash
# OpenCode Proxy Lambda logs
aws logs tail /aws/lambda/autodoc-control-plane-api-OpenCodeProxyFnB42F3C4E-Q3yAmAufzQDa \
  --region ca-central-1 \
  --follow

# OpenCode Session Start Lambda logs  
aws logs tail /aws/lambda/autodoc-control-plane-api-OpencodeSessionStartFn0C-kdfmaS8s3bzQ \
  --region ca-central-1 \
  --follow
```

## Files Modified in This Session

### Frontend
1. **Authentication** (`c:\Users\Sineth\opencode-web\src\api\client.ts`)
   - Custom fetch function intercepts all SDK requests to add JWT Authorization header
   
2. **Session List Display** (`c:\Users\Sineth\opencode-web\src\components\SessionList.tsx`)
   - Added defensive check for missing time field: `session.time?.updated ? formatDate(...) : 'just now'`
   - Added "+ New Session" button for creating sessions

### Backend - Infrastructure
1. **API Stack** (`C:\Users\Sineth\autodoc-control-plane-cdk\stacks\api_stack.py`)
   - Added GET method to /session/{sessionId}/message endpoint (line 2150-2151)
   - Added OPENCODE_SESSION_START_FN_ARN environment variable to proxy Lambda

### Backend - Lambda Functions
1. **OpenCode Proxy** (`C:\Users\Sineth\autodoc-control-plane-cdk\lambdas\opencode_session_proxy\handler.py`)
   - Fixed DynamoDB GetItem with composite key (tenantId + jobId) - line 333
   - Fixed ECS describe_tasks to not use invalid include parameter - line 76-80
   - Made cloneJobId optional for session creation (lines 219-255)
   - Added debug logging for task IP discovery

2. **OpenCode Session Start** (`C:\Users\Sineth\autodoc-control-plane-cdk\lambdas\opencode_session_start\handler.py`)
   - Made cloneJobId optional (lines 81-130)
   - Added time metadata to session responses (created_at, updated_at)
   - Added id and title fields to response for SDK compatibility

### Docker Container
1. **Entrypoint Script** (`C:\Users\Sineth\opencode\packages\containers\opencode\entrypoint.sh`)
   - Changed opencode serve command to use `--mdns` flag for binding to 0.0.0.0
   - Docker image rebuilt and pushed to ECR

## Testing Checklist

✅ **Completed Tests**:
- Infrastructure deployment successful
- ECS cluster operational
- Task creation working (status RUNNING)
- OpenCode server responsive on port 4096
- Sessions stored in DynamoDB
- API Gateway routing requests to Lambda

**To Test**:
1. Open chatbot and configure API endpoint in Settings
2. Create a new session (click "+ New Session")
3. Verify session appears in session list
4. Send a message to the session
5. Verify response from OpenCode backend

## Next Steps

1. **Verify OpenCode Server**: New sessions will use updated Docker image with --mdns flag
2. **Test Message Flow**: Create session → send message → receive response
3. **Check CloudWatch Logs**: Monitor for any errors in Lambda execution
4. **Monitor ECS Tasks**: Verify new tasks start successfully and stay RUNNING

## Session 2 Findings & New Issues

### Issue 1: SDK GET/HEAD Request with Body Bug
**Problem**: OpenCode SDK tries to make GET request with JSON body, causing "Failed to construct 'Request': Request with GET/HEAD method cannot have body"

**Root Cause**: OpenCode SDK has a bug where it attempts GET on endpoints that should be POST

**Workaround Applied**: Created custom fetch in MessageInput.tsx that bypasses SDK and sends direct POST request to `/session/{sessionId}/message`
- File: `src/components/MessageInput.tsx` (lines 150-165)
- Uses direct fetch instead of `props.api.session.message()`
- Gets JWT token from localStorage and adds Authorization header

**Files Modified**:
- `src/components/MessageInput.tsx` - Direct fetch implementation for message sending

### Issue 2: CDK Redeployment Creates New Security Groups
**Problem**: When CDK stack is redeployed, it creates NEW security groups, but old security group rules remain in place pointing to old groups

**What Happened**:
1. Initial deployment created Lambda SG: sg-05628b9ce0f8ba4e3
2. Redeployment created new Lambda SG: sg-0e37099458850a4f7  
3. Task SG inbound rule still referenced old Lambda SG
4. Lambda function still used old SG in VPC config

**Fix Applied**:
```bash
# 1. Remove old inbound rule from Task SG
aws ec2 revoke-security-group-ingress \
  --group-id sg-06cb3e9719726d5d2 \
  --ip-permissions IpProtocol=tcp,FromPort=4096,ToPort=4096,UserIdGroupPairs='[{GroupId=sg-05628b9ce0f8ba4e3}]' \
  --region ca-central-1 --profile autodoc-prod

# 2. Add new inbound rule to Task SG
aws ec2 authorize-security-group-ingress \
  --group-id sg-06cb3e9719726d5d2 \
  --ip-permissions IpProtocol=tcp,FromPort=4096,ToPort=4096,UserIdGroupPairs='[{GroupId=sg-0e37099458850a4f7}]' \
  --region ca-central-1 --profile autodoc-prod

# 3. Add egress rule to new Lambda SG
aws ec2 authorize-security-group-egress \
  --group-id sg-0e37099458850a4f7 \
  --ip-permissions IpProtocol=tcp,FromPort=4096,ToPort=4096,UserIdGroupPairs='[{GroupId=sg-06cb3e9719726d5d2}]' \
  --region ca-central-1 --profile autodoc-prod

# 4. Update Lambda VPC config to use new SG
aws lambda update-function-configuration \
  --function-name autodoc-control-plane-api-OpenCodeProxyFnB42F3C4E-Q3yAmAufzQDa \
  --region ca-central-1 --profile autodoc-prod \
  --vpc-config SubnetIds=subnet-0816ef618e3e33d58,subnet-052d4c3ec65318d7e,SecurityGroupIds=sg-0e37099458850a4f7
```

### Issue 3: CORS Not Applied After Redeployment
**Problem**: After redeployment, API Gateway responses didn't include CORS headers

**Root Cause**: CORS is configured in CDK but wasn't re-applied to live API after code changes

**Fix**: Redeployed API stack: `cdk deploy autodoc-control-plane-api --require-approval never --profile autodoc-prod`

### Problem 11: Lambda Dual-Subnet ENI Selection Causing Cross-Subnet Connectivity
**Status**: ✅ **RESOLVED** (Session 3 - 2026-05-08)

**Root Cause**: Lambda was configured with two subnets for redundancy:
- subnet-0816ef618e3e33d58 (10.0.3.0/24)
- subnet-052d4c3ec65318d7e (10.0.2.0/24)

When Lambda created ENIs, AWS allocated them in both subnets. However, the ECS task was always in 10.0.2.0/24. If Lambda happened to use the 10.0.3.x ENI for outbound connections, traffic would need to cross subnets. While local VPC routes existed (10.0.0.0/16), security group rules applied per-ENI and cross-subnet traffic from the wrong subnet could be blocked.

**Symptoms**:
- HTTP 502 "Bad gateway: <urlopen error [Errno 110] Connection timed out>"
- Lambda times out trying to reach task on port 4096

**What We Verified**:
- ✅ OpenCode IS listening on 0.0.0.0:4096
- ✅ Task is RUNNING at 10.0.2.181
- ✅ Task SG allows inbound port 4096 from Lambda SG
- ✅ Lambda SG allows egress port 4096 to Task SG
- ✅ Network ACLs allow all traffic (default VPC)
- ✅ Route tables properly configured with local 10.0.0.0/16 routes
- ✅ Lambda ENIs were in-use in BOTH subnets (eni-0b2375e4d9b7714f9 in 10.0.2.x and eni-00296565ecfcc81a7 in 10.0.3.x)

**Solution**: Pin Lambda to single subnet matching task location:
```bash
aws lambda update-function-configuration \
  --function-name autodoc-control-plane-api-OpenCodeProxyFnB42F3C4E-Q3yAmAufzQDa \
  --region ca-central-1 \
  --profile autodoc-prod \
  --vpc-config SubnetIds=subnet-052d4c3ec65318d7e,SecurityGroupIds=sg-0e37099458850a4f7
```

**Result**:
- Lambda now configured for subnet-052d4c3ec65318d7e only
- Old ENIs in 10.0.3.x released automatically (~10 min)
- Next Lambda invocation creates new ENI in 10.0.2.0/24
- Same-subnet communication guaranteed with no cross-subnet routing variables
- **✅ Connectivity restored - message requests now return 200 OK**

**Testing**: Sent message to existing session → Got 200 OK response with data

## Session 3 Findings & Ongoing Issues (2026-05-08)

### Issue 5: Messages Don't Display in UI Despite 200 OK Response
**Status**: 🔴 Still Investigating

**Symptoms**:
- User sends message via POST /session/{id}/message
- Lambda returns 200 OK
- But message doesn't appear in chat view
- No response from backend is displayed

**What We've Verified**:
- ✅ Network request succeeds (200 OK in browser dev tools)
- ✅ MessageInput component sends request
- ✅ OpenCode task receives and processes message
- ✅ Lambda returns response successfully

**Root Cause (Suspected)**:
1. MessageInput.tsx calls `updateMessage()` to add message to store, but message format may be incorrect
2. Message store format: `{ info: Message, parts: Part[] }` - may not be matching what's needed
3. ChatView/MessageItem components not re-rendering when messages are added
4. Or the `/event` endpoint is required for messages to be shown (currently returns 404)

**Fixes Attempted**:
- Updated MessageInput to call `updateMessage()` with proper structure
- Added `updatePart()` calls to add text content separately
- Added imports for store functions

**Still Failing** - Need to investigate:
1. Check browser console for JavaScript errors
2. Verify message store is actually being updated
3. Check MessageItem component rendering
4. May need to implement `/event` endpoint for real-time message streaming

**Next Steps**:
- Debug message store updates (console.log in updateMessage function)
- Test if messages appear when fetching via GET /session/{id}/messages
- May need to implement streaming event endpoint for proper message display

## Troubleshooting

### "Could not reach session task" Error

**Diagnosis Steps**:
1. Check if task is running: `aws ecs list-tasks --cluster autodoc-cluster --region ca-central-1 --profile autodoc-prod --desired-status RUNNING`
2. Get task's private IP: `aws ecs describe-tasks --cluster autodoc-cluster --tasks <TASK_ID> --region ca-central-1 --profile autodoc-prod --query 'tasks[0].attachments[0].details[?name==\`privateIPv4Address\`].value'`
3. Test if OpenCode is listening inside container: Connect via ECS Exec and run `curl -v http://localhost:4096/doc`
4. Test if OpenCode is listening on the actual IP: Inside container, run `curl -v http://<CONTAINER_IP>:4096/doc`
5. Check security groups: Verify task SG allows inbound on port 4096 from Lambda SG

**Common Issues**:
- Task SG has no inbound rules → Add rule allowing Lambda SG on port 4096
- OpenCode listening on localhost only → Check entrypoint uses `--mdns` or `--hostname 0.0.0.0`
- Wrong image deployed → Check image digest matches latest in ECR
- Task not RUNNING → Check task logs for startup errors

### OpenCode Server Not Responding

**Check Inside Container**:
```bash
# Connect to running task
aws ssm start-session --target "ecs:CLUSTER_NAME_TASK_ID_RUNTIME_ID" \
  --region ca-central-1 --profile autodoc-prod \
  --document-name AWS-StartInteractiveCommand \
  --parameters '{"command":["curl -v http://localhost:4096/doc"]}'
```

**Verify Listening on Correct Interface**:
```bash
# Test localhost
curl http://localhost:4096/doc

# Test on actual container IP
curl http://<CONTAINER_IP>:4096/doc

# Check what port is listening (may need netstat or ss)
ss -tlnp | grep 4096
```

### Lambda to Task Connectivity

**VPC/Subnet Check**:
```bash
# Verify Lambda and Task are in same VPC
aws lambda get-function --function-name <LAMBDA_NAME> \
  --region ca-central-1 --profile autodoc-prod \
  --query 'Configuration.VpcConfig' --output json

# Check Task's VPC
aws ecs describe-tasks --cluster autodoc-cluster --tasks <TASK_ID> \
  --region ca-central-1 --profile autodoc-prod \
  --query 'tasks[0].attachments[0].details' --output json
# Then check subnet VPC:
aws ec2 describe-subnets --subnet-ids <SUBNET_ID> \
  --region ca-central-1 --profile autodoc-prod --query 'Subnets[0].[VpcId]'
```

**Security Group - Inbound (Task Side)**:
```bash
# 1. Find task security group
aws ecs describe-tasks --cluster autodoc-cluster --tasks <TASK_ID> \
  --region ca-central-1 --profile autodoc-prod \
  --query 'tasks[0].attachments[0].details' --output json

# Get ENI ID, then:
aws ec2 describe-network-interfaces --network-interface-ids <ENI_ID> \
  --region ca-central-1 --profile autodoc-prod --query 'NetworkInterfaces[0].Groups'

# 2. Check task SG has inbound rule for port 4096
aws ec2 describe-security-groups --group-ids <TASK_SG_ID> \
  --region ca-central-1 --profile autodoc-prod --query 'SecurityGroups[0].IpPermissions'

# 3. If missing, add rule from Lambda SG
aws ec2 authorize-security-group-ingress \
  --group-id <TASK_SG_ID> \
  --ip-permissions IpProtocol=tcp,FromPort=4096,ToPort=4096,UserIdGroupPairs='[{GroupId=<LAMBDA_SG_ID>}]' \
  --region ca-central-1 --profile autodoc-prod
```

**Security Group - Egress (Lambda Side)**:
```bash
# Find Lambda SG
aws lambda list-functions --region ca-central-1 --profile autodoc-prod \
  --query 'Functions[?contains(FunctionName, `OpenCodeProxy`)].VpcConfig.SecurityGroupIds' --output text

# Check Lambda SG egress rules
aws ec2 describe-security-groups --group-ids <LAMBDA_SG_ID> \
  --region ca-central-1 --profile autodoc-prod --query 'SecurityGroups[0].IpPermissionsEgress'

# If port 4096 is missing, add egress rule
aws ec2 authorize-security-group-egress \
  --group-id <LAMBDA_SG_ID> \
  --ip-permissions IpProtocol=tcp,FromPort=4096,ToPort=4096,UserIdGroupPairs='[{GroupId=<TASK_SG_ID>}]' \
  --region ca-central-1 --profile autodoc-prod
```

**CRITICAL**: Both inbound (on task) AND egress (on Lambda) rules are required for bidirectional communication!

## Useful Commands

```bash
# Check current AWS account
aws sts get-caller-identity

# List Lambda functions
aws lambda list-functions --region ca-central-1

# View specific Lambda logs
aws logs filter-log-events \
  --log-group-name '/aws/lambda/autodoc-control-plane-api-OpenCodeProxyFnB42F3C4E-Q3yAmAufzQDa' \
  --region ca-central-1 \
  --start-time $(($(date +%s) * 1000 - 600000))

# Check ECS cluster for running tasks
aws ecs list-tasks \
  --cluster autodoc-cluster \
  --region ca-central-1

# View DynamoDB session record
aws dynamodb get-item \
  --table-name autodoc-jobs \
  --key '{"tenantId":{"S":"<tenantId>"},"jobId":{"S":"session_<id>"}}' \
  --region ca-central-1
```

## References

### Repositories
- **CDK Repository**: `C:\Users\Sineth\autodoc-control-plane-cdk`
  - Contains: Lambda functions, API Gateway, ECS task definitions, infrastructure stacks
  - Key file: `stacks/api_stack.py` (API Gateway routes and Lambda configuration)
  
- **OpenCode Source**: `C:\Users\Sineth\opencode\packages\containers\opencode`
  - Contains: Dockerfile, entrypoint.sh, workspace scripts
  - Build target: ECR repository `autodoc-opencode`
  
- **Frontend Repository**: `c:\Users\Sineth\opencode-web`
  - Contains: React/SolidJS chatbot UI
  - Key file: `src/api/client.ts` (SDK client with custom fetch)

### AWS Configuration
- **Production Account**: 675344693717 (autodoc-prod)
- **Region**: ca-central-1
- **API Endpoint**: https://4aukdm2t58.execute-api.ca-central-1.amazonaws.com
- **ECS Cluster**: autodoc-cluster
- **ECR Repository**: autodoc-opencode

### Architecture Documentation
- **CLAUDE.md**: Architectural rules and deployment guide in CDK repo root
- **README.md** files: Located in each package for context
