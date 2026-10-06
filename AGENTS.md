# @core/suppliers — rules for AI agents

## Purpose
Dropshipping operations behind a `SupplierAdapter` contract: import supplier products into @core/catalog as drafts
(price from @core/pricing rules, images copied to @core/media, plain-text description), map variants to supplier
SKUs with cost and delivery days, sync cost and stock (reprice; pause products that would sell at a loss), turn paid
orders into supplier orders (approval by default, or automatic), forward them with retries, record tracking on the
order and keep an exceptions queue. Ships the `manual` adapter (CSV import, orders emailed to the supplier).

## Map
- `index.ts` — public API: `upsertSupplier`, `parseSupplierCsv`, `importProduct`, `syncSupplier`, `setFxRatesProvider`, `approveSupplierOrder`, `forwardSupplierOrder`, `recordSupplierShipment`, `deliveryEstimate`, `registerAdapter`, `suppliersAdminResources`.
- `suppliers.ts` — flows and jobs (`suppliers.forward`, `suppliers.sync`, `suppliers.tracking`). `adapter.ts` — contract.
- `adapters/manual.ts` — manual adapter and CSV parser. `admin.ts` — suppliers, supplier orders, exceptions.

## Integration
1. Install @core/pricing and create at least one price rule. Migrations as in `src/lib/db/AGENTS.md`; the @core/jobs cron must run.
2. Import this module at startup (registers the manual adapter and the `paid` order handler).
3. Create a supplier in the admin: adapter `manual`, `config.orderEmail`, currency. API adapters read credentials from env, never from `config`.
4. Import: `importProduct(supplierId, parseSupplierCsv(csv, currency)[0], { slug, categories })` → review the draft, then publish.
5. Schedule `syncAllJob` (e.g. every 6 h) and `pollTrackingJob` (every 12 h) with @core/jobs `schedule`. Suppliers
   in another currency need exchange rates for the scheduled sync: `setFxRatesProvider(async () => ({ base, rates }))`
   at startup, or env `SUPPLIER_FX_RATES='{"base":"EUR","rates":{"USD":1.08}}'`. Without them, products whose cost
   changed are paused with an `fx_rates_missing` exception. A failing supplier gets a `sync_failed` exception; the rest still sync.
6. Product pages: show `deliveryEstimate(variantId)` before purchase.
7. Add `...suppliersAdminResources()` to `src/genpm/admin.ts`; check open exceptions daily.

## Conventions
- New adapters implement `SupplierAdapter` in their own file and call `registerAdapter`; list their image hosts.
- Supplier orders start in `pending_approval` unless the supplier has `autoForward`; failures retry, then open an exception.
- Forwarding is at most once: the row is claimed (`queued → sending`) before `placeOrder`. A timeout or a row found
  in `sending` means the outcome is unknown: it goes to `failed` with a `forward_failed` exception and is never
  re-sent automatically — check with the supplier before approving it again. Only non-refunded units are forwarded.
- Adapters: `placeOrder` throws only when the order was NOT created, uses `order.reference` as idempotency key when
  the API allows it, and passes `opts.signal` to `fetch`.
- Costs may be in another currency: pass exchange `rates` (and store them) when importing or syncing.

## Don't
- Don't scrape supplier websites or bypass their terms; use official APIs or the manual adapter.
- Don't forward unpaid, cancelled or refunded orders, and don't sell below cost (sync pauses those products).
- Don't hotlink supplier images or copy descriptions claiming features/certifications you can't verify.
