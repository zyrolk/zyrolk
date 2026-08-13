import { createHash } from "crypto";
import { CheckoutError } from "../checkout/checkoutLogic";
import {
  buildInitialFulfilmentGroups,
  OrderFulfilmentGroup,
} from "./orderFulfilmentGroups";
import { normalizeSupplierSourceConfig } from "../suppliers/supplierSourceCompatibility";
import { SUPPLIER_PORTAL_SOURCE_ID } from "../suppliers/supplierPortalLogic";
import {
  isSupplierOfferAvailableForCommerce,
  parseSupplierOfferSelection,
  projectSupplierOfferForAdmin,
  resolveActiveSupplierOffer,
} from "../suppliers/supplierOfferEngine";

export { ORDER_PRIVATE_COLLECTION } from "./orderFulfilmentGroups";
export const ORDER_PRIVATE_SCHEMA_VERSION = 2;

export type OrderLineFulfilmentMode = "supplier" | "internal";

export interface OrderPrivateAttributionLine {
  lineId: string;
  productId: string;
  zyroSku: string;
  fulfilmentMode: OrderLineFulfilmentMode;
  supplierOfferId: string | null;
  supplierOfferStateVersion: number | null;
  supplierSourceId: string | null;
  supplierId: string | null;
  supplierAccountId: string | null;
  supplierProductId: string | null;
  supplierItemCode: string | null;
  purchaseSupplierCost: number | null;
  approvedOfferPrice: number | null;
  approvedOfferStockEvidence: number | null;
  capturedAt: string;
}

export interface OrderPrivateDocument {
  orderId: string;
  schemaVersion: typeof ORDER_PRIVATE_SCHEMA_VERSION;
  createdAt: string;
  updatedAt: string;
  revision: number;
  lines: OrderPrivateAttributionLine[];
  fulfilmentGroups: OrderFulfilmentGroup[];
  assignedSupplierAccountIds: string[];
}

export interface CheckoutProductAttributionInput {
  productId: string;
  publicProduct: FirebaseFirestore.DocumentData;
  privateProduct: FirebaseFirestore.DocumentData | null;
}

const cleanText = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const uniqueReferences = (
  references: readonly FirebaseFirestore.DocumentReference[],
): FirebaseFirestore.DocumentReference[] => [...new Map(references.map((reference) => [reference.path, reference])).values()];

const readByPath = async (
  transaction: FirebaseFirestore.Transaction,
  references: readonly FirebaseFirestore.DocumentReference[],
): Promise<Map<string, FirebaseFirestore.DocumentSnapshot>> => {
  const unique = uniqueReferences(references);
  if (unique.length === 0) return new Map();
  const snapshots = await transaction.getAll(...unique);
  return new Map(snapshots.map((snapshot) => [snapshot.ref.path, snapshot]));
};

const buildLineId = (productId: string): string => (
  `line-${createHash("sha256").update(productId).digest("hex").slice(0, 32)}`
);

const hasSupplierCatalogueIdentity = (privateProduct: FirebaseFirestore.DocumentData): boolean => {
  if (privateProduct.fulfilmentMode === "internal") return false;
  if (privateProduct.fulfilmentMode === "supplier") return true;
  const selection = parseSupplierOfferSelection(privateProduct.supplierOfferSelection);
  const metadata = privateProduct.supplierMetadata && typeof privateProduct.supplierMetadata === "object"
    ? privateProduct.supplierMetadata as Record<string, unknown>
    : {};
  return Boolean(
    selection.activeOfferId
    || cleanText(privateProduct.supplierId)
    || cleanText(privateProduct.supplierSourceId)
    || cleanText(privateProduct.supplierItemCode)
    || cleanText(metadata.activeOfferId)
    || cleanText(metadata.supplierProductId),
  );
};

const requireZyroSku = (input: CheckoutProductAttributionInput): string => {
  const sku = cleanText(input.privateProduct?.sku) || cleanText(input.publicProduct.sku);
  if (!sku) {
    throw new CheckoutError(`Product "${input.productId}" is missing its Zyro SKU.`, 409);
  }
  return sku;
};

/**
 * Resolves immutable purchase evidence using exact document reads within the
 * caller's checkout transaction. It deliberately does not mutate selection or
 * perform failover: checkout may consume only the currently selected approved
 * offer committed by the existing offer engine.
 */
