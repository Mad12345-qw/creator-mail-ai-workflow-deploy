import { createServer } from "node:http";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { getConfig, getMissingConfig } from "./config.js";
import { FeishuClient } from "./feishuClient.js";
import { OpenAIClient } from "./openaiClient.js";
import { RedisStore } from "./redisStore.js";
import { getPathAndQuery, readJson, sendJson, sendRedirect, sendText } from "./http.js";
import { processCreatorEmail } from "./workflow.js";

const config = getConfig();
const feishu = new FeishuClient(config);
const openai = new OpenAIClient(config);
const redis = new RedisStore(config);
let lastMailboxEvent = { status: "not_received" };
let lastMailboxPoll = { status: "not_started" };

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
      openai
    });
    await redis.set(`polled-mail:${messageId}`, "1", { ex: 60 * 60 * 24 * 90 });
    processed.push(messageId);
  }
  lastMailboxPoll = { status: "completed", processed: processed.length, updatedAt: new Date().toISOString() };
  return lastMailboxPoll;
}

function scheduleMailboxPoll(reason) {
  pollMailbox()
    .then((result) => console.log(`Mailbox poll (${reason}):`, result.status, result.processed || result.seen || 0))
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
    openai
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
    pageSize: 1
  });
  const messageId = getMailboxMessageId((data.items || data.messages || [])[0]);
  if (!messageId) {
    return sendJson(res, 404, { ok: false, error: "no_mailbox_message_found" });
  }
  const fullMessage = await feishu.getMailboxMessage({
    userMailboxId: "me",
    messageId,
    accessToken: userToken.accessToken
  });
  const email = mapMailboxMessage(fullMessage, messageId);
  if (!/^(MAIL EVENT TEST|POLLING TEST READY|POLLING FINAL CHECK)/i.test(email.subject || "")) {
    return sendJson(res, 409, { ok: false, error: "latest_message_is_not_a_test_email" });
  }
  const result = await processCreatorEmail({ email, feishu, openai });
  await redis.set(`polled-mail:${messageId}`, "1", { ex: 60 * 60 * 24 * 90 });
  return sendJson(res, 200, {
    ok: true,
    processed: true,
    subject: email.subject,
    action: result.action
  });
}

async function handlePollEmail(req, res, query) {
  if (!verifyCronToken(query)) {
    return sendJson(res, 401, { ok: false, error: "invalid_cron_token" });
  }

  const result = await pollMailbox();
  return sendJson(res, 200, { ok: true, ...result });
}

async function handleSampleEmail(req, res) {
  const body = await readJson(req);
  const result = await processCreatorEmail({
    email: {
      messageId: body.messageId || `sample-${Date.now()}`,
      from: body.from || "creator@example.com",
      subject: body.subject || "Collaboration rate",
      text: body.text || "Hi, please let me know your budget for one TikTok video."
    },
    feishu,
    openai
  });
  return sendJson(res, 200, { ok: true, result });
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

  if (req.method === "GET" && path === "/debug/mail/folders") {
    return handleMailboxFolders(res, query);
  }

  if (req.method === "GET" && path === "/debug/mail/recent") {
    return handleRecentMailboxMessages(res, query);
  }

  if (req.method === "POST" && path === "/debug/mail/process-latest-test") {
    return handleLatestTestMailboxMessage(res, query);
  }

  if ((req.method === "GET" || req.method === "POST") && path === "/jobs/poll-email") {
    return handlePollEmail(req, res, query);
  }

  if (req.method === "POST" && path === "/debug/process-sample-email") {
    return handleSampleEmail(req, res);
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
  setInterval(() => scheduleMailboxPoll("interval"), 60_000).unref();
});
