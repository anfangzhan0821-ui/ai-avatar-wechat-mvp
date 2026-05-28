# Architecture

## MVP Architecture

```text
WeChat Entry
  -> Webhook Server
  -> Message Normalizer
  -> Conversation Store
  -> Knowledge Search
  -> AI Response
  -> Safety And Handoff Rules
  -> WeChat Reply
```

## Production Components

- Webhook service: receives WeChat messages.
- AI service: calls the language model.
- Knowledge service: retrieves product and service facts.
- Conversation database: stores user messages, replies, tags, and handoff state.
- CRM layer: tracks leads and next actions.
- Admin console: lets humans review, edit knowledge, and take over.
- Monitoring: logs errors, latency, and risky conversations.

## Data Model Draft

### Customer

- id
- wechat_openid or external_userid
- nickname
- first_seen_at
- last_seen_at
- tags
- lead_status

### Conversation

- id
- customer_id
- channel
- status
- assigned_human
- created_at
- updated_at

### Message

- id
- conversation_id
- role
- content
- raw_payload
- created_at

### Handoff

- id
- conversation_id
- reason
- status
- created_at
- resolved_at

## Lead Status

- new
- low_intent
- medium_intent
- high_intent
- human_required
- booked
- paid
- closed

