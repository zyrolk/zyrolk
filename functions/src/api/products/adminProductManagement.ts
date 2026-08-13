import { createHash } from "node:crypto";
import { FieldValue, Firestore } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import {
  COMMERCIAL_PRODUCT_FIELDS,
  mergeProductData,
  PRODUCT_PRIVATE_COLLECTION,
  splitProductData,
} from "./productCommercialData";
import {
  assertZyroBarcodeAvailable,
  buildZyroProductId,
  reserveZyroSku,
} from "../suppliers/supplierProductIdentity";
import { parseSupplierProductFieldOwnership } from "../suppliers/supplierFieldOwnership";
import { resolveOrderPrivateAttributionLines } from "../orders/orderPrivateAttribution";

const ADMIN_PRODUCT_AUDIT_COLLECTION = "admin_product_audit";
const MAX_TEXT_LIST_ITEMS = 40;
const MAX_GALLERY_ITEMS = 20;
const MAX_SPECIFICATIONS = 100;
const MAX_STOCK = 10_000_000;

const MANUAL_PRODUCT_DRAFT_FIELDS = new Set([
  "id", "sku", "name", "description", "shortDescription", "price", "originalPrice",
  "imageUrl", "imageUrls", "category", "subcategory", "brand", "model", "barcode",
  "productType", "tags", "keyFeatures", "whatsIncluded", "stock", "specs", "isNew",
  "isFeatured", "isBestSeller", "isActive", "supplierId", "supplierItemCode", "costPrice",
  "marketPrice",
]);

const MANUAL_OWNERSHIP_FIELDS = [
  "name", "description", "shortDescription", "brand", "model", "barcode", "productType",
  "category", "subcategory", "tags", "keyFeatures", "whatsIncluded", "price", "originalPrice",
  "stock", "specs", "imageUrl", "imageUrls", "isActive", "isNew", "isFeatured",
  "isBestSeller", "costPrice", "marketPrice",
] as const;

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const cleanText = (value: unknown, label: string, maximum: number, required = false): string => {
  if (value === undefined || value === null) {
    if (required) throw new ApiError(`${label} is required.`, 400);
    return "";
  }
  if (typeof value !== "string") throw new ApiError(`${label} is invalid.`, 400);
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (required && !normalized) throw new ApiError(`${label} is required.`, 400);
  if (normalized.length > maximum) throw new ApiError(`${label} is too long.`, 400);
  return normalized;
};

const cleanDocumentId = (value: unknown, label: string, required = true): string => {
  const result = cleanText(value, label, 160, required);
  if (result && (result.includes("/") || result === "." || result === "..")) {
    throw new ApiError(`${label} is invalid.`, 400);
  }
  return result;
};

const cleanNumber = (
  value: unknown,
  label: string,
  options: { required?: boolean; minimum?: number; maximum?: number; integer?: boolean } = {},
): number | undefined => {
  if (value === undefined || value === null || value === "") {
    if (options.required) throw new ApiError(`${label} is required.`, 400);
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)
    || (options.integer && !Number.isInteger(parsed))
    || (options.minimum !== undefined && parsed < options.minimum)
    || (options.maximum !== undefined && parsed > options.maximum)) {
    throw new ApiError(`${label} is invalid.`, 400);
  }
  return parsed;
};

const cleanBoolean = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ApiError("Product status is invalid.", 400);
  return value;
};

const cleanUrl = (value: unknown, label: string, required = false): string => {
  const url = cleanText(value, label, 2_048, required);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("protocol");
    return parsed.toString();
  } catch {
    throw new ApiError(`${label} must use a valid http or https URL.`, 400);
  }
};

const cleanTextList = (value: unknown, label: string, maximumItems = MAX_TEXT_LIST_ITEMS): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximumItems) throw new ApiError(`${label} is invalid.`, 400);
  const values = value.map((entry) => cleanText(entry, label, 240)).filter(Boolean);
  return [...new Set(values)];
};

