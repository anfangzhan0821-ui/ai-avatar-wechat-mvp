const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);
const WECHAT_TOKEN = process.env.WECHAT_TOKEN || "dev-token";
const WECHAT_CORP_ID = process.env.WECHAT_CORP_ID || process.env.WECOM_CORP_ID || "";
const WECHAT_ENCODING_AES_KEY =
  process.env.WECHAT_ENCODING_AES_KEY || process.env.WECOM_ENCODING_AES_KEY || "";
const WECHAT_AGENT_ID = process.env.WECHAT_AGENT_ID || process.env.WECOM_AGENT_ID || "";
const WECHAT_CORP_SECRET = process.env.WECHAT_CORP_SECRET || process.env.WECOM_CORP_SECRET || "";
const WECHAT_KF_SECRET =
  process.env.WECHAT_KF_SECRET || process.env.WECOM_KF_SECRET || WECHAT_CORP_SECRET;
const MAX_REPLY_CHARS = Number(process.env.MAX_REPLY_CHARS || 220);
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
  "语气：专业但不端着，口语、松弛、有观点；像朋友微信聊天，不像销售话术。",
  "回复长度：默认 1-2 句，最多 120 个中文字符。客户没有明确要求展开时，不要解释完整。",
  "互动方式：先短答，再只追问一个关键问题。不要一次问多个问题。",
  "格式：不要项目符号、编号、Markdown 标题、加粗。尽量一小段说完。",
  "节奏：客户问一句，你回一句半。把资料库当背景，不要把资料一次性倒出来。",
  "报价：客户问价格/收费时，不要直接给完整价格表；只说要看项目范围，然后问一个最关键的问题。",
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
let wechatAccessToken = "";
let wechatAccessTokenExpiresAt = 0;
let wechatKfAccessToken = "";
let wechatKfAccessTokenExpiresAt = 0;
const kfCursors = new Map();
const handledKfMsgIds = new Set();

const handoffKeywords = (process.env.HUMAN_HANDOFF_KEYWORDS ||
  "付款,合同,退款,投诉,能便宜吗,转人工,本人,老板,报价单,最终报价")
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

function splitReply(reply) {
  const parts = String(reply || "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [String(reply || "").trim()].filter(Boolean);
}

function canSendWechatAppMessage() {
  return Boolean(WECHAT_CORP_ID && WECHAT_CORP_SECRET && WECHAT_AGENT_ID);
}

async function getWechatAccessToken() {
  if (wechatAccessToken && Date.now() < wechatAccessTokenExpiresAt) {
    return wechatAccessToken;
  }

  const url = new URL("https://qyapi.weixin.qq.com/cgi-bin/gettoken");
  url.searchParams.set("corpid", WECHAT_CORP_ID);
  url.searchParams.set("corpsecret", WECHAT_CORP_SECRET);

  const response = await fetch(url);
  const data = await response.json();
  if (data.errcode !== 0 || !data.access_token) {
    throw new Error(`WeCom gettoken failed: ${data.errcode} ${data.errmsg || ""}`);
  }

  wechatAccessToken = data.access_token;
  wechatAccessTokenExpiresAt = Date.now() + Math.max((data.expires_in || 7200) - 300, 60) * 1000;
  return wechatAccessToken;
}

async function sendWechatAppText({ toUser, content }) {
  if (!canSendWechatAppMessage() || !toUser || !content) return;

  const accessToken = await getWechatAccessToken();
  const response = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      touser: toUser,
      msgtype: "text",
      agentid: Number(WECHAT_AGENT_ID),
      text: {
        content,
      },
      safe: 0,
    }),
  });
  const data = await response.json();
  if (data.errcode !== 0) {
    throw new Error(`WeCom message/send failed: ${data.errcode} ${data.errmsg || ""}`);
  }
}

function sendRemainingReplyParts({ toUser, parts }) {
  if (!canSendWechatAppMessage() || parts.length <= 1) return;

  parts.slice(1).forEach((part, index) => {
    setTimeout(() => {
      sendWechatAppText({ toUser, content: part }).catch((error) => {
        console.error("WeCom active message failed", error.message);
      });
    }, 900 * (index + 1));
  });
}

function canSendWechatKfMessage() {
  return Boolean(WECHAT_CORP_ID && WECHAT_KF_SECRET);
}

async function getWechatKfAccessToken() {
  if (wechatKfAccessToken && Date.now() < wechatKfAccessTokenExpiresAt) {
    return wechatKfAccessToken;
  }

  const url = new URL("https://qyapi.weixin.qq.com/cgi-bin/gettoken");
  url.searchParams.set("corpid", WECHAT_CORP_ID);
  url.searchParams.set("corpsecret", WECHAT_KF_SECRET);

  const response = await fetch(url);
  const data = await response.json();
  if (data.errcode !== 0 || !data.access_token) {
    throw new Error(`WeCom KF gettoken failed: ${data.errcode} ${data.errmsg || ""}`);
  }

  wechatKfAccessToken = data.access_token;
  wechatKfAccessTokenExpiresAt = Date.now() + Math.max((data.expires_in || 7200) - 300, 60) * 1000;
  return wechatKfAccessToken;
}

