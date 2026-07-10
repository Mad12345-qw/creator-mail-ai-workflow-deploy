const REQUIRED_FOR_BOOT = ["CRON_SECRET"];

const TABLE_ENV_KEYS = {
  projectProducts: "PROJECT_PRODUCT_TABLE_ID",
  emailRules: "EMAIL_RULE_TABLE_ID",
  statusRules: "STATUS_RULE_TABLE_ID",
  creators: "CREATOR_MASTER_TABLE_ID",
  collaborations: "COLLABORATION_TABLE_ID",
  quoteHistory: "QUOTE_HISTORY_TABLE_ID",
  emailLog: "EMAIL_LOG_TABLE_ID",
  agreementTemplates: "AGREEMENT_TEMPLATE_TABLE_ID",
  agreementRecords: "AGREEMENT_RECORD_TABLE_ID",
  payments: "PAYMENT_RECORD_TABLE_ID",
  samples: "SAMPLE_SHIPPING_TABLE_ID",
  contentDelivery: "CONTENT_DELIVERY_TABLE_ID",
  senderProfiles: "SENDER_PROFILE_TABLE_ID",
  approvalTasks: "APPROVAL_TASK_TABLE_ID",
  actionLogs: "ACTION_LOG_TABLE_ID"
};

function readList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readTables() {
  return Object.fromEntries(
    Object.entries(TABLE_ENV_KEYS).map(([name, envKey]) => [name, process.env[envKey] || ""])
  );
}

export function getConfig() {
  return {
    port: Number(process.env.PORT || 8787),
    baseUrl: process.env.APP_BASE_URL || "",
    cronSecret: process.env.CRON_SECRET || "",
    safeTestMode: String(process.env.SAFE_TEST_MODE || "true").toLowerCase() !== "false",
    testRecipients: readList(process.env.TEST_RECIPIENTS),
    feishu: {
      appId: process.env.FEISHU_APP_ID || "",
      appSecret: process.env.FEISHU_APP_SECRET || "",
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || "",
      encryptKey: process.env.FEISHU_ENCRYPT_KEY || "",
      oauthRedirectUri: process.env.FEISHU_OAUTH_REDIRECT_URI || "",
      oauthScopes: readList(process.env.FEISHU_OAUTH_SCOPES || "offline_access,mail:user_mailbox.message:readonly,mail:user_mailbox.message:send,mail:user_mailbox.folder:read"),
      senderMailboxId: process.env.FEISHU_SENDER_MAILBOX_ID || "",
      senderEmail: process.env.FEISHU_SENDER_EMAIL || "",
      mailUserId: process.env.FEISHU_MAIL_USER_ID || ""
    },
    mailProvider: process.env.MAIL_PROVIDER || "feishu",
    bitable: {
      appToken: process.env.BITABLE_APP_TOKEN || "",
      tables: readTables()
    },
    aiProvider: process.env.AI_PROVIDER || (process.env.DEEPSEEK_API_KEY ? "deepseek" : "openai"),
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY || "",
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || "",
      model: process.env.OPENAI_MODEL || "gpt-5-mini"
    },
    redis: {
      url: process.env.UPSTASH_REDIS_REST_URL || "",
      token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
      keyPrefix: process.env.REDIS_KEY_PREFIX || "creator-mail-ai"
    },
    rules: {
      directory: process.env.RULES_DIR || "config/rules"
    }
  };
}

export function getMissingConfig(config = getConfig()) {
  const missing = [];
  for (const key of REQUIRED_FOR_BOOT) {
    if (!process.env[key]) missing.push(key);
  }
  if (!config.feishu.appId) missing.push("FEISHU_APP_ID");
  if (!config.feishu.appSecret) missing.push("FEISHU_APP_SECRET");
  if (config.aiProvider === "deepseek") {
    if (!config.deepseek.apiKey) missing.push("DEEPSEEK_API_KEY");
  } else if (!config.openai.apiKey) {
    missing.push("OPENAI_API_KEY");
  }
  if (!config.bitable.appToken) missing.push("BITABLE_APP_TOKEN");
  return missing;
}

export { TABLE_ENV_KEYS };
