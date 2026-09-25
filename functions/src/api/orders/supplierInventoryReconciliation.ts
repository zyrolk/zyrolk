import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import { collectOrderStockQuantities } from "./orderStatusLogic";
import {
  ORDER_PRIVATE_COLLECTION,
  parseOrderPrivateFulfilment,
  type OrderFulfilmentGroup,
  type ParsedOrderPrivateFulfilment,
} from "./orderFulfilmentGroups";

const SUPPLIER_LOCAL_DEMAND_VERSION = 1;
export const SUPPLIER_LOCAL_DEMAND_TRACKING_VERSION = 1;

export type SupplierLocalDemandStatus = "tracked" | "legacy_bootstrap_required";

export interface SupplierLocalDemandState {
  version: number;
  quantity: number;
  status: SupplierLocalDemandStatus;
}

export type SupplierInventorySettlementStatus = "unresolved" | "reconciled";

export interface SupplierInventorySettlement {
  settlementId: string;
  orderId: string;
  groupId: string;
  productId: string;
  quantity: number;
  status: SupplierInventorySettlementStatus;
  supplierSourceId: string;
  supplierAccountId: string;
  baselineSupplierObservedStock: number;
  baselineSupplierObservationVersion: number;
  baselineSupplierObservationAt: string;
  preparedAt: string;
  preparedBy: string;
  externalSupplierOrderReference: string | null;
  reconciledAt?: string;
  reconciledBy?: string;
  supplierObservationStock?: number;
  supplierObservationVersion?: number;
  supplierObservationAt?: string;
}

export interface SupplierInventorySettlementActionInput {
  db: FirebaseFirestore.Firestore;
  orderId: unknown;
  groupId: unknown;
  productId: unknown;
  quantity: unknown;
  expectedGroupRevision: unknown;
  expectedOrderPrivateRevision: unknown;
  actorUid: string;
  externalSupplierOrderReference?: unknown;
  manualSupplierOrderPlaced?: unknown;
  acknowledgeFreshSupplierObservation?: unknown;
}

export interface SupplierInventorySettlementActionResult {
  orderId: string;
  groupId: string;
  productId: string;
  quantity: number;
  status: SupplierInventorySettlementStatus;
  idempotent: boolean;
  publicStock: number;
  localDemand: number;
  supplierObservation: {
    stock: number;
    version: number;
    observedAt: string;
  };
}

export interface SupplierLocalDemandBootstrapResult {
  orderId: string;
  dryRun: boolean;
  status: "would_bootstrap" | "bootstrapped" | "already_tracked" | "skipped";
  reason?: string;
  productQuantities: Record<string, number>;
}

type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : {}
);

const text = (value: unknown, maximum = 300): string => typeof value === "string"
  ? value.normalize("NFKC").trim().replace(/\s+/gu, " ").slice(0, maximum)
  : "";

const cleanIdentifier = (value: unknown, label: string): string => {
  const identifier = text(value, 180);
  if (!identifier || identifier.includes("/")) throw new ApiError(`${label} is invalid.`, 400);
  return identifier;
};

const positiveInteger = (value: unknown, label: string): number => {
  const parsed = nonNegativeInteger(value);
  if (parsed === null || parsed < 1) throw new ApiError(`${label} is invalid.`, 400);
  return parsed;
};

const observationTimestamp = (value: unknown): string => {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
  }
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object" && "toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
    const date = (value as { toDate: () => Date }).toDate();
    return date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : "";
  }
  return "";
};

const nowIso = (): string => new Date().toISOString();

const settlementIdFor = (orderId: string, groupId: string, productId: string): string => (
  `supplier-settlement-${createHash("sha256").update(`${orderId}|${groupId}|${productId}`).digest("hex").slice(0, 32)}`
);

