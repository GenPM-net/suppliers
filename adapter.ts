// Contrato de los adaptadores de proveedor. Cada uno vive en adapters/<nombre>.ts y se registra con `registerAdapter`.
import type { Money } from '../contracts/index.ts';
import type { Address } from '../orders/index.ts';
import type { Supplier } from './schema.ts';

export type ExternalVariant = {
  externalVariantId: string;
  /** Opciones (`{ Color: 'Red' }`); vacío si no tiene. */
  options: Record<string, string>;
  cost: Money;
  /** Stock del proveedor; null si no lo informa. */
  stock: number | null;
  weightGrams?: number | null;
  sku?: string | null;
};

export type ExternalProduct = {
  externalProductId: string;
  title: string;
  /** Texto plano (el adaptador quita el HTML del proveedor). */
  description: string;
  /** URLs https de imágenes; se copian a @core/media, nunca se enlazan. */
  images: string[];
  options: Array<{ name: string; values: string[] }>;
  variants: ExternalVariant[];
  shippingDays?: { min: number; max: number } | null;
};

export type SupplierOrderRequest = {
  /** Referencia propia (número de pedido) para que el proveedor no duplique. */
  reference: string;
  email: string;
  address: Address;
  lines: Array<{ externalVariantId: string; quantity: number }>;
};

export type TrackingInfo = { status: 'pending' | 'shipped' | 'delivered' | 'failed'; carrier?: string; trackingNumber?: string; trackingUrl?: string };

export interface SupplierAdapter {
  readonly name: string;
  /** Hosts de los que se pueden copiar imágenes (`.alicdn.com`). */
  readonly imageHosts: string[];
  search?(supplier: Supplier, query: string): Promise<Array<{ externalProductId: string; title: string; image?: string; cost: Money }>>;
  getProduct?(supplier: Supplier, externalProductId: string): Promise<ExternalProduct | null>;
  /**
   * Coste y stock actuales de muchas variantes a la vez. `cost: null` = desconocido (p. ej. el proveedor retiró la
   * variante): se mantiene el coste guardado y solo se aplica el stock.
   */
  syncVariants?(supplier: Supplier, externalVariantIds: string[]): Promise<Array<{ externalVariantId: string; cost: Money | null; stock: number | null }>>;
  /**
   * Crea el pedido en el proveedor. Lanza SOLO si el pedido no se creó (se reintentará); usa `order.reference` como
   * clave de idempotencia si la API la admite, y pasa `opts.signal` a fetch() (se aborta al vencer el tiempo).
   */
  placeOrder(supplier: Supplier, order: SupplierOrderRequest, opts?: { signal?: AbortSignal }): Promise<{ externalRef: string }>;
  getTracking?(supplier: Supplier, externalRef: string): Promise<TrackingInfo | null>;
}

const adapters = new Map<string, SupplierAdapter>();
export const registerAdapter = (a: SupplierAdapter) => void adapters.set(a.name, a);
export function getAdapter(name: string): SupplierAdapter {
  const a = adapters.get(name);
  if (!a) throw new Error(`supplier adapter not registered: ${name}`);
  return a;
}
