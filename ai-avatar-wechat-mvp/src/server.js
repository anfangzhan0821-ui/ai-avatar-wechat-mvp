const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8787);
const WECHAT_TOKEN = process.env.WECHAT_TOKEN || "dev-token";
const WECHAT_CORP_ID = process.env.WECHAT_CORP_ID || process.env.WECOM_CORP_ID || "";
const WECHAT_ENCODING_AES_KEY =
  process.env.WECHAT_ENCODING_AES_KEY || process.env.WECOM_ENCODING_AES_KEY || "";
const MAX_REPLY_CHARS = Number(process.env.MAX_REPLY_CHARS || 180);
const AI_API_KEY = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "";
const AI_BASE_URL = (process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const AI_MODEL = process.env.AI_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini";
const AI_API_STYLE = process.env.AI_API_STYLE || "responses";
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 25000);
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
  const pad = blockSize - (buffer.length % blockSize || blockSize);
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