const settlementRecords = (privateOrderValue: unknown): SupplierInventorySettlement[] => {
  const raw = record(privateOrderValue).supplierInventorySettlements;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((candidate): SupplierInventorySettlement[] => {
    const value = record(candidate);
    const quantity = nonNegativeInteger(value.quantity);
    const baselineStock = nonNegativeInteger(value.baselineSupplierObservedStock);
    const baselineVersion = nonNegativeInteger(value.baselineSupplierObservationVersion);
    const supplierObservationVersion = nonNegativeInteger(value.supplierObservationVersion);
    const status = value.status === "reconciled" ? "reconciled" : value.status === "unresolved" ? "unresolved" : null;
    if (quantity === null || baselineStock === null || baselineVersion === null || baselineVersion < 1 || !status) return [];
    if (!text(value.settlementId, 220) || !text(value.orderId, 180) || !text(value.groupId, 180) || !text(value.productId, 180)
      || !text(value.supplierSourceId, 160) || !text(value.supplierAccountId, 160)) return [];
    const baselineSupplierObservationAt = observationTimestamp(value.baselineSupplierObservationAt);
    const preparedAt = observationTimestamp(value.preparedAt);
    const preparedBy = text(value.preparedBy, 180);
    if (!baselineSupplierObservationAt || !preparedAt || !preparedBy) return [];
    const settlement: SupplierInventorySettlement = {
      settlementId: text(value.settlementId, 220),
      orderId: text(value.orderId, 180),
      groupId: text(value.groupId, 180),
      productId: text(value.productId, 180),
      quantity,
      status,
      supplierSourceId: text(value.supplierSourceId, 160),
      supplierAccountId: text(value.supplierAccountId, 160),
      baselineSupplierObservedStock: baselineStock,
      baselineSupplierObservationVersion: baselineVersion,
      baselineSupplierObservationAt,
      preparedAt,
      preparedBy,
      externalSupplierOrderReference: text(value.externalSupplierOrderReference, 220) || null,
      ...(observationTimestamp(value.reconciledAt) ? { reconciledAt: observationTimestamp(value.reconciledAt) } : {}),
      ...(text(value.reconciledBy, 180) ? { reconciledBy: text(value.reconciledBy, 180) } : {}),
      ...(nonNegativeInteger(value.supplierObservationStock) !== null ? { supplierObservationStock: nonNegativeInteger(value.supplierObservationStock)! } : {}),
      ...(supplierObservationVersion !== null && supplierObservationVersion > 0 ? { supplierObservationVersion } : {}),
      ...(observationTimestamp(value.supplierObservationAt) ? { supplierObservationAt: observationTimestamp(value.supplierObservationAt) } : {}),
    };
    return [settlement];
  });
};

export const reconciledSupplierQuantity = (
  privateOrderValue: unknown,
  productId: string,
): number => settlementRecords(privateOrderValue)
  .filter((settlement) => settlement.productId === productId && settlement.status === "reconciled")
  .reduce((total, settlement) => total + settlement.quantity, 0);

export const unreconciledSupplierOrderQuantity = (
  privateOrderValue: unknown,
  productId: string,
  orderQuantity: number,
): number => Math.max(0, orderQuantity - reconciledSupplierQuantity(privateOrderValue, productId));

const replaceSettlement = (
  privateOrderValue: unknown,
  nextSettlement: SupplierInventorySettlement,
): SupplierInventorySettlement[] => {
  const existing = settlementRecords(privateOrderValue);
  const index = existing.findIndex((candidate) => candidate.settlementId === nextSettlement.settlementId);
  if (index < 0) return [...existing, nextSettlement];
  return existing.map((candidate, candidateIndex) => candidateIndex === index ? nextSettlement : candidate);
};

const supplierOfferObservation = (value: unknown): { stock: number; version: number; observedAt: string; sourceId: string; supplierId: string; productId: string } => {
  const offer = record(value);
  const stock = nonNegativeInteger(offer.stock);
  const version = positiveInteger(offer.stateVersion, "Supplier offer state version");
  const observedAt = observationTimestamp(
    record(offer.health).inventoryObservedAt
      || offer.lastSyncAt
      || offer.updatedAt
      || record(offer.supplierSnapshot).observedAt,
  );
  if (stock === null || !observedAt) throw new ApiError("A current trusted supplier observation is required.", 409);
  return {
    stock,
    version,
    observedAt,
    sourceId: text(offer.sourceId, 160),
    supplierId: text(offer.supplierId, 160),
    productId: text(offer.productId, 180),
  };
};

