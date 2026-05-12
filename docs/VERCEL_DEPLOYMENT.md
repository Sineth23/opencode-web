# Vercel Deployment Guide

## Quick Deploy

When starting a new chat session, use this to redeploy the frontend to Vercel:

```bash
cd C:\Users\Sineth\opencode-web
vercel deploy --prod
```

## Full Reset & Deploy

If changes aren't showing up or you need a clean deployment:

```bash
# 1. Reset to clean state
git reset --hard HEAD
git clean -fd

# 2. Build
npm run build

# 3. Deploy to Vercel
vercel deploy --prod
```

## What Gets Deployed

- **Frontend:** Solid.js React app at `https://opencode-web-gamma.vercel.app`
- **Code:** Everything in `src/` directory
- **Config:** `vercel.json` contains environment variables:
  - `VITE_OPENCODE_ALB_URL` - ALB address that frontend redirects to
  - `VITE_COGNITO_CLIENT_ID` - Cognito auth
  - `VITE_COGNITO_USER_POOL_ID` - Cognito auth
  - `VITE_COGNITO_REGION` - Cognito region (ca-central-1)

## Deployment Flow

1. User visits `https://opencode-web-gamma.vercel.app`
2. Frontend prompts Cognito login
3. After auth, frontend redirects to: `http://autodoc-opencode-alb-1424128421.ca-central-1.elb.amazonaws.com`
4. ALB serves OpenCode IDE running in ECS Fargate

## Branch to Deploy

Always deploy from `feature/opencode-web-alb` branch:
```bash
git checkout feature/opencode-web-alb
```

This branch contains:
- Simple redirect-to-ALB logic (no SessionViewer, no polling)
- Correct environment variable configuration
- MiniMax LLM integration (not Anthropic)
