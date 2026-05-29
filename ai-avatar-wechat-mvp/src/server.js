const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);
const WECHAT_TOKEN = process.env.WECHAT_TOKEN || "dev-token";
const WECHAT_CORP_ID = process.env.WECHAT_CORP_ID || process.env.WECOM_CORP_ID || "";
const WECHAT_ENCODING_AES_KEY =
  process.env.WECHAT_ENCODING_AES_KEY || process.env.WECOM_ENCODING_AES_KEY || "";
const MAX_REPLY_CHARS = Math.max(Number(process.env.MAX_REPLY_CHARS || 700), 700);
const KNOWLEDGE_MAX_CHARS = Number(process.env.KNOWLEDGE_MAX_CHARS || 32000);
const AI_API_KEY = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "";
const AI_BASE_URL = (process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const AI_MODEL = process.env.AI_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini";
const AI_API_STYLE = process.env.AI_API_STYLE || "responses";
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 25000);
const DEFAULT_SYSTEM_PROMPT =
  "你是毛豆，嘉瑞品牌设计总监。你在企业微信里和客户正常聊天，负责初步沟通、需求诊断和专业答疑。";
const KNOWLEDGE_PATH = path.join(__dirname, "..", "knowledge", "jiarui-brand-avatar-knowledge.md");
const AVATAR_STYLE_PROMPT = [
  "你必须像一个正常人在微信里说话，不要像客服机器人。",
  "身份：你是毛豆本人风格的智能分身。不要自称 AI、机器人、助手，也不要说“根据资料库”。",
  "语气：专业但不端着，口语、松弛、有观点；可以说“说实话”“简单讲”“这个要看情况”。",
  "回复长度：多数情况下 1-4 句，复杂问题最多 2-3 个短段落。不要一上来写长篇说明。",
  "互动方式：先接住对方的话，再给判断；如果信息不够，最后自然追问一个关键问题。",
  "格式：少用项目符号和编号，除非客户明确问流程、报价、清单。不要使用 Markdown 标题。",
  "真实感：不要编造“最近正在做”的具体项目、客户或时间状态；资料库里的案例只能作为服务经验和案例来讲。",
  "边界：涉及最终报价、合同、付款、退款、投诉、法律风险、重大承诺时，不要直接拍板，要说需要本人/团队确认。",
].join("\n");

function loadAvatarKnowledge() {
  try {
    return fs.readFileSync(KNOWLEDGE_PATH, "utf8").slice(0, KNOWLEDGE_MAX_CHARS);
  } catch (error) {
    console.warn("Avatar knowledge file not loaded", error.message);
    return "";
  }
}

const avatarKnowledge = loadAvatarKnowledge();

const handoffKeywords = (process.env.HUMAN_HANDOFF_KEYWORDS ||
  "付款,合同,退款,投诉,能便宜吗,转人工,本人,老板")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

function verifyWechatSignature(query) {
  const { signature, timestamp, nonce } = query;
  if (!signature || !timestamp || !nonce) return false;

  const raw = [WECHAT_TOKEN, timestamp, nonce].sort().join("");
  const digest = crypto.createHash("sha1").update(raw).digest("hex");
  return digest === signature;
}

function sha1Signature(...parts) {
  return crypto.createHash("sha1").update(parts.sort().join("")).digest("hex");
}

function verifyWechatEncryptedSignature({ msgSignature, timestamp, nonce, encrypted }) {
  if (!msgSignature || !timestamp || !nonce || !encrypted) return false;
  return sha1Signature(WECHAT_TOKEN, timestamp, nonce, encrypted) === msgSignature;
}

function parseQuery(url) {
  const parsed = new URL(url, `http://localhost:${PORT}`);
  return Object.fromEntries(parsed.searchParams.entries());
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body) return {};
  return JSON.parse(body);
}

function extractXmlValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1] || match[2] || "" : "";
}

function getWechatAesKey() {
  if (!WECHAT_ENCODING_AES_KEY || WECHAT_ENCODING_AES_KEY.length !== 43) {
    throw new Error("WECHAT_ENCODING_AES_KEY must be 43 characters");
  }

  return Buffer.from(`${WECHAT_ENCODING_AES_KEY}=`, "base64");
}

