# Stable Rule Files

These files hold rules that rarely change:

- no-reply rules
- manual review rules
- default status transitions
- safety and agreement guardrails
- temporary cross-product promotion rules

Frequently changing business data stays in Feishu Bitable, especially:

- creator records
- creator status
- project/product data
- pricing and negotiation rules
- commission, bonus, flat fee, sample link
- collaboration progress

The creator table is treated as live business data and should be read from Feishu, not from local config.
