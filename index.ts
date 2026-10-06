// @core/suppliers — API pública. Al importarlo registra el adaptador manual y el reenvío de pedidos pagados.
import './adapters/manual.ts';

export {
  type ExternalProduct,
  type ExternalVariant,
  getAdapter,
  registerAdapter,
  type SupplierAdapter,
  type SupplierOrderRequest,
  type TrackingInfo,
} from './adapter.ts';
export { manualAdapter, parseCsv, parseSupplierCsv } from './adapters/manual.ts';
export { supplierExceptionsAdminResource, supplierOrdersAdminResource, suppliersAdminResource, suppliersAdminResources } from './admin.ts';
export {
  type Supplier,
  type SupplierException,
  type SupplierOrder,
  supplierExceptions,
  supplierOrders,
  supplierProducts,
  suppliers,
} from './schema.ts';
export {
  approveSupplierOrder,
  createSupplierOrders,
  currentFxRates,
  deliveryEstimate,
  exception,
  type FxRates,
  forwardJob,
  forwardSupplierOrder,
  importProduct,
  MAX_FORWARD_ATTEMPTS,
  pollTrackingJob,
  recordSupplierShipment,
  registerSuppliers,
  resolveException,
  setFxRatesProvider,
  STALLED_DAYS,
  SupplierError,
  SupplierInput,
  syncAllJob,
  syncSupplier,
  upsertSupplier,
} from './suppliers.ts';