function pkcs7Unpad(buffer) {
  const pad = buffer[buffer.length - 1];
  if (pad < 1 || pad > 32) return buffer;
  return buffer.subarray(0, buffer.length - pad);
}

function pkcs7Pad(buffer) {
  const blockSize = 32;
  const remainder = buffer.length % blockSize;
  const pad = remainder === 0 ? blockSize : blockSize - remainder;
  return Buffer.concat([buffer, Buffer.alloc(pad, pad)]);
}

function decryptWechatPayload(encrypted) {
  const aesKey = getWechatAesKey();
  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);

  const decrypted = pkcs7Unpad(
    Buffer.concat([decipher.update(encrypted, "base64"), decipher.final()])
  );
  const messageLength = decrypted.readUInt32BE(16);
  const message = decrypted.subarray(20, 20 + messageLength).toString("utf8");
  const receiveId = decrypted.subarray(20 + messageLength).toString("utf8");

  if (WECHAT_CORP_ID && receiveId && receiveId !== WECHAT_CORP_ID) {
    throw new Error("WeCom receive id mismatch");
  }

  return message;
}

function encryptWechatPayload(message) {
  const aesKey = getWechatAesKey();
  const messageBuffer = Buffer.from(message);
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(messageBuffer.length, 0);

  const random = crypto.randomBytes(16);
  const receiveId = Buffer.from(WECHAT_CORP_ID);
  const plaintext = pkcs7Pad(Buffer.concat([random, lengthBuffer, messageBuffer, receiveId]));
  const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  cipher.setAutoPadding(false);

  return Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64");
}

function buildEncryptedXml({ plainXml, nonce }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const encrypted = encryptWechatPayload(plainXml);
  const signature = sha1Signature(WECHAT_TOKEN, timestamp, nonce, encrypted);

  return [
    "<xml>",
    `<Encrypt><![CDATA[${encrypted}]]></Encrypt>`,
    `<MsgSignature><![CDATA[${signature}]]></MsgSignature>`,
    `<TimeStamp>${timestamp}</TimeStamp>`,
    `<Nonce><![CDATA[${nonce}]]></Nonce>`,
    "</xml>",
  ].join("");
}

function buildTextXml({ toUser, fromUser, content }) {
  const now = Math.floor(Date.now() / 1000);
  return [
    "<xml>",
    `<ToUserName><![CDATA[${toUser}]]></ToUserName>`,
    `<FromUserName><![CDATA[${fromUser}]]></FromUserName>`,
    `<CreateTime>${now}</CreateTime>`,
    "<MsgType><![CDATA[text]]></MsgType>",
    `<Content><![CDATA[${content}]]></Content>`,
    "</xml>",
  ].join("");
}

function needsHumanHandoff(text) {
  return handoffKeywords.some((keyword) => text.includes(keyword));
}

function isRecentCasualQuestion(text) {
  return /最近|这几天|近来/.test(text) && /忙|有意思|干嘛|做什么|在做/.test(text);
}

