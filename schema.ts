// Tablas de @core/suppliers. Las recoge drizzle-kit vía src/lib/db/drizzle.config.ts.
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { productVariants } from '../catalog/index.ts';
import { primaryId, timestamps } from '../db/index.ts';

export const suppliers = pgTable('suppliers', {
  id: primaryId('sup'),
  name: text('name').notNull(),
  /** Adaptador registrado: `manual`, `cj`, `aliexpress`… */
  adapter: text('adapter').notNull(),
  /** Configuración sin secretos (las credenciales van en variables de entorno). */
  config: jsonb('config').$type<Record<string, string>>().notNull().default({}),
  currency: text('currency').notNull(),
  status: text('status', { enum: ['active', 'paused'] }).notNull().default('active'),
  /** Reenviar pedidos pagados sin aprobación manual. */
  autoForward: boolean('auto_forward').notNull().default(false),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true, mode: 'date' }),
  ...timestamps,
});

/** Qué variante del catálogo corresponde a qué artículo del proveedor, con su coste y plazo. */
export const supplierProducts = pgTable(
  'supplier_products',
  {
    variantId: text('variant_id')
      .primaryKey()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    supplierId: text('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'cascade' }),
    externalProductId: text('external_product_id').notNull(),
    externalVariantId: text('external_variant_id').notNull(),
    cost: integer('cost').notNull(),
    currency: text('currency').notNull(),
    shippingDaysMin: integer('shipping_days_min'),
    shippingDaysMax: integer('shipping_days_max'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [index('supplier_products_supplier_idx').on(t.supplierId, t.externalVariantId)],
);

export const supplierOrders = pgTable(
  'supplier_orders',
  {
    id: primaryId('spo'),
    orderId: text('order_id').notNull(),
    supplierId: text('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    status: text('status', { enum: ['pending_approval', 'queued', 'sent', 'shipped', 'failed', 'cancelled'] }).notNull(),
    lines: jsonb('lines').$type<Array<{ orderLineId: string; externalVariantId: string; quantity: number }>>().notNull(),
    externalRef: text('external_ref'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex('supplier_orders_order_idx').on(t.orderId, t.supplierId), index('supplier_orders_status_idx').on(t.status)],
);

export const supplierExceptions = pgTable(
  'supplier_exceptions',
  {
    id: primaryId('sex'),
    type: text('type', { enum: ['out_of_stock', 'cost_increase', 'negative_margin', 'forward_failed', 'tracking_stalled', 'sync_failed'] }).notNull(),
    supplierId: text('supplier_id'),
    variantId: text('variant_id'),
    orderId: text('order_id'),
    message: text('message').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status', { enum: ['open', 'resolved'] }).notNull().default('open'),
    ...timestamps,
  },
  (t) => [index('supplier_exceptions_status_idx').on(t.status, t.createdAt)],
);

export type Supplier = typeof suppliers.$inferSelect;
export type SupplierOrder = typeof supplierOrders.$inferSelect;
export type SupplierException = typeof supplierExceptions.$inferSelect;
