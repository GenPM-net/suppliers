// Dropshipping: importar productos del proveedor al catálogo (precio por reglas), sincronizar coste y stock, reenviar
// pedidos pagados y traer el seguimiento. Lo que no se puede automatizar acaba en `supplier_exceptions`.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createProduct, getProductById, productVariants, products } from '../catalog/index.ts';
import { type Executor, getDb } from '../db/index.ts';
import { defineJob } from '../jobs/index.ts';
import { importRemoteImage } from '../media/index.ts';
import { convert, type Money } from '../money/index.ts';
import { addFulfillment, getOrder, onOrderEvent } from '../orders/index.ts';
import { priceFromCost, repriceProduct, setVariantPrice } from '../pricing/index.ts';
import { docFromText } from '../rich-text/index.ts';
import { type ExternalProduct, getAdapter } from './adapter.ts';
import { type Supplier, type SupplierOrder, supplierExceptions, supplierOrders, supplierProducts, suppliers } from './schema.ts';

export class SupplierError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid' | 'no_price_rule' | 'currency' | 'unsupported' | 'forbidden' | 'invalid_state',
    message: string = code,
  ) {
    super(message);
    this.name = 'SupplierError';
  }
}

export const SupplierInput = z.object({
  name: z.string().min(1).max(80),
  adapter: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  config: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,30}$/), z.string().max(300)).default({}),
  status: z.enum(['active', 'paused']).default('active'),
  autoForward: z.boolean().default(false),
});

export async function upsertSupplier(input: z.input<typeof SupplierInput>, id?: string, db: Executor = getDb()): Promise<Supplier> {
  const s = SupplierInput.parse(input);
  if (Object.keys(s.config).some((k) => /key|secret|token|password/i.test(k))) throw new SupplierError('invalid', 'credentials go in environment variables, not in supplier config');
  getAdapter(s.adapter);
  const [row] = id ? await db.update(suppliers).set(s).where(eq(suppliers.id, id)).returning() : await db.insert(suppliers).values(s).returning();
  return row!;
}

async function supplierById(id: string, db: Executor): Promise<Supplier> {
  const [s] = await db.select().from(suppliers).where(eq(suppliers.id, id));
  if (!s) throw new SupplierError('not_found', `supplier ${id} not found`);
  return s;
}

export async function exception(type: (typeof supplierExceptions.$inferInsert)['type'], message: string, refs: { supplierId?: string; variantId?: string; orderId?: string; data?: Record<string, unknown> }, db: Executor = getDb()) {
  await db.insert(supplierExceptions).values({ type, message: message.slice(0, 500), supplierId: refs.supplierId ?? null, variantId: refs.variantId ?? null, orderId: refs.orderId ?? null, data: refs.data ?? {} });
}

export type FxRates = { base: string; rates: Record<string, number> };

const FxRatesSchema = z.object({ base: z.string().regex(/^[A-Z]{3}$/), rates: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().positive()) });
let fxProvider: (() => Promise<FxRates | null> | FxRates | null) | null = null;

/**
 * Fuente de tipos de cambio para la sincronización programada (p. ej. una API de tipos o una tabla propia). Sin ella
 * se usa `SUPPLIER_FX_RATES` (JSON `{"base":"EUR","rates":{"USD":1.08}}`) si está definida.
 */
