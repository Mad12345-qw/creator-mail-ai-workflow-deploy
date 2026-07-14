import { createServer } from "node:http";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { getConfig, getMissingConfig } from "./config.js";
import { FeishuClient } from "./feishuClient.js";
import { OpenAIClient } from "./openaiClient.js";
import { RedisStore } from "./redisStore.js";
import { RuleStore } from "./ruleStore.js";
import { getPathAndQuery, readJson, sendJson, sendRedirect, sendText } from "./http.js";
import { processCreatorEmail, requiresManualReviewIntent, requiresNoReplyIntent } from "./workflow.js";

const config = getConfig();
const feishu = new FeishuClient(config);
const openai = new OpenAIClient(config);
const redis = new RedisStore(config);
const ruleStore = new RuleStore(config);
let lastMailboxEvent = { status: "not_received" };
let lastMailboxPoll = { status: "not_started" };
let lastOutbound = { status: "not_attempted" };
let clientIntakeSetup = { status: "not_started" };
let clientLiveAcceptance = { status: "not_started" };
let approvalQueueAudit = { status: "not_started" };
let mailboxInboxAudit = { status: "not_started" };
let manualReviewReconciliation = { status: "not_started" };
let historicalReplayAcceptance = { status: "not_started" };
let senderAddressReconciliation = { status: "not_started" };
let missingDraftReconciliation = { status: "not_started" };
let dataIntegrityAudit = { status: "not_started" };
let operationalSchemaAudit = { status: "not_started" };
let historicalContextReconciliation = { status: "not_started" };

const CLIENT_INTAKE_TABLE_NAME = "项目与产品插件库";
const CLIENT_INTAKE_VIEW_NAME = "项目与产品填写表";
const CLIENT_WIKI_URL = "https://zcn1ftnw54fl.feishu.cn/wiki/H0tkwIRmYiQ1wnks74Nc2m4kn5e";
const MAILBOX_POLL_SCAN_LIMIT = 500;
const OPERATIONAL_TABLE_FIELDS = {
  emailLog: [
    { field_name: "邮件ID", type: 1 },
    { field_name: "邮件正文", type: 1 },
    { field_name: "收件人邮箱", type: 1 },
    { field_name: "接收时间", type: 1 },
    { field_name: "回复发送时间", type: 1 },
    { field_name: "人工修改稿", type: 1 },
    { field_name: "是否允许发送", type: 7 },
    { field_name: "审批状态", type: 1 },
    { field_name: "负责人", type: 1 },
    { field_name: "人工备注", type: 1 },
    { field_name: "匹配项目", type: 1 },
    { field_name: "命中规则", type: 1 },
    { field_name: "数据完整性", type: 1 }
  ],
  approvalTasks: [
    { field_name: "发件人邮箱", type: 1 },
    { field_name: "原邮件主题", type: 1 },
    { field_name: "原邮件正文", type: 1 },
    { field_name: "接收时间", type: 1 },
    { field_name: "回复发送时间", type: 1 },
    { field_name: "匹配项目", type: 1 }
  ]
};
const CLIENT_INTAKE_FIELDS = [
  {
    field_name: "项目状态",
    type: 3,
    property: { options: ["Priority", "Active", "Limited", "Paused", "Closed", "Archived"].map((name) => ({ name })) }
  },
  { field_name: "品牌名称", type: 1 },
  { field_name: "产品名称", type: 1 },
  { field_name: "项目名称", type: 1 },
  {
    field_name: "推广平台",
    type: 4,
    property: { options: ["TikTok", "Instagram", "YouTube", "X"].map((name) => ({ name })) }
  },
  { field_name: "目标市场", type: 1 },
  { field_name: "产品链接", type: 15 },
  { field_name: "样品申请链接", type: 15 },
  { field_name: "产品简介与核心卖点", type: 1 },
  { field_name: "适合达人与内容方向", type: 1 },
  { field_name: "自然流佣金", type: 1 },
  { field_name: "广告流佣金", type: 1 },
  { field_name: "Bonus机制", type: 1 },
  {
    field_name: "Flat Fee支持",
    type: 3,
    property: { options: ["Yes", "No", "Conditional"].map((name) => ({ name })) }
  },
  { field_name: "支持纯佣", type: 7 },
  { field_name: "支持Hybrid", type: 7 },
  { field_name: "低报价转纯佣阈值N", type: 2 },
  {
    field_name: "阈值币种",
    type: 3,
    property: { options: ["USD", "EUR", "GBP", "CNY", "Other"].map((name) => ({ name })) }
  },
  {
    field_name: "样品政策",
    type: 3,
    property: { options: ["Yes", "No", "Limited"].map((name) => ({ name })) }
  },
  { field_name: "默认交付要求", type: 1 },
  { field_name: "广告投流与Spark Ads要求", type: 1 },
  { field_name: "广告授权期限", type: 1 },
  { field_name: "内容使用权", type: 1 },
  { field_name: "原始素材要求", type: 1 },
  { field_name: "发布时间要求", type: 1 },
  { field_name: "必须表达内容", type: 1 },
  { field_name: "禁止表达内容", type: 1 },
  { field_name: "标签与Hashtag", type: 1 },
  { field_name: "付款政策", type: 1 },
  { field_name: "项目负责人及备注", type: 1 }
];

function verifyCronToken(query) {
  const expected = config.cronSecret;
  return expected && query.get("token") === expected;
}

function getOAuthRedirectUri() {
  return config.feishu.oauthRedirectUri || (config.baseUrl ? `${config.baseUrl.replace(/\/$/, "")}/auth/feishu/callback` : "");
}

function getTokenCipherKey() {
  return createHash("sha256")
    .update(`${config.feishu.appId}:${config.feishu.appSecret}`)
    .digest();
}

function encryptTokenRecord(record) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getTokenCipherKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decryptTokenRecord(value) {
  const [version, iv, tag, ciphertext] = String(value || "").split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) return null;
  const decipher = createDecipheriv("aes-256-gcm", getTokenCipherKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

async function saveUserToken(tokenData) {
  const record = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: Date.now() + Number(tokenData.expires_in || 7200) * 1000,
    refreshExpiresAt: Date.now() + Number(tokenData.refresh_expires_in || 0) * 1000,
    userId: tokenData.user_id || tokenData.open_id || "",
    updatedAt: new Date().toISOString()
  };
  await redis.set("feishu-mail-user-token", encryptTokenRecord(record));
  return record;
}

async function getUserToken() {
  const stored = await redis.get("feishu-mail-user-token");
  const record = decryptTokenRecord(stored);
  if (!record || !record.accessToken) return null;
  if (Date.now() < record.expiresAt - 60_000) return record;
  if (!record.refreshToken || (record.refreshExpiresAt && Date.now() >= record.refreshExpiresAt - 60_000)) {
    return null;
  }
  const refreshed = await feishu.refreshUserAccessToken(record.refreshToken);
  return saveUserToken({ ...refreshed, user_id: refreshed.user_id || record.userId });
}

function eventValue(event, names) {
  if (!event || typeof event !== "object") return "";
  for (const name of names) {
    if (typeof event[name] === "string" && event[name]) return event[name];
  }
  for (const value of Object.values(event)) {
    if (value && typeof value === "object") {
      const nested = eventValue(value, names);
      if (nested) return nested;
    }
  }
  return "";
}

function readAddress(value, depth = 0) {
  if (depth > 6 || value === undefined || value === null) return "";
  if (typeof value === "string") {
    const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? match[0] : "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const address = readAddress(item, depth + 1);
      if (address) return address;
    }
    return "";
  }
  if (typeof value === "object") {
    const preferredKeys = ["mail_address", "email_address", "address", "email", "mail", "value"];
    for (const key of preferredKeys) {
      const address = readAddress(value[key], depth + 1);
      if (address) return address;
    }
    for (const [key, item] of Object.entries(value)) {
      if (!/(mail|email|address)/i.test(key)) continue;
      const address = readAddress(item, depth + 1);
      if (address) return address;
    }
    for (const item of Object.values(value)) {
      const address = readAddress(item, depth + 1);
      if (address) return address;
    }
  }
  return "";
}

function readSourceAddress(source, role) {
  const roleKeys = role === "from"
    ? ["from", "sender", "from_address", "sender_address", "from_email", "head_from", "envelope_from"]
    : ["to", "recipients", "to_address", "recipient", "recipient_address", "to_email", "head_to", "envelope_to"];
  for (const key of roleKeys) {
    const address = readAddress(source?.[key]);
    if (address) return address;
  }
  const keyPattern = role === "from" ? /(from|sender)/i : /(^to$|recipient)/i;
  const stack = [{ value: source, depth: 0 }];
  while (stack.length) {
    const current = stack.shift();
    if (!current?.value || typeof current.value !== "object" || current.depth > 5) continue;
    const headerName = String(current.value.name || current.value.key || current.value.header || "");
    if (keyPattern.test(headerName)) {
      const headerAddress = readAddress(current.value.value || current.value.content || current.value.text);
      if (headerAddress) return headerAddress;
    }
    for (const [key, value] of Object.entries(current.value)) {
      if (keyPattern.test(key)) {
        const address = readAddress(value);
        if (address) return address;
      }
      if (value && typeof value === "object") stack.push({ value, depth: current.depth + 1 });
    }
  }
  return "";
}

function readTimePrimitive(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return "";
  const raw = value.trim();
  if (!raw || !normalizeMailTime(raw)) return "";
  return raw;
}

