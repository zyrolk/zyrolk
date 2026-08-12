import { createHash } from "node:crypto";
import { FieldValue, Firestore } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import { SupplierHubAdminIdentity } from "../middleware/supplierHubAdminAuth";
import { PRODUCT_PRIVATE_COLLECTION } from "../products/productCommercialData";
import { reconcileSupplierApprovalStock } from "./supplierApprovalConcurrency";

export const SUPPLIER_PRODUCT_OFFERS_COLLECTION = "supplier_product_offers";
export const SUPPLIER_OFFER_SCHEMA_VERSION = 2;

export type SupplierOfferAvailability = "in_stock" | "out_of_stock" | "unavailable" | "unknown";

export interface SupplierOfferFieldOwnership {
  supplier: readonly string[];
  admin: readonly string[];
  system: readonly string[];
}

export interface SupplierProductOffer {
  id: string;
  schemaVersion: number;
  productId: string | null;
  supplierId: string;
  sourceId: string;
  supplierProductId: string;
  sku: string;
  skuNormalized: string;
  barcode: string;
  barcodeNormalized: string;
  price: number;
  cost: number;
  stock: number;
  availability: SupplierOfferAvailability;
  priority: number;
  health: Record<string, unknown>;
  lastSyncAt: string;
  enabled: boolean;
  reviewStatus: "review_pending" | "approved" | "rejected" | "suppressed";
  ownership: SupplierOfferFieldOwnership;
  catalogPayload: Record<string, unknown>;
  supplierSnapshot: Record<string, unknown>;
  /** Monotonic concurrency fence. Legacy documents are version zero. */
  stateVersion: number;
  /** Unreviewed supplier data. Commerce readers must never consume this state. */
  pendingObservation: SupplierOfferPendingObservation | null;
  createdAt: unknown;
  updatedAt: unknown;
}

export type SupplierOfferObservationKind = "catalog_upsert" | "catalog_removal";

export interface SupplierOfferEffectiveSnapshot {
  supplierId: string;
  sourceId: string;
  supplierProductId: string;
  sku: string;
  skuNormalized: string;
  barcode: string;
  barcodeNormalized: string;
  price: number;
  cost: number;
  stock: number;
  availability: SupplierOfferAvailability;
  health: Record<string, unknown>;
  lastSyncAt: string;
  catalogPayload: Record<string, unknown>;
  supplierSnapshot: Record<string, unknown>;
}

export interface SupplierOfferPendingObservation {
  revision: string;
  kind: SupplierOfferObservationKind;
  reviewQueueItemId: string;
  observedAt: string;
  traversalId: string | null;
  effective: SupplierOfferEffectiveSnapshot;
}

export interface SupplierOfferStateExpectation {
  exists: boolean;
  stateVersion: number;
  pendingRevision: string | null;
}

export interface SupplierOfferSelection {
  activeOfferId: string | null;
  lockedOfferId: string | null;
  failoverEnabled: boolean;
  updatedAt?: unknown;
  updatedBy?: string;
}

export const SUPPLIER_OFFER_FIELD_OWNERSHIP: SupplierOfferFieldOwnership = Object.freeze({
  supplier: Object.freeze([
    "supplierId", "sourceId", "supplierProductId", "sku", "barcode", "price", "cost", "stock",
    "availability", "lastSyncAt", "catalogPayload", "supplierSnapshot",
  ]),
  admin: Object.freeze(["priority", "enabled"]),
  system: Object.freeze(["id", "schemaVersion", "productId", "health", "createdAt", "updatedAt"]),
});

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const text = (value: unknown, maximum = 300): string => typeof value === "string"
  ? value.normalize("NFKC").trim().slice(0, maximum)
  : "";

export const normalizeSupplierOfferIdentity = (value: unknown): string => text(value, 300).toLocaleLowerCase();

const money = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) / 100 : 0;
};

const stock = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
};

const stateVersion = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "observedAt")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value ?? null;
};

const effectiveSnapshot = (offer: Pick<SupplierProductOffer,
  "supplierId" | "sourceId" | "supplierProductId" | "sku" | "skuNormalized" | "barcode" | "barcodeNormalized"
  | "price" | "cost" | "stock" | "availability" | "health" | "lastSyncAt" | "catalogPayload" | "supplierSnapshot"
>): SupplierOfferEffectiveSnapshot => ({
  supplierId: offer.supplierId,
  sourceId: offer.sourceId,
  supplierProductId: offer.supplierProductId,
  sku: offer.sku,
  skuNormalized: offer.skuNormalized,
  barcode: offer.barcode,
  barcodeNormalized: offer.barcodeNormalized,
  price: offer.price,
  cost: offer.cost,
  stock: offer.stock,
  availability: offer.availability,
  health: asRecord(offer.health),
  lastSyncAt: offer.lastSyncAt,
  catalogPayload: asRecord(offer.catalogPayload),
  supplierSnapshot: asRecord(offer.supplierSnapshot),
});