export function setFxRatesProvider(fn: (() => Promise<FxRates | null> | FxRates | null) | null): void {
  fxProvider = fn;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Tipos de cambio actuales (proveedor registrado o `SUPPLIER_FX_RATES`); undefined si no hay. */
export async function currentFxRates(): Promise<FxRates | undefined> {
  if (fxProvider) return (await fxProvider()) ?? undefined;
  const raw = process.env.SUPPLIER_FX_RATES;
  if (!raw) return undefined;
  const parsed = FxRatesSchema.safeParse(parseJson(raw));
  if (!parsed.success) throw new SupplierError('invalid', 'SUPPLIER_FX_RATES must be JSON like {"base":"EUR","rates":{"USD":1.08}}');
  return parsed.data;
}

/** Coste del proveedor en la moneda de la tienda (con tipos de cambio si son distintas). */
function storeCost(cost: Money, rates?: FxRates): Money {
  const store = process.env.STORE_CURRENCY ?? 'EUR';
  if (cost.currency === store) return cost;
  if (!rates) throw new SupplierError('currency', `supplier cost is in ${cost.currency}; pass exchange rates to convert to ${store}`);
  try {
    return convert(cost, store, rates);
  } catch (e) {
    throw new SupplierError('currency', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Importa un producto del proveedor como borrador: precio de cada variante por reglas de @core/pricing, imágenes
 * copiadas a @core/media y descripción como texto plano. Revísalo en el panel antes de publicarlo.
 */
export async function importProduct(
  supplierId: string,
  ext: ExternalProduct,
  opts: { slug: string; name?: string; categories?: string[]; rates?: FxRates; imageHosts?: string[]; status?: 'draft' | 'active' } ,
  db = getDb(),
) {
  const supplier = await supplierById(supplierId, db);
  const adapter = getAdapter(supplier.adapter);
  if (!ext.variants.length) throw new SupplierError('invalid', 'product has no variants');
  const variants = [];
  for (const v of ext.variants) {
    const cost = storeCost(v.cost, opts.rates);
    const quote = await priceFromCost(cost, { supplierId, categorySlugs: opts.categories }, db);
    if (!quote) throw new SupplierError('no_price_rule', 'create a price rule (@core/pricing) before importing');
    variants.push({ v, cost, quote });
  }
  const media: string[] = [];
  for (const url of ext.images.slice(0, 10)) {
    try {
      media.push((await importRemoteImage(url, { allowedHosts: [...adapter.imageHosts, ...(opts.imageHosts ?? [])], alt: ext.title.slice(0, 200), folder: 'products' }, db)).id);
    } catch {
      // Imagen no válida o de un host no permitido: se omite (el panel avisa de productos sin imagen).
    }
  }
  const product = await createProduct(
    {
      slug: opts.slug,
      name: (opts.name ?? ext.title).slice(0, 200),
      status: opts.status ?? 'draft',
      description: docFromText(ext.description),
      options: ext.options.slice(0, 3),
      categories: opts.categories ?? [],
      media,
      tags: [],
      variants: variants.map(({ v, cost, quote }) => ({
        sku: `${supplierId.slice(-6)}-${v.externalVariantId}`.slice(0, 64),
        options: v.options,
        price: quote.price.amount,
        cost: cost.amount,
        stock: v.stock ?? 0,
        trackStock: v.stock !== null,
        weightGrams: v.weightGrams ?? null,
      })),
    },
    db,
  );
  const view = (await getProductById(product.id, db))!;
  for (const { v } of variants) {
    const local = view.variants.find((x) => JSON.stringify(x.options) === JSON.stringify(v.options));
    if (!local) continue;
    await db.insert(supplierProducts).values({
      variantId: local.id,
      supplierId,
      externalProductId: ext.externalProductId,
      externalVariantId: v.externalVariantId,
      cost: v.cost.amount,
      currency: v.cost.currency,
      shippingDaysMin: ext.shippingDays?.min ?? null,
      shippingDaysMax: ext.shippingDays?.max ?? null,
      lastSyncAt: new Date(),
    });
    await setVariantPrice(local.id, local.priceAmount, db);
  }
  return { product: view, belowMinimum: variants.filter((x) => x.quote.belowMinimum).map((x) => x.v.externalVariantId) };
}

const costAlertPct = () => Number(process.env.SUPPLIER_COST_ALERT_PCT ?? 10);

/**
 * Sincroniza coste y stock con el proveedor. Si el coste cambia, reprecia con las reglas; si el margen queda negativo,
 * pasa el producto a borrador y crea una excepción (nunca vende con pérdida en silencio). Si el coste cambió en otra
 * moneda y no hay tipo de cambio, tampoco se sigue vendiendo con el coste viejo: el producto se pausa con una
 * excepción `fx_rates_missing` y el coste se vuelve a comprobar en la siguiente sincronización.
 */
export async function syncSupplier(supplierId: string, opts: { rates?: FxRates } = {}, db = getDb()): Promise<{ updated: number; paused: number }> {
  const supplier = await supplierById(supplierId, db);
  const adapter = getAdapter(supplier.adapter);
  if (!adapter.syncVariants) throw new SupplierError('unsupported', `${adapter.name} cannot sync automatically`);
  const mapped = await db.select().from(supplierProducts).where(eq(supplierProducts.supplierId, supplierId));
  let updated = 0;
  let paused = 0;
  let fresh: Awaited<ReturnType<NonNullable<typeof adapter.syncVariants>>>;
  try {
    fresh = await adapter.syncVariants(supplier, mapped.map((m) => m.externalVariantId));
  } catch (e) {
    await exception('sync_failed', e instanceof Error ? e.message : String(e), { supplierId }, db);
    return { updated, paused };
  }
  const touchedProducts = new Set<string>();
  const noRate = new Map<string, string>(); // variante → moneda sin tipo de cambio
  for (const f of fresh) {
    const m = mapped.find((x) => x.externalVariantId === f.externalVariantId);
    if (!m) continue;
    const changes: Partial<typeof productVariants.$inferInsert> = {};
    if (f.stock !== null) changes.stock = Math.max(0, f.stock);
    if (f.cost && (f.cost.amount !== m.cost || f.cost.currency !== m.currency)) {
      let cost: Money | null = null;
      try {
        cost = storeCost(f.cost, opts.rates);
      } catch (e) {
        if (!(e instanceof SupplierError && e.code === 'currency')) throw e;
        noRate.set(m.variantId, f.cost.currency);
      }
      if (cost) {
        const pct = m.cost ? ((f.cost.amount - m.cost) * 100) / m.cost : 100;
        if (pct >= costAlertPct()) await exception('cost_increase', `Cost rose ${pct.toFixed(1)}%`, { supplierId, variantId: m.variantId, data: { from: m.cost, to: f.cost.amount } }, db);
        changes.costAmount = cost.amount;
        await db.update(supplierProducts).set({ cost: f.cost.amount, currency: f.cost.currency }).where(eq(supplierProducts.variantId, m.variantId));
      }
    }
    await db.update(supplierProducts).set({ lastSyncAt: new Date() }).where(eq(supplierProducts.variantId, m.variantId));
    if (Object.keys(changes).length) {
      const [v] = await db.update(productVariants).set(changes).where(eq(productVariants.id, m.variantId)).returning();
      if (changes.costAmount !== undefined && v) touchedProducts.add(v.productId);
      updated++;
    }
  }
  if (noRate.size) {
    const rows = await db.select({ productId: productVariants.productId }).from(productVariants).where(inArray(productVariants.id, [...noRate.keys()]));
    const productIds = [...new Set(rows.map((r) => r.productId))];
    await db.update(products).set({ status: 'draft' }).where(inArray(products.id, productIds));
    await exception('fx_rates_missing', `Products paused: supplier cost changed in ${[...new Set(noRate.values())].join(', ')} and there is no exchange rate`, { supplierId, data: { productIds, variants: [...noRate.keys()] } }, db);
    paused += productIds.length;
    for (const id of productIds) touchedProducts.delete(id);
  }
  for (const productId of touchedProducts) {
    await repriceProduct(productId, { supplierId }, db);
    // Tras repreciar (o si ninguna regla aplica), ninguna variante puede venderse por debajo de su coste.
    const current = await db.select().from(productVariants).where(and(eq(productVariants.productId, productId), eq(productVariants.active, true)));
    const losing = current.filter((v) => v.costAmount != null && v.priceAmount <= v.costAmount).map((v) => ({ variantId: v.id }));
    if (losing.length) {
      await db.update(products).set({ status: 'draft' }).where(eq(products.id, productId));
      await exception('negative_margin', 'Product paused: selling price would not cover the cost', { supplierId, data: { productId, variants: losing.map((l) => l.variantId) } }, db);
      paused++;
    }
  }
  await db.update(suppliers).set({ lastSyncAt: new Date() }).where(eq(suppliers.id, supplierId));
  return { updated, paused };
}

/**
 * Sincronización programada de todos los proveedores activos con API, con los tipos de cambio de `currentFxRates`.
 * Cada proveedor va aparte: si uno falla queda una excepción `sync_failed` y se sigue con los demás.
 */
export const syncAllJob = defineJob('suppliers.sync', z.object({}), async () => {
  const db = getDb();
  const active = await db.select().from(suppliers).where(eq(suppliers.status, 'active'));
  let rates: FxRates | undefined;
  try {
    rates = await currentFxRates();
  } catch (e) {
    await exception('sync_failed', `Exchange rates unavailable: ${e instanceof Error ? e.message : String(e)}`, {}, db);
  }
  for (const s of active) {
    try {
      if (getAdapter(s.adapter).syncVariants) await syncSupplier(s.id, { rates }, db);
    } catch (e) {
      await exception('sync_failed', e instanceof Error ? e.message : String(e), { supplierId: s.id }, db);
    }
  }
}, { timeoutMs: 15 * 60_000, maxAttempts: 2 });

// —— pedidos ——

/** Crea los pedidos al proveedor (uno por proveedor) de un pedido pagado. Se ejecuta en el evento `paid`. */
export async function createSupplierOrders(orderId: string, db: Executor = getDb()): Promise<SupplierOrder[]> {
  const order = await getOrder(orderId, db);
  if (!order) return [];
  const variantIds = order.lines.flatMap((l) => (l.variantId ? [l.variantId] : []));
  if (!variantIds.length) return [];
  const mapped = await db.select().from(supplierProducts).where(inArray(supplierProducts.variantId, variantIds));
  const bySupplier = new Map<string, SupplierOrder['lines']>();
  for (const l of order.lines) {
    const m = mapped.find((x) => x.variantId === l.variantId);
    if (!m) continue;
    bySupplier.set(m.supplierId, [...(bySupplier.get(m.supplierId) ?? []), { orderLineId: l.id, externalVariantId: m.externalVariantId, quantity: l.quantity }]);
  }
  const created: SupplierOrder[] = [];
  for (const [supplierId, lines] of bySupplier) {
    const s = await supplierById(supplierId, db);
    const [row] = await db
      .insert(supplierOrders)
      .values({ orderId, supplierId, lines, status: s.autoForward && s.status === 'active' ? 'queued' : 'pending_approval' })
      .onConflictDoNothing()
      .returning();
    if (!row) continue;
    created.push(row);
    if (row.status === 'queued') await forwardJob.enqueue({ supplierOrderId: row.id }, { dedupeKey: `suppliers.forward:${row.id}` }, db);
  }
  return created;
}

/** Aprobación manual (modo por defecto): pasa a la cola de reenvío. */
export async function approveSupplierOrder(id: string, db: Executor = getDb()): Promise<SupplierOrder> {
  const [row] = await db.update(supplierOrders).set({ status: 'queued', error: null }).where(and(eq(supplierOrders.id, id), inArray(supplierOrders.status, ['pending_approval', 'failed']))).returning();
  if (!row) throw new SupplierError('invalid_state', 'only pending or failed supplier orders can be (re)sent');
  await forwardJob.enqueue({ supplierOrderId: id }, { dedupeKey: `suppliers.forward:${id}:${row.attempts}` }, db);
  return row;
}

export const MAX_FORWARD_ATTEMPTS = 5;

/** El resultado del envío es desconocido (cortado a medias): no se reenvía solo; queda para revisión manual. */
async function outcomeUnknown(so: SupplierOrder, why: string, db: Executor) {
  const [row] = await db
    .update(supplierOrders)
    .set({ status: 'failed', error: `outcome unknown: ${why}`.slice(0, 500) })
    .where(and(eq(supplierOrders.id, so.id), eq(supplierOrders.status, 'sending')))
    .returning();
  if (row) await exception('forward_failed', `Forwarding was interrupted (${why}); check with the supplier whether the order was received before re-sending`, { supplierId: so.supplierId, orderId: so.orderId, data: { supplierOrderId: so.id, outcome: 'unknown' } }, db);
}

/** Rechaza en cuanto se aborta `signal`, aunque el adaptador no lo respete. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return Promise.race([p, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
}

/**
 * Envía un pedido al proveedor como mucho una vez: reclama la fila (`queued → sending`) antes de llamar al adaptador.
 * Una fila que ya estaba `sending` (intento anterior cortado) nunca se reenvía: pasa a `failed` con excepción, porque
 * no se sabe si el proveedor la recibió. Un error del adaptador (que solo lanza si el pedido no se creó) vuelve a la
 * cola hasta agotar intentos; un timeout deja el resultado como desconocido. Se envían las unidades no reembolsadas.
 */
export async function forwardSupplierOrder(supplierOrderId: string, ctx: { attempt: number; signal: AbortSignal }, db: Executor = getDb()): Promise<void> {
  const [so] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, supplierOrderId));
  if (!so) return;
  if (so.status === 'sending') return outcomeUnknown(so, 'a previous attempt did not finish', db);
  if (so.status !== 'queued') return;
  const order = await getOrder(so.orderId, db);
  const lines = so.lines.flatMap((l) => {
    const ol = order?.lines.find((x) => x.id === l.orderLineId);
    const quantity = ol ? Math.min(l.quantity, ol.quantity - ol.refundedQuantity) : 0;
    return quantity > 0 ? [{ externalVariantId: l.externalVariantId, quantity }] : [];
  });
  if (!order || order.status === 'cancelled' || order.status === 'refunded' || !lines.length) {
    await db.update(supplierOrders).set({ status: 'cancelled' }).where(and(eq(supplierOrders.id, so.id), eq(supplierOrders.status, 'queued')));
    return;
  }
  const supplier = await supplierById(so.supplierId, db);
  const [claimed] = await db
    .update(supplierOrders)
    .set({ status: 'sending', attempts: sql`${supplierOrders.attempts} + 1` })
    .where(and(eq(supplierOrders.id, so.id), eq(supplierOrders.status, 'queued')))
    .returning();
  if (!claimed) return; // otro proceso lo reclamó
  try {
    if (!order.shippingAddress) throw new Error('order has no shipping address');
    const request = { reference: order.number, email: order.email, address: order.shippingAddress, lines };
    const { externalRef } = await untilAborted(getAdapter(supplier.adapter).placeOrder(supplier, request, { signal: ctx.signal }), ctx.signal);
    // También desde `failed`: si un intento dado por perdido acaba llegando, se registra que sí se envió.
    await db.update(supplierOrders).set({ status: 'sent', externalRef, error: null }).where(and(eq(supplierOrders.id, so.id), inArray(supplierOrders.status, ['sending', 'failed'])));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (ctx.signal.aborted) return outcomeUnknown(claimed, message, db);
    const final = ctx.attempt >= MAX_FORWARD_ATTEMPTS;
    await db
      .update(supplierOrders)
      .set({ status: final ? 'failed' : 'queued', error: message.slice(0, 500) })
      .where(and(eq(supplierOrders.id, so.id), eq(supplierOrders.status, 'sending')));
    if (final) {
      await exception('forward_failed', message, { supplierId: so.supplierId, orderId: so.orderId, data: { supplierOrderId: so.id } }, db);
      return;
    }
    throw e;
  }
}

/** Envía el pedido al proveedor (ver `forwardSupplierOrder`). Reintenta con backoff; al agotar intentos, excepción. */
export const forwardJob = defineJob('suppliers.forward', z.object({ supplierOrderId: z.string() }), ({ supplierOrderId }, ctx) => forwardSupplierOrder(supplierOrderId, ctx), {
  maxAttempts: MAX_FORWARD_ATTEMPTS,
  timeoutMs: 60_000,
});

/** Registra el envío del proveedor en el pedido (@core/orders) con las líneas de ese proveedor. */
export async function recordSupplierShipment(id: string, tracking: { carrier?: string; trackingNumber?: string; trackingUrl?: string }, db: Executor = getDb()): Promise<SupplierOrder> {
  const [so] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, id));
  if (!so || so.status !== 'sent') throw new SupplierError('invalid_state', 'only sent supplier orders can be marked shipped');
  const supplier = await supplierById(so.supplierId, db);
  await addFulfillment(so.orderId, { lines: so.lines.map((l) => ({ lineId: l.orderLineId, quantity: l.quantity })), ...tracking, source: supplier.name }, db);
  const [row] = await db.update(supplierOrders).set({ status: 'shipped' }).where(eq(supplierOrders.id, id)).returning();
  return row!;
}

