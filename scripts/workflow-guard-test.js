import { processCreatorEmail } from "../src/workflow.js";

const writes = [];
const feishu = {
  async findCreatorByEmail() {
    return null;
  },
  async listBitableRecords(tableName) {
    if (tableName === "projectProducts") {
      return {
        items: [{
          record_id: "project-1",
          fields: {
            "项目状态": "Active",
            "品牌名称": "Guard Brand",
            "产品名称": "Guard Product"
          }
        }]
      };
    }
    return { items: [] };
  },
  async createBitableRecord(tableName, fields) {
    writes.push({ tableName, fields });
    return { data: { record: { record_id: `${tableName}-1` } } };
  }
};

const ruleStore = { async load() { return {}; } };
const paidResult = await processCreatorEmail({
  email: { messageId: "guard-test-1", from: "creator@example.com", subject: "Paid collaboration", text: "I would like to discuss a paid collaboration." },
  feishu,
  openai: {
    async analyzeEmail() {
      return { intent: "paid_collaboration_inquiry", riskLevel: "Low", action: "draft_reply", summary: "Paid inquiry.", draftReply: "" };
    }
  },
  ruleStore
});

if (paidResult.action !== "manual_review") {
  throw new Error(`Expected manual_review, got ${paidResult.action}`);
}
const paidLog = writes.find((write) => write.tableName === "emailLog");
if (!paidLog || paidLog.fields["审批状态"] !== "待处理" || paidLog.fields["是否允许发送"] !== false) {
  throw new Error("Expected approval controls in the email log.");
}
if (!String(paidLog.fields["邮件概览"] || "").includes("creator@example.com")) {
  throw new Error("Expected a human-readable email overview in the primary field.");
}
if (writes.some((write) => write.tableName === "approvalTasks")) {
  throw new Error("New approvals must not require a separate approval table.");
}
if (!String(paidResult.analysis.draftReply || "").trim()) {
  throw new Error("Expected missing manual-review draft to be repaired.");
}

const bounceResult = await processCreatorEmail({
  email: { messageId: "guard-test-2", from: "mailer-daemon@example.com", subject: "Delivery failure", text: "Message delivery failed." },
  feishu,
  openai: {
    async analyzeEmail() {
      return { intent: "bounce_or_delivery_failure", riskLevel: "Low", action: "draft_reply", summary: "Delivery failed.", draftReply: "" };
    }
  },
  ruleStore
});

if (bounceResult.action !== "no_reply") {
  throw new Error(`Expected no_reply, got ${bounceResult.action}`);
}

const verificationResult = await processCreatorEmail({
  email: { messageId: "guard-test-3", from: "system@example.com", subject: "Forwarding verification", text: "Confirm email forwarding." },
  feishu,
  openai: {
    async analyzeEmail() {
      return { intent: "email_forwarding_verification", riskLevel: "Low", action: "draft_reply", summary: "Verification notice.", draftReply: "" };
    }
  },
  ruleStore
});

if (verificationResult.action !== "no_reply") {
  throw new Error(`Expected verification no_reply, got ${verificationResult.action}`);
}

const paidOnlyResult = await processCreatorEmail({
  email: { messageId: "guard-test-4", from: "creator@example.com", subject: "Collaboration", text: "I only accept paid collaborations." },
  feishu,
  openai: {
    async analyzeEmail() {
      return { intent: "creator_reply_paid_only", riskLevel: "Low", action: "draft_reply", summary: "Paid only.", draftReply: "Thank you." };
    }
  },
  ruleStore
});

if (paidOnlyResult.action !== "manual_review") {
  throw new Error(`Expected paid-only manual_review, got ${paidOnlyResult.action}`);
}

const mixedRuleResult = await processCreatorEmail({
  email: { messageId: "guard-test-5", from: "creator@example.com", subject: "Thanks", text: "Thanks, my rate is USD 150." },
  feishu,
  openai: {
    async analyzeEmail() {
      return { intent: "general_creator_reply", riskLevel: "Low", action: "no_reply", summary: "Mixed message.", draftReply: "Thank you." };
    }
  },
  ruleStore: {
    async load() {
      return {
        "no-reply-rules.json": { rules: [{ id: "simple-ack", match: ["thanks"], action: "no_reply" }] },
        "manual-review-rules.json": { rules: [{ id: "paid-collaboration", match: ["my rate"], action: "manual_review" }] }
      };
    }
  }
});