const cleanSpecifications = (value: unknown): Record<string, string> => {
  const source = record(value);
  if (Object.keys(source).length > MAX_SPECIFICATIONS) throw new ApiError("Product specifications are invalid.", 400);
  const entries = Object.entries(source).map(([key, rawValue]) => [
    cleanText(key, "Specification name", 100, true),
    cleanText(rawValue, "Specification value", 1_000),
  ] as const);
  return Object.fromEntries(entries.filter(([, entry]) => Boolean(entry)));
};

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value ?? null;
};

const digest = (value: unknown): string => createHash("sha256")
  .update(JSON.stringify(canonical(value)))
  .digest("hex");

const compact = (value: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
  Object.entries(value).filter(([, entry]) => entry !== undefined),
);

export interface AdminProductDraft {
  requestedId: string;
  requestedSku: string;
  name: string;
  description: string;
  shortDescription: string;
  price: number;
  originalPrice?: number;
  imageUrl: string;
  imageUrls: string[];
  category: string;
  subcategory: string;
  brand: string;
  model: string;
  barcode: string;
  productType: string;
  tags: string[];
  keyFeatures: string[];
  whatsIncluded: string[];
  stock: number;
  specs: Record<string, string>;
  isNew: boolean;
  isFeatured: boolean;
  isBestSeller: boolean;
  isActive: boolean;
  supplierId: string;
  supplierItemCode: string;
  costPrice?: number;
  marketPrice?: number;
}

export interface AdminProductActor {
  uid: string;
  email: string;
}

export interface AdminProductMutationResult {
  productId: string;
  sku: string;
  idempotent?: boolean;
  archived?: boolean;
}

export interface AdminProductIdentityDependencies {
  buildSkuCandidates?: (productId: string) => readonly string[];
}

const validateActor = (actor: AdminProductActor): AdminProductActor => ({
  uid: cleanText(actor.uid, "Admin identity", 160, true),
  email: cleanText(actor.email, "Admin email", 320) || "unknown",
});

export function parseAdminProductDraft(value: unknown): AdminProductDraft {
  const input = record(value);
  const unknownFields = Object.keys(input).filter((field) => !MANUAL_PRODUCT_DRAFT_FIELDS.has(field));
  if (unknownFields.length > 0) throw new ApiError(`Unsupported product field: ${unknownFields[0]}.`, 400);

  const price = cleanNumber(input.price, "Sale price", { required: true, minimum: 0.01, maximum: 1_000_000_000 })!;
  const originalPrice = cleanNumber(input.originalPrice, "Regular price", { minimum: 0.01, maximum: 1_000_000_000 });
  if (originalPrice !== undefined && originalPrice < price) {
    throw new ApiError("Regular price cannot be lower than the sale price.", 400);
  }
  const barcode = cleanText(input.barcode, "Barcode", 32);
  if (barcode && !/^\d{8,14}$/u.test(barcode)) throw new ApiError("Barcode must contain 8 to 14 digits.", 400);

  return {
    requestedId: cleanText(input.id, "Product ID", 180),
    requestedSku: cleanText(input.sku, "Product SKU", 40),
    name: cleanText(input.name, "Product name", 200, true),
    description: cleanText(input.description, "Product description", 20_000),
    shortDescription: cleanText(input.shortDescription, "Short description", 500),
    price,
    ...(originalPrice !== undefined ? { originalPrice } : {}),
    imageUrl: cleanUrl(input.imageUrl, "Primary product image", true),
    imageUrls: cleanTextList(input.imageUrls, "Product gallery", MAX_GALLERY_ITEMS)
      .map((entry) => cleanUrl(entry, "Gallery image")),
    category: cleanDocumentId(input.category, "Product category"),
    subcategory: cleanDocumentId(input.subcategory, "Product subcategory", false),
    brand: cleanDocumentId(input.brand, "Product brand"),
    model: cleanText(input.model, "Product model", 200),
    barcode,
    productType: cleanText(input.productType, "Product type", 200),
    tags: cleanTextList(input.tags, "Product tags"),
    keyFeatures: cleanTextList(input.keyFeatures, "Key features"),
    whatsIncluded: cleanTextList(input.whatsIncluded, "What's included"),
    stock: cleanNumber(input.stock, "Stock", { required: true, minimum: 0, maximum: MAX_STOCK, integer: true })!,
    specs: cleanSpecifications(input.specs),
    isNew: cleanBoolean(input.isNew, false),
    isFeatured: cleanBoolean(input.isFeatured, false),
    isBestSeller: cleanBoolean(input.isBestSeller, false),
    isActive: cleanBoolean(input.isActive, true),
    supplierId: cleanDocumentId(input.supplierId, "Supplier ID", false),
    supplierItemCode: cleanText(input.supplierItemCode, "Supplier item code", 300),
    ...(cleanNumber(input.costPrice, "Cost price", { minimum: 0, maximum: 1_000_000_000 }) !== undefined
      ? { costPrice: cleanNumber(input.costPrice, "Cost price", { minimum: 0, maximum: 1_000_000_000 }) }
      : {}),
    ...(cleanNumber(input.marketPrice, "Market price", { minimum: 0, maximum: 1_000_000_000 }) !== undefined
      ? { marketPrice: cleanNumber(input.marketPrice, "Market price", { minimum: 0, maximum: 1_000_000_000 }) }
      : {}),
  };
}

