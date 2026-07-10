const MANUAL_INTENTS = new Set([
  "quote",
  "rate_card",
  "negotiation",
  "hybrid",
  "agreement",
  "payment_issue",
  "complaint",
  "legal",
  "safety"
]);

function inferIntent(email) {
  const text = `${email.subject || ""}\n${email.text || ""}`.toLowerCase();
  if (/\brate card\b|\brate\b|quote|price|fee|budget|package/.test(text)) return "quote";
  if (/agreement|contract|signed|legal/.test(text)) return "agreement";
  if (/payment|paypal|bank|invoice|paid/.test(text)) return "payment_issue";
  if (/sample|shipping|address|tracking/.test(text)) return "sample_or_shipping";
  if (/unsubscribe|remove me|stop contacting/.test(text)) return "stop_contact";
  if (/out of office|automatic reply|auto reply/.test(text)) return "auto_reply";
  return "general_creator_reply";
}

function decideAction(intent) {
  if (intent === "auto_reply") return "no_reply";
  if (intent === "stop_contact") return "record_only";
  if (MANUAL_INTENTS.has(intent)) return "manual_review";
  return "draft_reply";
}

function findMatchingRule(email, rules) {
  const text = `${email.subject || ""}\n${email.text || ""}`.toLowerCase();
  const files = ["no-reply-rules.json", "manual-review-rules.json"];
  for (const file of files) {
    for (const rule of rules?.[file]?.rules || []) {
      if ((rule.match || []).some((phrase) => text.includes(String(phrase).toLowerCase()))) {
        return rule;
      }
    }
  }
  return null;
}

export async function processCreatorEmail({ email, feishu, openai, ruleStore }) {
  const fallbackIntent = inferIntent(email);
  const creator = await feishu.findCreatorByEmail(email.from);
  const rules = ruleStore ? await ruleStore.load() : {};
  const matchedRule = findMatchingRule(email, rules);
  const context = {
    note: "Creator data is read from the live Feishu creator table when a sender match exists.",
    creator: creator ? { name: creator.name, recordId: creator.recordId } : null,
    matchedRule: matchedRule ? { id: matchedRule.id, action: matchedRule.action, notes: matchedRule.notes } : null,
    fallbackIntent,
    fallbackAction: decideAction(fallbackIntent)
  };

  const analysis = await openai.analyzeEmail(email, context);
  const intent = analysis.intent && analysis.intent !== "unconfigured" ? analysis.intent : fallbackIntent;
  const permittedActions = new Set(["no_reply", "record_only", "draft_reply", "manual_review"]);
  const action = matchedRule?.action || (permittedActions.has(analysis.action) ? analysis.action : decideAction(intent));

  const logFields = {
    "邮件ID": email.messageId || "",
    "发件人邮箱": email.from || "",
    "邮件主题": email.subject || "",
    "AI识别类型": intent,
    "风险等级": analysis.riskLevel || (action === "manual_review" ? "High" : "Medium"),
    "处理动作": action,
    "AI摘要": analysis.summary || "",
    "AI草稿": analysis.draftReply || "",
    "关联达人": creator?.name || "",
    "处理状态": action === "manual_review" ? "待人工确认" : "已记录"
  };

  const writeResult = await feishu.createBitableRecord("emailLog", logFields);
  let approvalResult = null;
  if (action === "manual_review") {
    approvalResult = await feishu.createBitableRecord("approvalTasks", {
      "任务标题": `Review creator email: ${email.subject || "(no subject)"}`,
      "任务类型": "邮件人工确认",
      "风险等级": logFields["风险等级"],
      "AI建议": analysis.summary || "Manual review required.",
      "AI草稿": analysis.draftReply || "",
      "人工修改稿": "",
      "是否允许发送": false,
      "任务状态": "待处理",
      "负责人": "",
      "人工备注": "",
      "关联邮件ID": email.messageId || ""
    });
  }

  return {
    intent,
    action,
    creatorMatch: creator ? { recordId: creator.recordId, name: creator.name } : null,
    matchedRule: matchedRule?.id || null,
    analysis,
    writeResult,
    approvalResult
  };
}
