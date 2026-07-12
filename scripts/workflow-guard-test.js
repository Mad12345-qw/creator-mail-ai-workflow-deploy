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
if (!writes.some((write) => write.tableName === "approvalTasks")) {
  throw new Error("Expected an approval task to be created.");
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

console.log(JSON.stringify({ ok: true, paidAction: paidResult.action, bounceAction: bounceResult.action }));
