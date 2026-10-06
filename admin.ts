// Panel: proveedores (sincronizar), pedidos a proveedores (aprobar, reintentar, registrar envío) y excepciones.
import { count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AdminContext, AdminResource } from '../contracts/index.ts';
import { getDb } from '../db/index.ts';
import { getAdapter } from './adapter.ts';
import { parseSupplierCsv } from './adapters/manual.ts';
import { approveSupplierOrder, importProduct, recordSupplierShipment, resolveException, SupplierError, SupplierInput, syncSupplier, upsertSupplier } from './suppliers.ts';
import { type Supplier, type SupplierException, type SupplierOrder, supplierExceptions, supplierOrders, suppliers } from './schema.ts';

async function need(ctx: AdminContext, perm: string) {
  if (!(await ctx.can(perm))) throw new SupplierError('forbidden', `forbidden: ${perm}`);
}
const one = async <T>(table: typeof suppliers | typeof supplierOrders | typeof supplierExceptions, id: string) => ((await getDb().select().from(table).where(eq(table.id, id))) as unknown as T[])[0] ?? null;
const page = (q: { page: number; pageSize: number }) => ({ limit: q.pageSize, offset: (Math.max(q.page, 1) - 1) * q.pageSize });

const ImportOne = z.object({
  externalProductId: z.string().trim().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120).optional(),
  category: z.string().max(80).optional(),
});
const ImportCsv = z.object({ csv: z.string().min(1).max(500_000), category: z.string().max(80).optional() });

/** `Taza Térmica 500 ml` → `taza-termica-500-ml`. */
const slugify = (t: string) =>
  t
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'product';

export const suppliersAdminResource: AdminResource<Supplier> = {
  name: 'suppliers',
  label: { singular: 'Supplier', plural: 'Suppliers' },
  group: 'Dropshipping',
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true, list: true },
    { name: 'adapter', label: 'Integration', type: 'select', required: true, list: true, options: [{ value: 'manual', label: 'Manual (CSV + email)' }] },
    { name: 'currency', label: 'Currency', type: 'text', required: true },
    { name: 'config', label: 'Settings (no secrets)', type: 'json' },
    { name: 'autoForward', label: 'Send paid orders automatically', type: 'boolean', list: true },
    { name: 'status', label: 'Status', type: 'select', list: true, options: ['active', 'paused'].map((v) => ({ value: v, label: v })) },
    { name: 'lastSyncAt', label: 'Last sync', type: 'datetime', readOnly: true, list: true },
  ],
  input: SupplierInput,
  title: (s) => s.name,
  async list(q, ctx) {
    await need(ctx, 'suppliers:read');
    const [total] = await getDb().select({ n: count() }).from(suppliers);
    const { limit, offset } = page(q);
    return { rows: await getDb().select().from(suppliers).orderBy(suppliers.name).limit(limit).offset(offset), total: total?.n ?? 0 };
  },
  async get(id, ctx) {
    await need(ctx, 'suppliers:read');
    return one<Supplier>(suppliers, id);
  },
  async create(input, ctx) {
    await need(ctx, 'suppliers:update');
    return upsertSupplier(input as never);
  },
  async update(id, input, ctx) {
    await need(ctx, 'suppliers:update');
    return upsertSupplier(input as never, id);
  },
  actions: [
    {
      name: 'sync',
      label: 'Sync costs and stock now',
      permission: 'suppliers:update',
      available: (s) => !!getAdapter(s.adapter).syncVariants,
      async run(id, _i, ctx) {
        await need(ctx, 'suppliers:update');
        await syncSupplier(id);
        return (await one<Supplier>(suppliers, id))!;
      },
    },
    {
      name: 'import-product',
      label: 'Import a product by supplier id',
      permission: 'products:create',
      input: ImportOne,
      available: (s) => !!getAdapter(s.adapter).getProduct,
      async run(id, input, ctx) {
        await need(ctx, 'products:create');
        const i = ImportOne.parse(input);
        const s = (await one<Supplier>(suppliers, id))!;
        const ext = await getAdapter(s.adapter).getProduct!(s, i.externalProductId);
        if (!ext) throw new SupplierError('not_found', `product ${i.externalProductId} not found at ${s.name}`);
        await importProduct(id, ext, { slug: i.slug ?? slugify(ext.title), ...(i.category && { categories: [i.category] }) });
        return s;
      },
    },
    {
      name: 'import-csv',
      label: 'Import products from CSV',
      permission: 'products:create',
      input: ImportCsv,
      available: (s) => s.adapter === 'manual',
      async run(id, input, ctx) {
        await need(ctx, 'products:create');
        const i = ImportCsv.parse(input);
        const s = (await one<Supplier>(suppliers, id))!;
        let products;
        try {
          products = parseSupplierCsv(i.csv, s.currency);
        } catch (e) {
          throw new SupplierError('invalid', (e as Error).message);
        }
        // Siempre como borradores: el equipo revisa textos, imágenes y precios antes de publicar.
        for (const ext of products) await importProduct(id, ext, { slug: slugify(ext.title), ...(i.category && { categories: [i.category] }) });
        return s;
      },
    },
  ],
};