function buildSystemPrompt() {
  const extraPrompt = process.env.AVATAR_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;
  return [
    DEFAULT_SYSTEM_PROMPT,
    "",
    "【微信聊天风格】",
    AVATAR_STYLE_PROMPT,
    "",
    "【额外要求】",
    extraPrompt,
    avatarKnowledge ? ["", "【嘉瑞品牌话术资料库】", avatarKnowledge].join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function cleanReply(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\*\*/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(毛豆[:：]\s*)/i, "")
    .trim()
    .slice(0, MAX_REPLY_CHARS);
}

async function generateAiReply(customerText) {
  if (needsHumanHandoff(customerText)) {
    return "这个我先不直接拍板哈，容易说偏。\n\n我帮你记下来，具体价格、合同或者付款这些，还是让本人/团队确认后再回复你。";
  }

  if (isRecentCasualQuestion(customerText)) {
    return "最近主要还是在琢磨品牌这件事。\n\n有时候会觉得，很多企业不是产品不行，是好东西没被看见。设计要做的事，就是把那些藏在产品、技术、团队里的价值，翻译成别人一眼能懂的东西。\n\n你呢，最近在忙什么有意思的事？";
  }

  const fallback = "你好，我是毛豆。\n\n你可以先简单说下你想解决什么问题，是品牌升级、包装、画册，还是展厅/网站这类？";

  if (!AI_API_KEY) {
    return fallback;
  }

  const systemPrompt = buildSystemPrompt();
  let response;

  try {
    response =
      AI_API_STYLE === "chat_completions"
        ? await callChatCompletions({ systemPrompt, customerText })
        : await callResponses({ systemPrompt, customerText });
  } catch (error) {
    console.error("AI request failed", error.message);
    return fallback;
  }

  if (!response.ok) {
    console.error("AI provider returned error", response.status, await response.text());
    return fallback;
  }

  const data = await response.json();
  const text =
    AI_API_STYLE === "chat_completions"
      ? data.choices?.[0]?.message?.content || fallback
      : data.output_text ||
        data.output?.flatMap((item) => item.content || [])
          .map((item) => item.text || "")
          .join("") ||
        fallback;

  return cleanReply(text || fallback) || fallback;
}

function callResponses({ systemPrompt, customerText }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  return fetch(`${AI_BASE_URL}/responses`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${AI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      input: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: customerText,
        },
      ],
    }),
  }).finally(() => clearTimeout(timeout));
}

function callChatCompletions({ systemPrompt, customerText }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  return fetch(`${AI_BASE_URL}/chat/completions`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${AI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: customerText,
        },
      ],
      temperature: 0.4,
      max_tokens: 650,
    }),
  }).finally(() => clearTimeout(timeout));
}

async function handleWechatCallback(req, res) {
  const query = parseQuery(req.url);

  if (req.method === "GET") {
    if (query.msg_signature && query.echostr) {
      const valid = verifyWechatEncryptedSignature({
        msgSignature: query.msg_signature,
        timestamp: query.timestamp,
        nonce: query.nonce,
        encrypted: query.echostr,
      });

      if (!valid) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("invalid msg_signature");
        return;
      }

      const echo = decryptWechatPayload(query.echostr);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(echo);
      return;
    }

    const valid = verifyWechatSignature(query);
    res.writeHead(valid ? 200 : 403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(valid ? query.echostr || "" : "invalid signature");
    return;
  }

  if (req.method === "POST") {
    const body = await readBody(req);
    const encrypted = extractXmlValue(body, "Encrypt");
    let messageXml = body;
    let encryptedReply = false;

    if (query.msg_signature && encrypted) {
      const validEncrypted = verifyWechatEncryptedSignature({
        msgSignature: query.msg_signature,
        timestamp: query.timestamp,
        nonce: query.nonce,
        encrypted,
      });

      if (!validEncrypted && process.env.NODE_ENV === "production") {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("invalid msg_signature");
        return;
      }

      messageXml = decryptWechatPayload(encrypted);
      encryptedReply = true;
    }

    const valid = encryptedReply || verifyWechatSignature(query);
    if (!valid && process.env.NODE_ENV === "production") {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("invalid signature");
      return;
    }

    const fromUser = extractXmlValue(messageXml, "FromUserName");
    const toUser = extractXmlValue(messageXml, "ToUserName");
    const content = extractXmlValue(messageXml, "Content");

    const reply = await generateAiReply(content);
    const xml = buildTextXml({
      toUser: fromUser,
      fromUser: toUser,
      content: reply,
    });

    res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
    res.end(encryptedReply ? buildEncryptedXml({ plainXml: xml, nonce: query.nonce || "nonce" }) : xml);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("method not allowed");
}

async function handleTestChat(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  const body = await readJson(req);
  const message = String(body.message || "").trim();

  if (!message) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "message is required" }));
    return;
  }

  const reply = await generateAiReply(message);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ reply }));
}

async function handleRequest(req, res) {
  if (req.url.startsWith("/wechat/callback")) {
    await handleWechatCallback(req, res);
    return;
  }

  if (req.url.startsWith("/test-chat")) {
    await handleTestChat(req, res);
    return;
  }

  if (req.url.startsWith("/health")) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("internal server error");
  });
});

server.listen(PORT, () => {
  console.log(`AI avatar webhook listening on http://localhost:${PORT}`);
});
