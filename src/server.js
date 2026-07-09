import { createServer } from "node:http";
import { getConfig, getMissingConfig } from "./config.js";
import { FeishuClient } from "./feishuClient.js";
import { OpenAIClient } from "./openaiClient.js";
import { RedisStore } from "./redisStore.js";
import { getPathAndQuery, readJson, sendJson, sendText } from "./http.js";
import { processCreatorEmail } from "./workflow.js";

const config = getConfig();
const feishu = new FeishuClient(config);
const openai = new OpenAIClient(config);
const redis = new RedisStore(config);

function verifyCronToken(query) {
  const expected = config.cronSecret;
  return expected && query.get("token") === expected;
}

async function handleFeishuWebhook(req, res) {
  const body = await readJson(req);
  if (body.challenge) {
    return sendJson(res, 200, { challenge: body.challenge });
  }
  if (config.feishu.verificationToken && body.token && body.token !== config.feishu.verificationToken) {
    return sendJson(res, 401, { ok: false, error: "invalid_feishu_token" });
  }

  return sendJson(res, 200, {
    ok: true,
    received: true,
    next: "Connect mailbox event mapping after Feishu email authorization is ready."
  });
}

async function handlePollEmail(req, res, query) {
  if (!verifyCronToken(query)) {
    return sendJson(res, 401, { ok: false, error: "invalid_cron_token" });
  }

  return sendJson(res, 200, {
    ok: true,
    status: "poll_placeholder",
    next: [
      "Add Feishu/Gmail mailbox authorization.",
      "Map provider message payloads to the workflow email shape.",
      "Enable message-id dedupe persistence."
    ]
  });
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
      missingConfig: getMissingConfig(config)
    });
  }

  if (req.method === "GET" && path === "/cron/keepalive") {
    return sendText(res, 200, "ok");
  }

  if (req.method === "POST" && path === "/webhook/feishu") {
    return handleFeishuWebhook(req, res);
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
});
