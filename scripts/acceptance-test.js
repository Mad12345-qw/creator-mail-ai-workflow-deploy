import { getConfig } from "../src/config.js";
import { writeFile } from "node:fs/promises";
import { FeishuClient } from "../src/feishuClient.js";
import { OpenAIClient } from "../src/openaiClient.js";
import { RuleStore } from "../src/ruleStore.js";
import { processCreatorEmail } from "../src/workflow.js";

const config = getConfig();
const feishu = new FeishuClient(config);
const openai = new OpenAIClient(config);
const ruleStore = new RuleStore(config);
const runId = `acceptance-${Date.now()}`;
const created = [];

function recordId(result) {
  return result?.data?.record?.record_id || result?.record?.record_id || result?.record_id || "";
}

async function remember(tableName, result) {
  const id = recordId(result);
  if (id) created.push({ tableName, recordId: id });
  return id;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function cleanup() {
  for (const item of created.slice().reverse()) {
    try {
      await feishu.deleteBitableRecord(item.tableName, item.recordId);
    } catch (error) {
      console.error(`Cleanup failed for ${item.tableName}/${item.recordId}: ${error.message}`);
    }
  }
}

try {
  const projectResult = await feishu.createBitableRecord("projectProducts", {
    "项目ID": runId,
    "项目状态": "Active",
    "品牌名称": "Acceptance Brand",
    "产品名称": "Creator Test Product",
    "项目名称": "Pre-handoff Acceptance",
    "推广平台": ["TikTok"],
    "目标市场": "United States",
    "产品链接": { link: "https://example.com/product", text: "Test product" },
    "样品申请链接": { link: "https://example.com/sample", text: "Sample application" },
    "产品简介与核心卖点": "Controlled acceptance fixture for creator collaboration testing.",
    "自然流佣金": "15%",
    "广告流佣金": "10%",
    "Bonus机制": "USD 50 after the agreed performance milestone.",
    "Flat Fee支持": "Conditional",
    "支持纯佣": true,
    "支持Hybrid": true,
    "低报价转纯佣阈值N": 200,
    "阈值币种": "USD",
    "样品政策": "Yes",
    "默认交付要求": "One TikTok video; final terms require human approval.",
    "广告投流与Spark Ads要求": "Spark Ads only after explicit approval.",
    "禁止表达内容": "Do not promise payment or accept a creator quote automatically.",
    "付款政策": "Payment terms require human confirmation."
  });
  const projectRecordId = await remember("projectProducts", projectResult);
  assert(projectRecordId, "Could not create the temporary project policy record.");

  const scenarios = [
    {
      name: "quote",
      email: {
        messageId: `${runId}-quote`,
        from: "acceptance.creator@example.com",
        subject: "Acceptance Brand collaboration rate",
        text: "My rate is USD 150 for one TikTok video."
      },
      expectedAction: "manual_review",
      expectedRule: "paid-collaboration",
      expectsProject: true
    },
    {
      name: "auto_reply",
      email: {
        messageId: `${runId}-auto`,
        from: "acceptance.creator@example.com",
        subject: "Automatic reply",
        text: "I am out of office and will return next week."
      },
      expectedAction: "no_reply",
      expectedRule: "auto-reply"
    },
    {
      name: "stop_contact",
      email: {
        messageId: `${runId}-stop`,
        from: "acceptance.creator@example.com",
        subject: "Please remove me",
        text: "Please stop contacting me and remove me from future outreach."
      },
      expectedAction: "record_only",
      expectedRule: "stop-contact"
    },
    {
      name: "agreement",
      email: {
        messageId: `${runId}-agreement`,
        from: "acceptance.creator@example.com",
        subject: "Agreement changes",
        text: "Please revise the usage rights and legal name in the agreement."
      },
      expectedAction: "manual_review",
      expectedRule: "agreement"
    },
    {
      name: "sample",
      email: {
        messageId: `${runId}-sample`,
        from: "acceptance.creator@example.com",
        subject: "Acceptance Brand sample",
        text: "Could you share the sample application link for Creator Test Product?"
      },
      allowedActions: ["draft_reply", "manual_review"],
      expectsProject: true
    }
  ];

  const results = [];
  for (const scenario of scenarios) {
    const result = await processCreatorEmail({
      email: scenario.email,
      feishu,
      openai,
      ruleStore
    });
    await remember("emailLog", result.writeResult);
    if (result.approvalResult) await remember("approvalTasks", result.approvalResult);
    if (scenario.expectedAction) {
      assert(result.action === scenario.expectedAction, `${scenario.name}: expected ${scenario.expectedAction}, got ${result.action}`);
    } else {
      assert(scenario.allowedActions.includes(result.action), `${scenario.name}: unexpected action ${result.action}`);
    }
    if (scenario.expectedRule) {
      assert(result.matchedRule === scenario.expectedRule, `${scenario.name}: expected rule ${scenario.expectedRule}, got ${result.matchedRule}`);
    }
    if (scenario.expectsProject) {
      assert(result.projectMatches.some((project) => project.recordId === projectRecordId), `${scenario.name}: live project policy was not matched`);
    }
    results.push({
      name: scenario.name,
      action: result.action,
      rule: result.matchedRule,
      projectMatched: result.projectMatches.some((project) => project.recordId === projectRecordId),
      bitableWrite: Boolean(recordId(result.writeResult)),
      approvalCreated: Boolean(recordId(result.approvalResult))
    });
  }

  const report = {
    ok: true,
    runId,
    aiProvider: config.aiProvider,
    projectPolicyRead: true,
    scenarios: results
  };
  await writeFile(new URL("../acceptance-result.json", import.meta.url), JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await cleanup();
}
