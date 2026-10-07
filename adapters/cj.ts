// Adaptador CJdropshipping (API v2, https://developers.cjdropshipping.com/en/api/api2/). Credenciales solo por env:
// `CJ_API_KEY` (CJ → Apps → API → Add API, tipo "API Key"). Config del proveedor (no secreta):
//   logisticName     método de envío de CJ para los pedidos (obligatorio, p. ej. "CJPacket Ordinary")
//   fromCountryCode  almacén de salida (por defecto CN)
//   payWithBalance   "true" paga el pedido con el saldo de CJ al crearlo; si no, queda creado sin pagar en CJ
//   sandbox          "true" crea pedidos de prueba (isSandbox=1): ni cobro ni envío reales
// Precios de CJ en USD. Límite de CJ: 1 petición/s en cuentas gratuitas (`CJ_QPS` lo sube según tu nivel).
import { registerAdapter, type ExternalProduct, type SupplierAdapter, type TrackingInfo } from '../adapter.ts';
import type { Supplier } from '../schema.ts';

const BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

/** Error de la API de CJ con su código (`1602000` variante no encontrada, `1603003` pedido duplicado…). */
export class CjApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly requestId?: string,
  ) {
    super(`CJdropshipping ${code}: ${message}`);
  }
}

type Envelope<T> = { code: number; result?: boolean; success?: boolean; message?: string; data: T; requestId?: string };

// Token de acceso (180 días; CJ devuelve el mismo durante 24 h). Se pide al primer uso y se renueva si caduca.
let token: { value: string; expires: number } | null = null;
let queue: Promise<unknown> = Promise.resolve();
let lastCall = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Solo tests: olvida el token y el reloj del limitador. */
export function resetCjState(): void {
  token = null;
  lastCall = 0;
  queue = Promise.resolve();
}

// Peticiones en serie y espaciadas: CJ limita por usuario (1/s en el nivel gratuito) y responde 1600200 al pasarse.
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const qps = Math.max(1, Number(process.env.CJ_QPS) || 1);
  const run = queue.then(async () => {
    const wait = lastCall + Math.ceil(1000 / qps) - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    return fn();
  });
  queue = run.catch(() => {});
  return run;
}

async function raw<T>(method: 'GET' | 'POST', path: string, opts: { query?: Record<string, string>; body?: unknown; auth?: boolean; signal?: AbortSignal | undefined }): Promise<T> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth !== false) headers['CJ-Access-Token'] = await accessToken(opts.signal);
    const res = await throttled(() => fetch(url, { method, headers, body: opts.body === undefined ? null : JSON.stringify(opts.body), signal: opts.signal ?? null }));
    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (json && json.code === 200 && json.result !== false) return json.data;
    const code = json?.code ?? res.status;
    // Token revocado o caducado: se pide otro una vez. Límite de frecuencia: se espera y se reintenta dos veces.
    if (code === 1600001 && opts.auth !== false && attempt === 0) {
      token = null;
      continue;
    }
    if (code === 1600200 && attempt < 2) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    throw new CjApiError(code, json?.message ?? `HTTP ${res.status}`, json?.requestId);
  }
}

async function accessToken(signal?: AbortSignal): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const apiKey = process.env.CJ_API_KEY;
  if (!apiKey) throw new Error('CJ_API_KEY is not set (CJdropshipping → Apps → API → Add API, type "API Key")');
  const data = await raw<{ accessToken: string; accessTokenExpiryDate: string }>('POST', '/authentication/getAccessToken', { body: { apiKey }, auth: false, signal });
  const expires = Date.parse(data.accessTokenExpiryDate);
  token = { value: data.accessToken, expires: Number.isFinite(expires) ? expires : Date.now() + 86_400_000 };
  return token.value;
}

/** Coste en céntimos de USD redondeado hacia arriba: nunca se subestima lo que cobra el proveedor. */
function usd(value: unknown): { amount: number; currency: string } {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').split('-')[0]);
  if (!Number.isFinite(n) || n < 0) throw new CjApiError(0, `invalid price: ${String(value)}`);
  return { amount: Math.ceil(Math.round(n * 1e6) / 1e4), currency: 'USD' };
}