const validateCatalogRelationships = (
  draft: AdminProductDraft,
  categorySnapshot: FirebaseFirestore.DocumentSnapshot,
  brandSnapshot: FirebaseFirestore.DocumentSnapshot,
): void => {
  if (!categorySnapshot.exists) throw new ApiError("Select an existing product category.", 422);
  if (!brandSnapshot.exists) throw new ApiError("Select an existing product brand.", 422);
  const category = categorySnapshot.data() || {};
  const brand = brandSnapshot.data() || {};
  if (draft.isActive && category.isActive === false) throw new ApiError("Published products must use an active category.", 422);
  if (draft.isActive && brand.isActive === false) throw new ApiError("Published products must use an active brand.", 422);

  const subcategories = Array.isArray(category.subcategories)
    ? category.subcategories.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    : [];
  const activeSubcategories = subcategories.filter((entry) => entry.isActive !== false);
  const selectedSubcategory = subcategories.find((entry) => String(entry.id || "") === draft.subcategory);
  if (activeSubcategories.length > 0 && !draft.subcategory) {
    throw new ApiError("Select a sub category for the selected category.", 422);
  }
  if (draft.subcategory && !selectedSubcategory) {
    throw new ApiError("Selected sub category does not belong to the selected category.", 422);
  }
  if (draft.isActive && selectedSubcategory?.isActive === false) {
    throw new ApiError("Published products must use an active sub category.", 422);
  }

  const specificationTemplate = Array.isArray(category.specificationTemplate)
    ? category.specificationTemplate.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    : [];
  for (const field of specificationTemplate) {
    const name = typeof field.name === "string" ? field.name.trim() : "";
    if (field.required === true && name && !draft.specs[name]?.trim()) {
      throw new ApiError(`Required specification "${name}" must have a value.`, 422);
    }
  }
};

