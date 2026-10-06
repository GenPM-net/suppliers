// Adaptador manual: para cualquier proveedor sin API. Productos por CSV, pedidos por email al proveedor y seguimiento
// introducido en el panel. Configuración: `orderEmail` (a quién se envían los pedidos).
import { getEmailProvider } from '../../email/index.js';
import { parseMoney } from '../../money/index.js';
import { registerAdapter, type ExternalProduct, type SupplierAdapter } from '../adapter.js';

/**
 * CSV con cabecera: `product_id,title,description,image_urls,option1_name,option1_value,option2_name,option2_value,variant_id,cost,stock,weight_grams,ship_min_days,ship_max_days`
 * (una fila por variante; `image_urls` separadas por `|`; `cost` decimal en la moneda del proveedor).
 */
export function parseSupplierCsv(csv: string, currency: string): ExternalProduct[] {
  const rows = parseCsv(csv);
  const [header, ...data] = rows;
  if (!header) return [];
  const col = (name: string) => header.indexOf(name);
  for (const required of ['product_id', 'title', 'variant_id', 'cost']) if (col(required) < 0) throw new Error(`CSV is missing column ${required}`);
  const get = (r: string[], name: string) => (col(name) >= 0 ? (r[col(name)] ?? '').trim() : '');
  const byProduct = new Map<string, ExternalProduct>();
  for (const r of data) {
    if (!r.some((c) => c.trim())) continue;
    const pid = get(r, 'product_id');
    let p = byProduct.get(pid);
    if (!p) {
      const min = Number(get(r, 'ship_min_days'));
      const max = Number(get(r, 'ship_max_days'));
      p = {
        externalProductId: pid,
        title: get(r, 'title').slice(0, 200),
        description: get(r, 'description').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 10_000),
        images: get(r, 'image_urls').split('|').map((u) => u.trim()).filter((u) => u.startsWith('https://')).slice(0, 10),
        options: [],
        variants: [],
        shippingDays: min && max ? { min, max } : null,
      };
      byProduct.set(pid, p);
    }
    const options: Record<string, string> = {};
    for (const i of [1, 2, 3]) {
      const name = get(r, `option${i}_name`);
      const value = get(r, `option${i}_value`);
      if (!name || !value) continue;
      options[name] = value;
      const opt = p.options.find((o) => o.name === name) ?? (p.options.push({ name, values: [] }), p.options.at(-1)!);
      if (!opt.values.includes(value)) opt.values.push(value);
    }
    const stock = get(r, 'stock');
    const weight = get(r, 'weight_grams');
    p.variants.push({ externalVariantId: get(r, 'variant_id'), options, cost: parseMoney(get(r, 'cost'), currency), stock: stock === '' ? null : Number(stock), weightGrams: weight === '' ? null : Number(weight) });
  }
  return [...byProduct.values()];
}

/** CSV mínimo (RFC 4180): comillas dobles, comas y saltos de línea dentro de comillas. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export const manualAdapter: SupplierAdapter = {
  name: 'manual',
  imageHosts: [],
  async placeOrder(supplier, order) {
    const to = supplier.config.orderEmail;
    const from = process.env.EMAIL_FROM;
    if (!to || !from) throw new Error('manual supplier needs config.orderEmail and EMAIL_FROM');
    const a = order.address;
    const lines = order.lines.map((l) => `${l.externalVariantId} × ${l.quantity}`);
    const address = [a.name, a.company, a.line1, a.line2, `${a.postalCode} ${a.city}`, a.region, a.country, a.phone].filter(Boolean) as string[];
    await getEmailProvider().send({
      from,
      to,
      subject: `New order ${order.reference}`,
      text: [`Order: ${order.reference}`, '', ...lines, '', 'Ship to:', ...address].join('\n'),
      html: `<p>Order: <strong>${esc(order.reference)}</strong></p><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p>Ship to:<br>${address.map(esc).join('<br>')}</p>`,
    });
    return { externalRef: order.reference };
  },
};

registerAdapter(manualAdapter);