export const STALLED_DAYS = 10;

/** Consulta el seguimiento de los pedidos enviados y avisa de los que llevan demasiado sin moverse. */
export const pollTrackingJob = defineJob('suppliers.tracking', z.object({}), async () => {
  const db = getDb();
  const sent = await db.select().from(supplierOrders).where(eq(supplierOrders.status, 'sent'));
  for (const so of sent) {
    const supplier = await supplierById(so.supplierId, db);
    const adapter = getAdapter(supplier.adapter);
    const info = adapter.getTracking && so.externalRef ? await adapter.getTracking(supplier, so.externalRef).catch(() => null) : null;
    if (info && (info.status === 'shipped' || info.status === 'delivered') && (info.trackingNumber || info.trackingUrl)) {
      await recordSupplierShipment(so.id, { carrier: info.carrier, trackingNumber: info.trackingNumber, trackingUrl: info.trackingUrl }, db);
      continue;
    }
    if (so.updatedAt.getTime() < Date.now() - STALLED_DAYS * 86_400_000) {
      const [already] = await db.select({ id: supplierExceptions.id }).from(supplierExceptions).where(and(eq(supplierExceptions.type, 'tracking_stalled'), eq(supplierExceptions.orderId, so.orderId), eq(supplierExceptions.status, 'open')));
      if (!already) await exception('tracking_stalled', `No tracking after ${STALLED_DAYS} days`, { supplierId: so.supplierId, orderId: so.orderId }, db);
    }
  }
});

/** Plazo de entrega del proveedor para mostrarlo antes de comprar (mín./máx. días). */
export async function deliveryEstimate(variantId: string, db: Executor = getDb()): Promise<{ min: number; max: number } | null> {
  const [m] = await db.select().from(supplierProducts).where(eq(supplierProducts.variantId, variantId));
  return m?.shippingDaysMin != null && m.shippingDaysMax != null ? { min: m.shippingDaysMin, max: m.shippingDaysMax } : null;
}

export async function resolveException(id: string, db: Executor = getDb()): Promise<void> {
  await db.update(supplierExceptions).set({ status: 'resolved' }).where(eq(supplierExceptions.id, id));
}

/** Registra el reenvío al pagarse un pedido. Se llama al importar el módulo. */
export function registerSuppliers(): void {
  onOrderEvent('paid', 'suppliers.forward', async (o) => void (await createSupplierOrders(o.id)));
}
registerSuppliers();

