import { FeishuClient } from "../src/feishuClient.js";

const client = new FeishuClient({
  feishu: { appId: "test", appSecret: "test" },
  bitable: { appToken: "test", tables: { emailLog: "table-1" } }
});

client.listBitableRecords = async (_tableName, pageSize, pageToken) => {
  const offset = Number(pageToken || 0);
  const total = 250;
  const count = Math.min(pageSize, total - offset);
  const items = Array.from({ length: Math.max(0, count) }, (_, index) => ({ record_id: `record-${offset + index}` }));
  const nextOffset = offset + items.length;
  return {
    items,
    has_more: nextOffset < total,
    page_token: nextOffset < total ? String(nextOffset) : ""
  };
};

const result = await client.listAllBitableRecords("emailLog", { pageSize: 100, maxRecords: 1000 });
if (result.items.length !== 250) {
  throw new Error(`Expected 250 paginated records, got ${result.items.length}`);
}

console.log(JSON.stringify({ ok: true, records: result.items.length }));
