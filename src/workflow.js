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

export async function processCreatorEmail({ email, feishu, openai }) {
  const fallbackIntent = inferIntent(email);
  const context = {
    note: "Dynamic Feishu project/rule tables are not connected yet.",
    fallbackIntent,
    fallbackAction: decideAction(fallbackIntent)
  };

  const analysis = await openai.analyzeEmail(email, context);
  const intent = analysis.intent && analysis.intent !== "unconfigured" ? analysis.intent : fallbackIntent;
  const action = analysis.action && analysis.action !== "manual_review"
    ? analysis.action
    : decideAction(intent);

  const logFields = {
    Subject: email.subject || "",
    From_Email: email.from || "",
    Intent: intent,
    Action: action,
    Risk_Level: analysis.riskLevel || (action === "manual_review" ? "High" : "Medium"),
    AI_Summary: analysis.summary || "",
    Raw_Message_ID: email.messageId || ""
  };

  const writeResult = await feishu.createBitableRecord("emailLog", logFields);
  let approvalResult = null;
  if (action === "manual_review") {
    approvalResult = await feishu.createBitableRecord("approvalTasks", {
      Task_Title: `Review creator email: ${email.subject || "(no subject)"}`,
      Task_Description: analysis.summary || "Manual review required.",
      Risk_Level: logFields.Risk_Level,
      AI_Draft: analysis.draftReply || "",
      Task_Status: "Pending"
    });
  }

  return {
    intent,
    action,
    analysis,
    writeResult,
    approvalResult
  };
}
