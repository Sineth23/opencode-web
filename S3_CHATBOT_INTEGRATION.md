# S3 Chatbot Integration - Complete Guide

## Overview

You now have a complete system to browse and analyze tenant S3 bucket contents in your chatbot:

```
Browser Login (Cognito)
    ↓ (JWT token)
Frontend (S3Browser component)
    ↓ GET /s3/list (with Bearer token)
Lambda: s3_list_objects
    ↓ (extract tenantId from JWT)
    ↓ (lookup tenant bucket + role)
    ↓ (STS AssumeRole for temp credentials)
Tenant S3 Bucket
    ↓ (file list)
    ↓ GET /s3/read (with Bearer token)
Lambda: s3_read_object
    ↓ (same tenant validation)
    ↓ (read file content)
Frontend (display content)
    ↓ (include in chatbot message)
Chatbot (analyze contents)
```

## Components

### 1. Backend (CDK)

**Files Created**:
- `lambdas/s3_list_objects/handler.py` - List S3 objects
- `lambdas/s3_read_object/handler.py` - Read S3 object content

**API Routes** (add to `stacks/api_stack.py`):
- `GET /s3/list?prefix=...&maxKeys=...` - List files
- `GET /s3/read?key=...` - Read file content

**Architecture**:
- Extract `custom:tenantId` from JWT token
- Lookup tenant in DynamoDB (TENANTS_TABLE)
- Get tenant's S3 bucket name and IAM role ARN
- Use STS AssumeRole to get temporary credentials
- Access S3 with tenant's permissions
- Return results to frontend

### 2. Frontend (Solid.js)

**Component**: `src/components/S3Browser.tsx`

**Features**:
- Browse folder structure
- Click to navigate into folders
- Select file to read
- Display file content
- Call backend APIs with Bearer token

**Integration**:
```typescript
import S3Browser from "./components/S3Browser";

<S3Browser 
  onSelectFile={(file, content) => {
    // File selected: file.key, file.size, content
    // Include in chatbot message
  }}
/>
```

## Deployment Steps

### Step 1: Update CDK Stack

Edit `stacks/api_stack.py`:

1. **Add Lambda function definitions** (after other Lambda definitions, ~line 600):
```python
s3_list_objects_fn = _lambda.Function(
    self,
    "S3ListObjectsFn",
    runtime=_lambda.Runtime.PYTHON_3_12,
    handler="s3_list_objects.handler.main",
    code=lambdas_asset,
    timeout=Duration.seconds(15),
    log_retention=logs.RetentionDays.ONE_YEAR,
    environment={
        "TENANTS_TABLE": data.tenants_table.table_name,
        "USER_TENANTS_TABLE": data.user_tenants_table.table_name,
        "BUILD_ID": build_id,
    },
    **_lambda_vpc_config,
)
s3_list_objects_fn.add_to_role_policy(
    iam.PolicyStatement(
        actions=["sts:AssumeRole"],
        resources=["arn:aws:iam::*:role/tenant-*"],
        effect=iam.Effect.ALLOW,
    )
)
data.tenants_table.grant_read_data(s3_list_objects_fn)
data.user_tenants_table.grant_read_data(s3_list_objects_fn)

s3_read_object_fn = _lambda.Function(
    self,
    "S3ReadObjectFn",
    runtime=_lambda.Runtime.PYTHON_3_12,
    handler="s3_read_object.handler.main",
    code=lambdas_asset,
    timeout=Duration.seconds(15),
    log_retention=logs.RetentionDays.ONE_YEAR,
    environment={
        "TENANTS_TABLE": data.tenants_table.table_name,
        "USER_TENANTS_TABLE": data.user_tenants_table.table_name,
        "BUILD_ID": build_id,
    },
    **_lambda_vpc_config,
)
s3_read_object_fn.add_to_role_policy(
    iam.PolicyStatement(
        actions=["sts:AssumeRole"],
        resources=["arn:aws:iam::*:role/tenant-*"],
        effect=iam.Effect.ALLOW,
    )
)
data.tenants_table.grant_read_data(s3_read_object_fn)
data.user_tenants_table.grant_read_data(s3_read_object_fn)
```

2. **Add API routes** (in routes section, ~line 1900):
```python
http_api.add_routes(
    path="/s3/list",
    methods=[apigwv2.HttpMethod.GET],
    integration=apigwv2_integrations.HttpLambdaIntegration(
        "S3ListObjectsIntegration",
        handler=s3_list_objects_fn,
    ),
    authorizer=authorizer,
)

http_api.add_routes(
    path="/s3/read",
    methods=[apigwv2.HttpMethod.GET],
    integration=apigwv2_integrations.HttpLambdaIntegration(
        "S3ReadObjectIntegration",
        handler=s3_read_object_fn,
    ),
    authorizer=authorizer,
)
```

3. **Deploy**:
```bash
cd autodoc-control-plane-cdk
cdk deploy --require-approval never
```

### Step 2: Frontend Integration

