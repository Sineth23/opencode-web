# MiniMax Integration Testing Plan

## Prerequisites
1. ✅ Lambda deployed with MiniMax config (in progress)
2. ✅ Cognito JWT token in localStorage (obtained via login)
3. ✅ API endpoint configured in Settings

## Test Steps

### 1. Create a New Session
```javascript
// In browser console
fetch('https://4aukdm2t58.execute-api.ca-central-1.amazonaws.com/session', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${localStorage.getItem('cognito_id_token')}`
  },
  body: JSON.stringify({})
})
.then(r => r.json())
.then(d => {
  console.log('Session created:', d);
  localStorage.setItem('test_session_id', d.sessionId);
});
```

**Expected**: 
- ✅ Returns 202 (Accepted)
- ✅ Response includes `sessionId`, `taskArn`, `password`
- ✅ Session appears in session list

### 2. Wait for Task to Reach RUNNING
```bash
aws ecs list-tasks --cluster autodoc-cluster --region ca-central-1 \
  --profile autodoc-prod --desired-status RUNNING --output json
```

**Expected**:
- ✅ New task appears in list with RUNNING status
- ✅ Wait 30-60 seconds for ECS to provision task
- ✅ OpenCode server on port 4096 becomes available

### 3. Send Message and Get MiniMax Response
```javascript
// In browser console
const sessionId = localStorage.getItem('test_session_id');
const token = localStorage.getItem('cognito_id_token');

fetch(`https://4aukdm2t58.execute-api.ca-central-1.amazonaws.com/session/${sessionId}/message`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    parts: [
      {
        type: 'text',
        text: 'What is 2+2?'
      }
    ],
    model: {
      providerID: 'minimax',
      modelID: 'abab6.5-chat'
    }
  })
})
.then(r => r.text())
.then(text => {
  console.log('Response:', text);
  if (text) {
    try {
      console.log('Parsed:', JSON.parse(text));
    } catch (e) {
      console.log('Raw text:', text);
    }
  }
});
```

**Expected**:
- ✅ HTTP 200 response
- ✅ Response contains message from MiniMax API
- ✅ Message text includes LLM response (e.g., "4" or "The answer is 4")
- ✅ Response appears in chat UI

### 4. Verify Provider Dropdown Shows MiniMax
**Expected**:
- ✅ Provider dropdown shows "minimax"
- ✅ Model dropdown shows "abab6.5-chat" or "MiniMax Free Model"
- ✅ Agent dropdown has relevant options

### 5. Check CloudWatch Logs
```bash
# Check Lambda logs
aws logs tail /aws/lambda/autodoc-control-plane-api-OpencodeSessionStartFn* \
  --region ca-central-1 --follow --profile autodoc-prod

# Check ECS task logs  
aws ecs describe-tasks --cluster autodoc-cluster --tasks <TASK_ID> \
  --region ca-central-1 --profile autodoc-prod --query 'tasks[0]'
```

**Expected**:
- ✅ No errors in Lambda logs
- ✅ OPENCODE_CONFIG_CONTENT passed to task correctly
- ✅ No errors in task logs about config parsing
- ✅ OpenCode initialized with MiniMax provider

## Success Criteria

| Criteria | Status | Notes |
|----------|--------|-------|
| Lambda deployment succeeds | ⏳ In progress | Waiting for CDK deploy to complete |
| New session creation works | ⏳ Pending | Need to test after deployment |
| Task reaches RUNNING | ⏳ Pending | ECS provisioning 30-60 seconds |
| Message POST returns 200 | ⏳ Pending | Need to test message endpoint |
| MiniMax provides response | ⏳ Pending | Verify LLM output in response |
| Response displays in UI | ⏳ Pending | Check MessageInput component |
| Provider dropdown shows MiniMax | ⏳ Pending | Verify /config/providers endpoint |
| No errors in logs | ⏳ Pending | Check CloudWatch |

## Troubleshooting

### If Responses Are Empty
1. Check CloudWatch logs for Lambda errors
2. Verify OPENCODE_CONFIG_CONTENT environment variable is passed
3. Verify OpenCode received the config in task logs
4. Check if MiniMax API is accessible from task (network/firewall)
5. Verify MiniMax API credentials if needed

### If Provider Doesn't Show in Dropdown
1. Check `/config/providers` API response
2. May need to implement endpoint or update frontend
3. Can use direct model ID in message request for now

### If Task Doesn't Reach RUNNING
1. Check ECS task logs for startup errors
2. Verify IAM roles have proper permissions
3. Check CloudWatch for any service issues

## Next Steps After Successful Test
1. Document successful MiniMax integration
2. Enable event stream if needed for real-time updates
3. Consider moving MiniMax API key to AWS Secrets Manager
4. Test with various message types and models
5. Monitor latency and costs