const productProjection = (
  productId: string,
  sku: string,
  draft: AdminProductDraft,
  registeredBrandName: string,
  now: string,
  existingPublic?: Record<string, unknown>,
  routing: { fulfilmentMode: "internal" | "supplier"; supplierId?: string; supplierItemCode?: string } = { fulfilmentMode: "internal" },
): { publicData: Record<string, unknown>; commercialData: Record<string, unknown> } => {
  const discount = draft.originalPrice && draft.originalPrice > draft.price
    ? Math.round(((draft.originalPrice - draft.price) / draft.originalPrice) * 100)
    : undefined;
  const combined = compact({
    id: productId,
    name: draft.name,
    description: draft.description,
    shortDescription: draft.shortDescription || undefined,
    price: draft.price,
    originalPrice: draft.originalPrice,
    discount,
    imageUrl: draft.imageUrl,
    imageUrls: draft.imageUrls,
    category: draft.category,
    subcategory: draft.subcategory || undefined,
    brand: draft.brand,
    model: draft.model || undefined,
    barcode: draft.barcode || undefined,
    productType: draft.productType || undefined,
    tags: draft.tags,
    keyFeatures: draft.keyFeatures,
    whatsIncluded: draft.whatsIncluded,
    stock: draft.stock,
    specs: {
      ...draft.specs,
      ...(registeredBrandName ? { Brand: registeredBrandName } : {}),
      ...(draft.model ? { Model: draft.model } : {}),
    },
    isNew: draft.isNew,
    isFeatured: draft.isFeatured,
    isBestSeller: draft.isBestSeller,
    isActive: draft.isActive,
    rating: Number(existingPublic?.rating) || 0,
    reviewsCount: Number(existingPublic?.reviewsCount) || 0,
    createdAt: typeof existingPublic?.createdAt === "string" ? existingPublic.createdAt : now,
    updatedAt: now,
    sku,
    fulfilmentMode: routing.fulfilmentMode,
    supplierId: routing.fulfilmentMode === "supplier" ? routing.supplierId : undefined,
    supplierItemCode: routing.fulfilmentMode === "supplier" ? routing.supplierItemCode : undefined,
    costPrice: draft.costPrice,
    marketPrice: draft.marketPrice,
  });
  return splitProductData(combined);
};

const changedOwnership = (
  currentProduct: Record<string, unknown> | undefined,
  nextProduct: Record<string, unknown>,
  currentOwnership: unknown,
  actor: AdminProductActor,
  now: string,
): Record<string, unknown> => {
  const ownership: Record<string, unknown> = { ...parseSupplierProductFieldOwnership(currentOwnership) };
  for (const field of MANUAL_OWNERSHIP_FIELDS) {
    if (!currentProduct || JSON.stringify(canonical(currentProduct[field])) !== JSON.stringify(canonical(nextProduct[field]))) {
      ownership[field] = {
        owner: "admin",
        sourceId: null,
        updatedAt: now,
        updatedBy: actor.uid.slice(0, 160),
        reason: "admin_product_edit",
      };
    }
  }
  return ownership;
};

const publicUpdate = (
  data: Record<string, unknown>,
  updating: boolean,
): Record<string, unknown> => {
  if (!updating) return data;
  const optionalFields = ["shortDescription", "originalPrice", "discount", "subcategory", "model", "barcode", "productType"];
  return {
    ...data,
    ...Object.fromEntries(optionalFields
      .filter((field) => !Object.hasOwn(data, field))
      .map((field) => [field, FieldValue.delete()])),
  };
};

const privateUpdate = (
  data: Record<string, unknown>,
  draft: AdminProductDraft,
  fulfilmentMode: "internal" | "supplier",
): Record<string, unknown> => ({
  ...data,
  ...(draft.isActive ? {
    archivedAt: FieldValue.delete(),
    archivedBy: FieldValue.delete(),
  } : {}),
  ...(fulfilmentMode === "internal" ? { supplierId: FieldValue.delete() } : {}),
  ...(fulfilmentMode === "internal" ? {
    supplierItemCode: FieldValue.delete(),
    supplierItemCodeNormalized: FieldValue.delete(),
  } : {}),
  ...(draft.costPrice === undefined ? { costPrice: FieldValue.delete() } : {}),
  ...(draft.marketPrice === undefined ? { marketPrice: FieldValue.delete() } : {}),
});

