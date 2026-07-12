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

export function requiresManualReviewIntent(intent) {
  const normalized = String(intent || "").trim().toLowerCase();
  return MANUAL_INTENTS.has(normalized)
    || /(quote|rate|pricing|price|fee|budget|negotiat|paid[_ -]?collaboration|agreement|contract|payment|complaint|legal|safety)/.test(normalized);
}

function requiresNoReplyIntent(intent) {
  const normalized = String(intent || "").trim().toLowerCase();
  return normalized === "auto_reply"
    || /(test_message|test_email|bounce|delivery_failure|delivery_status|forward_verification_notification)/.test(normalized);
}

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
  if (requiresNoReplyIntent(intent)) return "no_reply";
  if (intent === "stop_contact") return "record_only";
  if (requiresManualReviewIntent(intent)) return "manual_review";
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

function projectSummary(record) {
  const fields = record.fields || {};
  return {
    recordId: record.record_id || "",
    status: fields["项目状态"] || "",
    brand: fields["品牌名称"] || "",
    product: fields["产品名称"] || "",
    campaign: fields["项目名称"] || "",
    platforms: fields["推广平台"] || "",
    markets: fields["目标市场"] || "",
    productLink: fields["产品链接"] || "",
    sampleLink: fields["样品申请链接"] || "",
    description: fields["产品简介与核心卖点"] || "",
    creatorFit: fields["适合达人与内容方向"] || "",
    organicCommission: fields["自然流佣金"] || "",
    paidTrafficCommission: fields["广告流佣金"] || "",
    bonus: fields["Bonus机制"] || "",
    flatFee: fields["Flat Fee支持"] || "",
    affiliate: fields["支持纯佣"] || false,
    hybrid: fields["支持Hybrid"] || false,
    affiliateThreshold: fields["低报价转纯佣阈值N"] || "",
    thresholdCurrency: fields["阈值币种"] || "",
    samplePolicy: fields["样品政策"] || "",
    deliverables: fields["默认交付要求"] || "",
    adsAndSpark: fields["广告投流与Spark Ads要求"] || "",
    adDuration: fields["广告授权期限"] || "",
    usageRights: fields["内容使用权"] || "",
    rawFootage: fields["原始素材要求"] || "",
    postingTimeline: fields["发布时间要求"] || "",
    requiredContent: fields["必须表达内容"] || "",
    forbiddenContent: fields["禁止表达内容"] || "",
    tags: fields["标签与Hashtag"] || "",
    paymentPolicy: fields["付款政策"] || ""
  };
}

async function findRelevantProjects(email, feishu) {
  const data = await feishu.listBitableRecords("projectProducts", 100);
  const active = (data.items || [])
    .map(projectSummary)
    .filter((project) => {
      const status = String(project.status || "").toLowerCase();
      return !status || ["priority", "active", "limited"].includes(status);
    });
  const emailText = `${email.subject || ""}\n${email.text || ""}`.toLowerCase();
  const matched = active.filter((project) =>
    [project.brand, project.product, project.campaign]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => value.length >= 2)
      .some((value) => emailText.includes(value))
  );
  return (matched.length ? matched : active).slice(0, 3);
}

export async function processCreatorEmail({ email, feishu, openai, ruleStore }) {
  const fallbackIntent = inferIntent(email);
  const [creator, projects] = await Promise.all([
    feishu.findCreatorByEmail(email.from),
    findRelevantProjects(email, feishu)
  ]);
  const rules = ruleStore ? await ruleStore.load() : {};
  const matchedRule = findMatchingRule(email, rules);
  const context = {
    note: "Creator and project policy data are read from live Feishu tables. Use only supplied values.",
    creator: creator ? { name: creator.name, recordId: creator.recordId } : null,
    projects,
    matchedRule: matchedRule ? { id: matchedRule.id, action: matchedRule.action, notes: matchedRule.notes } : null,
    fallbackIntent,
    fallbackAction: decideAction(fallbackIntent)
  };

  const analysis = await openai.analyzeEmail(email, context);
  const intent = analysis.intent && analysis.intent !== "unconfigured" ? analysis.intent : fallbackIntent;
  const permittedActions = new Set(["no_reply", "record_only", "draft_reply", "manual_review"]);
  const requiredAction = requiresManualReviewIntent(intent) || requiresManualReviewIntent(fallbackIntent)
    ? "manual_review"
    : decideAction(intent);
  const action = matchedRule?.action || (
    ["manual_review", "no_reply", "record_only"].includes(requiredAction)
      ? requiredAction
      : (permittedActions.has(analysis.action) ? analysis.action : requiredAction)
  );

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
    projectMatches: projects.map((project) => ({
      recordId: project.recordId,
      brand: project.brand,
      product: project.product,
      campaign: project.campaign
    })),
    matchedRule: matchedRule?.id || null,
    analysis,
    writeResult,
    approvalResult
  };
}
