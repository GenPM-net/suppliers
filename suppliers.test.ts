import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as authSchema from '../auth/schema.ts';
import { getProduct, getProductById, products, productVariants, upsertCategory } from '../catalog/index.ts';
import * as catalogSchema from '../catalog/schema.ts';
import { testDb } from '../db/__fixtures__/pglite.ts';
import type { Db } from '../db/index.ts';
import { type EmailMessage, setEmailProvider } from '../email/index.ts';
import { jobs, runDue } from '../jobs/index.ts';
import * as jobsSchema from '../jobs/schema.ts';
import * as mediaSchema from '../media/schema.ts';
import { money } from '../money/index.ts';
import { createOrder, getOrder, orderLines } from '../orders/index.ts';
import * as ordersSchema from '../orders/schema.ts';
import { upsertPriceRule } from '../pricing/index.ts';
import * as pricingSchema from '../pricing/schema.ts';
import { backendStorage, memoryBackend, setStorage } from '../storage/index.ts';
import * as schema from './schema.ts';
import {
  approveSupplierOrder,
  deliveryEstimate,
  forwardSupplierOrder,
  type ExternalProduct,
  importProduct,
  MAX_FORWARD_ATTEMPTS,
  parseSupplierCsv,
  pollTrackingJob,
  recordSupplierShipment,
  registerAdapter,
  setFxRatesProvider,
  type SupplierAdapter,
  supplierExceptions,
  supplierOrders,
  supplierProducts,
  suppliersAdminResource,
  syncAllJob,
  syncSupplier,
  upsertSupplier,
} from './index.ts';

let db: Db;
const sent: EmailMessage[] = [];
const realFetch = globalThis.fetch;
const address = { name: 'Ana', line1: 'Calle Mayor 1', city: 'Valencia', postalCode: '46001', country: 'ES' };
const fake = {
  costs: new Map<string, number>(),
  stock: new Map<string, number>(),
  currency: 'EUR',
  failSync: false,
  failOrders: false,
  hang: false,
  placed: [] as Array<Array<{ externalVariantId: string; quantity: number }>>,
  tracking: null as null | { trackingNumber: string },
};
const fakeApi: SupplierAdapter = {
  name: 'fakeapi',
  imageHosts: ['img.supplier.test'],
  async syncVariants(s, ids) {
    if (fake.failSync && s.name === 'Broken') throw new TypeError('cannot read properties of undefined');
    return ids.map((id) => ({ externalVariantId: id, cost: money(fake.costs.get(id) ?? 500, s.currency === 'EUR' ? 'EUR' : fake.currency), stock: fake.stock.get(id) ?? 10 }));
  },
  async placeOrder(_s, o) {
    fake.placed.push(o.lines);
    if (fake.failOrders) throw new Error('supplier API down');
    // Un proveedor que no responde y que además ignora la señal de cancelación.
    if (fake.hang) return new Promise<never>(() => {});
    return { externalRef: `EXT-${o.reference}` };
  },
  async getTracking() {
    return fake.tracking ? { status: 'shipped', carrier: 'GLS', ...fake.tracking } : null;
  },
};
registerAdapter(fakeApi);

const csv = `product_id,title,description,image_urls,option1_name,option1_value,variant_id,cost,stock,ship_min_days,ship_max_days
P1,"LED lamp, warm","<p>Nice <b>lamp</b></p>",https://img.supplier.test/a.png|http://insecure.test/b.png,Color,White,V1,7.20,25,7,12
P1,"LED lamp, warm",,,Color,Black,V2,7.50,0,7,12`;

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 10, 0, 0, 0, 10, 8, 2, 0, 0, 0, 0, 0, 0, 0]);