const assertCommittedSupplierTarget = (input: {
  order: RecordValue;
  privateOrder: ParsedOrderPrivateFulfilment;
  privateOrderValue: RecordValue;
  group: OrderFulfilmentGroup;
  productId: string;
  quantity: number;
  productPrivateValue: RecordValue;
  offerValue: RecordValue;
}, allowSettled: boolean): { line: ParsedOrderPrivateFulfilment["lines"][number]; observation: ReturnType<typeof supplierOfferObservation>; localDemand: SupplierLocalDemandState } => {
  const status = text(input.order.status, 30).toLowerCase();
  if (!["confirmed", "processing", "packed", "shipped", "delivered"].includes(status)
    || text(input.order.stockReservationStatus, 30).toLowerCase() !== "committed"
    || input.order.stockRestorationApplied === true) {
    throw new ApiError("Supplier inventory reconciliation requires committed, unrestored inventory.", 409);
  }
  if (input.group.status === "unassigned") throw new ApiError("The fulfilment group is not active.", 409);
  const line = input.privateOrder.lines.find((candidate) => candidate.productId === input.productId
    && input.group.lineIds.includes(candidate.lineId)
    && candidate.fulfilmentMode === "supplier");
  if (!line || !line.supplierSourceId || !line.supplierAccountId || !line.supplierOfferId) {
    throw new ApiError("Supplier purchase attribution is unavailable for this fulfilment group.", 409);
  }
  if (line.supplierAccountId !== input.group.supplierAccountId
    || !input.group.supplierSourceIds.includes(line.supplierSourceId)) {
    throw new ApiError("Supplier fulfilment identity does not match the purchase attribution.", 409);
  }
  const metadata = record(input.productPrivateValue.supplierMetadata);
  const currentSource = text(input.productPrivateValue.supplierSourceId, 160);
  const currentSupplierItemCode = text(input.productPrivateValue.supplierItemCode, 300);
  const currentSupplierProductId = text(metadata.supplierProductId, 300);
  if (currentSource !== line.supplierSourceId
    || (line.supplierItemCode && currentSupplierItemCode !== line.supplierItemCode)
    || (line.supplierProductId && currentSupplierProductId !== line.supplierProductId)) {
    throw new ApiError("Current supplier identity does not match the purchase-time attribution.", 409);
  }
  const observation = supplierOfferObservation(input.offerValue);
  const activeOfferId = text(record(input.productPrivateValue.supplierOfferSelection).activeOfferId, 220)
    || text(metadata.activeOfferId, 220);
  if (observation.productId !== input.productId
    || observation.sourceId !== line.supplierSourceId
    || observation.supplierId !== line.supplierId
    || activeOfferId !== line.supplierOfferId
    || text(input.offerValue.reviewStatus, 30).toLowerCase() !== "approved") {
    throw new ApiError("Current supplier offer does not match the purchase-time attribution.", 409);
  }
  const localDemand = supplierLocalDemandFromPrivate(input.productPrivateValue);
  const orderQuantities = collectOrderStockQuantities(input.order.items);
  if (orderQuantities.get(input.productId) !== input.quantity) {
    throw new ApiError("Reconciliation quantity does not match the order line.", 409);
  }
  if (allowSettled) {
    return { line, observation, localDemand: { version: SUPPLIER_LOCAL_DEMAND_VERSION, quantity: 0, status: "tracked" } };
  }
  if (!localDemand || localDemand.quantity < input.quantity || localDemand.status !== "tracked") {
    throw new ApiError("Supplier local demand bootstrap is required before reconciliation.", 409);
  }
  return { line, observation, localDemand };
};