const plain = (html: string | null | undefined) =>
  (html ?? '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
    .slice(0, 10_000);

type CjInventory = { totalInventory?: number | null };
type CjVariant = { vid: string; variantSku?: string | null; variantKey?: string | null; variantSellPrice: number | string; variantWeight?: number | null; inventories?: CjInventory[] | null };
type CjProduct = { pid: string; productNameEn: string; description?: string | null; bigImage?: string | null; productImageSet?: string[] | null; productKeyEn?: string | null; variants?: CjVariant[] | null };
type CjOrder = { orderId: string; orderStatus?: string | null; logisticName?: string | null; trackNumber?: string | null; trackingUrl?: string | null };

const stockOf = (inv: CjInventory[] | null | undefined) => (inv?.length ? inv.reduce((n, i) => n + Math.max(0, Number(i.totalInventory) || 0), 0) : null);
const NOT_FOUND = new Set([1602000, 1602001, 1602002, 1602003]);

function toExternal(p: CjProduct): ExternalProduct {
  // Las opciones vienen como "Color-Size" y cada variante como "Black-XXL"; si no cuadran, el valor entero va a la primera.
  const names = (p.productKeyEn ?? '').split('-').map((s) => s.trim()).filter(Boolean);
  const options = names.map((name) => ({ name, values: [] as string[] }));
  const variants = (p.variants ?? []).map((v) => {
    const parts = (v.variantKey ?? '').split('-').map((s) => s.trim());
    const values = parts.length === names.length ? parts : [(v.variantKey ?? '').trim()];
    const opts: Record<string, string> = {};
    values.forEach((value, i) => {
      const o = options[i];
      if (!o || !value) return;
      opts[o.name] = value;
      if (!o.values.includes(value)) o.values.push(value);
    });
    return { externalVariantId: v.vid, options: opts, cost: usd(v.variantSellPrice), stock: stockOf(v.inventories), weightGrams: v.variantWeight == null ? null : Math.round(Number(v.variantWeight)), sku: v.variantSku ?? null };
  });
  const images = [...new Set([...(p.productImageSet ?? []), ...(p.bigImage ? [p.bigImage] : [])])].filter((u) => u.startsWith('https://')).slice(0, 10);
  return { externalProductId: p.pid, title: p.productNameEn.slice(0, 200), description: plain(p.description), images, options: options.filter((o) => o.values.length), variants, shippingDays: null };
}

function tracking(o: CjOrder): TrackingInfo {
  const base = { ...(o.logisticName && { carrier: o.logisticName }), ...(o.trackNumber && { trackingNumber: o.trackNumber }), ...(o.trackingUrl && { trackingUrl: o.trackingUrl }) };
  switch (o.orderStatus) {
    case 'SHIPPED':
      return { status: 'shipped', ...base };
    case 'DELIVERED':
      return { status: 'delivered', ...base };
    case 'CANCELLED':
      return { status: 'failed', ...base };
    default:
      return { status: 'pending', ...base };
  }
}

const regionName = (code: string) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};

const flag = (s: Supplier, key: string) => s.config[key] === 'true';

export const cjAdapter: SupplierAdapter = {
  name: 'cj',
  imageHosts: ['.cjdropshipping.com', '.aliyuncs.com'],

  async search(_supplier, query) {
    const data = await raw<{ content?: Array<{ productList?: Array<{ id: string; nameEn: string; bigImage?: string; sellPrice: string }> }> }>('GET', '/product/listV2', { query: { keyWord: query.slice(0, 200), page: '1', size: '20' } });
    return (data.content ?? []).flatMap((c) => c.productList ?? []).map((p) => ({ externalProductId: p.id, title: p.nameEn, ...(p.bigImage && { image: p.bigImage }), cost: usd(p.sellPrice) }));
  },

  async getProduct(_supplier, externalProductId) {
    try {
      return toExternal(await raw<CjProduct>('GET', '/product/query', { query: { pid: externalProductId } }));
    } catch (e) {
      if (e instanceof CjApiError && NOT_FOUND.has(e.code)) return null;
      throw e;
    }
  },

  // Una petición por variante (CJ no tiene consulta por lotes). Las retiradas de CJ quedan sin stock y con coste desconocido.
  async syncVariants(_supplier, externalVariantIds) {
    const out = [];
    for (const vid of externalVariantIds) {
      try {
        const v = await raw<CjVariant>('GET', '/product/variant/queryByVid', { query: { vid, features: 'enable_inventory' } });
        out.push({ externalVariantId: vid, cost: usd(v.variantSellPrice), stock: stockOf(v.inventories) });
      } catch (e) {
        if (!(e instanceof CjApiError && NOT_FOUND.has(e.code))) throw e;
        out.push({ externalVariantId: vid, cost: null, stock: 0 });
      }
    }
    return out;
  },

  async placeOrder(supplier, order, opts) {
    const logisticName = supplier.config.logisticName;
    if (!logisticName) throw new Error('cj supplier needs config.logisticName (a CJ shipping method, e.g. "CJPacket Ordinary")');
    const a = order.address;
    const body = {
      orderNumber: order.reference,
      shippingCountryCode: a.country,
      shippingCountry: regionName(a.country),
      shippingProvince: a.region || a.city,
      shippingCity: a.city,
      shippingZip: a.postalCode,
      shippingCustomerName: a.name,
      shippingAddress: a.company ? `${a.line1} (${a.company})` : a.line1,
      ...(a.line2 && { shippingAddress2: a.line2 }),
      ...(a.phone && { shippingPhone: a.phone }),
      ...(a.taxId && { taxId: a.taxId }),
      email: order.email,
      logisticName,
      fromCountryCode: supplier.config.fromCountryCode || 'CN',
      payType: flag(supplier, 'payWithBalance') ? 2 : 3,
      isSandbox: flag(supplier, 'sandbox') ? 1 : 0,
      products: order.lines.map((l) => ({ vid: l.externalVariantId, quantity: l.quantity })),
    };
    try {
      const data = await raw<{ orderId?: string | null }>('POST', '/shopping/order/createOrderV2', { body, signal: opts?.signal });
      // Sin orderId (CJ lo reasigna en algunos casos) se sigue por nuestra referencia: getOrderDetail acepta ambas.
      return { externalRef: data.orderId || order.reference };
    } catch (e) {
      // `orderNumber` es la clave de idempotencia: si ya existe, un intento anterior lo creó y no es un fallo.
      if (!(e instanceof CjApiError && e.code === 1603003)) throw e;
      const existing = await raw<CjOrder>('GET', '/shopping/order/getOrderDetail', { query: { orderId: order.reference }, signal: opts?.signal }).catch(() => null);
      return { externalRef: existing?.orderId || order.reference };
    }
  },

  async getTracking(_supplier, externalRef) {
    try {
      return tracking(await raw<CjOrder>('GET', '/shopping/order/getOrderDetail', { query: { orderId: externalRef } }));
    } catch (e) {
      if (e instanceof CjApiError && e.code === 1603100) return null;
      throw e;
    }
  },
};

registerAdapter(cjAdapter);
