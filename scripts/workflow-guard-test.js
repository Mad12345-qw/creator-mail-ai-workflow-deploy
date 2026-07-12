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

const openai = {
  async analyzeEmail() {
    return {
      intent: "paid_collaboration_inquiry",
      riskLevel: "Low",
      action: "draft_reply",
      summary: "Creator is asking about paid collaboration.",
      draftReply: "Thank you for reaching out."
    };
  }
};

const ruleStore = { async load() { return {}; } };
const result = await processCreatorEmail({
  email: {
    messageId: "guard-test-1",
    from: "creator@example.com",
    subject: "Paid collaboration",
    text: "I would like to discuss a paid collaboration."
  },
  feishu,
  openai,
  ruleStore
});

if (result.action !== "manual_review") {
  throw new Error(`Expected manual_review, got ${result.action}`);
}
if (!writes.some((write) => write.tableName === "approvalTasks")) {
  throw new Error("Expected an approval task to be created.");
}

console.log(JSON.stringify({ ok: true, action: result.action, approvalCreated: true }));
