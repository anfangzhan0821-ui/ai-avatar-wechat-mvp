# AI Avatar WeChat MVP

This workspace is the execution package for building a WeChat-based AI avatar that can answer customer questions, qualify leads, and hand off to a human when needed.

## What This MVP Does

- Defines the AI avatar's business scope and boundaries.
- Collects your personal style, product/service information, FAQs, cases, and sales scripts.
- Provides a first version system prompt for the AI avatar.
- Defines the recommended WeChat entry path: WeChat Customer Service / WeCom Customer Service first, Official Account as an alternative.
- Provides a minimal backend skeleton that can be extended into a real webhook service.

## Recommended Build Path

1. Fill in `docs/01-avatar-profile.md`.
2. Fill in `docs/02-knowledge-base-template.md`.
3. Review and adjust `docs/03-system-prompt.md`.
4. Register and configure the WeChat customer entry using `docs/04-wechat-setup.md`.
5. Implement the production webhook based on `src/server.js`.
6. Add a database, vector search, CRM tags, and human handoff.

## Folder Guide

- `docs/`: business, product, and implementation documents.
- `src/`: minimal Node.js backend skeleton.
- `.env.example`: environment variables for future deployment.
- `Dockerfile`: container deployment entry.

## First Production Choice

Use an official customer-service entry rather than automating a personal WeChat account.

Preferred:

- WeChat Customer Service / WeCom Customer Service
- WeChat Official Account customer messages

Avoid:

- Personal WeChat automation
- Unofficial desktop automation
- QR-code login bots

## Local Run

```bash
npm run dev
```

Health check:

```bash
curl http://localhost:8787/health
```

Test chat:

```bash
curl -X POST http://localhost:8787/test-chat \
  -H "Content-Type: application/json" \
  -d '{"message":"你们是做什么的？"}'
```

## Deployment

See `docs/07-deployment-guide.md`.

Recommended first platform: Render.

This repo includes `render.yaml` for Render Blueprint deployment.
