// @core/suppliers — API pública. Al importarlo registra el adaptador manual y el reenvío de pedidos pagados.
import './adapters/manual.js';

export {
  type ExternalProduct,
  type ExternalVariant,
  getAdapter,
  registerAdapter,
  type SupplierAdapter,
  type SupplierOrderRequest,
  type TrackingInfo,
} from './adapter.js';
export { manualAdapter, parseCsv, parseSupplierCsv } from './adapters/manual.js';
export { supplierExceptionsAdminResource, supplierOrdersAdminResource, suppliersAdminResource, suppliersAdminResources } from './admin.js';
export {
  type Supplier,
  type SupplierException,
  type SupplierOrder,
  supplierExceptions,
  supplierOrders,
  supplierProducts,
  suppliers,
} from './schema.js';
export {
  approveSupplierOrder,
  createSupplierOrders,
  deliveryEstimate,
  exception,
  type FxRates,
  forwardJob,
  importProduct,
  MAX_FORWARD_ATTEMPTS,
  pollTrackingJob,
  recordSupplierShipment,
  registerSuppliers,
  resolveException,
  STALLED_DAYS,
  SupplierError,
  SupplierInput,
  syncAllJob,
  syncSupplier,
  upsertSupplier,
} from './suppliers.js';
