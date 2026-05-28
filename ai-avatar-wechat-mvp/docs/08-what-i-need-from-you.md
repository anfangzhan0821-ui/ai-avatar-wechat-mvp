# What I Need From You

To deploy this for real, please prepare these items.

## Required

1. A deployment target

Choose one:

- You already have a cloud server.
- You want to use a managed platform.
- You want me to prepare Docker deployment files only.

2. OpenAI API key

Needed for real AI replies.

```text
OPENAI_API_KEY=...
```

3. WeChat customer-service configuration

Needed after the backend has a public HTTPS URL.

```text
WECHAT_TOKEN=...
WECHAT_ENCODING_AES_KEY=...
WECHAT_CORP_ID=...
```

4. Your AI avatar content

Fill these files:

- `docs/01-avatar-profile.md`
- `docs/02-knowledge-base-template.md`

## Optional But Recommended

- A domain name.
- A server in the same region as most customers.
- A human handoff destination, such as WeCom group, email, SMS, or admin dashboard.
- A privacy notice telling customers they are talking to an AI assistant.

## Recommended Next Step

If you do not already have infrastructure, use a managed web service or container platform first. After the MVP proves useful, move to your own cloud server and database.

