# Deployment Guide

## Recommended MVP Deployment

Deploy this service as a public HTTPS web service.

The deployment target must provide:

- A public HTTPS URL.
- Environment variables.
- A stable Node.js or Docker runtime.
- Logs.

Good choices:

- Render Web Service for the first MVP.
- A managed container platform if you already use one.
- A cloud server with Docker after the MVP proves useful.

## Recommended Platform: Render

Render is the recommended first deployment path for this MVP because it gives you:

- Public HTTPS URL.
- Node.js web service runtime.
- Environment variables and secrets.
- Health checks.
- GitHub-based deploys.

This project includes `render.yaml`, so Render can create the service from the repository.

## Render Deployment Steps

1. Create a GitHub repository.
2. Upload this project folder to the repository.
3. Go to Render and create a new Blueprint or Web Service from that repository.
4. Confirm the detected service settings:

```text
Runtime: Node
Build Command: npm install
Start Command: npm start
Health Check Path: /health
```

5. Add these environment variables:

```text
OPENAI_API_KEY=your_openai_api_key
AVATAR_SYSTEM_PROMPT=your_final_prompt
```

Render will generate `WECHAT_TOKEN` if you deploy from `render.yaml`. Copy that token later into the WeChat customer-service callback settings.

6. Deploy.
7. Open the Render service URL and test:

```text
https://your-service.onrender.com/health
```

8. Test chat:

```bash
curl -X POST https://your-service.onrender.com/test-chat \
  -H "Content-Type: application/json" \
  -d '{"message":"你们是做什么的？"}'
```

9. Configure WeChat callback:

```text
Callback URL: https://your-service.onrender.com/wechat/callback
Token: the same WECHAT_TOKEN from Render
```

## Required Environment Variables

Set these before production:

```text
NODE_ENV=production
PORT=8787
WECHAT_TOKEN=your_wechat_callback_token
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4.1-mini
MAX_REPLY_CHARS=180
HUMAN_HANDOFF_KEYWORDS=付款,合同,退款,投诉,能便宜吗,转人工,本人,老板
AVATAR_SYSTEM_PROMPT=your_final_prompt
```

If your deployment platform assigns its own port, use that platform's `PORT` value.

## Public URLs

After deployment, you should have:

```text
https://your-domain.com/health
https://your-domain.com/test-chat
https://your-domain.com/wechat/callback
```

## Test The Deployment

Health check:

```bash
curl https://your-domain.com/health
```

Expected:

```json
{"ok":true}
```

AI test:

```bash
curl -X POST https://your-domain.com/test-chat \
  -H "Content-Type: application/json" \
  -d '{"message":"你们是做什么的？"}'
```

Expected:

```json
{"reply":"..."}
```

## WeChat Callback Configuration

In the WeChat customer-service platform, set:

```text
Callback URL: https://your-domain.com/wechat/callback
Token: same as WECHAT_TOKEN
EncodingAESKey: only if encrypted messages are enabled
```

The first WeChat verification request should be a GET request. The server will verify `signature`, `timestamp`, `nonce`, and return `echostr`.

## Docker Deployment

Build:

```bash
docker build -t ai-avatar-wechat-mvp .
```

Run:

```bash
docker run -p 8787:8787 \
  -e NODE_ENV=production \
  -e WECHAT_TOKEN=your_wechat_callback_token \
  -e OPENAI_API_KEY=your_openai_api_key \
  ai-avatar-wechat-mvp
```

## Production Notes

Before real customers use it, add:

- Persistent database for conversations and customer tags.
- Knowledge-base retrieval.
- Human handoff notification.
- Encrypted WeChat message support if enabled.
- Admin page for reviewing and correcting answers.