beforeEach(async () => {
  db = await testDb(authSchema, catalogSchema, ordersSchema, jobsSchema, pricingSchema, mediaSchema, schema);
  Object.assign(process.env, { STORE_CURRENCY: 'EUR', ORDER_LINK_SECRET: 'o'.repeat(40), SITE_URL: 'https://shop.test', EMAIL_FROM: 'shop@shop.test' });
  sent.length = 0;
  setEmailProvider({ name: 't', send: async (m) => (sent.push(m), { id: null }) });
  setStorage(backendStorage('memory', memoryBackend(), { secret: 's'.repeat(40), baseUrl: 'https://shop.test' }));
  globalThis.fetch = (async (url: string) => (String(url).startsWith('https://img.supplier.test/') ? new Response(png) : new Response('no', { status: 404 }))) as unknown as typeof fetch;
  fake.costs.clear();
  fake.stock.clear();
  fake.failOrders = false;
  fake.failSync = false;
  fake.hang = false;
  fake.currency = 'EUR';
  fake.placed.length = 0;
  fake.tracking = null;
  setFxRatesProvider(null);
  delete process.env.SUPPLIER_FX_RATES;
  await upsertCategory({ slug: 'lamps', name: 'Lamps' });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function importLamp(adapter = 'manual', config: Record<string, string> = { orderEmail: 'orders@supplier.test' }, autoForward = false) {
  const s = await upsertSupplier({ name: 'Acme', adapter, currency: 'EUR', config, autoForward });
  const [ext] = parseSupplierCsv(csv, 'EUR');
  const r = await importProduct(s.id, ext!, { slug: 'led-lamp', categories: ['lamps'], status: 'active' });
  return { supplier: s, ...r };
}

async function paidOrderFor(variantId: string, productId: string, qty = 1) {
  return createOrder({
    email: 'ana@x.test',
    currency: 'EUR',
    lines: [{ variantId, productId, sku: null, name: 'Lamp', title: 'White', kind: 'physical', quantity: qty, unitPrice: 1999, discount: 0 }],
    shippingAddress: address,
    payment: { provider: 'manual', ref: 'x', status: 'paid' },
  });
}

describe('CSV and import', () => {
  it('parses quoted CSV, groups variants and strips HTML', () => {
    const [p] = parseSupplierCsv(csv, 'EUR');
    expect(p).toMatchObject({ externalProductId: 'P1', title: 'LED lamp, warm', description: 'Nice lamp', images: ['https://img.supplier.test/a.png'], options: [{ name: 'Color', values: ['White', 'Black'] }], shippingDays: { min: 7, max: 12 } });
    expect(p!.variants.map((v) => [v.externalVariantId, v.cost.amount, v.stock])).toEqual([['V1', 720, 25], ['V2', 750, 0]]);
    expect(() => parseSupplierCsv('title\nx', 'EUR')).toThrow(/product_id/);
  });

  it('needs a price rule, imports priced variants with mappings, copies allowed images only', async () => {
    const s = await upsertSupplier({ name: 'Acme', adapter: 'manual', currency: 'EUR', config: {} });
    const [ext] = parseSupplierCsv(csv, 'EUR');
    await expect(importProduct(s.id, ext!, { slug: 'x' })).rejects.toMatchObject({ code: 'no_price_rule' });
    await upsertPriceRule({ name: 'x2.5', markupBps: 15000 });
    const { product } = await importProduct(s.id, ext!, { slug: 'led-lamp', categories: ['lamps'], imageHosts: ['img.supplier.test'] });
    expect(product.status).toBe('draft');
    expect(product.variants.map((v) => [v.title, v.price.amount, v.costAmount, v.stock])).toEqual([['White', 1899, 720, 25], ['Black', 1899, 750, 0]]);
    expect(product.media).toHaveLength(1);
    expect(await db.select().from(supplierProducts)).toHaveLength(2);
    expect(await deliveryEstimate(product.variants[0]!.id)).toEqual({ min: 7, max: 12 });
  });

  it('rejects secrets in config and other currencies without rates', async () => {
    await expect(upsertSupplier({ name: 'x', adapter: 'manual', currency: 'EUR', config: { apiKey: 'sk_live' } })).rejects.toThrow(/environment variables/);
    await upsertPriceRule({ name: 'x2', markupBps: 10000 });
    const usd = await upsertSupplier({ name: 'US', adapter: 'manual', currency: 'USD', config: {} });
    const ext: ExternalProduct = { externalProductId: 'U1', title: 'Cable', description: '', images: [], options: [], variants: [{ externalVariantId: 'U1V', options: {}, cost: money(1080, 'USD'), stock: 5 }] };
    await expect(importProduct(usd.id, ext, { slug: 'cable' })).rejects.toMatchObject({ code: 'currency' });
    const { product } = await importProduct(usd.id, ext, { slug: 'cable', rates: { base: 'EUR', rates: { USD: 1.08 } } });
    expect(product.variants[0]).toMatchObject({ costAmount: 1000, priceAmount: 2099 });
  });
});

describe('admin import actions', () => {
  it('imports from CSV as drafts (manual) and offers only the actions the adapter supports', async () => {
    await upsertPriceRule({ name: 'x2.5', markupBps: 15000 });
    const manual = await upsertSupplier({ name: 'Acme', adapter: 'manual', currency: 'EUR', config: {} });
    const api = await upsertSupplier({ name: 'API', adapter: 'fakeapi', currency: 'EUR', config: {} });
    const ctx = { user: { id: 'u', email: null, name: null }, can: async () => true };
    const action = (n: string) => suppliersAdminResource.actions!.find((a) => a.name === n)!;
    expect(action('import-csv').available!(manual)).toBe(true);
    expect(action('import-csv').available!(api)).toBe(false);
    expect(action('sync').available!(manual)).toBe(false);
    expect(action('sync').available!(api)).toBe(true);
    expect(action('import-product').available!(api)).toBe(false); // fakeapi no implementa getProduct
    await action('import-csv').run(manual.id, { csv, category: 'lamps' }, ctx);
    const p = (await getProduct('led-lamp-warm', { includeDraft: true }))!;
    expect(p).toMatchObject({ status: 'draft', categories: [{ slug: 'lamps', name: 'Lamps' }] });
    await expect(action('import-csv').run(manual.id, { csv: 'title\nx' }, ctx)).rejects.toMatchObject({ code: 'invalid' });
    await expect(action('import-csv').run(manual.id, { csv }, { ...ctx, can: async () => false })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('order forwarding', () => {
  beforeEach(async () => {
    await upsertPriceRule({ name: 'x2.5', markupBps: 15000 });
  });

  it('waits for approval, emails the manual supplier and records the shipment on the order', async () => {
    const { product } = await importLamp();
    const o = await paidOrderFor(product.variants[0]!.id, product.id, 2);
    await runDue();
    const [so] = await db.select().from(supplierOrders);
    expect(so).toMatchObject({ status: 'pending_approval', lines: [{ externalVariantId: 'V1', quantity: 2 }] });
    await approveSupplierOrder(so!.id);
    await runDue();
    const mail = sent.find((m) => m.to === 'orders@supplier.test')!;
    expect(mail.subject).toBe(`New order ${o.number}`);
    expect(mail.text).toContain('V1 × 2');
    expect(mail.text).toContain('Calle Mayor 1');
    expect((await db.select().from(supplierOrders))[0]!.status).toBe('sent');
    await recordSupplierShipment(so!.id, { carrier: 'Correos', trackingNumber: 'PQ1' });
    expect((await getOrder(o.id))!.fulfillmentStatus).toBe('fulfilled');
    expect((await getOrder(o.id))!.fulfillments[0]!.source).toBe('Acme');
  });

  it('auto-forwards with retries and opens an exception when the supplier keeps failing', async () => {
    const { product } = await importLamp('fakeapi', {}, true);
    fake.failOrders = true;
    await paidOrderFor(product.variants[0]!.id, product.id);
    await runDue(); // evento paid → crea el pedido al proveedor (en cola)
    for (let i = 0; i < MAX_FORWARD_ATTEMPTS; i++) await runDue({ now: new Date(Date.now() + (i + 1) * 3_600_000) });
    const [so] = await db.select().from(supplierOrders);
    expect(so).toMatchObject({ status: 'failed', error: 'supplier API down' });
    expect((await db.select().from(supplierExceptions)).map((e) => e.type)).toEqual(['forward_failed']);
    fake.failOrders = false;
    await approveSupplierOrder(so!.id);
    await runDue();
    expect((await db.select().from(supplierOrders))[0]).toMatchObject({ status: 'sent', externalRef: expect.stringMatching(/^EXT-/) });
  });

  it('never re-sends a supplier order whose previous attempt was interrupted; timeouts leave an exception', async () => {
    const { product } = await importLamp('fakeapi', {}, true);
    await paidOrderFor(product.variants[0]!.id, product.id);
    await runDue(); // evento paid → pedido al proveedor en cola
    fake.hang = true;
    const [so] = await db.select().from(supplierOrders);
    const ac = new AbortController();
    const run = forwardSupplierOrder(so!.id, { attempt: 1, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    // Mientras se envía, la fila está reclamada: otro intento simultáneo no la vuelve a mandar.
    expect((await db.select().from(supplierOrders))[0]!.status).toBe('sending');
    await forwardSupplierOrder(so!.id, { attempt: 2, signal: new AbortController().signal });
    expect(fake.placed).toHaveLength(1);
    ac.abort(new Error('timeout after 60000 ms'));
    await run;
    const after = (await db.select().from(supplierOrders))[0]!;
    expect(after).toMatchObject({ status: 'failed', attempts: 1, error: expect.stringMatching(/^outcome unknown/) });
    const ex = await db.select().from(supplierExceptions);
    expect(ex.map((e) => [e.type, e.data])).toEqual([['forward_failed', { supplierOrderId: so!.id, outcome: 'unknown' }]]);
    await runDue({ now: new Date(Date.now() + 3_600_000) });
    expect(fake.placed).toHaveLength(1);
  });

  it('a row left in sending by a crashed worker goes to review instead of being re-sent', async () => {
    const { product } = await importLamp('fakeapi', {}, true);
    await paidOrderFor(product.variants[0]!.id, product.id);
    await runDue();
    const [so] = await db.select().from(supplierOrders);
    await db.update(supplierOrders).set({ status: 'sending' });
    await forwardSupplierOrder(so!.id, { attempt: 2, signal: new AbortController().signal });
    expect(fake.placed).toHaveLength(0);
    expect((await db.select().from(supplierOrders))[0]!.status).toBe('failed');
    expect((await db.select().from(supplierExceptions)).map((e) => e.type)).toEqual(['forward_failed']);
  });

  it('forwards only the units that were not refunded and cancels when nothing is left', async () => {
    const { product } = await importLamp();
    const o = await paidOrderFor(product.variants[0]!.id, product.id, 3);
    await runDue();
    const line = (await getOrder(o.id))!.lines[0]!;
    await db.update(orderLines).set({ refundedQuantity: 1 }).where(eq(orderLines.id, line.id));
    const [so] = await db.select().from(supplierOrders);
    await approveSupplierOrder(so!.id);
    await runDue();
    expect(sent.find((m) => m.to === 'orders@supplier.test')!.text).toContain('V1 × 2');
    const o2 = await paidOrderFor(product.variants[0]!.id, product.id, 1);
    await runDue();
    await db.update(orderLines).set({ refundedQuantity: 1 }).where(eq(orderLines.orderId, o2.id));
    const so2 = (await db.select().from(supplierOrders).where(eq(supplierOrders.orderId, o2.id)))[0]!;
    await approveSupplierOrder(so2.id);
    await runDue();
    expect((await db.select().from(supplierOrders).where(eq(supplierOrders.id, so2.id)))[0]!.status).toBe('cancelled');
    expect(sent.filter((m) => m.to === 'orders@supplier.test')).toHaveLength(1);
  });

  it('polls tracking from the API and flags stalled orders', async () => {
    const { product } = await importLamp('fakeapi', {}, true);
    const o = await paidOrderFor(product.variants[0]!.id, product.id);
    await runDue();
    await runDue();
    await pollTrackingJob.enqueue({});
    await runDue();
    expect((await getOrder(o.id))!.fulfillmentStatus).toBe('unfulfilled');
    await db.update(supplierOrders).set({ updatedAt: new Date(Date.now() - 11 * 86_400_000) });
    await pollTrackingJob.enqueue({});
    await runDue();
    expect((await db.select().from(supplierExceptions)).map((e) => e.type)).toEqual(['tracking_stalled']);
    fake.tracking = { trackingNumber: 'GLS123' };
    await pollTrackingJob.enqueue({});
    await runDue();
    expect((await getOrder(o.id))!.fulfillments[0]).toMatchObject({ carrier: 'GLS', trackingNumber: 'GLS123' });
    expect(await db.select().from(jobs).where(eq(jobs.status, 'failed'))).toHaveLength(0);
  });
});

describe('sync', () => {
  it('updates stock, reprices on cost changes and pauses products that would sell at a loss', async () => {
    await upsertPriceRule({ name: 'x2.5', markupBps: 15000 });
    const { supplier, product } = await importLamp('fakeapi');
    fake.costs.set('V1', 1000); // +39 %
    fake.costs.set('V2', 750);
    fake.stock.set('V2', 3);
    const r = await syncSupplier(supplier.id);
    expect(r).toEqual({ updated: 2, paused: 0 });
    const after = (await getProductById(product.id))!;
    expect(after.variants.map((v) => [v.title, v.price.amount, v.stock])).toEqual([['White', 2599, 10], ['Black', 1899, 3]]);
    expect((await db.select().from(supplierExceptions)).map((e) => e.type)).toEqual(['cost_increase']);
    // Sin regla aplicable el precio no se recalcula: si el coste lo supera, el producto se pausa.
    await db.delete(pricingSchema.priceRules);
    fake.costs.set('V1', 5000);
    expect((await syncSupplier(supplier.id)).paused).toBe(1);
    expect((await db.select().from(products).where(eq(products.id, product.id)))[0]!.status).toBe('draft');
    expect((await db.select().from(supplierExceptions)).map((e) => e.type)).toContain('negative_margin');
    expect(await getProduct('led-lamp')).toBeNull();
    const v1 = (await db.select().from(productVariants).where(eq(productVariants.id, product.variants[0]!.id)))[0]!;
    expect(v1.costAmount).toBe(5000);
    await expect(syncSupplier((await upsertSupplier({ name: 'M', adapter: 'manual', currency: 'EUR', config: {} })).id)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('the scheduled sync isolates failing suppliers and pauses products whose foreign cost changed without rates', async () => {
    await upsertPriceRule({ name: 'x2', markupBps: 10000 });
    await upsertSupplier({ name: 'Broken', adapter: 'fakeapi', currency: 'EUR', config: {} });
    fake.failSync = true;
    const usd = await upsertSupplier({ name: 'US', adapter: 'fakeapi', currency: 'USD', config: {} });
    fake.currency = 'USD';
    const ext: ExternalProduct = { externalProductId: 'U1', title: 'Cable', description: '', images: [], options: [], variants: [{ externalVariantId: 'U1V', options: {}, cost: money(1080, 'USD'), stock: 5 }] };
    const { product } = await importProduct(usd.id, ext, { slug: 'cable', status: 'active', rates: { base: 'EUR', rates: { USD: 1.08 } } });
    fake.costs.set('U1V', 2160);
    fake.stock.set('U1V', 7);
    await syncAllJob.enqueue({});
    await runDue();
    expect(await db.select().from(jobs).where(eq(jobs.status, 'failed'))).toHaveLength(0);
    const ex = await db.select().from(supplierExceptions);
    expect(ex.map((e) => e.type).sort()).toEqual(['fx_rates_missing', 'sync_failed']);
    const v = (await db.select().from(productVariants).where(eq(productVariants.id, product.variants[0]!.id)))[0]!;
    expect([v.costAmount, v.stock]).toEqual([1000, 7]); // coste viejo, pero el producto ya no se vende
    expect((await db.select().from(products).where(eq(products.id, product.id)))[0]!.status).toBe('draft');
    // Con tipos de cambio (aquí por variable de entorno), el coste se convierte y se reprecia.
    process.env.SUPPLIER_FX_RATES = JSON.stringify({ base: 'EUR', rates: { USD: 1.08 } });
    await syncAllJob.enqueue({});
    await runDue();
    const v2 = (await db.select().from(productVariants).where(eq(productVariants.id, product.variants[0]!.id)))[0]!;
    expect([v2.costAmount, v2.priceAmount]).toEqual([2000, 4099]); // 20,00 × 2 = 40,00 → 40,99
    expect((await db.select().from(supplierExceptions)).filter((e) => e.type === 'fx_rates_missing')).toHaveLength(1);
  });
});