function readSourceTime(source, role) {
  const preferredKeys = role === "received"
    ? ["received_time", "receive_time", "received_at", "receive_at", "delivered_time", "delivery_time", "internal_date", "internal_time", "created_time", "create_time"]
    : ["sent_time", "send_time", "sent_at", "send_at", "date"];
  for (const key of preferredKeys) {
    const value = readTimePrimitive(source?.[key]);
    if (value) return value;
  }

  const keySet = new Set(preferredKeys);
  const headerPattern = role === "sent" ? /^(date|sent|send)$/i : /^(received|delivery|delivered)$/i;
  const stack = [{ value: source, depth: 0 }];
  while (stack.length) {
    const current = stack.shift();
    if (!current?.value || typeof current.value !== "object" || current.depth > 5) continue;
    const headerName = String(current.value.name || current.value.key || current.value.header || "").trim();
    if (headerPattern.test(headerName)) {
      const headerTime = readTimePrimitive(current.value.value || current.value.content || current.value.text);
      if (headerTime) return headerTime;
    }
    for (const [key, value] of Object.entries(current.value)) {
      if (keySet.has(String(key).toLowerCase())) {
        const nestedTime = readTimePrimitive(value);
        if (nestedTime) return nestedTime;
      }
      if (value && typeof value === "object" && !/(body|content|attachment)/i.test(key)) {
        stack.push({ value, depth: current.depth + 1 });
      }
    }
  }
  return "";
}

function getMailboxMessageId(message) {
  if (typeof message === "string") return message;
  return message?.message_id || message?.id || "";
}

function getBitableRecordId(result) {
  return result?.data?.record?.record_id || result?.record?.record_id || result?.record_id || "";
}

function mapMailboxMessage(message, fallbackMessageId) {
  const source = message.message || message;
  const body = source.body_plain_text || source.body_text || source.body || source.body_html || "";
  const sentTime = readSourceTime(source, "sent");
  const receivedTime = readSourceTime(source, "received");
  return {
    messageId: source.message_id || source.id || fallbackMessageId,
    from: readSourceAddress(source, "from"),
    to: readSourceAddress(source, "to"),
    subject: source.subject || "",
    text: typeof body === "string" ? body : body.plain_text || body.text || body.html || "",
    receivedAt: formatMailTime(receivedTime || sentTime),
    sentAt: formatMailTime(sentTime)
  };
}

async function listMailboxHistory(userToken, limit = 100) {
  const messages = [];
  let pageToken = "";
  while (messages.length < limit) {
    const data = await feishu.listMailboxMessages({
      accessToken: userToken.accessToken,
      folderId: config.feishu.inboxFolderId,
      pageSize: Math.min(20, limit - messages.length),
      pageToken
    });
    const pageItems = data.items || data.messages || [];
    messages.push(...pageItems);
    const nextPageToken = String(data.page_token || data.pageToken || "");
    if (!data.has_more || !nextPageToken || !pageItems.length) break;
    pageToken = nextPageToken;
  }
  return messages;
}

async function listMailboxDelta(userToken, limit = 500) {
  const messages = [];
  let pageToken = "";
  while (messages.length < limit) {
    const data = await feishu.listMailboxMessages({
      accessToken: userToken.accessToken,
      folderId: config.feishu.inboxFolderId,
      pageSize: Math.min(20, limit - messages.length),
      pageToken
    });
    const pageItems = data.items || data.messages || [];
    messages.push(...pageItems);
    const processedStates = await Promise.all(
      pageItems.map((item) => {
        const messageId = getMailboxMessageId(item);
        return messageId ? redis.exists(`polled-mail:${messageId}`) : Promise.resolve(true);
      })
    );
    if (pageItems.length && processedStates.every(Boolean)) break;
    const nextPageToken = String(data.page_token || data.pageToken || "");
    if (!data.has_more || !nextPageToken || !pageItems.length) break;
    pageToken = nextPageToken;
  }
  return messages;
}

async function processMailboxMessageOnce({ messageId, mailboxId = "me", userToken, existingLogsByMessageId = null }) {
  if (!messageId) throw new Error("Mailbox message id is missing.");
  const processedKey = `polled-mail:${messageId}`;
  if (await redis.exists(processedKey)) return { status: "already_processed" };

  const lockName = `mail-message-lock:${messageId}`;
  const lockToken = randomUUID();
  const locked = redis.isConfigured() ? await redis.acquireLock(lockName, lockToken, 300) : true;
  if (!locked) return { status: "already_processing" };
  try {
    if (await redis.exists(processedKey)) return { status: "already_processed" };
    let existingLog = existingLogsByMessageId?.get(messageId) || null;
    if (!existingLog) {
      const logsData = await feishu.listAllBitableRecords("emailLog", { maxRecords: 1000 });
      existingLog = (logsData.items || []).find((record) => String(record.fields?.["邮件ID"] || "") === messageId) || null;
    }
    if (existingLog) {
      await redis.set(processedKey, "1", { ex: 60 * 60 * 24 * 90 });
      return { status: "existing_log_recovered", existingLog };
    }

    const fullMessage = await feishu.getMailboxMessage({
      userMailboxId: mailboxId,
      messageId,
      accessToken: userToken.accessToken
    });
    const email = mapMailboxMessage(fullMessage, messageId);
    if (!email.from) throw new Error("Mailbox message sender address could not be parsed.");
    if (!email.subject && !email.text) throw new Error("Mailbox message has no readable subject or body.");

    const result = await processCreatorEmail({ email, feishu, openai, ruleStore });
    if (!getBitableRecordId(result.writeResult)) {
      throw new Error("Email log write did not return a record id.");
    }
    await redis.set(processedKey, "1", { ex: 60 * 60 * 24 * 90 });
    if (existingLogsByMessageId) existingLogsByMessageId.set(messageId, result.writeResult);
    return { status: "processed", result };
  } finally {
    if (redis.isConfigured()) await redis.releaseLock(lockName, lockToken).catch(() => {});
  }
}

async function pollMailbox() {
  const userToken = await getUserToken();
  if (!userToken) return { status: "authorization_required" };

  const initializedKey = "mailbox-poll-initialized-v3";
  const previousInitializedKey = "mailbox-poll-initialized-v2";
  const initialized = await redis.exists(initializedKey);
  const messages = initialized
    ? await listMailboxDelta(userToken, MAILBOX_POLL_SCAN_LIMIT)
    : await listMailboxHistory(userToken, MAILBOX_POLL_SCAN_LIMIT);
  const messageIds = messages.map(getMailboxMessageId).filter(Boolean);
  const logsData = await feishu.listAllBitableRecords("emailLog", { maxRecords: 1000 });
  const existingLogsByMessageId = new Map(
    (logsData.items || []).map((record) => [String(record.fields?.["邮件ID"] || ""), record])
  );

  if (!initialized) {
    if (await redis.exists(previousInitializedKey)) {
      for (let index = 0; index < messages.length; index += 1) {
        const messageId = getMailboxMessageId(messages[index]);
        if (!messageId) continue;
        if (index >= 20 || existingLogsByMessageId.has(messageId)) {
          await redis.set(`polled-mail:${messageId}`, "1", { ex: 60 * 60 * 24 * 90 });
        }
      }
      await redis.set(initializedKey, `migrated:${new Date().toISOString()}`);
    } else {
      for (const messageId of messageIds) {
        await redis.set(`polled-mail:${messageId}`, "1", { ex: 60 * 60 * 24 * 90 });
      }
      await redis.set(initializedKey, new Date().toISOString());
      lastMailboxPoll = { status: "baseline_created", seen: messageIds.length, updatedAt: new Date().toISOString() };
      return lastMailboxPoll;
    }
  }

  const processed = [];
  const recovered = [];
  const failures = [];
  for (const message of messages.slice().reverse()) {
    const messageId = getMailboxMessageId(message);
    if (!messageId || (await redis.exists(`polled-mail:${messageId}`))) continue;
    try {
      const outcome = await processMailboxMessageOnce({ messageId, userToken, existingLogsByMessageId });
      if (outcome.status === "processed") processed.push(messageId);
      if (outcome.status === "existing_log_recovered") recovered.push(messageId);
    } catch (error) {
      failures.push(error.message);
    }
  }
  lastMailboxPoll = {
    status: failures.length ? "completed_with_errors" : "completed",
    scanned: messages.length,
    processed: processed.length,
    recovered: recovered.length,
    failed: failures.length,
    error: failures[0] || "",
    updatedAt: new Date().toISOString()
  };
  return lastMailboxPoll;
}

function isChecked(value) {
  return value === true || value === 1 || String(value).toLowerCase() === "true";
}

async function recordOutbound(update) {
  lastOutbound = {
    ...lastOutbound,
    ...update,
    updatedAt: new Date().toISOString()
  };
  try {
    await redis.setJson("last-mail-outbound", lastOutbound, { ex: 60 * 60 * 24 * 7 });
  } catch (error) {
    console.error("Could not persist outbound mail diagnostics:", error.message);
  }
}

function bitableItemId(item, kind) {
  if (!item || typeof item !== "object") return "";
  if (kind === "table") return item.table_id || item.id || "";
  if (kind === "view") return item.view_id || item.id || "";
  return item.field_id || item.id || "";
}

async function recordClientIntakeSetup(update) {
  clientIntakeSetup = {
    ...clientIntakeSetup,
    ...update,
    updatedAt: new Date().toISOString()
  };
  try {
    await redis.setJson("client-intake-setup-v1", clientIntakeSetup, { ex: 60 * 60 * 24 * 30 });
  } catch (error) {
    console.error("Could not persist client intake setup:", error.message);
  }
}

