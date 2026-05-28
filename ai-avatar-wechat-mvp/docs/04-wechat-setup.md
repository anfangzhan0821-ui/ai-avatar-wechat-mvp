# WeChat Setup

## Recommended Entry

Use an official customer-service entry.

Priority:

1. WeChat Customer Service / WeCom Customer Service
2. WeChat Official Account customer messages
3. Mini Program customer service

Avoid personal WeChat automation because it is unstable and can create account risk.

## Information Needed From WeChat Platform

Prepare:

- Enterprise or account verification.
- Customer-service account.
- Callback URL.
- Token.
- EncodingAESKey if encrypted messages are enabled.
- Corp ID if using WeCom.
- App ID if using Official Account.
- App Secret if server-side API calls are needed.

## Callback URL

Development:

```text
https://your-test-domain.com/wechat/callback
```

Production:

```text
https://your-production-domain.com/wechat/callback
```

## Verification Flow

The platform usually verifies:

- `signature`
- `timestamp`
- `nonce`
- `echostr`

The server should:

1. Sort token, timestamp, and nonce.
2. Join them into one string.
3. SHA1 hash the result.
4. Compare with signature.
5. Return `echostr` if valid.

## Message Flow

```text
Customer message in WeChat
  -> WeChat callback
  -> Backend webhook
  -> Verify signature and decrypt if needed
  -> Save message
  -> Retrieve relevant knowledge
  -> Generate AI reply
  -> Apply safety and handoff rules
  -> Send reply or notify human
```

## Beta Launch Checklist

- Customer knows they are talking to an AI assistant.
- Human handoff is available.
- Conversation logs are stored.
- Sensitive questions are not answered automatically.
- 100 test questions have been reviewed.