const loadSettlementContext = async (
  transaction: FirebaseFirestore.Transaction,
  db: FirebaseFirestore.Firestore,
  input: SupplierInventorySettlementActionInput,
) => {
  const orderId = cleanIdentifier(input.orderId, "Order ID");
  const groupId = cleanIdentifier(input.groupId, "Fulfilment group ID");
  const productId = cleanIdentifier(input.productId, "Product ID");
  const quantity = positiveInteger(input.quantity, "Reconciliation quantity");
  const expectedGroupRevision = positiveInteger(input.expectedGroupRevision, "Fulfilment group revision");
  const expectedOrderPrivateRevision = positiveInteger(input.expectedOrderPrivateRevision, "Order fulfilment revision");
  const orderReference = db.collection("orders").doc(orderId);
  const privateReference = db.collection(ORDER_PRIVATE_COLLECTION).doc(orderId);
  const [orderSnapshot, privateSnapshot] = await Promise.all([
    transaction.get(orderReference),
    transaction.get(privateReference),
  ]);
  if (!orderSnapshot.exists || !privateSnapshot.exists) throw new ApiError("Order fulfilment attribution was not found.", 404);
  const orderValue = record(orderSnapshot.data());
  const privateOrderValue = record(privateSnapshot.data());
  const privateOrder = parseOrderPrivateFulfilment(orderId, privateOrderValue);
  const group = privateOrder.fulfilmentGroups.find((candidate) => candidate.groupId === groupId);
  if (!group) throw new ApiError("Fulfilment group not found.", 404);
  if (privateOrder.revision !== expectedOrderPrivateRevision || group.revision !== expectedGroupRevision) {
    throw new ApiError("Fulfilment state changed. Refresh and try again.", 409);
  }
  const productReference = db.collection("products").doc(productId);
  const productPrivateReference = db.collection("product_private").doc(productId);
  const [productSnapshot, productPrivateSnapshot] = await Promise.all([
    transaction.get(productReference),
    transaction.get(productPrivateReference),
  ]);
  if (!productSnapshot.exists || !productPrivateSnapshot.exists) throw new ApiError("Supplier product inventory was not found.", 409);
  const productPrivateValue = record(productPrivateSnapshot.data());
  const line = privateOrder.lines.find((candidate) => candidate.productId === productId && group.lineIds.includes(candidate.lineId));
  if (!line?.supplierOfferId) throw new ApiError("Supplier offer attribution was not found.", 409);
  const offerSnapshot = await transaction.get(db.collection("supplier_product_offers").doc(line.supplierOfferId));
  if (!offerSnapshot.exists) throw new ApiError("The attributed supplier offer was not found.", 409);
  const settlementId = settlementIdFor(orderId, groupId, productId);
  const existingSettlement = settlementRecords(privateOrderValue).find((candidate) => candidate.settlementId === settlementId) || null;
  const validated = assertCommittedSupplierTarget({
    order: orderValue,
    privateOrder,
    privateOrderValue,
    group,
    productId,
    quantity,
    productPrivateValue,
    offerValue: record(offerSnapshot.data()),
  }, existingSettlement?.status === "reconciled");
  return {
    orderId,
    groupId,
    productId,
    quantity,
    expectedGroupRevision,
    expectedOrderPrivateRevision,
    orderReference,
    privateReference,
    productReference,
    productPrivateReference,
    orderValue,
    privateOrderValue,
    privateOrder,
    group,
    productValue: record(productSnapshot.data()),
    productPrivateValue,
    observation: validated.observation,
    localDemand: validated.localDemand,
    existingSettlement,
    settlementId,
  };
};

const actionResult = (context: Awaited<ReturnType<typeof loadSettlementContext>>, status: SupplierInventorySettlementStatus, idempotent: boolean, publicStock: number, localDemand: number): SupplierInventorySettlementActionResult => ({
  orderId: context.orderId,
  groupId: context.groupId,
  productId: context.productId,
  quantity: context.quantity,
  status,
  idempotent,
  publicStock,
  localDemand,
  supplierObservation: {
    stock: context.observation.stock,
    version: context.observation.version,
    observedAt: context.observation.observedAt,
  },
});

export async function prepareSupplierInventorySettlement(
  input: SupplierInventorySettlementActionInput,
): Promise<SupplierInventorySettlementActionResult> {
  if (input.manualSupplierOrderPlaced !== true) throw new ApiError("Explicit confirmation of the manually placed supplier order is required.", 400);
  const externalReference = text(input.externalSupplierOrderReference, 220) || null;
  return input.db.runTransaction(async (transaction) => {
    const context = await loadSettlementContext(transaction, input.db, input);
    if (context.existingSettlement?.status === "reconciled") {
      return actionResult(context, "reconciled", true, Number(context.productValue.stock || 0), context.localDemand.quantity);
    }
    if (context.existingSettlement?.status === "unresolved") {
      return actionResult(context, "unresolved", true, Number(context.productValue.stock || 0), context.localDemand.quantity);
    }
    const preparedAt = nowIso();
    const settlement: SupplierInventorySettlement = {
      settlementId: context.settlementId,
      orderId: context.orderId,
      groupId: context.groupId,
      productId: context.productId,
      quantity: context.quantity,
      status: "unresolved",
      supplierSourceId: context.observation.sourceId,
      supplierAccountId: context.group.supplierAccountId,
      baselineSupplierObservedStock: context.observation.stock,
      baselineSupplierObservationVersion: context.observation.version,
      baselineSupplierObservationAt: context.observation.observedAt,
      preparedAt,
      preparedBy: input.actorUid,
      externalSupplierOrderReference: externalReference,
    };
    transaction.update(context.privateReference, {
      supplierInventorySettlements: replaceSettlement(context.privateOrderValue, settlement),
      revision: context.privateOrder.revision + 1,
      updatedAt: preparedAt,
    });
    transaction.create(input.db.collection("supplier_operations_audit").doc(`supplier-inventory-prepared-${context.settlementId}`), {
      id: `supplier-inventory-prepared-${context.settlementId}`,
      eventId: `supplier-inventory-prepared-${context.settlementId}`,
      action: "supplier_inventory_reconciliation_prepared",
      orderId: context.orderId,
      groupId: context.groupId,
      productId: context.productId,
      supplierSourceId: context.observation.sourceId,
      supplierAccountId: context.group.supplierAccountId,
      quantity: context.quantity,
      supplierObservationStock: context.observation.stock,
      supplierObservationVersion: context.observation.version,
      supplierObservationAt: context.observation.observedAt,
      actorUid: input.actorUid,
      timestamp: FieldValue.serverTimestamp(),
    });
    return actionResult(context, "unresolved", false, Number(context.productValue.stock || 0), context.localDemand.quantity);
  });
}

