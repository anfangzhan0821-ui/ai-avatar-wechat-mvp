# Execution Plan

## Goal

Build an AI avatar that customers can talk to inside WeChat. The avatar should answer common questions, explain services, qualify leads, and transfer important conversations to a human.

## Phase 1: Business Scope

Deliverables:

- Avatar identity
- Service scope
- Customer types
- Allowed answers
- Forbidden answers
- Human handoff rules

Owner:

- Founder / business owner

Output:

- `docs/01-avatar-profile.md`

## Phase 2: Knowledge Base

Deliverables:

- Product or service description
- Pricing rules
- FAQ
- Case studies
- Sales scripts
- Refund or after-sales policy
- Compliance disclaimers

Owner:

- Founder / sales / operations

Output:

- `docs/02-knowledge-base-template.md`

## Phase 3: AI Behavior Design

Deliverables:

- System prompt
- Response style
- Lead qualification rules
- Handoff rules
- Risk rules

Owner:

- AI product owner / engineer

Output:

- `docs/03-system-prompt.md`

## Phase 4: WeChat Entry

Deliverables:

- WeChat customer-service account
- Callback URL
- Token
- EncodingAESKey if encryption is enabled
- Test QR code

Owner:

- Business owner / engineer

Output:

- `docs/04-wechat-setup.md`

## Phase 5: Backend MVP

Deliverables:

- Webhook service
- Message parser
- AI response module
- Human handoff detector
- Conversation logs

Owner:

- Engineer

Output:

- `src/server.js`

## Phase 6: Beta Test

Deliverables:

- 100 test questions
- Failure log
- Prompt updates
- Knowledge base updates
- Human handoff tests

Owner:

- Founder / sales / engineer

Success criteria:

- Answers 70 percent of common questions correctly.
- Never fabricates price, promise, refund, contract, legal, medical, or investment claims.
- Important conversations are handed off to a human.