const observationRevision = (
  kind: SupplierOfferObservationKind,
  effective: SupplierOfferEffectiveSnapshot,
): string => {
  const reviewEffective = Object.fromEntries(
    Object.entries(effective).filter(([key]) => key !== "lastSyncAt"),
  );
  return createHash("sha256")
    .update(JSON.stringify(stableValue({ kind, effective: reviewEffective })))
    .digest("hex");
};

const parseEffectiveSnapshot = (value: unknown): SupplierOfferEffectiveSnapshot | null => {
  const candidate = asRecord(value);
  const sourceId = text(candidate.sourceId, 160);
  const supplierProductId = text(candidate.supplierProductId, 300);
  const sku = text(candidate.sku, 300);
  if (!sourceId || (!supplierProductId && !sku)) return null;
  return {
    supplierId: text(candidate.supplierId, 160) || sourceId,
    sourceId,
    supplierProductId: supplierProductId || sku,
    sku,
    skuNormalized: normalizeSupplierOfferIdentity(candidate.skuNormalized || sku),
    barcode: text(candidate.barcode, 300),
    barcodeNormalized: normalizeSupplierOfferIdentity(candidate.barcodeNormalized || candidate.barcode),
    price: money(candidate.price),
    cost: money(candidate.cost),
    stock: stock(candidate.stock),
    availability: supplierOfferAvailability(candidate.availability, candidate.stock),
    health: asRecord(candidate.health),
    lastSyncAt: text(candidate.lastSyncAt, 80),
    catalogPayload: asRecord(candidate.catalogPayload),
    supplierSnapshot: asRecord(candidate.supplierSnapshot),
  };
};

export function parseSupplierOfferPendingObservation(value: unknown): SupplierOfferPendingObservation | null {
  const candidate = asRecord(value);
  const kind = candidate.kind === "catalog_removal" ? "catalog_removal"
    : candidate.kind === "catalog_upsert" ? "catalog_upsert" : null;
  const effective = parseEffectiveSnapshot(candidate.effective);
  const reviewQueueItemId = text(candidate.reviewQueueItemId, 180);
  const observedAt = text(candidate.observedAt, 80);
  const revision = text(candidate.revision, 128);
  if (!kind || !effective || !reviewQueueItemId || !observedAt || !revision) return null;
  if (revision !== observationRevision(kind, effective)) return null;
  return {
    revision,
    kind,
    reviewQueueItemId,
    observedAt,
    traversalId: text(candidate.traversalId, 180) || null,
    effective,
  };
}

export function buildSupplierOfferPendingObservation(input: {
  offer: SupplierProductOffer;
  kind: SupplierOfferObservationKind;
  reviewQueueItemId: string;
  observedAt: string;
  traversalId?: string | null;
}): SupplierOfferPendingObservation {
  const effective = effectiveSnapshot(input.offer);
  return {
    revision: observationRevision(input.kind, effective),
    kind: input.kind,
    reviewQueueItemId: text(input.reviewQueueItemId, 180),
    observedAt: text(input.observedAt, 80),
    traversalId: text(input.traversalId, 180) || null,
    effective,
  };
}

export const supplierOfferStateExpectation = (value: unknown): SupplierOfferStateExpectation => {
  const offer = asRecord(value);
  const pending = parseSupplierOfferPendingObservation(offer.pendingObservation);
  return {
    exists: Object.keys(offer).length > 0,
    stateVersion: stateVersion(offer.stateVersion),
    pendingRevision: pending?.revision || null,
  };
};

export const supplierOfferStateMatchesExpectation = (
  value: unknown,
  expectation: SupplierOfferStateExpectation,
  exists = true,
): boolean => {
  if (exists !== expectation.exists) return false;
  if (!exists) return true;
  const current = supplierOfferStateExpectation(value);
  return current.stateVersion === expectation.stateVersion
    && current.pendingRevision === expectation.pendingRevision;
};

/**
 * Stages an observation without changing effective commerce fields on an
 * approved offer. Never-approved offers retain their legacy top-level shape so
 * existing Product Review readers remain compatible.
 */
export function buildSupplierOfferObservationWrite(input: {
  existing: SupplierProductOffer | null;
  observed: SupplierProductOffer;
  pending: SupplierOfferPendingObservation;
  traversalId: string;
  observedAt: string;
}): Record<string, unknown> {
  const currentVersion = input.existing?.stateVersion || 0;
  const samePending = input.existing?.pendingObservation?.revision === input.pending.revision
    && input.existing.pendingObservation.reviewQueueItemId === input.pending.reviewQueueItemId;
  const common = {
    schemaVersion: SUPPLIER_OFFER_SCHEMA_VERSION,
    pendingObservation: input.pending,
    stateVersion: samePending ? currentVersion : currentVersion + 1,
    supplierCatalogTraversalId: input.traversalId,
    supplierCatalogSeenAt: input.observedAt,
    updatedAt: input.observedAt,
  };
  if (input.existing?.reviewStatus === "approved") return common;
  return {
    ...input.observed,
    reviewStatus: "review_pending",
    ...common,
  };
}

