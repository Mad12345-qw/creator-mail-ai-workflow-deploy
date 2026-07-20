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
    || /(quote|rate|pricing|price|fee|budget|negotiat|paid|offer|agreement|contract|payment|complaint|legal|safety)/.test(normalized);
}

export function requiresNoReplyIntent(intent) {
  const normalized = String(intent || "").trim().toLowerCase();
  return /(test_message|test_email|bounce|delivery_failure|delivery_status|verification_notification|email_forwarding_verification|email_verification)/.test(normalized);
}

export function hasCreatorRoleConfusion(draft) {
  const text = String(draft || "").toLowerCase();
  return /\b(?:i am|i'm)\s+(?:a|an)\s+(?:content\s+)?(?:creator|influencer|affiliate)\b/.test(text)
    || /\bmy (?:audience|followers|channel|content|platform)\b/.test(text)
    || /\bi (?:would love|want|am interested|would like) to (?:apply|promote|feature|review|collaborate)\b/.test(text)
    || /\bi (?:have )?(?:applied|submitted my application)\b/.test(text)
    || /\b(?:send|ship) (?:me|us) (?:a|the) sample\b/.test(text);
}

function inferIntent(email) {
  const text = `${email.subject || ""}\n${email.text || ""}`.toLowerCase();
  if (/\brate card\b|\brate\b|quote|price|fee|budget|package/.test(text)) return "quote";
  if (/agreement|contract|signed|legal/.test(text)) return "agreement";
  if (/payment|paypal|bank|invoice|paid/.test(text)) return "payment_issue";
  if (/sample|shipping|address|tracking/.test(text)) return "sample_or_shipping";
  if (/unsubscribe|remove me|stop contacting/.test(text)) return "stop_contact";
  return "general_creator_reply";
}

function decideAction(intent) {
  if (requiresNoReplyIntent(intent)) return "no_reply";
  if (intent === "stop_contact") return "record_only";
  if (requiresManualReviewIntent(intent)) return "manual_review";
  return "draft_reply";
}

export function shouldAutoSendReply({ enabled, action, draftQualityStatus, projectMatches }) {
  return Boolean(enabled)
    && action === "draft_reply"
    && ["passed", "corrected"].includes(String(draftQualityStatus || ""));
}

function findMatchingRule(email, rules) {
  const text = `${email.subject || ""}\n${email.text || ""}`.toLowerCase();
  const matches = (file) => (rules?.[file]?.rules || []).filter((rule) =>
    (rule.match || []).some((phrase) => text.includes(String(phrase).toLowerCase()))
  );
  const noReplyMatches = matches("no-reply-rules.json");
  const hardNoReply = noReplyMatches.find((rule) =>
    ["system-delivery-notice", "stop-contact"].includes(rule.id)
  );
  if (hardNoReply) return hardNoReply;

  const manualMatch = matches("manual-review-rules.json")[0];
  if (manualMatch) return manualMatch;

  return null;
}

export function findPromotionRule(email, intent, action, rules) {
  if (!["draft_reply", "manual_review"].includes(action)) return null;
  const text = `${email.subject || ""}\n${email.text || ""}`.toLowerCase();
  return (rules?.["promotion-rules.json"]?.rules || []).find((rule) => {
    if (!rule.enabled || !rule.applicationLink || !rule.draftParagraph) return false;
    const aliases = (rule.brandAliases || []).map((value) => String(value).toLowerCase()).filter(Boolean);
    if (aliases.some((alias) => text.includes(alias)) || text.includes(String(rule.applicationLink).toLowerCase())) return false;
    const excluded = (rule.excludedIntents || []).map((value) => String(value).toLowerCase());
    const normalizedIntent = String(intent || "").toLowerCase();
    if (excluded.some((value) => normalizedIntent === value || normalizedIntent.includes(value))) return false;
    return (rule.eligibleSignals || []).some((signal) => text.includes(String(signal).toLowerCase()));
  }) || null;
}

export function appendPromotionToDraft(draft, rule) {
  const current = String(draft || "").trim();
  if (!rule || !current) return current;
  const lower = current.toLowerCase();
  const aliases = (rule.brandAliases || []).map((value) => String(value).toLowerCase()).filter(Boolean);
  const hasLink = lower.includes(String(rule.applicationLink).toLowerCase());
  const hasProduct = aliases.some((alias) => lower.includes(alias));
  if (hasLink && hasProduct) return current;
  const paragraph = hasProduct && !hasLink
    ? `If you're interested, you can apply for a sample here: ${rule.applicationLink}`
    : (!hasProduct && hasLink
      ? `We're also currently prioritizing our ${rule.productName || "Jissbon condom"} campaign and would love to invite you to consider this product as well.`
      : String(rule.draftParagraph || "").trim());
  const signoffPattern = /\n((?:best|best regards|kind regards|regards|sincerely)[,\s][\s\S]*)$/i;
  if (signoffPattern.test(current)) {
    return current.replace(signoffPattern, `\n\n${paragraph}\n\n$1`);
  }
  return `${current}\n\n${paragraph}`;
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  return String(text || "").toLowerCase().split(String(needle).toLowerCase()).length - 1;
}

export function validateDraftQuality({ email, draft, action, promotionRule }) {
  const text = String(draft || "").trim();
  const lower = text.toLowerCase();
  const violations = [];
  const actionable = ["draft_reply", "manual_review"].includes(action);
  if (!actionable && text) violations.push("unexpected_draft_for_non_reply_action");
  if (actionable && !text) violations.push("missing_actionable_draft");
  if (!text) return violations;
  if (hasCreatorRoleConfusion(text)) violations.push("creator_brand_role_confusion");
  if (/\b(?:as an ai|ai assistant|language model|system prompt|manual review|required context|provided context|internal policy)\b/i.test(text)) {
    violations.push("internal_or_ai_language");
  }
  if (/\[(?:your|brand|company|name|link|date)[^\]]*\]|<(?:your|brand|company|name|link|date)[^>]*>|\b(?:insert|add) (?:the )?(?:link|name|date) here\b/i.test(text)) {
    violations.push("unresolved_placeholder");
  }
  if (/\bwe (?:accept|approve|agree to) (?:your |the )?(?:rate|fee|price|quote|offer)\b|\byour (?:rate|fee|quote|offer) (?:is|has been) approved\b|\bwe will pay\b|\bpayment (?:is|will be) guaranteed\b|\b(?:agreement|contract) (?:is|has been) (?:finalized|approved|signed)\b/i.test(text)) {
    violations.push("unsupported_commercial_commitment");
  }
  if (/\bcould you (?:share|send) (?:the|your) (?:sample|product) application link\b|\bi would like to apply for (?:the|your) (?:sample|product)\b/i.test(text)) {
    violations.push("reply_direction_reversed");
  }
  const signoffCount = (text.match(/(?:^|\n)(?:best|best regards|kind regards|regards|sincerely)[,\s]/gi) || []).length;
  if (signoffCount > 1) violations.push("duplicate_signoff");
  if (promotionRule) {
    const link = String(promotionRule.applicationLink || "");
    const aliases = (promotionRule.brandAliases || []).map((value) => String(value).toLowerCase()).filter(Boolean);
    if (!link || countOccurrences(text, link) !== 1) violations.push("promotion_link_missing_or_duplicated");
    if (aliases.length && !aliases.some((alias) => lower.includes(alias))) violations.push("promotion_product_missing");
  }
  if (String(email?.subject || "").trim() && /^re:\s*$/i.test(String(email.subject))) {
    violations.push("empty_reply_subject_context");
  }
  return [...new Set(violations)];
}

