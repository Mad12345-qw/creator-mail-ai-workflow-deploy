# 达人合作邮件 AI 工作流后端骨架

这是一个先搭起来的 Render 可部署后端骨架，用于后续接入客户邮箱、飞书多维表格和 GPT。

## 当前已包含

- `GET /health` 健康检查
- `GET /cron/keepalive` 给 cron-job.org 保活使用
- `POST /webhook/feishu` 飞书事件入口
- `POST /jobs/poll-email` 定时拉取邮件入口
- `POST /debug/process-sample-email` 本地样例邮件处理入口
- Render 免费实例配置 `render.yaml`
- 飞书、多维表格、DeepSeek/GPT 的环境变量占位
- Upstash Redis REST 接入模块
- `config/rules` 稳定规则配置，达人表和报价规则仍从飞书读取
- 工作流骨架：识别邮件、读取动态数据、生成建议、写入日志/待办

## 本地运行

```powershell
npm start
```

检查：

```text
http://localhost:8787/health
```

## Render 上线前必须补齐

- 飞书自建应用的 App ID / App Secret
- 邮箱收发授权信息
- 飞书多维表格 app_token 和各数据表 table_id
- DeepSeek 或 GPT 使用方式对应的服务端配置
- `CRON_SECRET`
- Upstash Redis 的 REST URL / REST Token

## Cron 保活

Render 免费实例可以用 cron-job.org 定时请求：

```text
https://你的服务域名/cron/keepalive
```

真正拉取邮件建议请求：

```text
https://你的服务域名/jobs/poll-email?token=你的CRON_SECRET
```

cron-job.org 的详细填写方式见：`cron-job.org配置说明.md`。

Redis 申请和接入方式见：`Upstash_Redis申请和接入说明.md`。
