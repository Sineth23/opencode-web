# S3 Chatbot Integration - Setup Complete ✅

## What Was Created

### Backend (CDK - Lambda Functions)
```
✅ lambdas/s3_list_objects/handler.py      - List tenant S3 bucket files
✅ lambdas/s3_list_objects/__init__.py
✅ lambdas/s3_read_object/handler.py       - Read file content from S3
✅ lambdas/s3_read_object/__init__.py
✅ S3_LAMBDA_INTEGRATION.md                - Detailed integration guide
```

### Frontend (Solid.js Component)
```
✅ src/components/S3Browser.tsx            - File browser UI
✅ S3_CHATBOT_INTEGRATION.md               - Complete integration guide
```

## How It Works

```
1. User logs in (Cognito JWT)
    ↓
2. Frontend shows S3Browser component
    ↓
3. User browses tenant S3 bucket
    ↓
4. S3Browser calls:
    - /s3/list?prefix=...        → Lambda lists files
    - /s3/read?key=...           → Lambda reads file
    ↓
5. Lambda verifies tenant from JWT
    ↓
6. Lambda assumes tenant IAM role (STS AssumeRole)
    ↓
7. Lambda accesses tenant's S3 bucket
    ↓
8. User selects file → content displayed
    ↓
9. Include in chatbot message → analyze
```

## Deployment Checklist

### Step 1: Update CDK Stack ⏳
File: `stacks/api_stack.py`

1. Add Lambda function definitions (around line 600)
2. Add STS AssumeRole permissions
3. Grant DynamoDB access
4. Add API routes for `/s3/list` and `/s3/read`

See: `autodoc-control-plane-cdk/S3_LAMBDA_INTEGRATION.md`

### Step 2: Deploy CDK ⏳
```bash
cd autodoc-control-plane-cdk
cdk deploy --require-approval never
```

### Step 3: Test Endpoints ⏳
```bash
# List files
curl -H "Authorization: Bearer {idToken}" \
  "https://api.yourdomain.com/s3/list?prefix=projects/default/"

# Read file
curl -H "Authorization: Bearer {idToken}" \
  "https://api.yourdomain.com/s3/read?key=projects/default/data.json"
```

### Step 4: Integrate in Frontend ⏳
Add S3Browser to your ChatView or wherever you want it:

```typescript
import S3Browser from "./components/S3Browser";

<S3Browser 
  onSelectFile={(file, content) => {
    console.log("File selected:", file.key);
    console.log("Size:", file.size);
    console.log("Content:", content);
    // Include in message context
  }}
/>
```

## Architecture

### Security (Tenant Isolation)
- ✅ JWT token validation
- ✅ Tenant extracted from `custom:tenantId` claim
- ✅ Tenant lookup in DynamoDB
- ✅ STS AssumeRole for temporary credentials
- ✅ S3 access scoped to tenant's bucket

### Lambda Flow
```
GET /s3/list?prefix=...
  ↓
Extract JWT → validate → get tenantId
  ↓
Lookup TENANTS_TABLE → get bucket + role ARN
  ↓
STS AssumeRole → get temp credentials
  ↓
List S3 objects with temp credentials
  ↓
Return to frontend
```

### Frontend Flow
```
S3Browser component
  ↓
User enters prefix (e.g., "projects/default/")
  ↓
Calls /s3/list with JWT in Authorization header
  ↓
Displays file list
  ↓
User clicks file
  ↓
Calls /s3/read with JWT
  ↓
Displays file content
  ↓
onSelectFile callback with content
```

## Files Ready to Use

### Already Created ✅
- `src/components/S3Browser.tsx` - Just import and use!
- `lambdas/s3_list_objects/handler.py` - Ready for CDK
- `lambdas/s3_read_object/handler.py` - Ready for CDK

### Needs Configuration ⏳
- `stacks/api_stack.py` - Add Lambda definitions and routes
- Your ChatView or MessageInput - Import S3Browser

## Quick Example

```typescript
import S3Browser from "./components/S3Browser";
import { createSignal, Show } from "solid-js";

export default function MyComponent() {
  const [selectedContent, setSelectedContent] = createSignal("");

  return (
    <div class="space-y-4">
      <S3Browser 
        onSelectFile={(file, content) => {
          setSelectedContent(content || "");
        }}
      />
      
      <Show when={selectedContent()}>
        <div class="alert alert-info">
          <p>File selected! Include in message:</p>
          <pre class="text-sm">{selectedContent()}</pre>
        </div>
      </Show>
    </div>
  );
}
```

## Testing Locally

1. Make sure you're logged in (Cognito)
2. Check `.env.local` has API endpoint configured
3. S3Browser will call your API endpoints with Bearer token
4. Check browser DevTools → Network to see API calls

## Production Checklist

- [ ] Lambda functions added to CDK
- [ ] API routes added to api_stack.py
- [ ] CDK deployed
- [ ] API endpoints accessible
- [ ] S3Browser component integrated in ChatView
- [ ] File content included in chatbot messages
- [ ] CloudWatch logs monitored for errors
- [ ] IAM permissions verified (Lambda → STS → S3)

## Troubleshooting

**S3Browser shows error "Not configured"**
- Check `VITE_API_DEFAULT` in `.env.local`
- Make sure it includes protocol (https://)

**Lambda says "User has no tenant"**
- Check USER_TENANTS_TABLE has entry for your user ID
- Verify JWT token has `custom:tenantId` claim

**Lambda says "Tenant inactive"**
- Check TENANTS_TABLE has status=ACTIVE for your tenant
- Verify bucket and role ARN are set

**S3 says "access denied"**
- Check tenant role has S3 permissions
- Verify bucket name matches TENANTS_TABLE
- Check Lambda execution role can assume tenant role

## Next: Include in Chatbot

Once S3Browser is working:

1. Let user select files in S3Browser
2. Get file content
3. Include in message to chatbot:

```typescript
const fileContext = selectedContent() 
  ? `\n\nS3 Content:\n${selectedContent()}`
  : "";

const message = userInput() + fileContext;
// Send to chatbot API
```

---

**Status**: Backend code ready ✅ | Frontend ready ✅ | Needs CDK deployment ⏳

**Next Action**: Update `stacks/api_stack.py` and deploy with `cdk deploy`

**Detailed Guides**:
- Backend: `autodoc-control-plane-cdk/S3_LAMBDA_INTEGRATION.md`
- Frontend: `opencode-web/S3_CHATBOT_INTEGRATION.md`
