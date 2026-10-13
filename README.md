# @core/suppliers

[![genpm](https://api.genpm.net/v1/badge/@core/suppliers.svg)](https://genpm.net/p/@core/suppliers) ![license](https://img.shields.io/badge/license-MIT-blue)

> Dropshipping suppliers: import products priced by rules, sync cost and stock, forward paid orders, tracking and exceptions

A [GenPM](https://genpm.net) module: **source code + AI rules + MCP config**, injected into your project instead of hidden in `node_modules`. The code lands in `src/lib/suppliers`, pinned to a verified commit, and you own it.

## Install

```bash
genpm add @core/suppliers
```

No genpm yet? `curl -fsSL https://genpm.net/install.sh | sh` (macOS/Linux), `irm https://genpm.net/install.ps1 | iex` (Windows), or one-off with `npx @genpm-net/cli add @core/suppliers`.

Or let your AI agent do it: run `genpm mcp setup` once, then ask *"add @core/suppliers with genpm"* in Claude Code, Cursor, VS Code, Windsurf, Codex or Gemini CLI. It shows you a dry-run plan before writing anything.

## What it does

Dropshipping operations behind a `SupplierAdapter` contract: import supplier products into @core/catalog as drafts
(price from @core/pricing rules, images copied to @core/media, plain-text description), map variants to supplier
SKUs with cost and delivery days, sync cost and stock (reprice; pause products that would sell at a loss), turn paid
orders into supplier orders (approval by default, or automatic), forward them with retries, record tracking on the
order and keep an exceptions queue. Ships the `manual` adapter (CSV import, orders emailed to the supplier) and the
`cj` adapter (CJdropshipping API v2: search, import, cost/stock sync, orders and tracking).

## At a glance

- **GenPM dependencies** (installed with it): [@core/catalog](https://genpm.net/p/@core/catalog), [@core/orders](https://genpm.net/p/@core/orders), [@core/pricing](https://genpm.net/p/@core/pricing), [@core/jobs](https://genpm.net/p/@core/jobs), [@core/media](https://genpm.net/p/@core/media), [@core/email](https://genpm.net/p/@core/email), [@core/money](https://genpm.net/p/@core/money), [@core/rich-text](https://genpm.net/p/@core/rich-text), [@core/db](https://genpm.net/p/@core/db), [@core/contracts](https://genpm.net/p/@core/contracts)
- **npm dependencies** (proposed, never installed without asking): `zod`
- **Environment variables** (added to `.env.example`): `SUPPLIER_COST_ALERT_PCT`, `CJ_API_KEY`, `CJ_QPS`
- **AI rules**: [`AGENTS.md`](AGENTS.md), loaded by your agent only when it works in `src/lib/suppliers`

## Security

GenPM installs a 40-character commit SHA (never a branch), verifies an Ed25519-signed manifest, never runs install scripts and scans AI rules for prompt injection. Details: [genpm.net/docs/security](https://genpm.net/docs/security).

## License

MIT — see [LICENSE](LICENSE). Browse the full catalog at [genpm.net](https://genpm.net).