const validateIdempotencyKey = (value: unknown): string => {
  const key = cleanText(value, "Idempotency key", 160, true);
  if (!/^[A-Za-z0-9._:-]{16,160}$/u.test(key)) throw new ApiError("Idempotency key is invalid.", 400);
  return key;
};

export async function createAdminProduct(
  db: Firestore,
  actor: AdminProductActor,
  idempotencyKeyValue: unknown,
  draftValue: unknown,
  identityDependencies: AdminProductIdentityDependencies = {},
): Promise<AdminProductMutationResult> {
  const validatedActor = validateActor(actor);
  const idempotencyKey = validateIdempotencyKey(idempotencyKeyValue);
  const draft = parseAdminProductDraft(draftValue);
  if (draft.requestedId) throw new ApiError("Product ID is assigned by the server during product creation.", 400);
  if (draft.requestedSku) throw new ApiError("Zyro SKU is assigned by the server during product creation.", 400);
  if (draft.supplierId || draft.supplierItemCode) {
    throw new ApiError("Manual products are internal. Supplier routing must be established through an approved supplier offer.", 422);
  }
  const requestIdentity = `${validatedActor.uid}|${idempotencyKey}`;
  const productId = buildZyroProductId({ manualRequestId: requestIdentity });
  const requestHash = digest(requestIdentity);
  const payloadHash = digest(draft);
  const now = new Date().toISOString();

  return db.runTransaction(async (transaction) => {
    const productReference = db.collection("products").doc(productId);
    const privateReference = db.collection(PRODUCT_PRIVATE_COLLECTION).doc(productId);
    const [productSnapshot, privateSnapshot] = await Promise.all([
      transaction.get(productReference),
      transaction.get(privateReference),
    ]);
    const existingPrivate = privateSnapshot.data() || {};
    const manualCreation = record(existingPrivate.manualCreation);
    if (productSnapshot.exists || privateSnapshot.exists) {
      if (
        productSnapshot.exists
        && manualCreation.requestHash === requestHash
        && manualCreation.payloadHash === payloadHash
        && typeof existingPrivate.sku === "string"
      ) {
        return { productId, sku: existingPrivate.sku, idempotent: true };
      }
      if (manualCreation.requestHash === requestHash) {
        throw new ApiError("The idempotency key was already used with different product data.", 409);
      }
      throw new ApiError("The generated product identity is already owned by another product.", 409);
    }

    const categoryReference = db.collection("categories").doc(draft.category);
    const brandReference = db.collection("brands").doc(draft.brand);
    const [categorySnapshot, brandSnapshot] = await Promise.all([
      transaction.get(categoryReference),
      transaction.get(brandReference),
    ]);
    validateCatalogRelationships(draft, categorySnapshot, brandSnapshot);
    await assertZyroBarcodeAvailable(db, transaction, productId, draft.barcode);
    const brandName = cleanText(brandSnapshot.data()?.name, "Product brand", 200, true);
    const reservation = await reserveZyroSku(
      db,
      transaction,
      productId,
      identityDependencies.buildSkuCandidates?.(productId),
    );
    const projection = productProjection(productId, reservation.sku, draft, brandName, now);
    const fullProduct = mergeProductData(projection.publicData, projection.commercialData);
    const ownership = changedOwnership(undefined, fullProduct, undefined, validatedActor, now);

    transaction.create(productReference, projection.publicData);
    transaction.create(privateReference, {
      ...projection.commercialData,
      productId,
      sku: reservation.sku,
      zyroSkuClaimId: reservation.claimId,
      supplierFieldOwnership: ownership,
      manualCreation: { requestHash, payloadHash, createdBy: validatedActor.uid },
      updatedAt: now,
    });
    transaction.create(db.collection(ADMIN_PRODUCT_AUDIT_COLLECTION).doc(`create-${productId}`), {
      action: "create",
      productId,
      zyroSku: reservation.sku,
      actor: validatedActor,
      timestamp: now,
    });
    return { productId, sku: reservation.sku };
  });
}