export async function reconcileSupplierInventorySettlement(
  input: SupplierInventorySettlementActionInput,
): Promise<SupplierInventorySettlementActionResult> {
  if (input.acknowledgeFreshSupplierObservation !== true) throw new ApiError("Explicit confirmation of fresh supplier evidence is required.", 400);
  const externalReference = text(input.externalSupplierOrderReference, 220) || null;
  return input.db.runTransaction(async (transaction) => {
    const context = await loadSettlementContext(transaction, input.db, input);
    if (context.existingSettlement?.status === "reconciled") {
      return actionResult(context, "reconciled", true, Number(context.productValue.stock || 0), context.localDemand.quantity);
    }
    const settlement = context.existingSettlement;
    if (!settlement || settlement.status !== "unresolved") throw new ApiError("Supplier reconciliation preparation is required first.", 409);
    if (context.observation.version <= settlement.baselineSupplierObservationVersion
      || Date.parse(context.observation.observedAt) <= Date.parse(settlement.preparedAt)
      || context.observation.stock > settlement.baselineSupplierObservedStock - context.quantity) {
      throw new ApiError("A fresh supplier observation reflecting the manual supplier order is required.", 409);
    }
    const nextDemand = releaseSupplierLocalDemand(context.localDemand, context.quantity);
    const nextStock = projectSupplierAvailableStock({
      currentPublicStock: context.productValue.stock,
      supplierObservedStock: context.observation.stock,
      localDemand: nextDemand,
    });
    const reconciledAt = nowIso();
    const nextSettlement: SupplierInventorySettlement = {
      ...settlement,
      status: "reconciled",
      externalSupplierOrderReference: externalReference || settlement.externalSupplierOrderReference,
      reconciledAt,
      reconciledBy: input.actorUid,
      supplierObservationStock: context.observation.stock,
      supplierObservationVersion: context.observation.version,
      supplierObservationAt: context.observation.observedAt,
    };
    transaction.update(context.productReference, {
      stock: nextStock,
      availability: context.observation.stock > 0 ? "in_stock" : "out_of_stock",
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(context.productPrivateReference, withSupplierLocalDemand(context.productPrivateValue, nextDemand), { merge: true });
    transaction.update(context.privateReference, {
      supplierInventorySettlements: replaceSettlement(context.privateOrderValue, nextSettlement),
      revision: context.privateOrder.revision + 1,
      updatedAt: reconciledAt,
    });
    transaction.create(input.db.collection("supplier_operations_audit").doc(`supplier-inventory-reconciled-${context.settlementId}`), {
      id: `supplier-inventory-reconciled-${context.settlementId}`,
      eventId: `supplier-inventory-reconciled-${context.settlementId}`,
      action: "supplier_inventory_reconciled",
      orderId: context.orderId,
      groupId: context.groupId,
      productId: context.productId,
      supplierSourceId: context.observation.sourceId,
      supplierAccountId: context.group.supplierAccountId,
      quantity: context.quantity,
      supplierObservationStock: context.observation.stock,
      supplierObservationVersion: context.observation.version,
      supplierObservationAt: context.observation.observedAt,
      actorUid: input.actorUid,
      timestamp: FieldValue.serverTimestamp(),
    });
    return actionResult(context, "reconciled", false, nextStock, nextDemand.quantity);
  });
}

export async function bootstrapSupplierLocalDemandForOrder(
  db: FirebaseFirestore.Firestore,
  orderIdValue: unknown,
  options: { dryRun?: boolean } = {},
): Promise<SupplierLocalDemandBootstrapResult> {
  const orderId = cleanIdentifier(orderIdValue, "Order ID");
  const dryRun = options.dryRun !== false;
  return db.runTransaction(async (transaction) => {
    const orderReference = db.collection("orders").doc(orderId);
    const privateReference = db.collection(ORDER_PRIVATE_COLLECTION).doc(orderId);
    const [orderSnapshot, privateSnapshot] = await Promise.all([
      transaction.get(orderReference),
      transaction.get(privateReference),
    ]);
    if (!orderSnapshot.exists || !privateSnapshot.exists) return { orderId, dryRun, status: "skipped", reason: "order_or_private_missing", productQuantities: {} };
    const order = record(orderSnapshot.data());
    const privateOrderValue = record(privateSnapshot.data());
    if (nonNegativeInteger(privateOrderValue.supplierLocalDemandTrackingVersion) === SUPPLIER_LOCAL_DEMAND_TRACKING_VERSION) {
      return { orderId, dryRun, status: "already_tracked", productQuantities: {} };
    }
    if (!order.stockDeducted
      || text(order.stockReservationStatus, 30).toLowerCase() !== "committed"
      || order.stockRestorationApplied === true
      || !["confirmed", "processing", "packed", "shipped"].includes(text(order.status, 30).toLowerCase())) {
      return { orderId, dryRun, status: "skipped", reason: "order_not_active_committed", productQuantities: {} };
    }
    const privateOrder = parseOrderPrivateFulfilment(orderId, privateOrderValue);
    const quantities = collectOrderStockQuantities(order.items);
    const productQuantities: Record<string, number> = {};
    for (const line of privateOrder.lines.filter((candidate) => candidate.fulfilmentMode === "supplier")) {
      const quantity = quantities.get(line.productId) || 0;
      const group = privateOrder.fulfilmentGroups.find((candidate) => candidate.lineIds.includes(line.lineId));
      if (!quantity || !group || group.status === "unassigned" || !line.supplierSourceId || !line.supplierProductId) continue;
      const productPrivateReference = db.collection("product_private").doc(line.productId);
      const productSnapshot = await transaction.get(productPrivateReference);
      if (!productSnapshot.exists) throw new ApiError("Supplier product attribution is unavailable for bootstrap.", 409);
      const productPrivateValue = record(productSnapshot.data());
      const metadata = record(productPrivateValue.supplierMetadata);
      if (text(productPrivateValue.supplierSourceId, 160) !== line.supplierSourceId
        || text(metadata.supplierProductId, 300) !== line.supplierProductId) {
        throw new ApiError("Supplier attribution did not match during legacy bootstrap.", 409);
      }
      productQuantities[line.productId] = (productQuantities[line.productId] || 0) + quantity;
      if (!dryRun) {
        const currentDemand = supplierLocalDemandFromPrivate(productPrivateValue) || {
          version: SUPPLIER_LOCAL_DEMAND_VERSION,
          quantity: 0,
          status: "tracked" as const,
        };
        transaction.set(productPrivateReference, withSupplierLocalDemand(productPrivateValue, addSupplierLocalDemand(currentDemand, quantity)), { merge: true });
      }
    }
    if (Object.keys(productQuantities).length === 0) return { orderId, dryRun, status: "skipped", reason: "no_active_supplier_lines", productQuantities };
    if (!dryRun) {
      transaction.update(privateReference, {
        supplierLocalDemandTrackingVersion: SUPPLIER_LOCAL_DEMAND_TRACKING_VERSION,
        supplierLocalDemandBootstrappedAt: nowIso(),
        updatedAt: nowIso(),
      });
    }
    return { orderId, dryRun, status: dryRun ? "would_bootstrap" : "bootstrapped", productQuantities };
  });
}

const nonNegativeInteger = (value: unknown): number | null => {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue >= 0 ? numberValue : null;
};

export const supplierObservedStockFromPrivate = (privateValue: unknown): number | null => (
  nonNegativeInteger(record(record(privateValue).supplierMetadata).inventoryLevel)
);

export const supplierLocalDemandFromPrivate = (privateValue: unknown): SupplierLocalDemandState | null => {
  const metadata = record(record(privateValue).supplierMetadata);
  const candidate = record(metadata.localDemand);
  const quantity = nonNegativeInteger(candidate.quantity);
  if (quantity === null) return null;
  return {
    version: nonNegativeInteger(candidate.version) || SUPPLIER_LOCAL_DEMAND_VERSION,
    quantity,
    status: candidate.status === "legacy_bootstrap_required"
      ? "legacy_bootstrap_required"
      : "tracked",
  };
};

export const hasSupplierInventoryAuthority = (privateValue: unknown): boolean => (
  supplierObservedStockFromPrivate(privateValue) !== null
  || supplierLocalDemandFromPrivate(privateValue) !== null
);

/**
 * Legacy products have no local-demand field. The stock gap is only a
 * conservative lower-bound bootstrap; it is never treated as proof that a
 * supplier observation includes a particular Zyro order.
 */
export const resolveSupplierLocalDemand = (
  privateValue: unknown,
  currentPublicStock: unknown,
): SupplierLocalDemandState => {
  const existing = supplierLocalDemandFromPrivate(privateValue);
  if (existing) return existing;
  const supplierStock = supplierObservedStockFromPrivate(privateValue);
  const publicStock = nonNegativeInteger(currentPublicStock);
  const inferredQuantity = supplierStock !== null && publicStock !== null
    ? Math.max(0, supplierStock - publicStock)
    : 0;
  return {
    version: SUPPLIER_LOCAL_DEMAND_VERSION,
    quantity: inferredQuantity,
    status: inferredQuantity > 0 ? "legacy_bootstrap_required" : "tracked",
  };
};

/**
 * Canonical local demand only when it is provable: a valid stored state, or
 * the canonical inference from both a known supplier baseline and a known
 * public stock. Malformed stored state or unknown inputs return null.
 */
export const resolveProvenSupplierLocalDemand = (
  privateValue: unknown,
  currentPublicStock: unknown,
): SupplierLocalDemandState | null => {
  const existing = supplierLocalDemandFromPrivate(privateValue);
  if (existing) return existing;
  if (record(record(privateValue).supplierMetadata).localDemand !== undefined) return null;
  if (supplierObservedStockFromPrivate(privateValue) === null || nonNegativeInteger(currentPublicStock) === null) return null;
  return resolveSupplierLocalDemand(privateValue, currentPublicStock);
};

export const withSupplierLocalDemand = (
  privateValue: unknown,
  state: SupplierLocalDemandState,
): RecordValue => {
  const existing = record(privateValue);
  const metadata = record(existing.supplierMetadata);
  return {
    supplierMetadata: {
      ...metadata,
      localDemand: {
        version: SUPPLIER_LOCAL_DEMAND_VERSION,
        quantity: Math.max(0, Math.floor(state.quantity)),
        status: state.status,
      },
    },
  };
};

export const addSupplierLocalDemand = (
  state: SupplierLocalDemandState,
  quantity: number,
): SupplierLocalDemandState => ({
  ...state,
  quantity: state.quantity + Math.max(0, Math.floor(quantity)),
});

export const releaseSupplierLocalDemand = (
  state: SupplierLocalDemandState,
  quantity: number,
): SupplierLocalDemandState => {
  const nextQuantity = Math.max(0, state.quantity - Math.max(0, Math.floor(quantity)));
  return {
    ...state,
    quantity: nextQuantity,
    status: nextQuantity === 0 ? "tracked" : state.status,
  };
};

export const projectSupplierAvailableStock = (input: {
  currentPublicStock: unknown;
  supplierObservedStock: unknown;
  localDemand: SupplierLocalDemandState;
}): number => {
  const currentStock = nonNegativeInteger(input.currentPublicStock) || 0;
  const supplierStock = nonNegativeInteger(input.supplierObservedStock);
  if (supplierStock === null) return currentStock;
  const candidate = Math.max(0, supplierStock - input.localDemand.quantity);
  // Legacy records never increase public stock until their bootstrap is
  // explicitly reviewed. Missing metadata therefore fails closed.
  return input.localDemand.status === "legacy_bootstrap_required"
    ? Math.min(currentStock, candidate)
    : candidate;
};