The S3Browser component is already in your frontend and ready to use.

Add to your ChatView or wherever you want S3 browsing:

```typescript
import S3Browser from "./components/S3Browser";

// In your component:
<S3Browser 
  onSelectFile={(file, content) => {
    console.log("Selected file:", file.key);
    console.log("Content preview:", content.substring(0, 100));
    // Include in chatbot message or state
  }}
/>
```

## Usage Flow

1. **User logs in** with Cognito
2. **Opens chatbot** → sees S3Browser component
3. **Browses S3 bucket**:
   - Initial prefix: `projects/default/`
   - Click folder to navigate
   - See file size for each file
4. **Selects file** → component reads content
5. **Includes in message** → sends to chatbot with file content
6. **Chatbot analyzes** → uses file content in context

## API Examples

### List Files
```bash
curl -H "Authorization: Bearer {idToken}" \
  "https://api.yourdomain.com/s3/list?prefix=projects/default/&maxKeys=50"
```

**Response**:
```json
{
  "ok": true,
  "bucket": "tenant-001",
  "prefix": "projects/default/",
  "items": [
    {
      "key": "projects/default/readme.md",
      "size": 2048,
      "lastModified": "2026-05-06T10:00:00+00:00",
      "isDirectory": false
    },
    {
      "key": "projects/default/data/",
      "size": 0,
      "lastModified": "2026-05-06T10:00:00+00:00",
      "isDirectory": true
    }
  ],
  "itemCount": 2
}
```

### Read File
```bash
curl -H "Authorization: Bearer {idToken}" \
  "https://api.yourdomain.com/s3/read?key=projects/default/readme.md"
```

**Response**:
```json
{
  "ok": true,
  "bucket": "tenant-001",
  "key": "projects/default/readme.md",
  "size": 2048,
  "contentType": "text/markdown",
  "content": "# Project README\n\n..."
}
```

## Security

✅ **Tenant Isolation**:
- JWT token decoded to extract `custom:tenantId`
- User validated in USER_TENANTS_TABLE
- Tenant validated in TENANTS_TABLE
- Only tenant's own bucket accessible

✅ **STS AssumeRole**:
- Temporary credentials (15 minutes)
- Role ARN validated
- Session name includes user ID (audit trail)

✅ **File Size Limits**:
- Max 5MB per file read
- Max 1000 items per list
- Prevents accidental large transfers

✅ **API Security**:
- JWT authorization on all routes
- Query validation (prefix, key)
- HTTPS only in production

## Troubleshooting

### Lambda deployment errors
```
Error: Cannot find module 's3_list_objects.handler'
```
**Fix**: Ensure files exist in `lambdas/s3_list_objects/` with proper Python imports

### S3 access denied
```
"User is not authorized to perform: sts:AssumeRole"
```
**Fix**: 
1. Check Lambda execution role has STS permission
2. Verify tenant role ARN is correct in TENANTS_TABLE
3. Verify tenant role has S3 access policy

### Tenant not found
```
"User has no tenant"
```
**Fix**: Check USER_TENANTS_TABLE has entry for logged-in user

### File not found
```
"Object not found"
```
**Fix**: Verify S3 key exists in tenant's bucket

## Next Steps

1. ✅ **Lambda functions created** - Ready to add to CDK
2. ✅ **Frontend component ready** - S3Browser.tsx
3. 📋 **Add to CDK stack** - Update stacks/api_stack.py
4. 📋 **Deploy CDK** - `cdk deploy`
5. 📋 **Test API** - Use curl or api-tester.html
6. 📋 **Integrate with ChatView** - Add S3Browser component
7. 📋 **Include files in messages** - Pass content to chatbot

## File Structure

```
opencode-web/
├── src/
│   ├── components/
│   │   ├── S3Browser.tsx          ✅ (file browser)
│   │   ├── ChatView.tsx           (add S3Browser here)
│   │   └── ...
│   ├── utils/
│   │   ├── cognito.ts            ✅ (JWT extraction)
│   │   └── ...
│   └── ...

autodoc-control-plane-cdk/
├── lambdas/
│   ├── s3_list_objects/          ✅ (created)
│   │   ├── handler.py
│   │   └── __init__.py
│   ├── s3_read_object/           ✅ (created)
│   │   ├── handler.py
│   │   └── __init__.py
│   └── ...
├── stacks/
│   └── api_stack.py              📋 (add routes)
└── ...
```

## Summary

You now have:
- ✅ Cognito authentication with tenant isolation
- ✅ S3 Lambda functions for listing and reading files
- ✅ Frontend S3Browser component
- ✅ JWT-protected API routes
- ✅ STS AssumeRole for tenant isolation

**Ready to deploy!** Follow the deployment steps above to activate S3 browsing in your chatbot.

---

**Generated**: 2026-05-06
**Backend**: CDK (Lambda + API Gateway)
**Frontend**: Solid.js (S3Browser component)
**Security**: Tenant isolation via JWT + STS AssumeRole