export async function updateAdminProduct(
  db: Firestore,
  productIdValue: unknown,
  actor: AdminProductActor,
  draftValue: unknown,
  identityDependencies: AdminProductIdentityDependencies = {},
): Promise<AdminProductMutationResult> {
  const validatedActor = validateActor(actor);
  const productId = cleanDocumentId(productIdValue, "Product ID");
  const draft = parseAdminProductDraft(draftValue);
  if (draft.requestedId && draft.requestedId !== productId) throw new ApiError("Product ID is immutable.", 409);
  const now = new Date().toISOString();
  const auditReference = db.collection(ADMIN_PRODUCT_AUDIT_COLLECTION).doc();

  return db.runTransaction(async (transaction) => {
    const productReference = db.collection("products").doc(productId);
    const privateReference = db.collection(PRODUCT_PRIVATE_COLLECTION).doc(productId);
    const [productSnapshot, privateSnapshot] = await Promise.all([
      transaction.get(productReference),
      transaction.get(privateReference),
    ]);
    if (!productSnapshot.exists) throw new ApiError("Product not found.", 404);
    const existingPublic = productSnapshot.data() || {};
    const existingPrivate = privateSnapshot.data() || {};
    const existingSku = typeof existingPrivate.sku === "string" && existingPrivate.sku.trim()
      ? existingPrivate.sku.trim()
      : typeof existingPublic.sku === "string" ? existingPublic.sku.trim() : "";
    if (draft.requestedSku && existingSku && draft.requestedSku !== existingSku) {
      throw new ApiError("Zyro SKU is immutable after product creation.", 409);
    }
    const existingSupplierId = cleanDocumentId(existingPrivate.supplierId, "Supplier ID", false);
    const existingSupplierItemCode = cleanText(existingPrivate.supplierItemCode, "Supplier item code", 300);
    const selection = record(existingPrivate.supplierOfferSelection);
    const activeOfferId = typeof selection.activeOfferId === "string" ? selection.activeOfferId.trim() : "";
    const legacySupplierRouting = existingPrivate.fulfilmentMode !== "internal"
      && Boolean(activeOfferId && existingSupplierId && existingSupplierItemCode);
    const supplierBacked = existingPrivate.fulfilmentMode === "supplier" || legacySupplierRouting;
    if (supplierBacked && !existingSku) {
      throw new ApiError("Supplier-backed product identity is incomplete and must be repaired before publication.", 409);
    }
    if (!supplierBacked && (draft.supplierId || draft.supplierItemCode)) {
      throw new ApiError("Internal products cannot be converted by entering supplier fields. Attach an approved supplier offer instead.", 422);
    }
    if (supplierBacked && (
      (draft.supplierId && draft.supplierId !== existingSupplierId)
      || (draft.supplierItemCode && draft.supplierItemCode !== existingSupplierItemCode)
    )) {
      throw new ApiError("Supplier routing is managed by the approved supplier offer and cannot be edited here.", 409);
    }

    const categoryReference = db.collection("categories").doc(draft.category);
    const brandReference = db.collection("brands").doc(draft.brand);
    const [categorySnapshot, brandSnapshot] = await Promise.all([
      transaction.get(categoryReference),
      transaction.get(brandReference),
    ]);
    validateCatalogRelationships(draft, categorySnapshot, brandSnapshot);
    await assertZyroBarcodeAvailable(db, transaction, productId, draft.barcode);
    const brandName = cleanText(brandSnapshot.data()?.name, "Product brand", 200, true);
    const reservation = existingSku ? null : await reserveZyroSku(
      db,
      transaction,
      productId,
      identityDependencies.buildSkuCandidates?.(productId),
    );
    const sku = existingSku || reservation!.sku;
    const projection = productProjection(productId, sku, draft, brandName, now, existingPublic, supplierBacked ? {
      fulfilmentMode: "supplier",
      supplierId: existingSupplierId,
      supplierItemCode: existingSupplierItemCode,
    } : { fulfilmentMode: "internal" });
    if (draft.isActive && supplierBacked) {
      const routingLines = await resolveOrderPrivateAttributionLines(
        db as FirebaseFirestore.Firestore,
        transaction as FirebaseFirestore.Transaction,
        [{
          productId,
          publicProduct: projection.publicData,
          privateProduct: { ...existingPrivate, ...projection.commercialData },
        }],
        now,
      );
      if (routingLines[0]?.fulfilmentMode !== "supplier") {
        throw new ApiError("Published supplier products require a valid approved offer and active supplier account.", 422);
      }
    }
    const currentProduct = mergeProductData(existingPublic, existingPrivate);
    const nextProduct = mergeProductData(projection.publicData, projection.commercialData);
    const ownership = changedOwnership(currentProduct, nextProduct, existingPrivate.supplierFieldOwnership, validatedActor, now);
    const changedFields = MANUAL_OWNERSHIP_FIELDS.filter((field) => (
      JSON.stringify(canonical(currentProduct[field])) !== JSON.stringify(canonical(nextProduct[field]))
    ));

    transaction.set(productReference, {
      ...publicUpdate(projection.publicData, true),
      ...Object.fromEntries(COMMERCIAL_PRODUCT_FIELDS.map((field) => [field, FieldValue.delete()])),
      ...(draft.isActive ? {
        visible: FieldValue.delete(),
        archivedAt: FieldValue.delete(),
        archivedBy: FieldValue.delete(),
      } : {}),
    }, { merge: true });
    transaction.set(privateReference, privateUpdate({
      ...projection.commercialData,
      productId,
      sku,
      ...(reservation ? { zyroSkuClaimId: reservation.claimId } : {}),
      supplierFieldOwnership: ownership,
      updatedAt: now,
    }, draft, supplierBacked ? "supplier" : "internal"), { merge: true });
    transaction.create(auditReference, {
      action: "update",
      productId,
      zyroSku: sku,
      actor: validatedActor,
      changedFields,
      timestamp: now,
    });
    return { productId, sku };
  });
}

