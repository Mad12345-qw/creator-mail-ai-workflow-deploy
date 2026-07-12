import { createServer } from "node:http";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { getConfig, getMissingConfig } from "./config.js";
import { FeishuClient } from "./feishuClient.js";
import { OpenAIClient } from "./openaiClient.js";
import { RedisStore } from "./redisStore.js";
import { RuleStore } from "./ruleStore.js";
import { getPathAndQuery, readJson, sendJson, sendRedirect, sendText } from "./http.js";
import { processCreatorEmail } from "./workflow.js";

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

const CLIENT_INTAKE_TABLE_NAME = "项目与产品插件库";
const CLIENT_INTAKE_VIEW_NAME = "项目与产品填写表";
const CLIENT_WIKI_URL = "https://zcn1ftnw54fl.feishu.cn/wiki/H0tkwIRmYiQ1wnks74Nc2m4kn5e";
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

function readAddress(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return readAddress(value[0]);
  if (value && typeof value === "object") return value.mail_address || value.address || value.email || "";
  return "";
}

function getMailboxMessageId(message) {
  if (typeof message === "string") return message;
  return message?.message_id || message?.id || "";
}

function mapMailboxMessage(message, fallbackMessageId) {
  const source = message.message || message;
  const body = source.body_plain_text || source.body_text || source.body || source.body_html || "";
  return {
    messageId: source.message_id || source.id || fallbackMessageId,
    from: readAddress(source.from || source.sender || source.from_address),
    subject: source.subject || "",
    text: typeof body === "string" ? body : body.plain_text || body.text || body.html || ""
  };
}

async function pollMailbox() {
  const userToken = await getUserToken();
  if (!userToken) return { status: "authorization_required" };

  const data = await feishu.listMailboxMessages({
    accessToken: userToken.accessToken,
    folderId: config.feishu.inboxFolderId,
    pageSize: 20
  });
  const messages = data.items || data.messages || [];
  const messageIds = messages.map(getMailboxMessageId).filter(Boolean);
  const initializedKey = "mailbox-poll-initialized-v2";

  if (!(await redis.exists(initializedKey))) {
    for (const messageId of messageIds) {
      await redis.set(`polled-mail:${messageId}`, "1", { ex: 60 * 60 * 24 * 90 });
    }
    await redis.set(initializedKey, new Date().toISOString());
    lastMailboxPoll = { status: "baseline_created", seen: messageIds.length, updatedAt: new Date().toISOString() };
    return lastMailboxPoll;
  }

  const processed = [];
  for (const message of messages.slice().reverse()) {
    const messageId = getMailboxMessageId(message);
    if (!messageId || (await redis.exists(`polled-mail:${messageId}`))) continue;
    const fullMessage = await feishu.getMailboxMessage({
      userMailboxId: "me",
      messageId,
      accessToken: userToken.accessToken
    });
    await processCreatorEmail({
      email: mapMailboxMessage(fullMessage, messageId),
      feishu,
      openai,
      ruleStore
    });
    await redis.set(`polled-mail:${messageId}`, "1", { ex: 60 * 60 * 24 * 90 });
    processed.push(messageId);
  }
  lastMailboxPoll = { status: "completed", processed: processed.length, updatedAt: new Date().toISOString() };
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
    const data = await feishu.listBitableRecords("projectProducts", 100);
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
      if (!projectMatched) throw new Error(`${scenario.name}: client project policy was not matched.`);
      if (!scenario.allowedActions.includes(result.action)) {
        throw new Error(`${scenario.name}: unexpected action ${result.action}.`);
      }
      results.push({ name: scenario.name, action: result.action, projectMatched });
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
  return messageId.includes("acceptance")
    || /\btest\b|测试|polling final check|polling test ready|mail event test/.test(subject)
    || config.testRecipients.includes(sender);
}