const Tracking = z.object({ carrier: z.string().max(60).optional(), trackingNumber: z.string().max(100).optional(), trackingUrl: z.url().optional() });

export const supplierOrdersAdminResource: AdminResource<SupplierOrder> = {
  name: 'supplier-orders',
  label: { singular: 'Supplier order', plural: 'Supplier orders' },
  group: 'Dropshipping',
  fields: [
    { name: 'orderId', label: 'Order', type: 'relation', relationTo: 'orders', readOnly: true, list: true },
    { name: 'supplierId', label: 'Supplier', type: 'relation', relationTo: 'suppliers', readOnly: true, list: true },
    { name: 'status', label: 'Status', type: 'text', readOnly: true, list: true },
    { name: 'lines', label: 'Items', type: 'json', readOnly: true },
    { name: 'externalRef', label: 'Supplier reference', type: 'text', readOnly: true },
    { name: 'error', label: 'Last error', type: 'text', readOnly: true },
  ],
  input: z.object({}),
  title: (o) => `${o.orderId} → ${o.supplierId}`,
  async list(q, ctx) {
    await need(ctx, 'orders:read');
    const where = q.filters?.status ? sql`${supplierOrders.status} = ${q.filters.status}` : undefined;
    const [total] = await getDb().select({ n: count() }).from(supplierOrders).where(where);
    const { limit, offset } = page(q);
    return { rows: await getDb().select().from(supplierOrders).where(where).orderBy(desc(supplierOrders.createdAt)).limit(limit).offset(offset), total: total?.n ?? 0 };
  },
  async get(id, ctx) {
    await need(ctx, 'orders:read');
    return one<SupplierOrder>(supplierOrders, id);
  },
  actions: [
    {
      name: 'approve',
      label: 'Send to supplier',
      permission: 'orders:fulfill',
      confirm: true,
      available: (o) => o.status === 'pending_approval' || o.status === 'failed',
      async run(id, _i, ctx) {
        await need(ctx, 'orders:fulfill');
        return approveSupplierOrder(id);
      },
    },
    {
      name: 'shipped',
      label: 'Supplier shipped it (add tracking)',
      permission: 'orders:fulfill',
      input: Tracking,
      available: (o) => o.status === 'sent',
      async run(id, input, ctx) {
        await need(ctx, 'orders:fulfill');
        return recordSupplierShipment(id, Tracking.parse(input));
      },
    },
  ],
};

export const supplierExceptionsAdminResource: AdminResource<SupplierException> = {
  name: 'supplier-exceptions',
  label: { singular: 'Exception', plural: 'Exceptions' },
  group: 'Dropshipping',
  fields: [
    { name: 'type', label: 'Type', type: 'text', readOnly: true, list: true },
    { name: 'message', label: 'Message', type: 'text', readOnly: true, list: true },
    { name: 'data', label: 'Details', type: 'json', readOnly: true },
    { name: 'status', label: 'Status', type: 'text', readOnly: true, list: true },
    { name: 'createdAt', label: 'Date', type: 'datetime', readOnly: true, list: true },
  ],
  input: z.object({}),
  title: (e) => e.message,
  async list(q, ctx) {
    await need(ctx, 'suppliers:read');
    const where = sql`${supplierExceptions.status} = ${q.filters?.status ?? 'open'}`;
    const [total] = await getDb().select({ n: count() }).from(supplierExceptions).where(where);
    const { limit, offset } = page(q);
    return { rows: await getDb().select().from(supplierExceptions).where(where).orderBy(desc(supplierExceptions.createdAt)).limit(limit).offset(offset), total: total?.n ?? 0 };
  },
  async get(id, ctx) {
    await need(ctx, 'suppliers:read');
    return one<SupplierException>(supplierExceptions, id);
  },
  actions: [
    {
      name: 'resolve',
      label: 'Mark as resolved',
      permission: 'suppliers:update',
      available: (e) => e.status === 'open',
      async run(id, _i, ctx) {
        await need(ctx, 'suppliers:update');
        await resolveException(id);
        return (await one<SupplierException>(supplierExceptions, id))!;
      },
    },
  ],
};

export const suppliersAdminResources = () => [suppliersAdminResource, supplierOrdersAdminResource, supplierExceptionsAdminResource];