export async function archiveAdminProduct(
  db: Firestore,
  productIdValue: unknown,
  actor: AdminProductActor,
): Promise<AdminProductMutationResult> {
  const validatedActor = validateActor(actor);
  const productId = cleanDocumentId(productIdValue, "Product ID");
  const now = new Date().toISOString();
  return db.runTransaction(async (transaction) => {
    const productReference = db.collection("products").doc(productId);
    const privateReference = db.collection(PRODUCT_PRIVATE_COLLECTION).doc(productId);
    const [productSnapshot, privateSnapshot] = await Promise.all([
      transaction.get(productReference),
      transaction.get(privateReference),
    ]);
    if (!productSnapshot.exists) throw new ApiError("Product not found.", 404);
    const product = productSnapshot.data() || {};
    const privateProduct = privateSnapshot.data() || {};
    const sku = typeof privateProduct.sku === "string" ? privateProduct.sku : typeof product.sku === "string" ? product.sku : "";
    if (product.archivedAt) return { productId, sku, idempotent: true, archived: true };

    transaction.set(productReference, {
      isActive: false,
      visible: false,
      archivedAt: now,
      archivedBy: validatedActor.uid,
      updatedAt: now,
    }, { merge: true });
    transaction.set(privateReference, {
      productId,
      archivedAt: now,
      archivedBy: validatedActor.uid,
      updatedAt: now,
    }, { merge: true });
    transaction.create(db.collection(ADMIN_PRODUCT_AUDIT_COLLECTION).doc(), {
      action: "archive",
      productId,
      zyroSku: sku || null,
      actor: validatedActor,
      timestamp: now,
    });
    return { productId, sku, archived: true };
  });
}