async function syncWechatKfMessages({ token, openKfid }) {
  if (!canSendWechatKfMessage() || !token) return [];

  const accessToken = await getWechatKfAccessToken();
  const cursorKey = openKfid || "default";
  const body = {
    token,
    limit: 100,
    voice_format: 0,
  };
  if (openKfid) body.open_kfid = openKfid;
  if (kfCursors.has(cursorKey)) body.cursor = kfCursors.get(cursorKey);

  const response = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg?access_token=${accessToken}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (data.errcode !== 0) {
    throw new Error(`WeCom KF sync_msg failed: ${data.errcode} ${data.errmsg || ""}`);
  }
  if (data.next_cursor) {
    kfCursors.set(cursorKey, data.next_cursor);
  }

  return data.msg_list || [];
}

async function sendWechatKfText({ externalUserId, openKfid, content }) {
  if (!canSendWechatKfMessage() || !externalUserId || !openKfid || !content) return;

  const accessToken = await getWechatKfAccessToken();
  const response = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg?access_token=${accessToken}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      touser: externalUserId,
      open_kfid: openKfid,
      msgid: crypto.randomBytes(16).toString("hex"),
      msgtype: "text",
      text: {
        content,
      },
    }),
  });
  const data = await response.json();
  if (data.errcode !== 0) {
    throw new Error(`WeCom KF send_msg failed: ${data.errcode} ${data.errmsg || ""}`);
  }
}

function rememberKfMsgId(msgid) {
  if (!msgid) return false;
  if (handledKfMsgIds.has(msgid)) return true;
  handledKfMsgIds.add(msgid);
  if (handledKfMsgIds.size > 500) {
    const first = handledKfMsgIds.values().next().value;
    handledKfMsgIds.delete(first);
  }
  return false;
}

async function replyToWechatKfMessage(message) {
  if (message.origin !== 3 || message.msgtype !== "text" || !message.text?.content) return;
  if (rememberKfMsgId(message.msgid)) return;

  const reply = await generateAiReply(message.text.content);
  const parts = splitReply(reply);
  for (const [index, part] of parts.entries()) {
    if (index > 0) {
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    await sendWechatKfText({
      externalUserId: message.external_userid,
      openKfid: message.open_kfid,
      content: part,
    });
  }
}

async function handleWechatKfEvent(messageXml) {
  const token = extractXmlValue(messageXml, "Token");
  const openKfid = extractXmlValue(messageXml, "OpenKfId");
  const messages = await syncWechatKfMessages({ token, openKfid });
  for (const message of messages) {
    await replyToWechatKfMessage(message);
  }
}

function needsHumanHandoff(text) {
  return handoffKeywords.some((keyword) => text.includes(keyword));
}

function isRecentCasualQuestion(text) {
  return /最近|这几天|近来/.test(text) && /忙|有意思|干嘛|做什么|在做/.test(text);
}

function isGreeting(text) {
  return /^(你好|您好|哈喽|hello|hi|嗨|在吗|在不在)[啊呀呐呢\s！!。,.，]*$/i.test(text.trim());
}

function isPricingQuestion(text) {
  return /多少钱|怎么收费|收费|价格|报价|费用|预算/.test(text);
}

function directShortReply(text) {
  if (/工业|设备|制造|工厂|机械/.test(text) && /升级|形象|品牌|视觉/.test(text)) {
    return "工业设备这类很适合做形象升级。\n\n关键不是做得花，而是把技术感、可靠感和规模感讲清楚。你们现在主要短板是在画册、官网，还是展厅？";
  }

  if (/画册/.test(text) && /做吗|能做|可以做|有没有|吗|？|\?/.test(text)) {
    return "做啊，画册算我们常接的项目。\n\n你们是产品画册，还是企业介绍册？";
  }

  if (/(VI|vi|视觉识别|品牌视觉)/.test(text) && /做吗|能做|可以做|有没有|吗|？|\?/.test(text)) {
    return "做的。\n\n不过 VI 不是只画个标，得看你主要用在线上、包装，还是门店物料上。你是哪种场景？";
  }

  if (/包装/.test(text) && /做吗|能做|可以做|有没有|吗|？|\?/.test(text)) {
    return "包装也做。\n\n你是已有产品想升级，还是新产品从零开始？";
  }

  if (/品牌银弹/.test(text)) {
    return "简单讲，就是把产品里真正值钱的点挖出来，再用设计让客户一眼看懂。\n\n你想套到你们自己的产品上看看吗？";
  }

  return "";
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
  let cleaned = String(text || "")
    .replace(/\r/g, "")
    .replace(/\*\*/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(毛豆[:：]\s*)/i, "")
    .trim()
    .slice(0, MAX_REPLY_CHARS);
  if (!/[。！？!?]$/.test(cleaned)) {
    cleaned = cleaned.replace(/[，,、；;：:][^，,、；;：:。！？!?]*$/, "");
  }
  return cleaned;
}

async function generateAiReply(customerText) {
  if (needsHumanHandoff(customerText)) {
    return "这个我先不直接拍板哈，容易说偏。\n\n我帮你记下来，具体价格、合同或者付款这些，还是让本人/团队确认后再回复你。";
  }

  if (isRecentCasualQuestion(customerText)) {
    return "最近主要还是在琢磨品牌这件事。\n\n很多企业不是东西不行，是好东西没被看见。你呢，最近在忙什么有意思的事？";
  }

  if (isGreeting(customerText)) {
    return "嗨，你好呀，我是毛豆。\n\n你是想聊品牌视觉，还是先随便问问？";
  }

  if (isPricingQuestion(customerText)) {
    return "这个要看项目范围，不能一口价乱报。\n\n你是想做画册、VI，还是整套品牌升级？";
  }

  const shortReply = directShortReply(customerText);
  if (shortReply) {
    return shortReply;
  }

  const fallback = "可以聊。\n\n你先说下你现在最想解决的问题，我听听看。";

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
      max_tokens: 160,
    }),
  }).finally(() => clearTimeout(timeout));
}

