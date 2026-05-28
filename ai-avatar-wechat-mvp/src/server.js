const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8787);
const WECHAT_TOKEN = process.env.WECHAT_TOKEN || "dev-token";
const MAX_REPLY_CHARS = Number(process.env.MAX_REPLY_CHARS || 180);
const AI_API_KEY = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "";
const AI_BASE_URL = (process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const AI_MODEL = process.env.AI_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini";
const AI_API_STYLE = process.env.AI_API_STYLE || "responses";
const DEFAULT_SYSTEM_PROMPT =
  "你是微信里的 AI 客服助手。回复要简洁、自然、中文口语化。不确定就说需要本人确认。涉及付款、合同、退款、投诉、法律、医疗、投资、最终价格、折扣时必须转人工。";

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

async function generateAiReply(customerText) {
  if (needsHumanHandoff(customerText)) {
    return "这个问题需要本人或团队确认后再回复你，避免我说得不准确。我先帮你记录下来。";
  }

  const fallback = "你好，我是 AI 助手，可以先帮你解答常见问题。你可以简单说下你的需求、预算和希望解决的问题。";

  if (!AI_API_KEY) {
    return fallback;
  }

  const systemPrompt = process.env.AVATAR_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;
  const response =
    AI_API_STYLE === "chat_completions"
      ? await callChatCompletions({ systemPrompt, customerText })
      : await callResponses({ systemPrompt, customerText });

  if (!response.ok) {
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

  return text.slice(0, MAX_REPLY_CHARS);
}

function callResponses({ systemPrompt, customerText }) {
  return fetch(`${AI_BASE_URL}/responses`, {
    method: "POST",
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
  });
}

function callChatCompletions({ systemPrompt, customerText }) {
  return fetch(`${AI_BASE_URL}/chat/completions`, {
    method: "POST",
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
    }),
  });
}

async function handleWechatCallback(req, res) {
  const query = parseQuery(req.url);

  if (req.method === "GET") {
    const valid = verifyWechatSignature(query);
    res.writeHead(valid ? 200 : 403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(valid ? query.echostr || "" : "invalid signature");
    return;
  }

  if (req.method === "POST") {
    const valid = verifyWechatSignature(query);
    if (!valid && process.env.NODE_ENV === "production") {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("invalid signature");
      return;
    }

    const body = await readBody(req);
    const fromUser = extractXmlValue(body, "FromUserName");
    const toUser = extractXmlValue(body, "ToUserName");
    const content = extractXmlValue(body, "Content");

    const reply = await generateAiReply(content);
    const xml = buildTextXml({
      toUser: fromUser,
      fromUser: toUser,
      content: reply,
    });

    res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
    res.end(xml);
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
