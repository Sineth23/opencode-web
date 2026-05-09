# Test Local ECS OpenCode with Bedrock/Anthropic
# Run this after logging in to the app and getting a valid JWT token

param(
    [string]$CloneJobId = "",
    [string]$JwtToken = ""
)

if (-not $JwtToken) {
    Write-Host "❌ JWT token required. Get it from browser console:" -ForegroundColor Red
    Write-Host "  localStorage.getItem('cognito_id_token')" -ForegroundColor Yellow
    exit 1
}

if (-not $CloneJobId) {
    Write-Host "❌ Clone job ID required. Get it from /jobs endpoint or app UI" -ForegroundColor Red
    exit 1
}

$API_ENDPOINT = "https://4aukdm2t58.execute-api.ca-central-1.amazonaws.com"
$CLUSTER = "autodoc-cluster"
$REGION = "ca-central-1"
$PROFILE = "autodoc-prod"

Write-Host "🚀 Starting local ECS OpenCode test..." -ForegroundColor Cyan

# Step 1: Create session
Write-Host "`n[1/4] Creating ECS session..." -ForegroundColor Cyan
$sessionResp = curl.exe -s -X POST "$API_ENDPOINT/session" `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer $JwtToken" `
  -d @"
{
  "cloneJobId": "$CloneJobId"
}
"@

$sessionData = $sessionResp | ConvertFrom-Json
$SESSION_ID = $sessionData.sessionId
$TASK_ARN = $sessionData.taskArn
$PASSWORD = $sessionData.password

if (-not $SESSION_ID) {
    Write-Host "❌ Failed to create session:" -ForegroundColor Red
    Write-Host $sessionResp
    exit 1
}

Write-Host "✅ Session created: $SESSION_ID" -ForegroundColor Green
Write-Host "📋 Task ARN: $TASK_ARN" -ForegroundColor White
$TASK_ID = $TASK_ARN.Split('/')[-1]
Write-Host "📌 Task ID: $TASK_ID" -ForegroundColor White

# Step 2: Wait for task to boot
Write-Host "`n[2/4] Waiting for ECS task to reach RUNNING state..." -ForegroundColor Cyan
$maxWait = 90
$elapsed = 0
$interval = 5

while ($elapsed -lt $maxWait) {
    $tasks = aws ecs list-tasks --cluster $CLUSTER --region $REGION --profile $PROFILE --desired-status RUNNING --output json | ConvertFrom-Json

    if ($tasks.taskArns -contains $TASK_ARN) {
        Write-Host "✅ Task is RUNNING!" -ForegroundColor Green
        break
    }

    Write-Host "⏳ Task still provisioning... ($elapsed/$maxWait seconds)" -ForegroundColor Yellow
    Start-Sleep -Seconds $interval
    $elapsed += $interval
}

if ($elapsed -ge $maxWait) {
    Write-Host "⚠️  Task did not reach RUNNING state in time" -ForegroundColor Yellow
    Write-Host "Check logs: aws logs tail /ecs/autodoc-opencode --region $REGION --profile $PROFILE --follow" -ForegroundColor Yellow
}

# Step 3: Get container runtime ID
Write-Host "`n[3/4] Getting container runtime ID..." -ForegroundColor Cyan
$taskDetails = aws ecs describe-tasks `
  --cluster $CLUSTER `
  --tasks $TASK_ID `
  --region $REGION `
  --profile $PROFILE `
  --output json | ConvertFrom-Json

$CONTAINER_RT = $taskDetails.tasks[0].containers[0].runtimeId

if (-not $CONTAINER_RT) {
    Write-Host "❌ Failed to get container runtime ID" -ForegroundColor Red
    exit 1
}

Write-Host "✅ Container runtime ID: $CONTAINER_RT" -ForegroundColor Green

# Step 4: Show SSM tunnel command
Write-Host "`n[4/4] Setting up SSM port tunnel..." -ForegroundColor Cyan
Write-Host "Run this in a NEW terminal (keep it running):" -ForegroundColor Cyan
Write-Host ""
Write-Host "aws ssm start-session ``" -ForegroundColor Yellow
Write-Host "  --target `"ecs:${CLUSTER}_${TASK_ID}_${CONTAINER_RT}`" ``" -ForegroundColor Yellow
Write-Host "  --document-name AWS-StartPortForwardingSession ``" -ForegroundColor Yellow
Write-Host "  --parameters '{`"portNumber`":[`"4096`"],`"localPortNumber`":[`"4096`"]}' ``" -ForegroundColor Yellow
Write-Host "  --region $REGION ``" -ForegroundColor Yellow
Write-Host "  --profile $PROFILE" -ForegroundColor Yellow
Write-Host ""

# Save session info for later
$info = @{
    sessionId = $SESSION_ID
    taskArn = $TASK_ARN
    taskId = $TASK_ID
    password = $PASSWORD
    containerRt = $CONTAINER_RT
} | ConvertTo-Json

$info | Out-File -FilePath ".\test-session.json" -Force
Write-Host "✅ Session info saved to test-session.json" -ForegroundColor Green

Write-Host "`n📝 Next steps:" -ForegroundColor Cyan
Write-Host "1. Run the SSM command above in a new terminal" -ForegroundColor White
Write-Host "2. Wait for 'Port 4096 opened for sessionid'" -ForegroundColor White
Write-Host "3. Run: npm run dev" -ForegroundColor White
Write-Host "4. Open http://localhost:5173 in browser" -ForegroundColor White
Write-Host "5. Send a message - should get Claude response!" -ForegroundColor White