async function ensureClientIntakeTable() {
  await recordClientIntakeSetup({ status: "checking", error: "" });
  const tablesData = await feishu.listBitableTables(100);
  const tables = tablesData.items || [];
  let table = tables.find((item) => String(item.name || "") === CLIENT_INTAKE_TABLE_NAME);
  if (!table) {
    const created = await feishu.createBitableTable({ name: CLIENT_INTAKE_TABLE_NAME });
    table = created.table || created;
  }
  const tableId = bitableItemId(table, "table");
  if (!tableId) throw new Error("Feishu did not return the client intake table id.");

  const fieldsData = await feishu.listBitableFields(tableId, 100);
  const existingNames = new Set((fieldsData.items || []).map((item) => String(item.field_name || item.name || "")));
  const createdFields = [];
  for (const field of CLIENT_INTAKE_FIELDS) {
    if (existingNames.has(field.field_name)) continue;
    await feishu.createBitableField(tableId, field);
    createdFields.push(field.field_name);
  }

  let viewId = "";
  let viewStatus = "ready";
  try {
    const viewsData = await feishu.listBitableViews(tableId, 100);
    let view = (viewsData.items || []).find((item) => String(item.view_name || item.name || "") === CLIENT_INTAKE_VIEW_NAME);
    if (!view) {
      const createdView = await feishu.createBitableView(tableId, {
        name: CLIENT_INTAKE_VIEW_NAME,
        type: "grid"
      });
      view = createdView.view || createdView;
    }
    viewId = bitableItemId(view, "view");
  } catch (error) {
    viewStatus = `table_ready_grid_view_failed: ${error.message}`;
  }

  const tableUrl = `${CLIENT_WIKI_URL}?table=${encodeURIComponent(tableId)}${viewId ? `&view=${encodeURIComponent(viewId)}` : ""}`;
  await recordClientIntakeSetup({
    status: "complete",
    tableId,
    viewId,
    tableUrl,
    viewStatus,
    createdFields,
    error: ""
  });
  return clientIntakeSetup;
}

async function ensureOperationalTableFields() {
  operationalSchemaAudit = { status: "checking", createdFields: [], updatedAt: new Date().toISOString() };
  try {
    const createdFields = [];
    for (const [tableName, fields] of Object.entries(OPERATIONAL_TABLE_FIELDS)) {
      const tableId = await feishu.resolveBitableTableId(tableName);
      if (!tableId) throw new Error(`Operational table is not configured: ${tableName}`);
      const fieldsData = await feishu.listBitableFields(tableId, 100);
      const existingFields = fieldsData.items || [];
      const existingNames = new Set(existingFields.map((item) => String(item.field_name || item.name || "")));
      if (tableName === "emailLog" && !existingNames.has("邮件概览")) {
        const technicalPrimaryField = existingFields.find((item) => String(item.field_name || item.name || "") === "邮件ID");
        const fieldId = bitableItemId(technicalPrimaryField, "field");
        if (fieldId) {
          await feishu.updateBitableField(tableId, fieldId, {
            field_name: "邮件概览",
            type: Number(technicalPrimaryField.type || 1)
          });
          existingNames.delete("邮件ID");
          existingNames.add("邮件概览");
          createdFields.push("emailLog.邮件概览(主列重命名)");
        }
      }
      for (const field of fields) {
        if (existingNames.has(field.field_name)) continue;
        await feishu.createBitableField(tableId, field);
        createdFields.push(`${tableName}.${field.field_name}`);
      }
      if (tableName === "emailLog") {
        const recordsData = await feishu.listAllBitableRecords("emailLog", { maxRecords: 1000 });
        for (const record of recordsData.items || []) {
          const recordFields = record.fields || {};
          const messageId = String(recordFields["邮件ID"] || recordFields["邮件概览"] || "").trim();
          const overview = formatEmailOverview({
            receivedAt: recordFields["接收时间"],
            from: recordFields["发件人邮箱"],
            subject: recordFields["邮件主题"]
          });
          if (!messageId && !overview) continue;
          await feishu.updateBitableRecord("emailLog", record.record_id, {
            ...(messageId ? { "邮件ID": messageId } : {}),
            "邮件概览": overview || messageId
          });
        }
      }
    }
    operationalSchemaAudit = {
      status: "complete",
      createdFields,
      updatedAt: new Date().toISOString(),
      error: ""
    };
  } catch (error) {
    operationalSchemaAudit = {
      status: "failed",
      createdFields: [],
      updatedAt: new Date().toISOString(),
      error: error.message
    };
  }
  return operationalSchemaAudit;
}

function formatEmailOverview(email) {
  const receivedAt = String(email?.receivedAt || "").trim() || "时间待补充";
  const from = String(email?.from || "").trim() || "未知发件人";
  const subject = String(email?.subject || "").trim() || "无主题";
  return `${receivedAt} | ${from} | ${subject}`.slice(0, 500);
}

function hasProjectIdentity(record) {
  const fields = record?.fields || {};
  return [fields["品牌名称"], fields["产品名称"], fields["项目名称"]]
    .some((value) => String(value || "").trim());
}