/** Promotes only the exact server-staged observation reviewed by the admin. */
export function promoteSupplierOfferPendingObservation(
  offer: SupplierProductOffer,
  revision: string,
): SupplierProductOffer {
  const pending = offer.pendingObservation;
  if (!pending || pending.revision !== revision) throw new Error("The supplier offer observation changed after it was reviewed.");
  return {
    ...offer,
    schemaVersion: SUPPLIER_OFFER_SCHEMA_VERSION,
    ...pending.effective,
    reviewStatus: "approved",
    stateVersion: offer.stateVersion + 1,
    pendingObservation: null,
    updatedAt: pending.observedAt,
  };
}

export const normalizeSupplierOfferPriority = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(10_000, Math.floor(parsed))) : 100;
};

export function buildSupplierOfferId(sourceIdValue: unknown, supplierProductIdValue: unknown, skuValue: unknown): string {
  const sourceId = normalizeSupplierOfferIdentity(sourceIdValue);
  const productIdentity = normalizeSupplierOfferIdentity(supplierProductIdValue) || normalizeSupplierOfferIdentity(skuValue);
  if (!sourceId || !productIdentity) throw new Error("A supplier offer requires a source and product identity.");
  return `offer-${createHash("sha256").update(`${sourceId}|${productIdentity}`).digest("hex").slice(0, 40)}`;
}

export function supplierOfferAvailability(value: unknown, stockValue: unknown): SupplierOfferAvailability {
  const normalized = normalizeSupplierOfferIdentity(value).replace(/[\s-]+/gu, "_");
  if (["unavailable", "discontinued", "deleted", "inactive"].includes(normalized)) return "unavailable";
  if (["out_of_stock", "outofstock", "sold_out"].includes(normalized)) return "out_of_stock";
  if (["in_stock", "instock", "available", "active"].includes(normalized)) return stock(stockValue) > 0 ? "in_stock" : "out_of_stock";
  return stock(stockValue) > 0 ? "in_stock" : "out_of_stock";
}

export interface BuildSupplierProductOfferInput {
  sourceId: unknown;
  supplierId: unknown;
  supplierProductId?: unknown;
  sku: unknown;
  barcode?: unknown;
  productId?: unknown;
  price?: unknown;
  cost?: unknown;
  stock?: unknown;
  availability?: unknown;
  priority?: unknown;
  health?: unknown;
  lastSyncAt: string;
  enabled?: unknown;
  reviewStatus?: unknown;
  catalogPayload?: unknown;
  supplierSnapshot?: unknown;
  stateVersion?: unknown;
  pendingObservation?: unknown;
  existing?: unknown;
  timestamp: unknown;
}

/** Creates a complete offer while preserving administrator-controlled settings from an existing offer. */
export function buildSupplierProductOffer(input: BuildSupplierProductOfferInput): SupplierProductOffer {
  const existing = asRecord(input.existing);
  const sourceId = text(input.sourceId, 160);
  const supplierId = text(input.supplierId, 160) || sourceId;
  const supplierProductId = text(input.supplierProductId, 300) || text(input.sku, 300);
  const sku = text(input.sku, 300);
  const barcode = text(input.barcode, 300);
  const id = buildSupplierOfferId(sourceId, supplierProductId, sku);
  const productId = text(input.productId, 180) || text(existing.productId, 180) || null;
  return {
    id,
    schemaVersion: SUPPLIER_OFFER_SCHEMA_VERSION,
    productId,
    supplierId,
    sourceId,
    supplierProductId,
    sku,
    skuNormalized: normalizeSupplierOfferIdentity(sku),
    barcode,
    barcodeNormalized: normalizeSupplierOfferIdentity(barcode),
    price: money(input.price),
    cost: money(input.cost),
    stock: stock(input.stock),
    availability: supplierOfferAvailability(input.availability, input.stock),
    priority: existing.priority === undefined ? normalizeSupplierOfferPriority(input.priority) : normalizeSupplierOfferPriority(existing.priority),
    health: asRecord(input.health),
    lastSyncAt: text(input.lastSyncAt, 80),
    enabled: typeof existing.enabled === "boolean" ? existing.enabled : input.enabled !== false,
    reviewStatus: ["approved", "rejected", "suppressed"].includes(text(input.reviewStatus, 30))
      ? text(input.reviewStatus, 30) as SupplierProductOffer["reviewStatus"]
      : "review_pending",
    ownership: SUPPLIER_OFFER_FIELD_OWNERSHIP,
    catalogPayload: asRecord(input.catalogPayload),
    supplierSnapshot: asRecord(input.supplierSnapshot),
    stateVersion: stateVersion(input.stateVersion ?? existing.stateVersion),
    pendingObservation: input.pendingObservation === null
      ? null
      : parseSupplierOfferPendingObservation(input.pendingObservation ?? existing.pendingObservation),
    createdAt: existing.createdAt ?? input.timestamp,
    updatedAt: input.timestamp,
  };
}