if (mixedRuleResult.action !== "manual_review") {
  throw new Error(`Expected mixed thanks/rate manual_review, got ${mixedRuleResult.action}`);
}

const multiProjectFeishu = {
  ...feishu,
  async listAllBitableRecords(tableName) {
    if (tableName !== "projectProducts") return { items: [] };
    return {
      items: [
        { record_id: "project-a", fields: { "项目状态": "Active", "品牌名称": "Brand A", "产品名称": "Product A" } },
        { record_id: "project-b", fields: { "项目状态": "Active", "品牌名称": "Brand B", "产品名称": "Product B" } }
      ]
    };
  }
};
const unmatchedProjectResult = await processCreatorEmail({
  email: { messageId: "guard-test-6", from: "creator@example.com", subject: "Hello", text: "I am interested in working together." },
  feishu: multiProjectFeishu,
  openai: {
    async analyzeEmail() {
      return { intent: "general_creator_reply", riskLevel: "Low", action: "draft_reply", summary: "General interest.", draftReply: "Thank you." };
    }
  },
  ruleStore
});

if (unmatchedProjectResult.action !== "manual_review" || unmatchedProjectResult.projectMatches.length !== 0) {
  throw new Error("Expected unmatched multi-project email to require manual review without guessing a project.");
}

const promotionRule = {
  id: "temporary-jissbon-cross-sell",
  enabled: true,
  productName: "Jissbon condoms",
  brandAliases: ["Jissbon", "杰士邦"],
  applicationLink: "https://affiliate-us.tiktok.com/api/v1/share/AJXACZJQ6WcO",
  eligibleSignals: ["sample", "product", "interested", "collaboration", "apply"],
  excludedIntents: ["auto_reply", "stop_contact", "bounce_or_delivery_failure", "payment_issue", "agreement", "complaint", "legal", "safety"],
  draftParagraph: "We're also currently prioritizing our Jissbon condom campaign. Apply here: https://affiliate-us.tiktok.com/api/v1/share/AJXACZJQ6WcO"
};
const promotionRuleStore = {
  async load() {
    return { "promotion-rules.json": { rules: [promotionRule] } };
  }
};
const promotedSampleResult = await processCreatorEmail({
  email: { messageId: "guard-test-7", from: "fitness@example.com", subject: "Fitness sample", text: "I am interested in applying for the fitness product sample." },
  feishu,
  openai: {
    async analyzeEmail() {
      return { intent: "sample_or_shipping", riskLevel: "Low", action: "draft_reply", summary: "Sample request.", draftReply: "Thanks for your interest.\n\nBest regards,\nTeam" };
    }
  },
  ruleStore: promotionRuleStore
});
if (promotedSampleResult.promotionRule !== promotionRule.id
  || !promotedSampleResult.analysis.draftReply.includes(promotionRule.applicationLink)
  || promotedSampleResult.analysis.draftReply.indexOf(promotionRule.applicationLink) > promotedSampleResult.analysis.draftReply.indexOf("Best regards")) {
  throw new Error("Expected the Jissbon recommendation before the sign-off for another product sample request.");
}

const directJissbonResult = await processCreatorEmail({
  email: { messageId: "guard-test-8", from: "creator@example.com", subject: "Jissbon sample", text: "I am interested in applying for the Jissbon sample." },
  feishu,
  openai: {
    async analyzeEmail() {
      return { intent: "sample_or_shipping", riskLevel: "Low", action: "draft_reply", summary: "Jissbon request.", draftReply: "Thanks for your Jissbon interest." };
    }
  },
  ruleStore: promotionRuleStore
});
if (directJissbonResult.promotionRule || directJissbonResult.analysis.draftReply.includes(promotionRule.applicationLink)) {
  throw new Error("Direct Jissbon inquiries must not receive a duplicate cross-sell recommendation.");
}

console.log(JSON.stringify({ ok: true, paidAction: paidResult.action, bounceAction: bounceResult.action, verificationAction: verificationResult.action, paidOnlyAction: paidOnlyResult.action, mixedRuleAction: mixedRuleResult.action, unmatchedProjectAction: unmatchedProjectResult.action, promotionRule: promotedSampleResult.promotionRule }));