async function auditApprovalQueue() {
  approvalQueueAudit = { status: "running", updatedAt: new Date().toISOString() };
  try {
    const [tasksData, logsData] = await Promise.all([
      feishu.listBitableRecords("approvalTasks", 100),
      feishu.listBitableRecords("emailLog", 100)
    ]);
    const logsByMessageId = new Map(
      (logsData.items || []).map((record) => [String(record.fields?.["邮件ID"] || ""), record.fields || {}])
    );
    const tasks = tasksData.items || [];
    let testRecords = 0;
    let realRecords = 0;
    let unknownRecords = 0;
    const statusCounts = {};
    for (const task of tasks) {
      const fields = task.fields || {};
      const taskStatus = String(fields["任务状态"] || "未设置");
      statusCounts[taskStatus] = (statusCounts[taskStatus] || 0) + 1;
      const messageId = String(fields["关联邮件ID"] || "");
      const logFields = logsByMessageId.get(messageId);
      if (!logFields) {
        unknownRecords += 1;
      } else if (isKnownTestEmail(logFields)) {
        testRecords += 1;
      } else {
        realRecords += 1;
      }
    }
    approvalQueueAudit = {
      status: "complete",
      totalRecords: tasks.length,
      testRecords,
      realRecords,
      unknownRecords,
      statusCounts,
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
      feishu.listBitableRecords("emailLog", 100)
    ]);
    const messages = mailData.items || mailData.messages || [];
    const loggedMessageIds = new Set(
      (logsData.items || []).map((record) => String(record.fields?.["邮件ID"] || "")).filter(Boolean)
    );
    const visibleStates = await Promise.all(messages.map(async (item) => {
      const messageId = getMailboxMessageId(item);
      return {
        messageId,
        receivedAt: item.received_time || item.sent_time || "",
        deduped: messageId ? Boolean(await redis.exists(`polled-mail:${messageId}`)) : false,
        logged: messageId ? loggedMessageIds.has(messageId) : false
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
      const source = fullMessage.message || fullMessage;
      const from = readAddress(source.from || source.sender || source.from_address).trim().toLowerCase();
      const to = readAddress(source.to || source.recipients || source.to_address).trim().toLowerCase();
      recent.push({
        receivedAt: normalizeMailTime(source.received_time || source.sent_time || state.receivedAt),
        selfSent: Boolean(from && to && from === to),
        deduped: state.deduped,
        logged: state.logged
      });
    }
    mailboxInboxAudit = {
      status: "complete",
      visibleMessages: messages.length,
      unprocessedVisible: visibleStates.filter((item) => !item.deduped).length,
      unloggedVisible: visibleStates.filter((item) => !item.logged).length,
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

async function processApprovedTasks() {
  const tasksData = await feishu.listBitableRecords("approvalTasks", 100);
  const candidates = (tasksData.items || []).filter((task) => {
    const fields = task.fields || {};
    const status = String(fields["任务状态"] || "");
    return isChecked(fields["是否允许发送"]) && !["已发送", "发送失败"].includes(status);
  });
  if (!candidates.length) return { checked: 0, sent: 0, safeModeSkipped: 0 };

  const logsData = await feishu.listBitableRecords("emailLog", 100);
  const logsByMessageId = new Map(
    (logsData.items || []).map((record) => [String(record.fields?.["邮件ID"] || ""), record])
  );
  const userToken = await getUserToken();
  if (!userToken) throw new Error("Mailbox owner authorization is required before sending approved mail.");

  let sent = 0;
  let safeModeSkipped = 0;
  for (const task of candidates) {
    const fields = task.fields || {};
    const messageId = String(fields["关联邮件ID"] || "");
    const emailLog = logsByMessageId.get(messageId);
    const recipient = String(emailLog?.fields?.["发件人邮箱"] || "").trim();
    const draft = String(fields["人工修改稿"] || fields["AI草稿"] || emailLog?.fields?.["AI草稿"] || "").trim();
    if (!recipient || !draft) {
      await feishu.updateBitableRecord("approvalTasks", task.record_id, { "任务状态": "发送资料不完整" });
      continue;
    }
    const recipientAllowed = config.testRecipients.includes(recipient.toLowerCase());
    if (config.safeTestMode && !recipientAllowed) {
      safeModeSkipped += 1;
      await recordOutbound({
        status: "blocked_by_safe_test_mode",
        recipient,
        messageId,
        apiAccepted: false,
        error: "Recipient is not in TEST_RECIPIENTS while SAFE_TEST_MODE is enabled."
      });
      continue;
    }
    const originalSubject = String(emailLog?.fields?.["邮件主题"] || "");
    const subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
    await recordOutbound({ status: "sending", recipient, subject, messageId, apiAccepted: false, error: "" });
    let result;
    try {
      result = await feishu.sendMailboxMessage({
        accessToken: userToken.accessToken,
        to: recipient,
        subject,
        bodyPlainText: draft,
        dedupeKey: `approval-${task.record_id}-${messageId}`
      });
    } catch (error) {
      await recordOutbound({
        status: "api_failed",
        recipient,
        subject,
        messageId,
        apiAccepted: false,
        error: error.message
      });
      throw error;
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
    await feishu.updateBitableRecord("approvalTasks", task.record_id, { "任务状态": "已发送" });
    if (emailLog?.record_id) {
      await feishu.updateBitableRecord("emailLog", emailLog.record_id, { "处理状态": "已发送" });
    }
    await feishu.createBitableRecord("actionLogs", {
      "事件类型": "approved_mail_sent",
      "事件来源": "approval_task",
      "操作内容": subject,
      "操作结果": result.message_id || "sent",
      "错误信息": "",
      "关联邮件ID": messageId
    });
    sent += 1;
  }
  return { checked: candidates.length, sent, safeModeSkipped };
}

async function runMailboxWork(reason) {
  const poll = await pollMailbox();
  const approvals = await processApprovedTasks();
  await auditApprovalQueue();
  await auditMailboxInbox();
  console.log(`Mailbox work (${reason}):`, poll.status, approvals.sent);
  return { poll, approvals };
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
  if (await redis.exists(dedupeKey)) return;
  await redis.set(dedupeKey, "1", { ex: 60 * 60 * 24 * 30 });

  const userToken = await getUserToken();
  if (!userToken) {
    throw new Error("Mailbox owner authorization is required before processing mail events.");
  }
  const message = await feishu.getMailboxMessage({
    userMailboxId: mailboxId,
    messageId,
    accessToken: userToken.accessToken
  });
  await processCreatorEmail({
      email: mapMailboxMessage(message, messageId),
      feishu,
      openai,
      ruleStore
  });
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
  if (config.feishu.verificationToken && token && token !== config.feishu.verificationToken) {
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
  setTimeout(() => scheduleMailboxPoll("startup"), 3_000);
  setTimeout(() => {
    ensureClientIntakeTable()
      .then(() => runClientLiveAcceptance())
      .then(() => auditApprovalQueue())
      .catch(async (error) => {
        await recordClientIntakeSetup({ status: "failed", error: error.message });
        console.error("Client intake setup failed:", error.message);
      });
  }, 5_000);
  setInterval(() => scheduleMailboxPoll("interval"), 60_000).unref();
});