export function parseSupplierOfferSelection(value: unknown): SupplierOfferSelection {
  const selection = asRecord(value);
  return {
    activeOfferId: text(selection.activeOfferId, 180) || null,
    lockedOfferId: text(selection.lockedOfferId, 180) || null,
    failoverEnabled: selection.failoverEnabled !== false,
    ...(selection.updatedAt !== undefined ? { updatedAt: selection.updatedAt } : {}),
    ...(text(selection.updatedBy, 160) ? { updatedBy: text(selection.updatedBy, 160) } : {}),
  };
}

export const isSupplierOfferAvailableForCommerce = (offer: Pick<SupplierProductOffer, "enabled" | "availability" | "stock" | "health">): boolean => {
  const availability = normalizeSupplierOfferIdentity(offer.health.availability);
  const sourceAvailability = normalizeSupplierOfferIdentity(offer.health.sourceAvailability);
  return offer.enabled
    && offer.availability === "in_stock"
    && offer.stock > 0
    && availability !== "unavailable"
    && sourceAvailability !== "unavailable";
};

const byPriority = (left: SupplierProductOffer, right: SupplierProductOffer): number => (
  right.priority - left.priority || left.sourceId.localeCompare(right.sourceId) || left.id.localeCompare(right.id)
);

/** Resolves policy deterministically. A lock always wins; failover never changes a locked supplier. */
export function resolveActiveSupplierOffer(
  offers: readonly SupplierProductOffer[],
  selectionValue: unknown,
): SupplierProductOffer | null {
  const selection = parseSupplierOfferSelection(selectionValue);
  // Pending observations are stored separately and review-pending offers have
  // never become effective. Selection is therefore restricted to approved
  // top-level state even when a caller forgets to pre-filter.
  const enabled = offers.filter((offer) => offer.enabled && offer.reviewStatus === "approved").sort(byPriority);
  if (selection.lockedOfferId) return enabled.find((offer) => offer.id === selection.lockedOfferId) || null;
  const active = enabled.find((offer) => offer.id === selection.activeOfferId);
  if (active && (!selection.failoverEnabled || isSupplierOfferAvailableForCommerce(active))) return active;
  if (!selection.failoverEnabled && selection.activeOfferId) return active || null;
  return enabled.filter(isSupplierOfferAvailableForCommerce)[0] || enabled[0] || null;
}

/**
 * Projects the commerce fields owned by an explicitly selected supplier offer.
 * The stock delta preserves reservations and intervening inventory adjustments
 * already reflected in the live product document.
 */
export function buildSupplierOfferPublicProjection(
  offer: SupplierProductOffer,
  currentProductValue: unknown,
  previousSupplierStockValue?: unknown,
): Record<string, unknown> {
  if (offer.reviewStatus !== "approved") {
    throw new Error("Only an approved supplier offer can be projected to the public catalogue.");
  }
  const currentProduct = asRecord(currentProductValue);
  const previousSupplierStock = previousSupplierStockValue === undefined
    ? currentProduct.stock
    : previousSupplierStockValue;
  const projectedStock = reconcileSupplierApprovalStock(
    previousSupplierStock,
    currentProduct.stock,
    offer.stock,
    true,
  );
  const catalogPayload = asRecord(offer.catalogPayload);
  const candidateComparePrice = money(catalogPayload.originalPrice ?? catalogPayload.comparePrice ?? currentProduct.originalPrice);
  const originalPrice = candidateComparePrice >= offer.price ? candidateComparePrice : offer.price;
  const discount = originalPrice > offer.price
    ? Math.round(((originalPrice - offer.price) / originalPrice) * 100)
    : 0;
  return {
    price: offer.price,
    originalPrice,
    discount,
    stock: projectedStock,
    availability: offer.availability === "unavailable"
      ? "unavailable"
      : projectedStock > 0 ? "in_stock" : "out_of_stock",
  };
}

/** Builds the public result of an approved supplier-removal review. */
export function buildSupplierRemovalPublicProjection(
  replacementOffer: SupplierProductOffer | null,
  currentProductValue: unknown,
  stockBaselineValue?: unknown,
): Record<string, unknown> {
  if (replacementOffer && isSupplierOfferAvailableForCommerce(replacementOffer)) {
    return buildSupplierOfferPublicProjection(replacementOffer, currentProductValue, stockBaselineValue);
  }
  return {
    stock: 0,
    availability: "unavailable",
    isActive: false,
    active: false,
    visible: false,
  };
}