function dryRunFeishuClient() {
  return new Proxy(feishu, {
    get(target, property) {
      if (property === "createBitableRecord" || property === "updateBitableRecord" || property === "deleteBitableRecord") {
        return async () => ({ skipped: true, dryRun: true });
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function runClientLiveAcceptance() {
  clientLiveAcceptance = { status: "running", updatedAt: new Date().toISOString() };
  try {
    const data = await feishu.listAllBitableRecords("projectProducts", { maxRecords: 1000 });
    const records = (data.items || []).filter(hasProjectIdentity);
    if (!records.length) throw new Error("No completed client project record was found.");

    const record = records[0];
    const fields = record.fields || {};
    const brand = String(fields["品牌名称"] || "").trim();
    const product = String(fields["产品名称"] || "").trim();
    const campaign = String(fields["项目名称"] || "").trim();
    const identity = brand || product || campaign;
    const dryRunFeishu = dryRunFeishuClient();
    const scenarios = [
      {
        name: "quote_requires_review",
        email: {
          messageId: `client-live-acceptance-quote-${Date.now()}`,
          from: "delivery-acceptance@example.com",
          subject: `${identity} collaboration rate`,
          text: `My rate is USD 150 for one video featuring ${product || identity}.`
        },
        allowedActions: ["manual_review"]
      },
      {
        name: "sample_draft",
        email: {
          messageId: `client-live-acceptance-sample-${Date.now()}`,
          from: "delivery-acceptance@example.com",
          subject: `${identity} sample request`,
          text: `Could you share the sample application details for ${product || identity}?`
        },
        allowedActions: ["draft_reply", "manual_review"]
      },
      {
        name: "other_product_cross_sell",
        email: {
          messageId: `client-live-acceptance-cross-sell-${Date.now()}`,
          from: "delivery-acceptance@example.com",
          subject: "Fitness equipment sample application",
          text: "I am interested in applying for the fitness product sample and discussing a collaboration."
        },
        allowedActions: ["draft_reply", "manual_review"],
        requireProjectMatch: false,
        expectedPromotionRule: "temporary-jissbon-cross-sell"
      }
    ];

    const results = [];
    for (const scenario of scenarios) {
      const result = await processCreatorEmail({
        email: scenario.email,
        feishu: dryRunFeishu,
        openai,
        ruleStore
      });
      const projectMatched = result.projectMatches.some((project) => project.recordId === record.record_id);
      if (scenario.requireProjectMatch !== false && !projectMatched) {
        throw new Error(`${scenario.name}: client project policy was not matched.`);
      }
      if (!scenario.allowedActions.includes(result.action)) {
        throw new Error(`${scenario.name}: unexpected action ${result.action}.`);
      }
      if (scenario.expectedPromotionRule && result.promotionRule !== scenario.expectedPromotionRule) {
        throw new Error(`${scenario.name}: expected promotion rule ${scenario.expectedPromotionRule}.`);
      }
      results.push({
        name: scenario.name,
        action: result.action,
        projectMatched,
        promotionRule: result.promotionRule || ""
      });
    }

    clientLiveAcceptance = {
      status: "passed",
      projectRecordsFound: records.length,
      projectPolicyRead: true,
      writesSuppressed: true,
      scenarios: results,
      updatedAt: new Date().toISOString(),
      error: ""
    };
  } catch (error) {
    clientLiveAcceptance = {
      status: "failed",
      projectPolicyRead: false,
      writesSuppressed: true,
      scenarios: [],
      updatedAt: new Date().toISOString(),
      error: error.message
    };
  }
  return clientLiveAcceptance;
}

function isKnownTestEmail(fields) {
  const messageId = String(fields["邮件ID"] || "").toLowerCase();
  const subject = String(fields["邮件主题"] || "").toLowerCase();
  const sender = String(fields["发件人邮箱"] || "").trim().toLowerCase();
  return /^(sample-|rule-verification|creator-match-verification|outbound-approval-verification|guard-test)/.test(messageId)
    || messageId.includes("acceptance")
    || /\btest\b|测试|polling final check|polling test ready|mail event test/.test(subject)
    || /@example\.com$/.test(sender)
    || config.testRecipients.includes(sender);
}

async function auditApprovalQueue() {
  approvalQueueAudit = { status: "running", updatedAt: new Date().toISOString() };
  try {
    const [tasksData, logsData] = await Promise.all([
      feishu.listAllBitableRecords("approvalTasks", { maxRecords: 1000 }),
      feishu.listAllBitableRecords("emailLog", { maxRecords: 1000 })
    ]);
    const latestEmailLogs = (logsData.items || [])
      .slice()
      .sort((left, right) => Number(right.created_time || 0) - Number(left.created_time || 0))
      .slice(0, 5)
      .map((record) => {
        const fields = record.fields || {};
        return {
          createdAt: normalizeMailTime(record.created_time),
          emailType: String(fields["AI识别类型"] || ""),
          action: String(fields["处理动作"] || ""),
          status: String(fields["处理状态"] || ""),
          hasDraft: Boolean(String(fields["AI草稿"] || "").trim()),
          testRecord: isKnownTestEmail(fields)
        };
      });
    const tasks = tasksData.items || [];
    const mergedApprovals = (logsData.items || []).filter(
      (record) => String(record.fields?.["处理动作"] || "") === "manual_review"
    );
    let testRecords = 0;
    let realRecords = 0;
    const statusCounts = {};
    for (const record of mergedApprovals) {
      const fields = record.fields || {};
      const approvalStatus = String(fields["审批状态"] || "未设置");
      statusCounts[approvalStatus] = (statusCounts[approvalStatus] || 0) + 1;
      if (isKnownTestEmail(fields)) {
        testRecords += 1;
      } else {
        realRecords += 1;
      }
    }
    approvalQueueAudit = {
      status: "complete",
      mode: "merged_email_log",
      totalRecords: mergedApprovals.length,
      totalEmailLogs: (logsData.items || []).length,
      legacyArchivedRecords: tasks.length,
      testRecords,
      realRecords,
      unknownRecords: 0,
      statusCounts,
      latestEmailLogs,
      readOnly: true,
      updatedAt: new Date().toISOString(),
      error: ""
    };
  } catch (error) {
    approvalQueueAudit = {
      status: "failed",
      readOnly: true,
      updatedAt: new Date().toISOString(),
      error: error.message
    };
  }
  return approvalQueueAudit;
}

function normalizeMailTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    const milliseconds = raw.length <= 10 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

function formatMailTime(value) {
  const normalized = normalizeMailTime(value);
  if (!normalized) return "";
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return normalized;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).formatToParts(date).map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

async function auditMailboxInbox() {
  mailboxInboxAudit = { status: "running", updatedAt: new Date().toISOString() };
  try {
    const userToken = await getUserToken();
    if (!userToken) throw new Error("Mailbox owner authorization is unavailable.");
    const [mailData, logsData] = await Promise.all([
      feishu.listMailboxMessages({
        accessToken: userToken.accessToken,
        folderId: config.feishu.inboxFolderId,
        pageSize: 20
      }),
      feishu.listAllBitableRecords("emailLog", { maxRecords: 1000 })
    ]);
    const messages = mailData.items || mailData.messages || [];
    const logsByMessageId = new Map(
      (logsData.items || [])
        .map((record) => [String(record.fields?.["邮件ID"] || ""), record.fields || {}])
        .filter(([messageId]) => Boolean(messageId))
    );
    const visibleStates = await Promise.all(messages.map(async (item) => {
      const messageId = getMailboxMessageId(item);
      return {
        messageId,
        receivedAt: item.received_time || item.sent_time || "",
        deduped: messageId ? Boolean(await redis.exists(`polled-mail:${messageId}`)) : false,
        logFields: messageId ? logsByMessageId.get(messageId) || null : null
      };
    }));
    const recent = [];
    for (const state of visibleStates.slice(0, 5)) {
      if (!state.messageId) continue;
      const fullMessage = await feishu.getMailboxMessage({
        userMailboxId: "me",
        messageId: state.messageId,
        accessToken: userToken.accessToken
      });
      const email = mapMailboxMessage(fullMessage, state.messageId);
      const from = email.from.trim().toLowerCase();
      const to = email.to.trim().toLowerCase();
      recent.push({
        receivedAt: email.receivedAt,
        fromPresent: Boolean(from),
        toPresent: Boolean(to),
        selfSent: Boolean(from && to && from === to),
        deduped: state.deduped,
        logged: Boolean(state.logFields),
        emailType: String(state.logFields?.["AI识别类型"] || ""),
        action: String(state.logFields?.["处理动作"] || ""),
        status: String(state.logFields?.["处理状态"] || ""),
        hasDraft: Boolean(String(state.logFields?.["AI草稿"] || "").trim())
      });
    }
    mailboxInboxAudit = {
      status: "complete",
      visibleMessages: messages.length,
      unprocessedVisible: visibleStates.filter((item) => !item.deduped).length,
      unloggedVisible: visibleStates.filter((item) => !item.logFields).length,
      recent,
      readOnly: true,
      updatedAt: new Date().toISOString(),
      error: ""
    };
  } catch (error) {
    mailboxInboxAudit = {
      status: "failed",
      readOnly: true,
      updatedAt: new Date().toISOString(),
      error: error.message
    };
  }
  return mailboxInboxAudit;
}

async function reconcileMissingSenderAddresses(limit = 40) {
  senderAddressReconciliation = { status: "running", scanned: 0, corrected: 0, updatedAt: new Date().toISOString() };
  try {
    const userToken = await getUserToken();
    if (!userToken) throw new Error("Mailbox owner authorization is unavailable.");
    const logsData = await feishu.listAllBitableRecords("emailLog", { maxRecords: 1000 });
    const blankLogs = (logsData.items || []).filter((record) => !String(record.fields?.["发件人邮箱"] || "").trim());
    const messages = [];
    let pageToken = "";
    while (messages.length < limit) {
      const data = await feishu.listMailboxMessages({
        accessToken: userToken.accessToken,
        folderId: config.feishu.inboxFolderId,
        pageSize: Math.min(20, limit - messages.length),
        pageToken
      });
      const pageItems = data.items || data.messages || [];
      messages.push(...pageItems);
      const nextPageToken = String(data.page_token || data.pageToken || "");
      if (!data.has_more || !nextPageToken || !pageItems.length) break;
      pageToken = nextPageToken;
    }
    const messageById = new Map(messages.map((item) => [getMailboxMessageId(item), item]));
    let corrected = 0;
    let unresolved = 0;
    for (const record of blankLogs) {
      const messageId = String(record.fields?.["邮件ID"] || "");
      if (!messageId || !messageById.has(messageId)) {
        unresolved += 1;
        continue;
      }
      const fullMessage = await feishu.getMailboxMessage({
        userMailboxId: "me",
        messageId,
        accessToken: userToken.accessToken
      });
      const email = mapMailboxMessage(fullMessage, messageId);
      if (!email.from) {
        unresolved += 1;
        continue;
      }
      await feishu.updateBitableRecord("emailLog", record.record_id, { "发件人邮箱": email.from });
      corrected += 1;
    }
    senderAddressReconciliation = {
      status: "complete",
      scanned: blankLogs.length,
      corrected,
      unresolved,
      updatedAt: new Date().toISOString(),
      error: ""
    };
  } catch (error) {
    senderAddressReconciliation = {
      status: "failed",
      scanned: 0,
      corrected: 0,
      unresolved: 0,
      updatedAt: new Date().toISOString(),
      error: error.message
    };
  }
  return senderAddressReconciliation;
}

async function reconcileMissingDrafts(limit = 40) {
  missingDraftReconciliation = { status: "running", scanned: 0, corrected: 0, updatedAt: new Date().toISOString() };
  try {
    const userToken = await getUserToken();
    if (!userToken) throw new Error("Mailbox owner authorization is unavailable.");
    const [logsData, tasksData] = await Promise.all([
      feishu.listAllBitableRecords("emailLog", { maxRecords: 1000 }),
      feishu.listAllBitableRecords("approvalTasks", { maxRecords: 1000 })
    ]);
    const blankLogs = (logsData.items || []).filter((record) => {
      const fields = record.fields || {};
      return ["draft_reply", "manual_review"].includes(String(fields["处理动作"] || ""))
        && !String(fields["AI草稿"] || "").trim();
    });
    const tasksByMessageId = new Map(
      (tasksData.items || []).map((task) => [String(task.fields?.["关联邮件ID"] || ""), task])
    );
    const messages = [];
    let pageToken = "";
    while (messages.length < limit) {
      const data = await feishu.listMailboxMessages({
        accessToken: userToken.accessToken,
        folderId: config.feishu.inboxFolderId,
        pageSize: Math.min(20, limit - messages.length),
        pageToken
      });
      const pageItems = data.items || data.messages || [];
      messages.push(...pageItems);
      const nextPageToken = String(data.page_token || data.pageToken || "");
      if (!data.has_more || !nextPageToken || !pageItems.length) break;
      pageToken = nextPageToken;
    }
    const messageIds = new Set(messages.map(getMailboxMessageId).filter(Boolean));
    const dryRunFeishu = dryRunFeishuClient();
    let corrected = 0;
    let unresolved = 0;
    for (const record of blankLogs) {
      const messageId = String(record.fields?.["邮件ID"] || "");
      if (!messageId || !messageIds.has(messageId)) {
        unresolved += 1;
        continue;
      }
      const fullMessage = await feishu.getMailboxMessage({
        userMailboxId: "me",
        messageId,
        accessToken: userToken.accessToken
      });
      const email = mapMailboxMessage(fullMessage, messageId);
      const result = await processCreatorEmail({ email, feishu: dryRunFeishu, openai, ruleStore });
      const draft = String(result.analysis?.draftReply || "").trim();
      if (!draft) {
        unresolved += 1;
        continue;
      }
      await feishu.updateBitableRecord("emailLog", record.record_id, {
        "AI草稿": draft,
        "AI摘要": String(result.analysis?.summary || record.fields?.["AI摘要"] || "")
      });
      const task = tasksByMessageId.get(messageId);
      if (task?.record_id) {
        await feishu.updateBitableRecord("approvalTasks", task.record_id, { "AI草稿": draft });
      }
      corrected += 1;
    }
    missingDraftReconciliation = {
      status: "complete",
      scanned: blankLogs.length,
      corrected,
      unresolved,
      updatedAt: new Date().toISOString(),
      error: ""
    };
  } catch (error) {
    missingDraftReconciliation = {
      status: "failed",
      scanned: 0,
      corrected: 0,
      unresolved: 0,
      updatedAt: new Date().toISOString(),
      error: error.message
    };
  }
  return missingDraftReconciliation;
}

async function reconcileHistoricalContext(limit = 40) {
  historicalContextReconciliation = { status: "running", scanned: 0, corrected: 0, updatedAt: new Date().toISOString() };
  try {
    const userToken = await getUserToken();
    if (!userToken) throw new Error("Mailbox owner authorization is unavailable.");
    const [logsData, tasksData, actionLogsData] = await Promise.all([
      feishu.listAllBitableRecords("emailLog", { maxRecords: 1000 }),
      feishu.listAllBitableRecords("approvalTasks", { maxRecords: 1000 }),
      feishu.listAllBitableRecords("actionLogs", { maxRecords: 1000 })
    ]);
    const messages = await listMailboxHistory(userToken, limit);
    const messageIds = new Set(messages.map(getMailboxMessageId).filter(Boolean));
    const tasksByMessageId = new Map(
      (tasksData.items || []).map((task) => [String(task.fields?.["关联邮件ID"] || ""), task])
    );
    const sentTimesByMessageId = new Map(
      (actionLogsData.items || [])
        .filter((record) => String(record.fields?.["事件类型"] || "") === "approved_mail_sent")
        .map((record) => [
          String(record.fields?.["关联邮件ID"] || ""),
          formatMailTime(record.created_time || record.createdTime || record.last_modified_time || record.lastModifiedTime)
        ])
        .filter(([messageId, sentAt]) => Boolean(messageId && sentAt))
    );
    const dryRunFeishu = dryRunFeishuClient();
    let corrected = 0;
    let unresolved = 0;
    for (const record of logsData.items || []) {
      const messageId = String(record.fields?.["邮件ID"] || "");
      if (!messageId || !messageIds.has(messageId)) {
        unresolved += 1;
        continue;
      }
      const fullMessage = await feishu.getMailboxMessage({
        userMailboxId: "me",
        messageId,
        accessToken: userToken.accessToken
      });
      const email = mapMailboxMessage(fullMessage, messageId);
      const result = await processCreatorEmail({ email, feishu: dryRunFeishu, openai, ruleStore });
      const matchedProjectText = (result.projectMatches || [])
        .map((project) => [project.brand, project.product, project.campaign].filter(Boolean).join(" / "))
        .filter(Boolean)
        .join("; ");
      const updateFields = {
        "邮件概览": formatEmailOverview(email),
        "发件人邮箱": email.from || "",
        "收件人邮箱": email.to || "",
        "邮件主题": email.subject || "",
        "邮件正文": String(email.text || "").slice(0, 20000),
        "接收时间": email.receivedAt || "",
        "匹配项目": matchedProjectText,
        "命中规则": result.matchedRule || "",
        "数据完整性": email.from && (email.subject || email.text) ? "complete" : "incomplete_source"
      };
      const replySentAt = sentTimesByMessageId.get(messageId) || "";
      if (replySentAt) updateFields["回复发送时间"] = replySentAt;
      await feishu.updateBitableRecord("emailLog", record.record_id, updateFields);
      const task = tasksByMessageId.get(messageId);
      if (task?.record_id) {
        await feishu.updateBitableRecord("approvalTasks", task.record_id, {
          "发件人邮箱": email.from || "",
          "原邮件主题": email.subject || "",
          "原邮件正文": String(email.text || "").slice(0, 20000),
          "接收时间": email.receivedAt || "",
          ...(replySentAt ? { "回复发送时间": replySentAt } : {}),
          "匹配项目": matchedProjectText
        });
      }
      corrected += 1;
    }
    historicalContextReconciliation = {
      status: "complete",
      scanned: (logsData.items || []).length,
      corrected,
      unresolved,
      updatedAt: new Date().toISOString(),
      error: ""
    };
  } catch (error) {
    historicalContextReconciliation = {
      status: "failed",
      scanned: 0,
      corrected: 0,
      unresolved: 0,
      updatedAt: new Date().toISOString(),
      error: error.message
    };
  }
  return historicalContextReconciliation;
}

async function reconcileManualReviewLogs() {
  manualReviewReconciliation = { status: "running", updatedAt: new Date().toISOString() };
  try {
    const [logsData, tasksData] = await Promise.all([
      feishu.listAllBitableRecords("emailLog", { maxRecords: 1000 }),
      feishu.listAllBitableRecords("approvalTasks", { maxRecords: 1000 })
    ]);
    const tasksByMessageId = new Map(
      (tasksData.items || []).map((task) => [String(task.fields?.["关联邮件ID"] || ""), task.fields || {}])
    );
    let correctedLogs = 0;
    let migratedApprovals = 0;
    for (const record of logsData.items || []) {
      const fields = record.fields || {};
      const intent = String(fields["AI识别类型"] || "");
      const action = String(fields["处理动作"] || "");
      const messageId = String(fields["邮件ID"] || "");
      if (!messageId || (action !== "manual_review" && !requiresManualReviewIntent(intent))) continue;
      const task = tasksByMessageId.get(messageId) || {};
      const updateFields = {
        "处理动作": "manual_review",
        "风险等级": "High",
        "处理状态": String(fields["处理状态"] || "") === "已发送" ? "已发送" : "待人工确认",
        "人工修改稿": String(fields["人工修改稿"] || task["人工修改稿"] || ""),
        "是否允许发送": isChecked(fields["是否允许发送"]) || isChecked(task["是否允许发送"]),
        "审批状态": String(fields["审批状态"] || task["任务状态"] || "待处理"),
        "负责人": String(fields["负责人"] || task["负责人"] || ""),
        "人工备注": String(fields["人工备注"] || task["人工备注"] || "")
      };
      await feishu.updateBitableRecord("emailLog", record.record_id, updateFields);
      if (action !== "manual_review") correctedLogs += 1;
      if (Object.keys(task).length) migratedApprovals += 1;
    }
    manualReviewReconciliation = {
      status: "complete",
      correctedLogs,
      createdTasks: 0,
      migratedApprovals,
      updatedAt: new Date().toISOString(),
      error: ""
    };
  } catch (error) {
    manualReviewReconciliation = {
      status: "failed",
      correctedLogs: 0,
      createdTasks: 0,
      updatedAt: new Date().toISOString(),
      error: error.message
    };
  }
  return manualReviewReconciliation;
}

async function auditDataIntegrity() {
  dataIntegrityAudit = { status: "running", updatedAt: new Date().toISOString() };
  try {
    const [logsData, tasksData] = await Promise.all([
      feishu.listAllBitableRecords("emailLog", { maxRecords: 1000 }),
      feishu.listAllBitableRecords("approvalTasks", { maxRecords: 1000 })
    ]);
    const logs = logsData.items || [];
    const tasks = tasksData.items || [];
    const productionLogs = logs.filter((record) => !isKnownTestEmail(record.fields || {}));
    const productionMessageIds = new Set(
      productionLogs.map((record) => String(record.fields?.["邮件ID"] || "")).filter(Boolean)
    );
    const allMessageIds = new Set(
      logs.map((record) => String(record.fields?.["邮件ID"] || "")).filter(Boolean)
    );
    const productionTasks = tasks.filter((task) => productionMessageIds.has(String(task.fields?.["关联邮件ID"] || "")));
    const logCounts = new Map();
    const taskCounts = new Map();
    for (const record of productionLogs) {
      const messageId = String(record.fields?.["邮件ID"] || "");
      if (messageId) logCounts.set(messageId, (logCounts.get(messageId) || 0) + 1);
    }
    for (const task of productionTasks) {
      const messageId = String(task.fields?.["关联邮件ID"] || "");
      if (messageId) taskCounts.set(messageId, (taskCounts.get(messageId) || 0) + 1);
    }
    const duplicateEmailLogs = [...logCounts.values()].filter((count) => count > 1).length;
    const duplicateApprovalTasks = [...taskCounts.values()].filter((count) => count > 1).length;
    const missingMessageIds = productionLogs.filter((record) => !String(record.fields?.["邮件ID"] || "")).length;
    const missingSenders = productionLogs.filter((record) => !String(record.fields?.["发件人邮箱"] || "")).length;
    const missingBodies = productionLogs.filter((record) => !String(record.fields?.["邮件正文"] || "").trim()).length;
    const missingDrafts = productionLogs.filter((record) => {
      const fields = record.fields || {};
      return ["draft_reply", "manual_review"].includes(String(fields["处理动作"] || ""))
        && !String(fields["AI草稿"] || "").trim();
    }).length;
    const manualLogsMissingApproval = productionLogs.filter((record) => {
      const fields = record.fields || {};
      return String(fields["处理动作"] || "") === "manual_review"
        && !String(fields["审批状态"] || "").trim();
    }).length;
    const orphanApprovalTasks = 0;
    const missingApprovalContext = productionLogs.filter((record) => {
      const fields = record.fields || {};
      if (String(fields["处理动作"] || "") !== "manual_review") return false;
      return !String(fields["发件人邮箱"] || "")
        || !String(fields["邮件正文"] || "").trim()
        || !String(fields["AI草稿"] || "").trim();
    }).length;
    const receivedTimeCount = productionLogs.filter((record) => String(record.fields?.["接收时间"] || "").trim()).length;
    const sentProductionLogs = productionLogs.filter((record) => String(record.fields?.["处理状态"] || "") === "已发送");
    const replySentTimeCount = sentProductionLogs.filter((record) => String(record.fields?.["回复发送时间"] || "").trim()).length;
    const issues = {
      duplicateEmailLogs,
      duplicateApprovalTasks,
      missingMessageIds,
      missingSenders,
      missingBodies,
      missingDrafts,
      manualLogsMissingApproval,
      orphanApprovalTasks,
      missingApprovalContext
    };
    const issueCount = Object.values(issues).reduce((sum, value) => sum + Number(value || 0), 0);
    dataIntegrityAudit = {
      status: issueCount === 0 ? "passed" : "failed",
      emailLogs: logs.length,
      productionEmailLogs: productionLogs.length,
      testEmailLogs: logs.length - productionLogs.length,
      approvalTasks: tasks.length,
      approvalMode: "merged_email_log",
      legacyApprovalTasks: tasks.length,
      timeCoverage: {
        received: receivedTimeCount,
        receivedExpected: productionLogs.length,
        replySent: replySentTimeCount,
        replySentExpected: sentProductionLogs.length
      },
      issues,
      issueCount,
      updatedAt: new Date().toISOString(),
      error: ""
    };
  } catch (error) {
    dataIntegrityAudit = {
      status: "failed",
      issues: {},
      issueCount: -1,
      updatedAt: new Date().toISOString(),
      error: error.message
    };
  }
  return dataIntegrityAudit;
}

function historicalPolicyViolation(email, result) {
  const text = `${email.subject || ""}\n${email.text || ""}`.toLowerCase();
  const violations = [];
  const manualSignal = /\brate card\b|\brate\b|quote|pricing|price|\bfee\b|budget|paid collaboration|agreement|contract|payment|invoice|legal/.test(text);
  const autoReplySignal = /out of office|automatic reply|auto reply/.test(text);
  const stopContactSignal = /unsubscribe|remove me|stop contacting/.test(text);
  if (manualSignal && result.action !== "manual_review") {
    violations.push("manual-review email was not routed to manual_review");
  }
  if (requiresManualReviewIntent(result.intent) && result.action !== "manual_review") {
    violations.push("commercial or risk intent was not routed to manual_review");
  }
  if (autoReplySignal && result.action !== "no_reply") {
    violations.push("automatic reply was not routed to no_reply");
  }
  if (stopContactSignal && result.action !== "record_only") {
    violations.push("stop-contact email was not routed to record_only");
  }
  if (requiresNoReplyIntent(result.intent) && result.action !== "no_reply") {
    violations.push("system or verification email was not routed to no_reply");
  }
  if (["draft_reply", "manual_review"].includes(result.action) && !String(result.analysis?.draftReply || "").trim()) {
    violations.push("actionable email did not produce a draft");
  }
  if (!["no_reply", "record_only", "draft_reply", "manual_review"].includes(result.action)) {
    violations.push("workflow returned an unsupported action");
  }
  if (!(result.projectMatches || []).length && !["manual_review", "no_reply", "record_only"].includes(result.action)) {
    violations.push("unmatched project email was allowed to draft automatically");
  }
  return violations;
}

async function runHistoricalReplayAcceptance(limit = 40, offset = 0) {
  const rangeStart = offset + 1;
  const rangeEnd = offset + limit;
  const cacheKey = `historical-replay-${rangeStart}-${rangeEnd}-20260712-v3`;
  if (redis.isConfigured()) {
    try {
      const cached = await redis.getJson(cacheKey);
      if (cached?.status === "passed" && Number(cached.processed || 0) >= limit && Number(cached.offset || 0) === offset) {
        historicalReplayAcceptance = { ...cached, cached: true };
        return historicalReplayAcceptance;
      }
    } catch (error) {
      console.error("Historical replay cache read failed:", error.message);
    }
  }
  historicalReplayAcceptance = {
    status: "running",
    requested: limit,
    offset,
    range: `${rangeStart}-${rangeEnd}`,
    processed: 0,
    updatedAt: new Date().toISOString()
  };
  try {
    const userToken = await getUserToken();
    if (!userToken) throw new Error("Mailbox owner authorization is unavailable.");
    const messages = [];
    let pageToken = "";
    const targetMessageCount = offset + limit;
    while (messages.length < targetMessageCount) {
      const pageSize = Math.min(20, targetMessageCount - messages.length);
      const data = await feishu.listMailboxMessages({
        accessToken: userToken.accessToken,
        folderId: config.feishu.inboxFolderId,
        pageSize,
        pageToken
      });
      const pageItems = data.items || data.messages || [];
      messages.push(...pageItems);
      const nextPageToken = String(data.page_token || data.pageToken || "");
      if (!data.has_more || !nextPageToken || !pageItems.length) break;
      pageToken = nextPageToken;
    }
    const selectedMessages = messages.slice(offset, offset + limit);
    const dryRunFeishu = dryRunFeishuClient();
    const results = [];
    const errors = [];
    const violations = [];
    if (selectedMessages.length < limit) {
      errors.push({ sample: 0, error: `Only ${selectedMessages.length} messages were available for range ${rangeStart}-${rangeEnd}.` });
    }
    for (let index = 0; index < selectedMessages.length; index += 1) {
      const sampleNumber = offset + index + 1;
      const messageId = getMailboxMessageId(selectedMessages[index]);
      try {
        const fullMessage = await feishu.getMailboxMessage({
          userMailboxId: "me",
          messageId,
          accessToken: userToken.accessToken
        });
        const email = mapMailboxMessage(fullMessage, messageId);
        const result = await processCreatorEmail({
          email,
          feishu: dryRunFeishu,
          openai,
          ruleStore
        });
        const itemViolations = historicalPolicyViolation(email, result);
        if (itemViolations.length) {
          violations.push({ sample: sampleNumber, reasons: itemViolations });
        }
        results.push({
          sample: sampleNumber,
          intent: result.intent,
          action: result.action,
          hasDraft: Boolean(String(result.analysis?.draftReply || "").trim()),
          projectMatched: Boolean((result.projectMatches || []).length),
          passed: itemViolations.length === 0
        });
      } catch (error) {
        errors.push({ sample: sampleNumber, error: error.message });
      }
      historicalReplayAcceptance = {
        ...historicalReplayAcceptance,
        processed: index + 1,
        updatedAt: new Date().toISOString()
      };
    }
    const passed = errors.length === 0 && violations.length === 0 && results.length === limit;
    const batches = [
      { from: rangeStart, to: Math.min(rangeStart + 19, rangeEnd) },
      ...(limit > 20 ? [{ from: rangeStart + 20, to: rangeEnd }] : [])
    ].map((batch) => {
      const batchResults = results.filter((item) => item.sample >= batch.from && item.sample <= batch.to);
      const batchViolations = violations.filter((item) => item.sample >= batch.from && item.sample <= batch.to);
      const batchErrors = errors.filter((item) => item.sample >= batch.from && item.sample <= batch.to);
      return {
        range: `${batch.from}-${batch.to}`,
        processed: batch.to - batch.from + 1,
        passed: batchResults.filter((item) => item.passed).length,
        failed: batchViolations.length + batchErrors.length
      };
    });
    historicalReplayAcceptance = {
      status: passed ? "passed" : "failed",
      requested: limit,
      offset,
      range: `${rangeStart}-${rangeEnd}`,
      processed: selectedMessages.length,
      writesSuppressed: true,
      sendsSuppressed: true,
      passedSamples: results.filter((item) => item.passed).length,
      failedSamples: limit - results.filter((item) => item.passed).length,
      actionCounts: results.reduce((counts, item) => {
        counts[item.action] = (counts[item.action] || 0) + 1;
        return counts;
      }, {}),
      batches,
      results,
      violations,
      errors,
      updatedAt: new Date().toISOString(),
      error: passed ? "" : "Historical replay acceptance found failures."
    };
  } catch (error) {
    historicalReplayAcceptance = {
      status: "failed",
      requested: limit,
      offset,
      range: `${rangeStart}-${rangeEnd}`,
      processed: 0,
      writesSuppressed: true,
      sendsSuppressed: true,
      results: [],
      violations: [],
      errors: [],
      updatedAt: new Date().toISOString(),
      error: error.message
    };
  }
  if (historicalReplayAcceptance.status === "passed" && redis.isConfigured()) {
    try {
      await redis.setJson(cacheKey, historicalReplayAcceptance, { ex: 60 * 60 * 24 * 30 });
    } catch (error) {
      console.error("Historical replay cache write failed:", error.message);
    }
  }
  return historicalReplayAcceptance;
}

async function processApprovedTasks() {
  const logsData = await feishu.listAllBitableRecords("emailLog", { maxRecords: 1000 });
  const candidates = (logsData.items || []).filter((record) => {
    const fields = record.fields || {};
    const status = String(fields["审批状态"] || "");
    const eligibleStatus = ["待处理", "待人工确认", "已批准", "待发送"].includes(status)
      || (!config.safeTestMode && status === "安全模式拦截");
    return isChecked(fields["是否允许发送"]) && eligibleStatus;
  });
  if (!candidates.length) return { checked: 0, sent: 0, failed: 0, safeModeSkipped: 0 };
  const userToken = await getUserToken();
  if (!userToken) throw new Error("Mailbox owner authorization is required before sending approved mail.");

  let sent = 0;
  let failed = 0;
  let safeModeSkipped = 0;
  for (const emailLog of candidates) {
    const fields = emailLog.fields || {};
    const messageId = String(fields["邮件ID"] || "");
    const recipient = String(fields["发件人邮箱"] || "").trim();
    const draft = String(fields["人工修改稿"] || fields["AI草稿"] || "").trim();
    if (!recipient || !draft) {
      await feishu.updateBitableRecord("emailLog", emailLog.record_id, { "审批状态": "发送资料不完整" });
      continue;
    }
    const recipientAllowed = config.testRecipients.includes(recipient.toLowerCase());
    if (config.safeTestMode && !recipientAllowed) {
      safeModeSkipped += 1;
      await feishu.updateBitableRecord("emailLog", emailLog.record_id, { "审批状态": "安全模式拦截" });
      await recordOutbound({
        status: "blocked_by_safe_test_mode",
        recipient,
        messageId,
        apiAccepted: false,
        error: "Recipient is not in TEST_RECIPIENTS while SAFE_TEST_MODE is enabled."
      });
      continue;
    }
    const originalSubject = String(fields["邮件主题"] || "");
    const subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
    await recordOutbound({ status: "sending", recipient, subject, messageId, apiAccepted: false, error: "" });
    let result;
    try {
      result = await feishu.sendMailboxMessage({
        accessToken: userToken.accessToken,
        to: recipient,
        subject,
        bodyPlainText: draft,
        dedupeKey: `approval-email-log-${emailLog.record_id}-${messageId}`
      });
    } catch (error) {
      failed += 1;
      await recordOutbound({
        status: "api_failed",
        recipient,
        subject,
        messageId,
        apiAccepted: false,
        error: error.message
      });
      await feishu.updateBitableRecord("emailLog", emailLog.record_id, { "审批状态": "发送失败" });
      await feishu.createBitableRecord("actionLogs", {
        "事件类型": "approved_mail_send_failed",
        "事件来源": "email_log_approval",
        "操作内容": subject,
        "操作结果": "failed",
        "错误信息": error.message,
        "关联邮件ID": messageId
      });
      continue;
    }
    await recordOutbound({
      status: "api_accepted",
      recipient,
      subject,
      messageId,
      apiAccepted: true,
      providerMessageId: result.message_id || "",
      error: ""
    });
    const replySentAt = formatMailTime(Date.now());
    await feishu.updateBitableRecord("emailLog", emailLog.record_id, {
      "处理状态": "已发送",
      "审批状态": "已发送",
      "回复发送时间": replySentAt
    });
    await feishu.createBitableRecord("actionLogs", {
      "事件类型": "approved_mail_sent",
      "事件来源": "email_log_approval",
      "操作内容": subject,
      "操作结果": result.message_id || "sent",
      "错误信息": "",
      "关联邮件ID": messageId
    });
    sent += 1;
  }
  return { checked: candidates.length, sent, failed, safeModeSkipped };
}

async function runMailboxWork(reason) {
  const lockName = "mailbox-work-lock";
  const lockToken = randomUUID();
  const locked = redis.isConfigured() ? await redis.acquireLock(lockName, lockToken, 900) : true;
  if (!locked) {
    return {
      poll: { status: "already_running", processed: 0 },
      approvals: { checked: 0, sent: 0, safeModeSkipped: 0 }
    };
  }
  try {
    const poll = await pollMailbox();
    await reconcileManualReviewLogs();
    const approvals = await processApprovedTasks();
    await auditApprovalQueue();
    await auditMailboxInbox();
    await auditDataIntegrity();
    console.log(`Mailbox work (${reason}):`, poll.status, approvals.sent);
    return { poll, approvals };
  } finally {
    if (redis.isConfigured()) await redis.releaseLock(lockName, lockToken).catch(() => {});
  }
}

function scheduleMailboxPoll(reason) {
  runMailboxWork(reason)
    .then((result) => console.log(`Mailbox work complete (${reason}):`, result.poll.processed || result.poll.seen || 0))
    .catch((error) => {
      lastMailboxPoll = { status: "failed", error: error.message, updatedAt: new Date().toISOString() };
      console.error(`Mailbox poll (${reason}) failed:`, error.message);
    });
}

async function processMailboxEvent(body) {
  const event = body.event || body;
  const eventId = body.header?.event_id || body.event_id || eventValue(event, ["event_id"]);
  const messageId = eventValue(event, ["message_id", "mail_message_id"]);
  const mailboxId = eventValue(event, ["user_mailbox_id", "mailbox_id"]) || "me";
  if (!messageId) {
    console.warn("Feishu mail event did not include a message id.");
    return;
  }
  const dedupeKey = `mail-event:${eventId || messageId}`;
  if (await redis.exists(dedupeKey) || await redis.exists(`polled-mail:${messageId}`)) return;

  const userToken = await getUserToken();
  if (!userToken) {
    throw new Error("Mailbox owner authorization is required before processing mail events.");
  }
  await processMailboxMessageOnce({ messageId, mailboxId, userToken });
  await redis.set(dedupeKey, "1", { ex: 60 * 60 * 24 * 30 });
}

async function recordMailboxEvent(update) {
  lastMailboxEvent = {
    ...lastMailboxEvent,
    ...update,
    updatedAt: new Date().toISOString()
  };
  try {
    await redis.setJson("last-mailbox-event", lastMailboxEvent, { ex: 60 * 60 * 24 * 7 });
  } catch (error) {
    console.error("Could not persist mailbox event diagnostics:", error.message);
  }
}

async function handleFeishuWebhook(req, res) {
  const body = await readJson(req);
  if (body.challenge) {
    return sendJson(res, 200, { challenge: body.challenge });
  }
  const eventType = body.header?.event_type || body.type || "";
  const messageId = eventValue(body.event || body, ["message_id", "mail_message_id"]);
  await recordMailboxEvent({
    status: "callback_received",
    eventType,
    messageIdPresent: Boolean(messageId),
    error: ""
  });
  const token = body.token || body.header?.token;
  if (config.feishu.verificationToken && token !== config.feishu.verificationToken) {
    await recordMailboxEvent({ status: "rejected_invalid_verification_token", error: "verification token mismatch" });
    return sendJson(res, 401, { ok: false, error: "invalid_feishu_token" });
  }
  sendJson(res, 200, { ok: true, received: true });
  if (eventType.includes("user_mailbox") || eventValue(body.event || body, ["message_id", "mail_message_id"])) {
    await recordMailboxEvent({
      status: "webhook_received",
      eventType,
      messageIdPresent: Boolean(messageId),
      error: ""
    });
    processMailboxEvent(body)
      .then(() => recordMailboxEvent({ status: "processed", error: "" }))
      .catch(async (error) => {
        await recordMailboxEvent({ status: "failed", error: error.message });
        console.error("Feishu mailbox event failed:", error.message);
      });
  }
}

async function handleFeishuAuthorizationStart(res) {
  if (!redis.isConfigured()) {
    return sendJson(res, 503, { ok: false, error: "redis_required_for_mailbox_authorization" });
  }
  const redirectUri = getOAuthRedirectUri();
  if (!redirectUri) {
    return sendJson(res, 503, { ok: false, error: "missing_feishu_oauth_redirect_uri" });
  }
  const state = randomUUID();
  await redis.set(`feishu-oauth-state:${state}`, "1", { ex: 600 });
  return sendRedirect(res, feishu.getAuthorizationUrl({
    redirectUri,
    state,
    scopes: config.feishu.oauthScopes
  }));
}

async function handleFeishuAuthorizationCallback(res, query) {
  const code = query.get("code");
  const state = query.get("state");
  if (!code || !state || !(await redis.exists(`feishu-oauth-state:${state}`))) {
    return sendJson(res, 400, { ok: false, error: "invalid_or_expired_oauth_state" });
  }
  await redis.del(`feishu-oauth-state:${state}`);
  const tokenData = await feishu.exchangeAuthorizationCode(code);
  const record = await saveUserToken(tokenData);
  return sendText(res, 200, `Feishu mailbox authorization completed for ${record.userId || "the selected mailbox"}. You can close this page.`);
}

async function handleMailboxConnectionTest(res, query) {
  if (!verifyCronToken(query)) {
    return sendJson(res, 401, { ok: false, error: "invalid_cron_token" });
  }
  const userToken = await getUserToken();
  if (!userToken) {
    return sendJson(res, 409, { ok: false, error: "mailbox_owner_authorization_required" });
  }
  const data = await feishu.listMailboxMessages({
    accessToken: userToken.accessToken,
    folderId: config.feishu.inboxFolderId,
    pageSize: 1
  });
  const items = data.items || data.messages || [];
  return sendJson(res, 200, {
    ok: true,
    connected: true,
    mailboxProbe: "read_only",
    messagesVisible: Array.isArray(items) ? items.length : 0
  });
}

async function handleMailboxEventStatus(res, query) {
  if (!verifyCronToken(query)) {
    return sendJson(res, 401, { ok: false, error: "invalid_cron_token" });
  }
  const stored = await redis.getJson("last-mailbox-event");
  const event = stored || lastMailboxEvent;
  return sendJson(res, 200, {
    ok: true,
    event: {
      status: event.status || "not_received",
      eventType: event.eventType || "",
      messageIdPresent: Boolean(event.messageIdPresent),
      updatedAt: event.updatedAt || "",
      error: event.error || ""
    }
  });
}

async function handleMailboxOutboundStatus(res, query) {
  if (!verifyCronToken(query)) {
    return sendJson(res, 401, { ok: false, error: "invalid_cron_token" });
  }
  const stored = await redis.getJson("last-mail-outbound");
  const outbound = stored || lastOutbound;
  return sendJson(res, 200, {
    ok: true,
    outbound: {
      status: outbound.status || "not_attempted",
      recipient: outbound.recipient || "",
      subject: outbound.subject || "",
      messageId: outbound.messageId || "",
      providerMessageId: outbound.providerMessageId || "",
      apiAccepted: Boolean(outbound.apiAccepted),
      updatedAt: outbound.updatedAt || "",
      error: outbound.error || ""
    },
    deliveryConfirmation: "The Feishu send API confirms acceptance only; recipient mailbox delivery must be verified in the sender's Sent folder or recipient mailbox."
  });
}

async function handleMailboxFolders(res, query) {
  if (!verifyCronToken(query)) {
    return sendJson(res, 401, { ok: false, error: "invalid_cron_token" });
  }
  const userToken = await getUserToken();
  if (!userToken) {
    return sendJson(res, 409, { ok: false, error: "mailbox_owner_authorization_required" });
  }
  const data = await feishu.listMailboxFolders({ accessToken: userToken.accessToken });
  const folders = data.items || data.folders || [];
  return sendJson(res, 200, {
    ok: true,
    folders: folders.map((folder) => ({
      id: folder.folder_id || folder.id || "",
      name: folder.name || "",
      type: folder.type || ""
    }))
  });
}

async function handleRecentMailboxMessages(res, query) {
  if (!verifyCronToken(query)) {
    return sendJson(res, 401, { ok: false, error: "invalid_cron_token" });
  }
  const userToken = await getUserToken();
  if (!userToken) {
    return sendJson(res, 409, { ok: false, error: "mailbox_owner_authorization_required" });
  }
  const data = await feishu.listMailboxMessages({
    accessToken: userToken.accessToken,
    folderId: config.feishu.inboxFolderId,
    pageSize: 20
  });
  const messages = data.items || data.messages || [];
  const first = messages[0] || {};
  return sendJson(res, 200, {
    ok: true,
    messageShape: Object.fromEntries(Object.entries(first).map(([key, value]) => [
      key,
      value && typeof value === "object" ? Object.keys(value) : typeof value
    ])),
    messages: messages.map((message) => ({
      id: getMailboxMessageId(message),
      subject: message.subject || "",
      receivedAt: message.received_time || message.sent_time || ""
    }))
  });
}

async function handleLatestTestMailboxMessage(res, query) {
  if (!verifyCronToken(query)) {
    return sendJson(res, 401, { ok: false, error: "invalid_cron_token" });
  }
  const userToken = await getUserToken();
  if (!userToken) {
    return sendJson(res, 409, { ok: false, error: "mailbox_owner_authorization_required" });
  }
  const data = await feishu.listMailboxMessages({
    accessToken: userToken.accessToken,
    folderId: config.feishu.inboxFolderId,
    pageSize: 20
  });
  for (const item of data.items || data.messages || []) {
    const messageId = getMailboxMessageId(item);
    if (!messageId) continue;
    const fullMessage = await feishu.getMailboxMessage({
      userMailboxId: "me",
      messageId,
      accessToken: userToken.accessToken
    });
    const email = mapMailboxMessage(fullMessage, messageId);
    if (!/^(MAIL EVENT TEST|POLLING TEST READY|POLLING FINAL CHECK)/i.test(email.subject || "")) continue;
    const result = await processCreatorEmail({ email, feishu, openai, ruleStore });
    await redis.set(`polled-mail:${messageId}`, "1", { ex: 60 * 60 * 24 * 90 });
    return sendJson(res, 200, {
      ok: true,
      processed: true,
      subject: email.subject,
      action: result.action
    });
  }
  return sendJson(res, 404, { ok: false, error: "no_test_email_found_in_recent_messages" });
}

async function handleMailboxMessageShape(res, query) {
  if (!verifyCronToken(query)) {
    return sendJson(res, 401, { ok: false, error: "invalid_cron_token" });
  }
  const userToken = await getUserToken();
  if (!userToken) {
    return sendJson(res, 409, { ok: false, error: "mailbox_owner_authorization_required" });
  }
  const data = await feishu.listMailboxMessages({
    accessToken: userToken.accessToken,
    folderId: config.feishu.inboxFolderId,
    pageSize: 1
  });
  const messageId = getMailboxMessageId((data.items || data.messages || [])[0]);
  const fullMessage = await feishu.getMailboxMessage({ userMailboxId: "me", messageId, accessToken: userToken.accessToken });
  const describe = (value) => Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [
    key,
    item && typeof item === "object" && !Array.isArray(item) ? Object.keys(item) : typeof item
  ]));
  return sendJson(res, 200, { ok: true, root: describe(fullMessage), message: describe(fullMessage.message) });
}

async function handlePollEmail(req, res, query) {
  if (!verifyCronToken(query)) {
    return sendJson(res, 401, { ok: false, error: "invalid_cron_token" });
  }

  const result = await runMailboxWork("manual");
  return sendJson(res, 200, { ok: true, ...result });
}

async function route(req, res) {
  const { path, query } = getPathAndQuery(req);

  if (req.method === "GET" && path === "/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "creator-mail-ai-workflow",
      safeTestMode: config.safeTestMode,
      redisConfigured: redis.isConfigured(),
      mailboxOAuthRedirectConfigured: Boolean(getOAuthRedirectUri()),
      outboundTracking: "enabled",
      publicSampleProcessing: false,
      mailboxPoll: {
        status: lastMailboxPoll.status || "not_started",
        processed: Number(lastMailboxPoll.processed || 0),
        seen: Number(lastMailboxPoll.seen || 0),
        updatedAt: lastMailboxPoll.updatedAt || "",
        error: lastMailboxPoll.error || ""
      },
      clientIntakeSetup,
      clientLiveAcceptance,
      approvalQueueAudit,
      mailboxInboxAudit,
      manualReviewReconciliation,
      historicalReplayAcceptance,
      senderAddressReconciliation,
      missingDraftReconciliation,
      dataIntegrityAudit,
      operationalSchemaAudit,
      historicalContextReconciliation,
      missingConfig: getMissingConfig(config)
    });
  }

  if (req.method === "GET" && path === "/cron/keepalive") {
    scheduleMailboxPoll("keepalive");
    return sendText(res, 200, "ok");
  }

  if (req.method === "POST" && path === "/webhook/feishu") {
    return handleFeishuWebhook(req, res);
  }

  if (req.method === "GET" && path === "/auth/feishu/start") {
    return handleFeishuAuthorizationStart(res);
  }

  if (req.method === "GET" && path === "/auth/feishu/callback") {
    return handleFeishuAuthorizationCallback(res, query);
  }

  if (req.method === "GET" && path === "/debug/mail/connection") {
    return handleMailboxConnectionTest(res, query);
  }

  if (req.method === "GET" && path === "/debug/mail/event-status") {
    return handleMailboxEventStatus(res, query);
  }

  if (req.method === "GET" && path === "/debug/mail/outbound-status") {
    return handleMailboxOutboundStatus(res, query);
  }

  if (req.method === "GET" && path === "/debug/mail/folders") {
    return handleMailboxFolders(res, query);
  }

  if (req.method === "GET" && path === "/debug/mail/recent") {
    return handleRecentMailboxMessages(res, query);
  }

  if (req.method === "POST" && path === "/debug/mail/process-latest-test") {
    return handleLatestTestMailboxMessage(res, query);
  }

  if (req.method === "GET" && path === "/debug/mail/message-shape") {
    return handleMailboxMessageShape(res, query);
  }

  if ((req.method === "GET" || req.method === "POST") && path === "/jobs/poll-email") {
    return handlePollEmail(req, res, query);
  }

  return sendJson(res, 404, { ok: false, error: "not_found" });
}

if (process.argv.includes("--check")) {
  console.log(JSON.stringify({
    ok: true,
    missingConfig: getMissingConfig(config),
    port: config.port
  }, null, 2));
  process.exit(0);
}

const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    sendJson(res, 500, {
      ok: false,
      error: error.message
    });
  });
});

server.listen(config.port, () => {
  console.log(`creator-mail-ai-workflow listening on ${config.port}`);
  setTimeout(() => {
    ensureClientIntakeTable()
      .then(() => ensureOperationalTableFields())
      .then(() => runMailboxWork("startup"))
      .then(() => runClientLiveAcceptance())
      .then(() => auditApprovalQueue())
      .then(() => reconcileHistoricalContext(40))
      .then(() => reconcileMissingSenderAddresses(40))
      .then(() => reconcileMissingDrafts(40))
      .then(() => reconcileManualReviewLogs())
      .then(() => auditDataIntegrity())
      .then(() => runHistoricalReplayAcceptance(40, 80))
      .catch((error) => {
        console.error("Startup validation failed:", error.message);
      });
  }, 3_000);
  setInterval(() => scheduleMailboxPoll("interval"), 60_000).unref();
});