export async function resolveOrderPrivateAttributionLines(
  db: FirebaseFirestore.Firestore,
  transaction: FirebaseFirestore.Transaction,
  inputs: readonly CheckoutProductAttributionInput[],
  capturedAt: string,
): Promise<OrderPrivateAttributionLine[]> {
  const supplierInputs = inputs.map((input) => {
    const privateProduct = input.privateProduct || {};
    const selection = parseSupplierOfferSelection(privateProduct.supplierOfferSelection);
    const supplierBacked = hasSupplierCatalogueIdentity(privateProduct);
    if (supplierBacked && !selection.activeOfferId) {
      throw new CheckoutError(`Product "${input.productId}" does not have an active approved supplier offer.`, 409);
    }
    return { input, privateProduct, selection, supplierBacked };
  });

  const offerSnapshots = await readByPath(transaction, supplierInputs
    .filter((entry) => entry.supplierBacked)
    .map((entry) => db.collection("supplier_product_offers").doc(entry.selection.activeOfferId!)));

  const resolvedOffers = new Map<string, NonNullable<ReturnType<typeof projectSupplierOfferForAdmin>>>();
  for (const entry of supplierInputs.filter((candidate) => candidate.supplierBacked)) {
    const offerReference = db.collection("supplier_product_offers").doc(entry.selection.activeOfferId!);
    const offerSnapshot = offerSnapshots.get(offerReference.path);
    const offer = projectSupplierOfferForAdmin(offerSnapshot?.data());
    const resolved = offer ? resolveActiveSupplierOffer([offer], entry.selection) : null;
    if (!offerSnapshot?.exists
      || !offer
      || !resolved
      || resolved.id !== entry.selection.activeOfferId
      || offer.productId !== entry.input.productId
      || offer.reviewStatus !== "approved"
      || !isSupplierOfferAvailableForCommerce(offer)) {
      throw new CheckoutError(`Product "${entry.input.productId}" does not have an available approved supplier offer.`, 409);
    }
    resolvedOffers.set(entry.input.productId, offer);
  }

  const sourceSnapshots = await readByPath(transaction, [...resolvedOffers.values()]
    .filter((offer) => offer.sourceId !== SUPPLIER_PORTAL_SOURCE_ID)
    .map((offer) => db.collection("supplierSources").doc(offer.sourceId)));
  const resolvedAccountIds = new Map<string, string>();
  for (const [productId, offer] of resolvedOffers) {
    // Supplier Portal submissions already carry the authenticated account UID
    // as supplierId. A single virtual source cannot have one global account
    // mapping, so reuse that existing authoritative relationship only here.
    if (offer.sourceId === SUPPLIER_PORTAL_SOURCE_ID) {
      if (!offer.supplierId) throw new CheckoutError(`Product "${productId}" supplier routing is not configured.`, 409);
      resolvedAccountIds.set(productId, offer.supplierId);
      continue;
    }
    const sourceReference = db.collection("supplierSources").doc(offer.sourceId);
    const sourceSnapshot = sourceSnapshots.get(sourceReference.path);
    if (!sourceSnapshot?.exists) {
      throw new CheckoutError(`Product "${productId}" supplier source is unavailable.`, 409);
    }
    const source = normalizeSupplierSourceConfig(sourceSnapshot.id, sourceSnapshot.data()!);
    if (!source.enabled || source.supplierId !== offer.supplierId || !source.supplierAccountId) {
      throw new CheckoutError(`Product "${productId}" supplier routing is not configured.`, 409);
    }
    resolvedAccountIds.set(productId, source.supplierAccountId);
  }

  const accountIds = [...new Set(resolvedAccountIds.values())];
  const accountSnapshots = await readByPath(transaction, accountIds.flatMap((accountId) => [
    db.collection("users").doc(accountId),
    db.collection("supplier_profiles").doc(accountId),
  ]));
  for (const [productId, accountId] of resolvedAccountIds) {
    const user = accountSnapshots.get(db.collection("users").doc(accountId).path);
    const profile = accountSnapshots.get(db.collection("supplier_profiles").doc(accountId).path);
    if (!user?.exists
      || user.data()?.role !== "supplier"
      || !profile?.exists
      || cleanText(profile.data()?.profileStatus).toLowerCase() !== "active") {
      throw new CheckoutError(`Product "${productId}" supplier account is not active.`, 409);
    }
  }

  return supplierInputs.map(({ input, supplierBacked }) => {
    const common = {
      lineId: buildLineId(input.productId),
      productId: input.productId,
      zyroSku: requireZyroSku(input),
      capturedAt,
    };
    if (!supplierBacked) {
      return {
        ...common,
        fulfilmentMode: "internal" as const,
        supplierOfferId: null,
        supplierOfferStateVersion: null,
        supplierSourceId: null,
        supplierId: null,
        supplierAccountId: null,
        supplierProductId: null,
        supplierItemCode: null,
        purchaseSupplierCost: null,
        approvedOfferPrice: null,
        approvedOfferStockEvidence: null,
      };
    }
    const offer = resolvedOffers.get(input.productId)!;
    const supplierAccountId = resolvedAccountIds.get(input.productId)!;
    return {
      ...common,
      fulfilmentMode: "supplier" as const,
      supplierOfferId: offer.id,
      supplierOfferStateVersion: offer.stateVersion,
      supplierSourceId: offer.sourceId,
      supplierId: offer.supplierId,
      supplierAccountId,
      supplierProductId: offer.supplierProductId,
      supplierItemCode: offer.sku,
      purchaseSupplierCost: offer.cost,
      approvedOfferPrice: offer.price,
      approvedOfferStockEvidence: offer.stock,
    };
  });
}

export function buildOrderPrivateDocument(
  orderId: string,
  lines: readonly OrderPrivateAttributionLine[],
  capturedAt: string,
): OrderPrivateDocument {
  const immutableLines = [...lines];
  return {
    orderId,
    schemaVersion: ORDER_PRIVATE_SCHEMA_VERSION,
    createdAt: capturedAt,
    updatedAt: capturedAt,
    revision: 1,
    lines: immutableLines,
    fulfilmentGroups: buildInitialFulfilmentGroups(immutableLines, capturedAt),
    assignedSupplierAccountIds: [],
  };
}