function safeBrandFallbackDraft(promotionRule) {
  const base = "Thank you for reaching out and for your interest in collaborating with us. We have received your message and are reviewing the details with our team. We will follow up with the relevant next steps once confirmed.";
  return appendPromotionToDraft(base, promotionRule);
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
  const data = feishu.listAllBitableRecords
    ? await feishu.listAllBitableRecords("projectProducts", { maxRecords: 1000 })
    : await feishu.listBitableRecords("projectProducts", 100);
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
  if (matched.length) return matched.slice(0, 3);
  return active.length === 1 ? active : [];
}

export async function processCreatorEmail({ email, feishu, openai, ruleStore, autoSendDraftReplies = false, writeLog = true }) {
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

  let analysis = await openai.analyzeEmail(email, context);
  const intent = analysis.intent && analysis.intent !== "unconfigured" ? analysis.intent : fallbackIntent;
  let requiredAction = requiresManualReviewIntent(intent) || requiresManualReviewIntent(fallbackIntent)
    ? "manual_review"
    : decideAction(intent);
  const action = matchedRule?.action || (
    ["manual_review", "no_reply", "record_only"].includes(requiredAction)
      ? requiredAction
      : "draft_reply"
  );
  if (["draft_reply", "manual_review"].includes(action) && !String(analysis.draftReply || "").trim()) {
    const repaired = await openai.analyzeEmail(email, {
      ...context,
      draftRepair: {
        required: true,
        instruction: "Return a complete, cautious email draft. Do not invent or approve commercial terms."
      },
      previousAnalysis: analysis
    });
    analysis = {
      ...analysis,
      draftReply: String(repaired.draftReply || "").trim()
        || "Thank you for your message. We have received the details and are reviewing them internally. We will follow up once the relevant terms have been confirmed."
    };
  }
  let identityStatus = ["draft_reply", "manual_review"].includes(action) ? "brand_reply_verified" : "not_applicable";
  if (["draft_reply", "manual_review"].includes(action) && hasCreatorRoleConfusion(analysis.draftReply)) {
    const repaired = await openai.analyzeEmail(email, {
      ...context,
      roleCorrection: {
        required: true,
        instruction: "Rewrite draftReply as the brand/company partnership team replying to the creator. Never write from the creator's point of view."
      },
      previousAnalysis: analysis
    });
    const repairedDraft = String(repaired.draftReply || "").trim();
    analysis = {
      ...analysis,
      draftReply: repairedDraft && !hasCreatorRoleConfusion(repairedDraft)
        ? repairedDraft
        : "Thank you for reaching out and for your interest in collaborating with us. We have received your message and are reviewing the details with our team. We will follow up with the relevant next steps once confirmed."
    };
    identityStatus = "role_confusion_corrected";
  }
  const promotionRule = findPromotionRule(email, intent, action, rules);
  if (promotionRule) {
    analysis = {
      ...analysis,
      draftReply: appendPromotionToDraft(analysis.draftReply, promotionRule)
    };
  }
  if (!["draft_reply", "manual_review"].includes(action)) {
    analysis = { ...analysis, draftReply: "" };
  }
  let draftQualityIssues = validateDraftQuality({
    email,
    draft: analysis.draftReply,
    action,
    promotionRule
  });
  let draftQualityStatus = draftQualityIssues.length ? "repair_required" : "passed";
  if (draftQualityIssues.length && ["draft_reply", "manual_review"].includes(action)) {
    const repaired = await openai.analyzeEmail(email, {
      ...context,
      qualityRepair: {
        required: true,
        violations: draftQualityIssues,
        instruction: "Rewrite draftReply as a clean brand-to-creator email. Fix every listed violation. Do not invent or approve commercial terms."
      },
      requiredPromotion: promotionRule ? {
        productName: promotionRule.productName,
        applicationLink: promotionRule.applicationLink,
        paragraph: promotionRule.draftParagraph
      } : null,
      previousAnalysis: analysis
    });
    const repairedDraft = appendPromotionToDraft(String(repaired.draftReply || "").trim(), promotionRule);
    const remainingIssues = validateDraftQuality({ email, draft: repairedDraft, action, promotionRule });
    analysis = {
      ...analysis,
      draftReply: remainingIssues.length ? safeBrandFallbackDraft(promotionRule) : repairedDraft
    };
    draftQualityIssues = validateDraftQuality({ email, draft: analysis.draftReply, action, promotionRule });
    draftQualityStatus = draftQualityIssues.length ? "fallback_with_remaining_issues" : "corrected";
  }

  const matchedProjectText = projects
    .map((project) => [project.brand, project.product, project.campaign].filter(Boolean).join(" / "))
    .filter(Boolean)
    .join("; ");
  const dataQualityIssues = [
    !email.messageId ? "missing_message_id" : "",
    !email.from ? "missing_sender" : "",
    !email.subject && !email.text ? "missing_content" : "",
    !projects.length && !["no_reply", "record_only"].includes(action) ? "unmatched_project" : ""
  ].filter(Boolean);
  const autoSend = shouldAutoSendReply({
    enabled: autoSendDraftReplies,
    action,
    draftQualityStatus,
    projectMatches: projects
  });

  const logFields = {
    "邮件概览": `${email.receivedAt || "时间待补充"} | ${email.from || "未知发件人"} | ${email.subject || "无主题"}`.slice(0, 500),
    "邮件ID": email.messageId || "",
    "发件人邮箱": email.from || "",
    "收件人邮箱": email.to || "",
    "邮件主题": email.subject || "",
    "邮件正文": String(email.text || "").slice(0, 20000),
    "接收时间": email.receivedAt || "",
    "AI识别类型": intent,
    "风险等级": action === "manual_review" ? "High" : (analysis.riskLevel || "Medium"),
    "处理动作": action,
    "AI摘要": analysis.summary || "",
    "AI草稿": analysis.draftReply || "",
    "人工修改稿": "",
    "是否允许发送": autoSend,
    "审批状态": autoSend ? "待自动发送" : (action === "manual_review" ? "待处理" : "无需审批"),
    "身份校验": identityStatus,
    "草稿质检": draftQualityStatus,
    "草稿质检问题": draftQualityIssues.join(","),
    "负责人": "",
    "人工备注": "",
    "关联达人": creator?.name || "",
    "匹配项目": matchedProjectText,
    "命中规则": [matchedRule?.id, promotionRule?.id].filter(Boolean).join("; "),
    "数据完整性": dataQualityIssues.length ? dataQualityIssues.join(",") : "complete",
    "处理状态": autoSend ? "待自动发送" : (action === "manual_review" ? "待人工确认" : "已记录")
  };

  const writeResult = writeLog
    ? await feishu.createBitableRecord("emailLog", logFields)
    : { skipped: true, dryRun: true };
  const approvalResult = null;

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
    promotionRule: promotionRule?.id || null,
    autoSend,
    logFields,
    identityStatus,
    draftQuality: {
      status: draftQualityStatus,
      issues: draftQualityIssues
    },
    analysis,
    writeResult,
    approvalResult
  };
}
