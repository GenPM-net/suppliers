// Adaptador CJdropshipping contra una API simulada con las formas de respuesta de su documentación v2.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Supplier } from '../schema.ts';
import { CjApiError, cjAdapter as cj, resetCjState } from './cj.ts';

const realFetch = globalThis.fetch;
type Call = { method: string; path: string; query: Record<string, string>; token: string | null; body: Record<string, unknown> | null };
let calls: Call[];
let handlers: Record<string, (c: Call) => { code: number; data?: unknown; message?: string }>;
let tokens: number;

const ok = (data: unknown) => ({ code: 200, data });
const fail = (code: number, message = 'error') => ({ code, message });

beforeEach(() => {
  resetCjState();
  calls = [];
  tokens = 0;
  process.env.CJ_API_KEY = 'CJ123@api@test';
  process.env.CJ_QPS = '1000';
  handlers = {
    'POST /authentication/getAccessToken': () => ok({ accessToken: `tok-${++tokens}`, accessTokenExpiryDate: new Date(Date.now() + 180 * 86_400_000).toISOString() }),
  };
  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    expect([url.origin, url.pathname.startsWith('/api2.0/v1/')]).toEqual(['https://developers.cjdropshipping.com', true]);
    const path = url.pathname.replace('/api2.0/v1', '');
    const headers = new Headers(init?.headers);
    const c: Call = { method: init?.method ?? 'GET', path, query: Object.fromEntries(url.searchParams), token: headers.get('CJ-Access-Token'), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    const h = handlers[`${c.method} ${path}`];
    const r = h ? h(c) : fail(1600101, 'Interface not found');
    return Response.json({ ...r, result: r.code === 200, success: r.code === 200, requestId: 'req-1' });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.CJ_API_KEY;
  delete process.env.CJ_QPS;
});

const supplier = (config: Record<string, string> = {}) => ({ id: 'sup_1', name: 'CJ', adapter: 'cj', currency: 'USD', config }) as unknown as Supplier;

const product = {
  pid: '000B9312-456A-4D31-94BD-B083E2A198E8',
  productNameEn: 'Small trailer model',
  description: '<p>Die-cast <b>metal</b> trailer&nbsp;model</p><script>alert(1)</script><p>Scale 1:32</p>',
  bigImage: 'https://cf.cjdropshipping.com/quick/product/main.jpg',
  productImageSet: ['https://cf.cjdropshipping.com/quick/product/main.jpg', 'https://cf.cjdropshipping.com/quick/product/side.jpg', 'http://insecure.test/x.jpg'],
  productKeyEn: 'Color-Size',
  variants: [
    { vid: 'V-BLACK-XXL', variantSku: 'CJ-1-Black-XXL', variantKey: 'Black-XXL', variantSellPrice: 58.09, variantWeight: 1580, inventories: [{ countryCode: 'CN', totalInventory: 12912 }, { countryCode: 'US', totalInventory: 88 }] },
    { vid: 'V-RED-M', variantSku: 'CJ-1-Red-M', variantKey: 'Red-M', variantSellPrice: '11.854', variantWeight: null, inventories: [] },
  ],
};

describe('CJdropshipping adapter', () => {
  it('maps a product: options from "Color-Size", USD cost rounded up, stock summed, plain text and https images', async () => {
    handlers['GET /product/query'] = (c) => (c.query.pid === product.pid ? ok(product) : fail(1602001, 'Product not found'));
    const p = await cj.getProduct!(supplier(), product.pid);
    expect(p).toEqual({
      externalProductId: product.pid,
      title: 'Small trailer model',
      description: 'Die-cast metal trailer model\nScale 1:32',
      images: ['https://cf.cjdropshipping.com/quick/product/main.jpg', 'https://cf.cjdropshipping.com/quick/product/side.jpg'],
      options: [
        { name: 'Color', values: ['Black', 'Red'] },
        { name: 'Size', values: ['XXL', 'M'] },
      ],
      variants: [
        { externalVariantId: 'V-BLACK-XXL', options: { Color: 'Black', Size: 'XXL' }, cost: { amount: 5809, currency: 'USD' }, stock: 13000, weightGrams: 1580, sku: 'CJ-1-Black-XXL' },
        { externalVariantId: 'V-RED-M', options: { Color: 'Red', Size: 'M' }, cost: { amount: 1186, currency: 'USD' }, stock: null, weightGrams: null, sku: 'CJ-1-Red-M' },
      ],
      shippingDays: null,
    });
    expect(await cj.getProduct!(supplier(), 'missing')).toBeNull();
    // Un solo token para todas las llamadas, enviado en la cabecera CJ-Access-Token.
    expect(tokens).toBe(1);
    expect(calls.filter((c) => c.path !== '/authentication/getAccessToken').every((c) => c.token === 'tok-1')).toBe(true);
    expect(calls[0]!.body).toEqual({ apiKey: 'CJ123@api@test' });
  });

  it('searches the V2 list and reads the first price of a range', async () => {
    handlers['GET /product/listV2'] = (c) => ok({ content: [{ productList: [{ id: 'P1', nameEn: `Hoodie for ${c.query.keyWord}`, bigImage: 'https://cf.cjdropshipping.com/a.jpg', sellPrice: '9.50-11.85' }] }] });
    expect(await cj.search!(supplier(), 'cats')).toEqual([{ externalProductId: 'P1', title: 'Hoodie for cats', image: 'https://cf.cjdropshipping.com/a.jpg', cost: { amount: 950, currency: 'USD' } }]);
    expect(calls.at(-1)!.query).toMatchObject({ keyWord: 'cats', page: '1', size: '20' });
  });

  it('syncs variant by variant; a removed variant has unknown cost and no stock', async () => {
    handlers['GET /product/variant/queryByVid'] = (c) =>
      c.query.vid === 'GONE' ? fail(1602003, 'Variant has been removed from shelves') : ok({ vid: c.query.vid, variantSellPrice: 3, inventories: [{ totalInventory: 7 }] });
    expect(await cj.syncVariants!(supplier(), ['A', 'GONE'])).toEqual([
      { externalVariantId: 'A', cost: { amount: 300, currency: 'USD' }, stock: 7 },
      { externalVariantId: 'GONE', cost: null, stock: 0 },
    ]);
    expect(calls.find((c) => c.path === '/product/variant/queryByVid')!.query.features).toBe('enable_inventory');
    handlers['GET /product/variant/queryByVid'] = () => fail(1600000, 'System busy');
    await expect(cj.syncVariants!(supplier(), ['A'])).rejects.toMatchObject({ code: 1600000 });
  });

  it('places the order with our reference as orderNumber, unpaid by default, and needs a shipping method', async () => {
    handlers['POST /shopping/order/createOrderV2'] = () => ok({ orderId: '210711100018043276', orderStatus: 'CREATED' });
    const order = {
      reference: 'R-1001',
      email: 'ana@x.test',
      address: { name: 'Ana', line1: 'Calle Mayor 1', line2: '2º B', city: 'Valencia', postalCode: '46001', region: 'Valencia', country: 'ES', phone: '+34600000000' },
      lines: [{ externalVariantId: 'V-BLACK-XXL', quantity: 2 }],
    };
    await expect(cj.placeOrder(supplier(), order)).rejects.toThrow(/logisticName/);
    expect(calls).toEqual([]);
    expect(await cj.placeOrder(supplier({ logisticName: 'CJPacket Ordinary' }), order)).toEqual({ externalRef: '210711100018043276' });
    expect(calls.at(-1)!.body).toEqual({
      orderNumber: 'R-1001',
      shippingCountryCode: 'ES',
      shippingCountry: 'Spain',
      shippingProvince: 'Valencia',
      shippingCity: 'Valencia',
      shippingZip: '46001',
      shippingCustomerName: 'Ana',
      shippingAddress: 'Calle Mayor 1',
      shippingAddress2: '2º B',
      shippingPhone: '+34600000000',
      email: 'ana@x.test',
      logisticName: 'CJPacket Ordinary',
      fromCountryCode: 'CN',
      payType: 3,
      isSandbox: 0,
      products: [{ vid: 'V-BLACK-XXL', quantity: 2 }],
    });
    await cj.placeOrder(supplier({ logisticName: 'CJPacket Ordinary', payWithBalance: 'true', sandbox: 'true', fromCountryCode: 'US' }), order);
    expect(calls.at(-1)!.body).toMatchObject({ payType: 2, isSandbox: 1, fromCountryCode: 'US' });
  });

  it('a duplicate orderNumber is not a failure: it returns the order an earlier attempt created', async () => {
    handlers['POST /shopping/order/createOrderV2'] = () => fail(1603003, 'Order exist, please do not duplicate create');
    handlers['GET /shopping/order/getOrderDetail'] = (c) => (c.query.orderId === 'R-1' ? ok({ orderId: '2108231000', orderNum: 'R-1', orderStatus: 'UNPAID' }) : fail(1603100));
    const order = { reference: 'R-1', email: 'a@x.test', address: { name: 'A', line1: 'L', city: 'C', postalCode: '1', country: 'US' }, lines: [{ externalVariantId: 'V', quantity: 1 }] };
    expect(await cj.placeOrder(supplier({ logisticName: 'CJPacket Ordinary' }), order)).toEqual({ externalRef: '2108231000' });
    // Sin región se usa la ciudad (CJ exige provincia).
    expect(calls.find((c) => c.path === '/shopping/order/createOrderV2')!.body).toMatchObject({ shippingProvince: 'C', shippingCountry: 'United States' });
    // Cualquier otro error significa que el pedido no se creó: se lanza para reintentar.
    handlers['POST /shopping/order/createOrderV2'] = () => fail(1602000, 'Variant not found');
    await expect(cj.placeOrder(supplier({ logisticName: 'CJPacket Ordinary' }), order)).rejects.toBeInstanceOf(CjApiError);
  });

  it('maps order status to tracking', async () => {
    const orders: Record<string, unknown> = {
      S: { orderId: 'S', orderStatus: 'SHIPPED', logisticName: 'CJPacket Ordinary', trackNumber: 'CJ123', trackingUrl: 'https://track.test/CJ123' },
      D: { orderId: 'D', orderStatus: 'DELIVERED', trackNumber: 'CJ9' },
      X: { orderId: 'X', orderStatus: 'CANCELLED' },
      P: { orderId: 'P', orderStatus: 'UNSHIPPED' },
    };
    handlers['GET /shopping/order/getOrderDetail'] = (c) => (orders[c.query.orderId!] ? ok(orders[c.query.orderId!]) : fail(1603100, 'Order not found'));
    expect(await cj.getTracking!(supplier(), 'S')).toEqual({ status: 'shipped', carrier: 'CJPacket Ordinary', trackingNumber: 'CJ123', trackingUrl: 'https://track.test/CJ123' });
    expect(await cj.getTracking!(supplier(), 'D')).toEqual({ status: 'delivered', trackingNumber: 'CJ9' });
    expect(await cj.getTracking!(supplier(), 'X')).toEqual({ status: 'failed' });
    expect(await cj.getTracking!(supplier(), 'P')).toEqual({ status: 'pending' });
    expect(await cj.getTracking!(supplier(), 'nope')).toBeNull();
  });

  it('gets a new token once when CJ rejects the current one, and needs CJ_API_KEY', async () => {
    let first = true;
    handlers['GET /product/query'] = (c) => {
      if (c.token === 'tok-1' && first) return (first = false), fail(1600001, 'Invalid API key or access token');
      return ok(product);
    };
    expect((await cj.getProduct!(supplier(), product.pid))!.title).toBe('Small trailer model');
    expect(tokens).toBe(2);
    resetCjState();
    delete process.env.CJ_API_KEY;
    await expect(cj.getProduct!(supplier(), product.pid)).rejects.toThrow(/CJ_API_KEY/);
  });

  it('spaces requests to respect the per-second limit', async () => {
    process.env.CJ_QPS = '20'; // 50 ms entre llamadas
    handlers['GET /product/variant/queryByVid'] = (c) => ok({ vid: c.query.vid, variantSellPrice: 1, inventories: [] });
    const t0 = Date.now();
    await cj.syncVariants!(supplier(), ['A', 'B', 'C', 'D']);
    // Token + 4 variantes = 5 llamadas → al menos 4 huecos de 50 ms.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
  });
});
