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

## Setup

After `genpm add`, follow these steps (your AI agent finds the same steps in `src/lib/suppliers/AGENTS.md` and can do them for you):

1. Install @core/pricing and create at least one price rule. Migrations as in `src/lib/db/AGENTS.md`; the @core/jobs cron must run.
2. Import this module at startup (registers the manual adapter and the `paid` order handler).
3. Create a supplier in the admin: adapter `manual`, `config.orderEmail`, currency. API adapters read credentials from env, never from `config`.
   CJdropshipping: adapter `cj`, currency `USD`, env `CJ_API_KEY` (CJ → Apps → install "API" → Add API, type "API Key").
   Config: `logisticName` (required, a CJ shipping method such as `CJPacket Ordinary`), `fromCountryCode` (default `CN`),
   `payWithBalance: "true"` to pay each order from the CJ balance (otherwise orders wait unpaid in CJ), and
   `sandbox: "true"` while testing (no charge, no shipment). CJ allows 1 request/s on free accounts: raise `CJ_QPS`
   only if your CJ level allows it. Import with `getAdapter('cj').getProduct(supplier, pid)` → `importProduct`.
4. Import: `importProduct(supplierId, parseSupplierCsv(csv, currency)[0], { slug, categories })` (or the supplier's
   "Import products from CSV" admin action) → review the draft, then publish. CSV header (one row per variant):
   `product_id,title,description,image_urls,option1_name,option1_value,option2_name,option2_value,variant_id,cost,stock,weight_grams,ship_min_days,ship_max_days`
   (`image_urls` separated by `|`, https only; `cost` decimal in the supplier currency). Images are copied only from
   allowed hosts: add the supplier's image domains to its `config.imageHosts` (`cdn.supplier.com,.img.supplier.com`);
   skipped images open an `images_skipped` exception.
5. Schedule `syncAllJob` (e.g. every 6 h) and `pollTrackingJob` (every 12 h) with @core/jobs `schedule`. Suppliers
   in another currency need exchange rates for the scheduled sync: `setFxRatesProvider(async () => ({ base, rates }))`
   at startup, or env `SUPPLIER_FX_RATES='{"base":"EUR","rates":{"USD":1.08}}'`. Without them, products whose cost
   changed are paused with an `fx_rates_missing` exception. A failing supplier gets a `sync_failed` exception; the rest still sync.
6. Product pages: show `deliveryEstimate(variantId)` before purchase.
7. Add `...suppliersAdminResources()` to `src/genpm/admin.ts`; check open exceptions daily.

## What's inside

Paths are relative to `src/lib/suppliers`.

- `index.ts` — public API: `upsertSupplier`, `parseSupplierCsv`, `importProduct`, `syncSupplier`, `setFxRatesProvider`, `approveSupplierOrder`, `forwardSupplierOrder`, `recordSupplierShipment`, `deliveryEstimate`, `registerAdapter`, `suppliersAdminResources`.
- `suppliers.ts` — flows and jobs (`suppliers.forward`, `suppliers.sync`, `suppliers.tracking`). `adapter.ts` — contract.
- `adapters/manual.ts` — manual adapter and CSV parser. `adapters/cj.ts` — CJdropshipping adapter (`cjAdapter`, `CjApiError`).
- `admin.ts` — suppliers, supplier orders, exceptions.

## At a glance

- **GenPM dependencies** (installed with it): [@core/catalog](https://genpm.net/p/@core/catalog), [@core/orders](https://genpm.net/p/@core/orders), [@core/pricing](https://genpm.net/p/@core/pricing), [@core/jobs](https://genpm.net/p/@core/jobs), [@core/media](https://genpm.net/p/@core/media), [@core/email](https://genpm.net/p/@core/email), [@core/money](https://genpm.net/p/@core/money), [@core/rich-text](https://genpm.net/p/@core/rich-text), [@core/db](https://genpm.net/p/@core/db), [@core/contracts](https://genpm.net/p/@core/contracts)
- **npm dependencies** (proposed, never installed without asking): `zod`
- **Environment variables** (added to `.env.example`): `SUPPLIER_COST_ALERT_PCT`, `CJ_API_KEY`, `CJ_QPS`
- **AI rules**: [`AGENTS.md`](AGENTS.md), loaded by your agent only when it works in `src/lib/suppliers`

## Security

GenPM installs a 40-character commit SHA (never a branch), verifies an Ed25519-signed manifest, never runs install scripts and scans AI rules for prompt injection. Details: [genpm.net/docs/security](https://genpm.net/docs/security).

## License

MIT — see [LICENSE](LICENSE). Browse the full catalog at [genpm.net](https://genpm.net).