export function projectSupplierOfferForAdmin(value: unknown): SupplierProductOffer | null {
  const offer = asRecord(value);
  const sourceId = text(offer.sourceId, 160);
  const supplierProductId = text(offer.supplierProductId, 300);
  const sku = text(offer.sku, 300);
  if (!sourceId || (!supplierProductId && !sku)) return null;
  return buildSupplierProductOffer({
    sourceId,
    supplierId: offer.supplierId,
    supplierProductId,
    sku,
    barcode: offer.barcode,
    productId: offer.productId,
    price: offer.price,
    cost: offer.cost,
    stock: offer.stock,
    availability: offer.availability,
    priority: offer.priority,
    health: offer.health,
    lastSyncAt: text(offer.lastSyncAt, 80),
    enabled: offer.enabled,
    reviewStatus: offer.reviewStatus,
    catalogPayload: offer.catalogPayload,
    supplierSnapshot: offer.supplierSnapshot,
    stateVersion: offer.stateVersion,
    pendingObservation: offer.pendingObservation,
    existing: offer,
    timestamp: offer.updatedAt ?? null,
  });
}

const cleanDocumentId = (value: unknown, label: string): string => {
  const result = text(value, 180);
  if (!result || result.includes("/")) throw new ApiError(`${label} is invalid.`, 400);
  return result;
};

const activeSupplierPrivateProjection = (offer: SupplierProductOffer | null, existingPrivate: unknown = {}): Record<string, unknown> => offer ? {
  supplierId: offer.supplierId,
  supplierSourceId: offer.sourceId,
  supplierItemCode: offer.sku,
  supplierItemCodeNormalized: offer.skuNormalized,
  costPrice: offer.cost,
  supplierMetadata: {
    ...asRecord(asRecord(existingPrivate).supplierMetadata),
    supplierProductId: offer.supplierProductId,
    sku: offer.sku,
    barcode: offer.barcode,
    activeOfferId: offer.id,
    lastOfferSelectionAt: offer.lastSyncAt,
    inventoryLevel: offer.stock,
    price: offer.price,
    availability: offer.availability,
    supplierFailoverDeactivated: false,
    failoverPreviousVisibility: null,
  },
} : {};

const inactiveSupplierPrivateProjection = (existingPrivate: unknown = {}, currentProductValue: unknown = {}): Record<string, unknown> => {
  const metadata = asRecord(asRecord(existingPrivate).supplierMetadata);
  const currentProduct = asRecord(currentProductValue);
  const priorVisibility = metadata.supplierFailoverDeactivated === true
    ? asRecord(metadata.failoverPreviousVisibility)
    : {
      isActive: currentProduct.isActive,
      active: currentProduct.active,
      visible: currentProduct.visible,
    };
  return ({
  supplierOfferSelection: {
    ...parseSupplierOfferSelection(asRecord(existingPrivate).supplierOfferSelection),
  },
  supplierMetadata: {
    ...metadata,
    activeOfferId: null,
    inventoryLevel: 0,
    availability: "unavailable",
    supplierFailoverDeactivated: true,
    failoverPreviousVisibility: priorVisibility,
  },
  });
};

const offerEligibilitySnapshot = (value: unknown): Record<string, unknown> => {
  const offer = asRecord(value);
  return {
    productId: text(offer.productId, 180) || null,
    enabled: offer.enabled !== false,
    reviewStatus: text(offer.reviewStatus, 30),
    stock: stock(offer.stock),
    availability: supplierOfferAvailability(offer.availability, offer.stock),
    healthAvailability: normalizeSupplierOfferIdentity(asRecord(offer.health).availability),
    sourceAvailability: normalizeSupplierOfferIdentity(asRecord(offer.health).sourceAvailability),
  };
};

export function supplierOfferEligibilityChanged(before: unknown, after: unknown): boolean {
  return JSON.stringify(offerEligibilitySnapshot(before)) !== JSON.stringify(offerEligibilitySnapshot(after));
}

export interface SupplierOfferFailoverResult {
  productId: string;
  changed: boolean;
  previousOfferId: string | null;
  activeOfferId: string | null;
}

/**
 * Reconciles an unavailable active offer without publishing any unapproved
 * supplier data. The public and private projections and immutable audit event
 * are committed in one Firestore transaction.
 */