async function handleWechatCallback(req, res) {
  const query = parseQuery(req.url);
  const startTime = Date.now();

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
    console.log(`\n[${new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" })}] 📩 [POST /wechat/callback] 收到消息推送`);
    console.log("   query:", JSON.stringify(query));

    const body = await readBody(req);
    console.log("   body前200字符:", body.substring(0, 200));
    const encrypted = extractXmlValue(body, "Encrypt");
    let messageXml = body;
    let encryptedReply = false;

    if (query.msg_signature && encrypted) {
      console.log("   🔐 检测到加密消息，验证签名...");
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
      console.log("   ✅ 解密成功, 明文前300字符:", messageXml.substring(0, 300));
    } else {
      console.log("   ⚠️ 未检测到加密或无签名，使用明文处理");
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
    const event = extractXmlValue(messageXml, "Event");
    const msgType = extractXmlValue(messageXml, "MsgType");

    console.log(`   📊 解析结果: fromUser=${fromUser}, toUser=${toUser}, msgType=${msgType || "(无)"}, event=${event || "(无)"}, content="${content?.substring(0, 50)}"`);

    if (event === "kf_msg_or_event") {
      console.log("   🔔 检测到微信客服事件 → 调用 handleWechatKfEvent");
      handleWechatKfEvent(messageXml).catch((error) => {
        console.error("WeCom KF event failed", error.message);
      });
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("success");
      return;
    }

    const reply = await generateAiReply(content);
    const replyParts = splitReply(reply);
    console.log(`   🤖 AI 回复: "${(replyParts[0] || "").substring(0, 100)}" (共${replyParts.length}段)`);

    sendRemainingReplyParts({ toUser: fromUser, parts: replyParts });
    const xml = buildTextXml({
      toUser: fromUser,
      fromUser: toUser,
      content: replyParts[0] || "",
    });

    res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
    res.end(encryptedReply ? buildEncryptedXml({ plainXml: xml, nonce: query.nonce || "nonce" }) : xml);
    console.log(`   ✅ 回复已发送, 耗时: ${Date.now() - startTime}ms`);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("method not allowed");
  console.log("   ⚠️ 不支持的HTTP方法:", req.method);
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
  const replyParts = splitReply(reply);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ reply: replyParts[0] || "", replies: replyParts }));
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
  console.log(`   环境变量状态:`);
  console.log(`     WECHAT_TOKEN: ${WECHAT_TOKEN ? "✅ 已配置" : "❌ 未配置"}`);
  console.log(`     WECHAT_CORP_ID: ${WECHAT_CORP_ID ? "✅ 已配置" : "❌ 未配置"}`);
  console.log(`     WECHAT_ENCODING_AES_KEY: ${WECHAT_ENCODING_AES_KEY ? "✅ 已配置 (" + WECHAT_ENCODING_AES_KEY.length + "字符)" : "❌ 未配置"}`);
  console.log(`     AI_API_KEY: ${AI_API_KEY ? "✅ 已配置" : "❌ 未配置 (将使用本地匹配模式)"}`);
  console.log(`     AI_BASE_URL: ${AI_BASE_URL}`);
  console.log(`     AI_MODEL: ${AI_MODEL}`);
  console.log(`     WECHAT_CORP_SECRET: ${WECHAT_CORP_SECRET ? "✅ 已配置" : "❌ 未配置 (主动推送消息需要)"}`);
  console.log(`     WECHAT_KF_SECRET: ${WECHAT_KF_SECRET ? "✅ 已配置" : "❌ 未配置 (微信客服回复需要)"}`);
});