export async function reconcileSupplierProductOfferFailover(
  db: Firestore,
  productIdValue: unknown,
  reason = "supplier_offer_eligibility_changed",
): Promise<SupplierOfferFailoverResult> {
  const productId = cleanDocumentId(productIdValue, "Product ID");
  return db.runTransaction(async (transaction) => {
    const productReference = db.collection("products").doc(productId);
    const privateReference = db.collection(PRODUCT_PRIVATE_COLLECTION).doc(productId);
    const offersQuery = db.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).where("productId", "==", productId).limit(100);
    const [productSnapshot, privateSnapshot, offersSnapshot] = await Promise.all([
      transaction.get(productReference),
      transaction.get(privateReference),
      transaction.get(offersQuery),
    ]);
    if (!productSnapshot.exists) {
      return { productId, changed: false, previousOfferId: null, activeOfferId: null };
    }
    const offers = offersSnapshot.docs
      .map((document) => projectSupplierOfferForAdmin({ id: document.id, ...document.data() }))
      .filter((offer): offer is SupplierProductOffer => Boolean(offer));
    const privateProduct = privateSnapshot.data() || {};
    const previousSelection = parseSupplierOfferSelection(privateProduct.supplierOfferSelection);
    if (!previousSelection.activeOfferId) {
      return { productId, changed: false, previousOfferId: null, activeOfferId: null };
    }
    const previousOffer = offers.find((offer) => offer.id === previousSelection.activeOfferId) || null;
    // A selected legacy offer can carry a pre-SH-2D pending/rejected state whose
    // last approved values cannot be proven. Never guess from those values and
    // never let that ambiguous review state mutate the current public product.
    // A fresh Product Review decision will establish the separated effective
    // state before automatic failover is allowed again.
    if (previousOffer && previousOffer.reviewStatus !== "approved") {
      return {
        productId,
        changed: false,
        previousOfferId: previousOffer.id,
        activeOfferId: previousOffer.id,
      };
    }
    const previousOfferEligible = Boolean(
      previousOffer
      && previousOffer.reviewStatus === "approved"
      && isSupplierOfferAvailableForCommerce(previousOffer),
    );
    const failoverDeactivated = asRecord(privateProduct.supplierMetadata).supplierFailoverDeactivated === true;
    if (previousOfferEligible && !failoverDeactivated) {
      return {
        productId,
        changed: false,
        previousOfferId: previousOffer?.id || null,
        activeOfferId: previousOffer?.id || null,
      };
    }

    const eligibleOffers = offers.filter((offer) => (
      offer.reviewStatus === "approved" && isSupplierOfferAvailableForCommerce(offer)
    ));
    const automaticSelectionAllowed = previousSelection.failoverEnabled && !previousSelection.lockedOfferId;
    const replacementOffer = automaticSelectionAllowed
      ? resolveActiveSupplierOffer(eligibleOffers, { activeOfferId: null, lockedOfferId: null, failoverEnabled: true })
      : null;
    const previousSupplierStock = asRecord(privateProduct.supplierMetadata).inventoryLevel
      ?? previousOffer?.stock
      ?? productSnapshot.data()?.stock;
    const publicProjection = replacementOffer
      ? buildSupplierOfferPublicProjection(replacementOffer, productSnapshot.data(), previousSupplierStock)
      : buildSupplierRemovalPublicProjection(null, productSnapshot.data(), previousSupplierStock);
    if (replacementOffer && failoverDeactivated) {
      const previousVisibility = asRecord(asRecord(privateProduct.supplierMetadata).failoverPreviousVisibility);
      Object.assign(publicProjection, {
        ...(previousVisibility.isActive !== undefined ? { isActive: previousVisibility.isActive } : {}),
        ...(previousVisibility.active !== undefined ? { active: previousVisibility.active } : {}),
        ...(previousVisibility.visible !== undefined ? { visible: previousVisibility.visible } : {}),
      });
    }
    const nextSelection: SupplierOfferSelection = {
      ...previousSelection,
      // Keep the configured offer while commerce is safely deactivated. This
      // lets a later health recovery re-project it without auto-selecting an
      // unrelated legacy offer.
      activeOfferId: replacementOffer?.id || previousSelection.activeOfferId,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: "system:supplier-failover",
    };
    transaction.set(productReference, {
      ...publicProjection,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(privateReference, {
      ...(replacementOffer
        ? activeSupplierPrivateProjection(replacementOffer, privateProduct)
        : inactiveSupplierPrivateProjection(privateProduct, productSnapshot.data())),
      supplierOfferSelection: nextSelection,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    const auditReference = db.collection("supplier_operations_audit").doc();
    transaction.create(auditReference, {
      id: auditReference.id,
      eventId: auditReference.id,
      module: "supplier_offers",
      action: "automatic_offer_failover",
      productId,
      offerId: replacementOffer?.id || null,
      previousOfferId: previousOffer?.id || previousSelection.activeOfferId,
      adminUserId: "system",
      adminEmail: "",
      reason,
      before: {
        selection: previousSelection,
        publicCommerce: Object.fromEntries(Object.entries({
          price: productSnapshot.data()?.price,
          originalPrice: productSnapshot.data()?.originalPrice,
          discount: productSnapshot.data()?.discount,
          stock: productSnapshot.data()?.stock,
          availability: productSnapshot.data()?.availability,
        }).filter(([, value]) => value !== undefined)),
      },
      after: { selection: nextSelection, publicCommerce: publicProjection },
      timestamp: FieldValue.serverTimestamp(),
    });
    return {
      productId,
      changed: true,
      previousOfferId: previousOffer?.id || previousSelection.activeOfferId,
      activeOfferId: replacementOffer?.id || null,
    };
  });
}

const writeOfferAdministrationAudit = (
  transaction: FirebaseFirestore.Transaction,
  db: Firestore,
  input: {
    action: string;
    productId: string;
    offerId: string | null;
    actor: SupplierHubAdminIdentity;
    before: unknown;
    after: unknown;
  },
): void => {
  const reference = db.collection("supplier_operations_audit").doc();
  transaction.create(reference, {
    id: reference.id,
    eventId: reference.id,
    module: "supplier_offers",
    action: input.action,
    productId: input.productId,
    offerId: input.offerId,
    adminUserId: input.actor.uid,
    adminEmail: input.actor.email,
    before: input.before,
    after: input.after,
    timestamp: FieldValue.serverTimestamp(),
  });
};

export async function listSupplierProductOffers(
  db: Firestore,
  productIdValue: unknown,
): Promise<{ productId: string; offers: SupplierProductOffer[]; selection: SupplierOfferSelection }> {
  const productId = cleanDocumentId(productIdValue, "Product ID");
  const [offerSnapshot, privateSnapshot] = await Promise.all([
    db.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).where("productId", "==", productId).limit(100).get(),
    db.collection(PRODUCT_PRIVATE_COLLECTION).doc(productId).get(),
  ]);
  const offers = offerSnapshot.docs
    .map((document) => projectSupplierOfferForAdmin({ id: document.id, ...document.data() }))
    .filter((offer): offer is SupplierProductOffer => Boolean(offer))
    .sort(byPriority);
  return {
    productId,
    offers,
    selection: parseSupplierOfferSelection(privateSnapshot.data()?.supplierOfferSelection),
  };
}

export async function configureSupplierProductOffer(
  db: Firestore,
  productIdValue: unknown,
  offerIdValue: unknown,
  value: unknown,
  actor: SupplierHubAdminIdentity,
): Promise<{ offer: SupplierProductOffer; selection: SupplierOfferSelection }> {
  const productId = cleanDocumentId(productIdValue, "Product ID");
  const offerId = cleanDocumentId(offerIdValue, "Supplier offer ID");
  const patch = asRecord(value);
  if (!Object.hasOwn(patch, "priority") && !Object.hasOwn(patch, "enabled")) {
    throw new ApiError("Supplier offer priority or enabled state is required.", 400);
  }
  if (Object.hasOwn(patch, "enabled") && typeof patch.enabled !== "boolean") {
    throw new ApiError("Supplier offer enabled state is invalid.", 400);
  }
  if (Object.hasOwn(patch, "priority") && (!Number.isInteger(Number(patch.priority)) || Number(patch.priority) < 0 || Number(patch.priority) > 10_000)) {
    throw new ApiError("Supplier offer priority is invalid.", 400);
  }

  return db.runTransaction(async (transaction) => {
    const offerReference = db.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).doc(offerId);
    const productReference = db.collection("products").doc(productId);
    const privateReference = db.collection(PRODUCT_PRIVATE_COLLECTION).doc(productId);
    const offerQuery = db.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).where("productId", "==", productId).limit(100);
    const [offerSnapshot, productSnapshot, privateSnapshot, offersSnapshot] = await Promise.all([
      transaction.get(offerReference),
      transaction.get(productReference),
      transaction.get(privateReference),
      transaction.get(offerQuery),
    ]);
    if (!offerSnapshot.exists || offerSnapshot.data()?.productId !== productId) throw new ApiError("Supplier offer was not found.", 404);
    const beforeOffer = projectSupplierOfferForAdmin({ id: offerSnapshot.id, ...offerSnapshot.data() });
    if (!beforeOffer) throw new ApiError("Supplier offer is invalid.", 409);
    const updatedOffer = projectSupplierOfferForAdmin({
      ...beforeOffer,
      ...(Object.hasOwn(patch, "priority") ? { priority: normalizeSupplierOfferPriority(patch.priority) } : {}),
      ...(Object.hasOwn(patch, "enabled") ? { enabled: patch.enabled } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (!updatedOffer) throw new ApiError("Supplier offer is invalid.", 409);
    const currentSelection = parseSupplierOfferSelection(privateSnapshot.data()?.supplierOfferSelection);
    const effectiveSelection = !updatedOffer.enabled && currentSelection.lockedOfferId === updatedOffer.id
      ? { ...currentSelection, lockedOfferId: null }
      : currentSelection;
    const allOffers = offersSnapshot.docs
      .map((document) => document.id === offerId
        ? updatedOffer
        : projectSupplierOfferForAdmin({ id: document.id, ...document.data() }))
      .filter((offer): offer is SupplierProductOffer => Boolean(offer && offer.reviewStatus === "approved"));
    const resolved = resolveActiveSupplierOffer(allOffers, effectiveSelection);
    const selection: SupplierOfferSelection = {
      ...effectiveSelection,
      activeOfferId: resolved?.id || null,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actor.uid,
    };
    const previousOffer = offersSnapshot.docs
      .map((document) => projectSupplierOfferForAdmin({ id: document.id, ...document.data() }))
      .find((offer) => offer?.id === currentSelection.activeOfferId) || null;
    const previousSupplierStock = asRecord(privateSnapshot.data()?.supplierMetadata).inventoryLevel
      ?? previousOffer?.stock
      ?? productSnapshot.data()?.stock;
    const publicProjection = productSnapshot.exists
      ? resolved
        ? buildSupplierOfferPublicProjection(resolved, productSnapshot.data(), previousSupplierStock)
        : buildSupplierRemovalPublicProjection(null, productSnapshot.data(), previousSupplierStock)
      : null;
    transaction.set(offerReference, {
      ...(Object.hasOwn(patch, "priority") ? { priority: updatedOffer.priority } : {}),
      ...(Object.hasOwn(patch, "enabled") ? { enabled: updatedOffer.enabled } : {}),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actor.uid,
    }, { merge: true });
    if (publicProjection) {
      transaction.set(productReference, {
        ...publicProjection,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    transaction.set(privateReference, {
      ...activeSupplierPrivateProjection(resolved, privateSnapshot.data()),
      supplierOfferSelection: selection,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    writeOfferAdministrationAudit(transaction, db, {
      action: "offer_configured",
      productId,
      offerId,
      actor,
      before: {
        priority: beforeOffer.priority,
        enabled: beforeOffer.enabled,
        selection: currentSelection,
        publicCommerce: productSnapshot.exists ? {
          price: productSnapshot.data()?.price,
          originalPrice: productSnapshot.data()?.originalPrice,
          discount: productSnapshot.data()?.discount,
          stock: productSnapshot.data()?.stock,
          availability: productSnapshot.data()?.availability,
        } : null,
      },
      after: { priority: updatedOffer.priority, enabled: updatedOffer.enabled, selection, publicCommerce: publicProjection },
    });
    return { offer: updatedOffer, selection };
  });
}

export async function selectSupplierProductOffer(
  db: Firestore,
  productIdValue: unknown,
  value: unknown,
  actor: SupplierHubAdminIdentity,
): Promise<{ selection: SupplierOfferSelection; activeOffer: SupplierProductOffer | null }> {
  const productId = cleanDocumentId(productIdValue, "Product ID");
  const requested = asRecord(value);
  const offerId = cleanDocumentId(requested.offerId, "Supplier offer ID");
  if (requested.locked !== undefined && typeof requested.locked !== "boolean") throw new ApiError("Supplier offer lock is invalid.", 400);
  if (requested.failoverEnabled !== undefined && typeof requested.failoverEnabled !== "boolean") throw new ApiError("Supplier failover setting is invalid.", 400);

  return db.runTransaction(async (transaction) => {
    const productReference = db.collection("products").doc(productId);
    const privateReference = db.collection(PRODUCT_PRIVATE_COLLECTION).doc(productId);
    const offerQuery = db.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).where("productId", "==", productId).limit(100);
    const [productSnapshot, privateSnapshot, offersSnapshot] = await Promise.all([
      transaction.get(productReference),
      transaction.get(privateReference),
      transaction.get(offerQuery),
    ]);
    if (!productSnapshot.exists) throw new ApiError("The storefront product was not found.", 404);
    const offers = offersSnapshot.docs
      .map((document) => projectSupplierOfferForAdmin({ id: document.id, ...document.data() }))
      .filter((offer): offer is SupplierProductOffer => Boolean(offer));
    const requestedOffer = offers.find((offer) => offer.id === offerId);
    if (!requestedOffer || !requestedOffer.enabled || requestedOffer.reviewStatus !== "approved") {
      throw new ApiError("An approved and enabled supplier offer is required.", 409);
    }
    const previous = parseSupplierOfferSelection(privateSnapshot.data()?.supplierOfferSelection);
    const previousOffer = offers.find((offer) => offer.id === previous.activeOfferId);
    const previousSupplierStock = asRecord(privateSnapshot.data()?.supplierMetadata).inventoryLevel
      ?? previousOffer?.stock
      ?? productSnapshot.data()?.stock;
    const publicProjection = buildSupplierOfferPublicProjection(
      requestedOffer,
      productSnapshot.data(),
      previousSupplierStock,
    );
    const selection: SupplierOfferSelection = {
      activeOfferId: requestedOffer.id,
      lockedOfferId: requested.locked === true
        ? requestedOffer.id
        : requested.locked === false && previous.lockedOfferId === requestedOffer.id ? null : previous.lockedOfferId,
      failoverEnabled: typeof requested.failoverEnabled === "boolean" ? requested.failoverEnabled : previous.failoverEnabled,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actor.uid,
    };
    transaction.set(productReference, {
      ...publicProjection,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(privateReference, {
      ...activeSupplierPrivateProjection(requestedOffer, privateSnapshot.data()),
      supplierOfferSelection: selection,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    writeOfferAdministrationAudit(transaction, db, {
      action: "active_offer_selected",
      productId,
      offerId,
      actor,
      before: {
        selection: previous,
        publicCommerce: {
          price: productSnapshot.data()?.price,
          originalPrice: productSnapshot.data()?.originalPrice,
          discount: productSnapshot.data()?.discount,
          stock: productSnapshot.data()?.stock,
          availability: productSnapshot.data()?.availability,
        },
      },
      after: { selection, publicCommerce: publicProjection },
    });
    return { selection, activeOffer: requestedOffer };
  });
}
