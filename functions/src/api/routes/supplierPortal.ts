import { createHash } from "crypto";
import * as express from "express";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { ApiError, sendApiError } from "../errors";
import { requireSupplierHubAdmin } from "../middleware/supplierHubAdminAuth";
import {
  assignOrderFulfilmentGroup,
  correctOrderFulfilmentTracking,
  ORDER_PRIVATE_COLLECTION,
  parseOrderPrivateFulfilment,
  recordOrderFulfilmentTracking,
  supplierGroupForAccount,
  transitionOrderFulfilmentGroup,
} from "../orders/orderFulfilmentGroups";
import { PRODUCT_PRIVATE_COLLECTION, sanitizePublicProductData } from "../products/productCommercialData";
import { createSupplierAuditEvent } from "../suppliers/supplierAuditTrail";
import { buildSupplierProductApprovalBaseline } from "../suppliers/supplierApprovalConcurrency";
import { RawA2ZProduct } from "../suppliers/a2z/types";
import {
  buildSupplierOfferObservationWrite,
  buildSupplierOfferPendingObservation,
  buildSupplierProductOffer,
  parseSupplierOfferSelection,
  projectSupplierOfferForAdmin,
  supplierOfferStateExpectation,
  SUPPLIER_PRODUCT_OFFERS_COLLECTION,
} from "../suppliers/supplierOfferEngine";
import { buildSupplierLifecycleFieldChange, buildSupplierProductComparison } from "../suppliers/supplierProductImport";
import { extractSupplierMediaFromRecord } from "../suppliers/supplierMediaPipeline";
import { resolveSupplierPortalSkuClaim } from "../suppliers/supplierPortalSkuClaims";
import { buildSupplierQueueLifecycle } from "../../scheduled/supplierReviewQueue";
import {
  assertNoUnresolvedSupplierStockProposal,
  calculateSupplierSummary,
  normalizeProductFingerprint,
  normalizeSupplierSku,
  sanitizeSupplierProductDraft,
  sanitizeSupplierProfile,
  SUPPLIER_PORTAL_SOURCE_ID,
  supplierAccountManagesProduct,
  SupplierSourceAccountMapping,
  supplierOwnsOrder,
  validateSupplierProductForSubmission,
} from "../suppliers/supplierPortalLogic";

interface SupplierPortalDependencies {
  db: FirebaseFirestore.Firestore;
  auth: { verifyIdToken(token: string, checkRevoked?: boolean): Promise<{ uid: string; email?: string }> };
}

interface SupplierIdentity {
  uid: string;
  email: string;
  profileStatus: string;
}

const readBearerToken = (req: express.Request): string => {
  const match = (req.header("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError("Authentication required", 401);
  return match[1];
};

const toIso = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
    return ((value as { toDate(): Date }).toDate()).toISOString();
  }
  return "";
};

const cleanId = (value: unknown, label: string): string => {
  const result = typeof value === "string" ? value.trim().slice(0, 160) : "";
  if (!result || result.includes("/")) throw new ApiError(`A valid ${label} is required`, 400);
  return result;
};

const assertTrackingBody = (body: unknown): Record<string, unknown> => {
  const value = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const allowed = new Set(["courierName", "trackingNumber", "expectedGroupRevision", "expectedOrderPrivateRevision"]);
  const unsupported = Object.keys(value).find((key) => !allowed.has(key));
  if (unsupported) throw new ApiError(`Unsupported tracking field: ${unsupported}`, 400);
  return value;
};

const readPageSize = (value: unknown): number => {
  const requested = Number(value);
  return Number.isInteger(requested) ? Math.min(100, Math.max(10, requested)) : 100;
};

const readCursor = (value: unknown): string => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : "";

const applyDocumentCursor = <T extends FirebaseFirestore.Query>(query: T, cursor: string): T => (
  cursor ? query.startAfter(cursor) as T : query
);

const chunksOf = <T>(values: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
};

const sourceAccountMapping = (
  document: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot,
): SupplierSourceAccountMapping => ({
  id: document.id,
  supplierId: document.data()?.supplierId || document.id,
  supplierAccountId: document.data()?.supplierAccountId,
});

async function readSupplierProductSourceMapping(
  db: FirebaseFirestore.Firestore,
  product: Record<string, unknown>,
): Promise<SupplierSourceAccountMapping[]> {
  const sourceId = String(product.supplierSourceId || "").trim();
  if (!sourceId || sourceId === SUPPLIER_PORTAL_SOURCE_ID) return [];
  const source = await db.collection("supplierSources").doc(sourceId).get();
  return source.exists ? [sourceAccountMapping(source)] : [];
}

const hashId = (value: string): string => createHash("sha256").update(value).digest("hex");

const portalSupplierProductId = (supplierAccountId: string, supplierSku: string): string => (
  `${supplierAccountId}:${normalizeSupplierSku(supplierSku)}`
);

const portalRawProduct = (
  draft: ReturnType<typeof sanitizeSupplierProductDraft>,
  supplierAccountId: string,
): RawA2ZProduct => ({
  supplierProductId: portalSupplierProductId(supplierAccountId, draft.supplierSku),
  sku: draft.supplierSku,
  title: draft.name,
  longDescription: draft.description,
  shortDescription: draft.shortDescription,
  mediaGallery: [draft.imageUrl, ...draft.imageUrls.filter((url) => url !== draft.imageUrl)],
  wholesalePrice: draft.price,
  recommendedRetailPrice: draft.price,
  price: draft.price,
  costPrice: draft.price,
  inventoryLevel: draft.stock,
  availability: draft.stock > 0 ? "in_stock" : "out_of_stock",
  barcode: draft.barcode,
  brand: draft.brand,
  model: draft.model,
  categoryHierarchy: [draft.category, draft.subcategory].filter(Boolean),
  supplierCategory: draft.category,
  supplierSubcategory: draft.subcategory,
  productType: draft.productType,
  tags: draft.tags,
  specifications: draft.specs,
  features: draft.keyFeatures,
  providedFields: [
    "supplierProductId", "sku", "title", "longDescription", "shortDescription", "mediaGallery",
    "wholesalePrice", "recommendedRetailPrice", "price", "costPrice", "inventoryLevel",
    "availability", "barcode", "brand", "model", "categoryHierarchy", "supplierCategory",
    "supplierSubcategory", "productType", "tags", "specifications", "features",
  ],
});

const buildProductId = (supplierId: string, name: string, supplierSku: string): string => {
  const slug = `${name}-${supplierSku}`.normalize("NFKC").toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 90) || "supplier-product";
  return `${slug}-${hashId(supplierId).slice(0, 8)}`;
};

const projectProduct = (id: string, product: Record<string, unknown>, supplierItemCode = ""): Record<string, unknown> => ({
  id,
  name: String(product.name || ""),
  sku: String(product.sku || ""),
  supplierItemCode,
  brand: String(product.brand || ""),
  model: String(product.model || ""),
  barcode: String(product.barcode || ""),
  productType: String(product.productType || ""),
  category: String(product.category || ""),
  subcategory: String(product.subcategory || ""),
  description: String(product.description || ""),
  shortDescription: String(product.shortDescription || ""),
  price: Number(product.price || 0),
  stock: Number(product.stock || 0),
  lowStockLimit: Number(product.lowStockLimit || 5),
  imageUrl: String(product.imageUrl || ""),
  imageUrls: Array.isArray(product.imageUrls) ? product.imageUrls.filter((item) => typeof item === "string") : [],
  tags: Array.isArray(product.tags) ? product.tags.filter((item) => typeof item === "string") : [],
  keyFeatures: Array.isArray(product.keyFeatures) ? product.keyFeatures.filter((item) => typeof item === "string") : [],
  whatsIncluded: Array.isArray(product.whatsIncluded) ? product.whatsIncluded.filter((item) => typeof item === "string") : [],
  specs: product.specs && typeof product.specs === "object" ? product.specs : {},
  isActive: product.isActive !== false,
  updatedAt: toIso(product.updatedAt),
});

const projectRequestPayload = (request: Record<string, unknown>): Record<string, unknown> => {
  const payload = request.productPayload && typeof request.productPayload === "object"
    ? request.productPayload as Record<string, unknown>
    : {};
  return projectProduct(
    String(payload.id || request.productId || ""),
    payload,
    String(request.supplierSku || payload.supplierItemCode || ""),
  );
};

const projectRequest = (id: string, request: Record<string, unknown>): Record<string, unknown> => ({
  id,
  requestType: String(request.requestType || "new_product"),
  productId: String(request.productId || ""),
  productName: String(request.productName || request.productPayload && (request.productPayload as Record<string, unknown>).name || ""),
  supplierSku: String(request.supplierSku || ""),
  status: String(request.status || "draft"),
  rejectionReason: String(request.rejectionReason || ""),
  productPayload: projectRequestPayload(request),
  createdAt: toIso(request.createdAt),
  updatedAt: toIso(request.updatedAt),
  submittedAt: toIso(request.submittedAt),
  reviewedAt: toIso(request.reviewedAt),
});

const projectOrder = (
  id: string,
  order: Record<string, unknown>,
  supplierId: string,
  privateData?: FirebaseFirestore.DocumentData,
): Record<string, unknown> | null => {
  const sourceItems = Array.isArray(order.items) ? order.items as Array<Record<string, unknown>> : [];
  let groupId = "";
  let groupRevision = 0;
  let orderPrivateRevision = 0;
  let attributionAvailable = false;
  let groupStatus = String(order.supplierFulfilmentStatus || "pending");
  let tracking: Record<string, unknown> | null = null;
  let items = sourceItems;
  if (privateData) {
    const privateOrder = parseOrderPrivateFulfilment(id, privateData);
    const group = supplierGroupForAccount(privateOrder, supplierId);
    if (!group) return null;
    const productIds = new Set(privateOrder.lines
      .filter((line) => group.lineIds.includes(line.lineId))
      .map((line) => line.productId));
    items = sourceItems.filter((item) => productIds.has(String(item.productId || "")));
    groupId = group.groupId;
    groupRevision = group.revision;
    orderPrivateRevision = privateOrder.revision;
    groupStatus = group.status;
    attributionAvailable = true;
    tracking = group.tracking ? {
      courierName: group.tracking.courierName,
      trackingNumber: group.tracking.trackingNumber,
      trackingUrl: group.tracking.trackingUrl,
      recordedAt: group.tracking.recordedAt,
      revision: group.tracking.revision,
    } : null;
  } else {
    const explicitlyAssignedItems = sourceItems.filter((item) => item.supplierId === supplierId);
    items = explicitlyAssignedItems.length > 0 ? explicitlyAssignedItems : sourceItems;
  }
  const projectedItems = items.map((item) => ({
    productId: String(item.productId || ""),
    name: String(item.name || ""),
    price: Number(item.price || 0),
    quantity: Number(item.quantity || 0),
    imageUrl: String(item.imageUrl || ""),
  }));
  return {
    id,
    orderNumber: String(order.orderNumber || id),
    customerName: String(order.customerName || ""),
    customerPhone: String(order.customerPhone || ""),
    customerAddress: String(order.customerAddress || ""),
    district: String(order.district || ""),
    city: String(order.city || ""),
    items: projectedItems,
    supplierTotal: projectedItems.reduce((total, item) => total + item.price * item.quantity, 0),
    status: String(order.status || "pending"),
    supplierFulfilmentStatus: groupStatus,
    groupId,
    groupRevision,
    orderPrivateRevision,
    attributionAvailable,
    tracking,
    paymentMethod: String(order.paymentMethod || ""),
    paymentStatus: String(order.paymentStatus || ""),
    createdAt: toIso(order.createdAt),
    supplierFulfilmentUpdatedAt: toIso(order.supplierFulfilmentUpdatedAt),
  };
};

const assertActive = (identity: SupplierIdentity): void => {
  if (identity.profileStatus !== "active") throw new ApiError("Supplier profile must be active before using this action", 403);
};

const assertProfileWritable = (identity: SupplierIdentity): void => {
  if (identity.profileStatus === "disabled") throw new ApiError("Supplier profile is disabled", 403);
};

export async function assignOrderToSupplier(
  db: FirebaseFirestore.Firestore,
  orderId: string,
  groupId: string,
  supplierId: string,
  expectedGroupRevision: unknown,
  expectedOrderPrivateRevision: unknown,
  adminUid = "system-admin",
) {
  return assignOrderFulfilmentGroup({
    db, orderId, groupId, supplierAccountId: supplierId,
    expectedGroupRevision, expectedOrderPrivateRevision, adminUid,
  });
}

export async function verifySupplierPortalIdentityToken(
  auth: SupplierPortalDependencies["auth"],
  token: string,
  checkRevoked = true,
): Promise<{ uid: string; email?: string }> {
  return auth.verifyIdToken(token, checkRevoked);
}

export async function transitionSupplierOrderFulfilment(
  db: FirebaseFirestore.Firestore,
  orderId: string,
  supplierId: string,
  groupId: string,
  nextStatus: unknown,
  expectedGroupRevision: unknown,
  expectedOrderPrivateRevision: unknown,
  reason?: unknown,
) {
  return transitionOrderFulfilmentGroup({
    db, orderId, supplierAccountId: supplierId, groupId, nextStatus,
    expectedGroupRevision, expectedOrderPrivateRevision, reason,
  });
}

export async function recordSupplierOrderTracking(
  db: FirebaseFirestore.Firestore,
  orderId: string,
  supplierId: string,
  groupId: string,
  courierName: unknown,
  trackingNumber: unknown,
  expectedGroupRevision: unknown,
  expectedOrderPrivateRevision: unknown,
) {
  return recordOrderFulfilmentTracking({
    db,
    orderId,
    groupId,
    supplierAccountId: supplierId,
    courierName,
    trackingNumber,
    expectedGroupRevision,
    expectedOrderPrivateRevision,
  });
}

export async function correctAdminOrderTracking(
  db: FirebaseFirestore.Firestore,
  orderId: string,
  groupId: string,
  adminUid: string,
  courierName: unknown,
  trackingNumber: unknown,
  expectedGroupRevision: unknown,
  expectedOrderPrivateRevision: unknown,
) {
  return correctOrderFulfilmentTracking({
    db,
    orderId,
    groupId,
    adminUid,
    courierName,
    trackingNumber,
    expectedGroupRevision,
    expectedOrderPrivateRevision,
  });
}

export function registerSupplierPortalRoutes(app: express.Express, dependencies: SupplierPortalDependencies): void {
  const authenticate = async (req: express.Request, res: express.Response): Promise<SupplierIdentity> => {
    const checkRevoked = res.locals.supplierHubLocalExpressPreview !== true;
    const decoded = await verifySupplierPortalIdentityToken(dependencies.auth, readBearerToken(req), checkRevoked);
    const [userSnapshot, profileSnapshot] = await Promise.all([
      dependencies.db.collection("users").doc(decoded.uid).get(),
      dependencies.db.collection("supplier_profiles").doc(decoded.uid).get(),
    ]);
    if (!userSnapshot.exists || userSnapshot.data()?.role !== "supplier") throw new ApiError("Supplier access required", 403);
    const profileStatus = profileSnapshot.exists
      ? String(profileSnapshot.data()?.profileStatus || "pending").toLocaleLowerCase()
      : "missing";
    return { uid: decoded.uid, email: String(decoded.email || userSnapshot.data()?.email || ""), profileStatus };
  };

  const route = (handler: (req: express.Request, res: express.Response, identity: SupplierIdentity) => Promise<void>): express.RequestHandler => (
    async (req, res) => {
      try {
        const identity = await authenticate(req, res);
        await handler(req, res, identity);
      } catch (error) {
        sendApiError(res, error, {
          logMessage: "Supplier Portal request failed.",
          fallbackMessage: "Supplier Portal is temporarily unavailable",
          context: { path: req.path, method: req.method },
        });
      }
    }
  );

  app.post("/api/supplier-portal/orders/:orderId/assign", requireSupplierHubAdmin, async (req, res) => {
    const orderId = typeof req.params.orderId === "string" ? req.params.orderId.trim() : "";
    const groupId = typeof req.body?.groupId === "string" ? req.body.groupId.trim() : "";
    const supplierId = typeof req.body?.supplierId === "string" ? req.body.supplierId.trim() : "";
    if (!orderId || orderId.includes("/") || !groupId || groupId.includes("/") || !supplierId || supplierId.includes("/")) {
      res.status(400).json({ error: "A valid order, fulfilment group and supplier are required" });
      return;
    }
    try {
      const result = await assignOrderToSupplier(
        dependencies.db,
        orderId,
        groupId,
        supplierId,
        req.body?.expectedGroupRevision,
        req.body?.expectedOrderPrivateRevision,
        String(res.locals.supplierAdmin?.uid || "unknown-admin"),
      );
      res.json({ success: true, supplierId, ...result });
    } catch (error) {
      sendApiError(res, error, {
        logMessage: "Admin supplier order assignment failed.",
        fallbackMessage: "Order could not be assigned to the supplier",
        context: { orderId, supplierId },
      });
    }
  });

  app.get("/api/supplier-portal/orders/:orderId/fulfilment-groups", requireSupplierHubAdmin, async (req, res) => {
    const orderId = typeof req.params.orderId === "string" ? req.params.orderId.trim() : "";
    if (!orderId || orderId.includes("/")) {
      res.status(400).json({ error: "A valid order is required" });
      return;
    }
    try {
      const [orderSnapshot, privateSnapshot] = await dependencies.db.getAll(
        dependencies.db.collection("orders").doc(orderId),
        dependencies.db.collection(ORDER_PRIVATE_COLLECTION).doc(orderId),
      );
      if (!orderSnapshot.exists) throw new ApiError("Order not found", 404);
      if (!privateSnapshot.exists || !Array.isArray(privateSnapshot.data()?.fulfilmentGroups)) {
        res.json({
          success: true,
          orderId,
          attributionAvailable: false,
          message: "Fulfilment attribution unavailable for this legacy order",
          orderPrivateRevision: null,
          groups: [],
        });
        return;
      }
      const privateOrder = parseOrderPrivateFulfilment(orderId, privateSnapshot.data());
      const profileSnapshots = privateOrder.fulfilmentGroups.length
        ? await dependencies.db.getAll(...privateOrder.fulfilmentGroups.map((group) => (
          dependencies.db.collection("supplier_profiles").doc(group.supplierAccountId)
        )))
        : [];
      const profileById = new Map(profileSnapshots.map((snapshot) => [snapshot.id, snapshot.data() || {}]));
      res.json({
        success: true,
        orderId,
        attributionAvailable: true,
        orderPrivateRevision: privateOrder.revision,
        groups: privateOrder.fulfilmentGroups.map((group) => ({
          groupId: group.groupId,
          lineIds: group.lineIds,
          supplierAccountId: group.supplierAccountId,
          supplierSourceIds: group.supplierSourceIds,
          supplierName: String(profileById.get(group.supplierAccountId)?.companyName || group.supplierAccountId),
          status: group.status,
          revision: group.revision,
          assignedAt: group.assignedAt,
          acceptedAt: group.acceptedAt,
          processingAt: group.processingAt,
          packedAt: group.packedAt,
          shippedAt: group.shippedAt,
          deliveredAt: group.deliveredAt,
          tracking: group.tracking,
          declineReason: group.declineReason,
        })),
      });
    } catch (error) {
      sendApiError(res, error, {
        logMessage: "Admin fulfilment-group retrieval failed.",
        fallbackMessage: "Fulfilment groups could not be loaded",
        context: { orderId },
      });
    }
  });

  app.get("/api/supplier-portal", route(async (req, res, identity) => {
    const pageSize = readPageSize(req.query.pageSize);
    const productCursor = readCursor(req.query.productsCursor);
    const requestCursor = readCursor(req.query.requestsCursor);
    const orderCursor = readCursor(req.query.ordersCursor);
    const notificationCursor = readCursor(req.query.notificationsCursor);
    const mappedSourceSnapshot = await dependencies.db.collection("supplierSources")
      .where("supplierAccountId", "==", identity.uid)
      .get();
    const mappedSources = mappedSourceSnapshot.docs.map(sourceAccountMapping);
    const mappedSourceIds = mappedSources.map((source) => source.id);
    const commercialProductQueries = [
      applyDocumentCursor(dependencies.db.collection(PRODUCT_PRIVATE_COLLECTION).where("supplierId", "==", identity.uid).orderBy(FieldPath.documentId()).limit(pageSize), productCursor).get(),
      ...chunksOf(mappedSourceIds, 30).map((sourceIds) => (
        applyDocumentCursor(dependencies.db.collection(PRODUCT_PRIVATE_COLLECTION).where("supplierSourceId", "in", sourceIds).orderBy(FieldPath.documentId()).limit(pageSize), productCursor).get()
      )),
    ];
    const [profileSnapshot, commercialProductSnapshots, legacyProductSnapshot, requestSnapshot, privateOrders, directOrders, sharedOrders, notificationSnapshot, categorySnapshot, brandSnapshot] = await Promise.all([
      dependencies.db.collection("supplier_profiles").doc(identity.uid).get(),
      Promise.all(commercialProductQueries),
      applyDocumentCursor(dependencies.db.collection("products").where("supplierId", "==", identity.uid).orderBy(FieldPath.documentId()).limit(pageSize), productCursor).get(),
      applyDocumentCursor(dependencies.db.collection("supplier_product_requests").where("supplierId", "==", identity.uid).orderBy(FieldPath.documentId()).limit(pageSize), requestCursor).get(),
      applyDocumentCursor(dependencies.db.collection(ORDER_PRIVATE_COLLECTION).where("assignedSupplierAccountIds", "array-contains", identity.uid).orderBy(FieldPath.documentId()).limit(pageSize), orderCursor).get(),
      applyDocumentCursor(dependencies.db.collection("orders").where("supplierId", "==", identity.uid).orderBy(FieldPath.documentId()).limit(pageSize), orderCursor).get(),
      applyDocumentCursor(dependencies.db.collection("orders").where("supplierIds", "array-contains", identity.uid).orderBy(FieldPath.documentId()).limit(pageSize), orderCursor).get(),
      applyDocumentCursor(dependencies.db.collection("supplier_notifications").where("supplierId", "==", identity.uid).orderBy(FieldPath.documentId()).limit(pageSize), notificationCursor).get(),
      dependencies.db.collection("categories").get(),
      dependencies.db.collection("brands").get(),
    ]);
    const commercialCandidates = new Map(commercialProductSnapshots
      .flatMap((snapshot) => snapshot.docs)
      .map((document) => [document.id, document] as const));
    const ownedCommercialDocuments = [...commercialCandidates.values()]
      .filter((document) => supplierAccountManagesProduct(document.data(), identity.uid, mappedSources))
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, pageSize);
    const commercialById = new Map(ownedCommercialDocuments.map((document) => [document.id, document.data()]));
    const legacyProducts = legacyProductSnapshot.docs.filter((document) => supplierAccountManagesProduct(
      { ...document.data(), ...(commercialCandidates.get(document.id)?.data() || {}) },
      identity.uid,
      mappedSources,
    ));
    const productIds = new Set([
      ...commercialById.keys(),
      ...legacyProducts.map((document) => document.id),
    ]);
    const productDocuments = productIds.size > 0
      ? await dependencies.db.getAll(...[...productIds].map((productId) => dependencies.db.collection("products").doc(productId)))
      : [];
    const products = productDocuments.filter((document) => document.exists).map((document) => projectProduct(
      document.id,
      document.data() || {},
      String(commercialById.get(document.id)?.supplierItemCode || document.data()?.supplierItemCode || ""),
    ));
    const requests = requestSnapshot.docs.map((document) => projectRequest(document.id, document.data()))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    const privateByOrderId = new Map(privateOrders.docs.map((document) => [document.id, document.data()]));
    const routedOrderDocuments = privateOrders.size
      ? await dependencies.db.getAll(...privateOrders.docs.map((document) => dependencies.db.collection("orders").doc(document.id)))
      : [];
    const orderDocuments = new Map([...directOrders.docs, ...sharedOrders.docs, ...routedOrderDocuments]
      .filter((document) => document.exists)
      .map((document) => [document.id, document]));
    const orders = [...orderDocuments.values()]
      .filter((document) => privateByOrderId.has(document.id) || supplierOwnsOrder(document.data() || {}, identity.uid))
      .map((document) => projectOrder(document.id, document.data() || {}, identity.uid, privateByOrderId.get(document.id)))
      .filter((order): order is Record<string, unknown> => Boolean(order))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    const storedNotifications = notificationSnapshot.docs.map((document) => ({
      id: document.id,
      type: String(document.data().type || "update"),
      title: String(document.data().title || "Supplier update"),
      message: String(document.data().message || ""),
      orderId: String(document.data().orderId || ""),
      isRead: document.data().isRead === true,
      createdAt: toIso(document.data().createdAt),
    }));
    const notifiedOrderIds = new Set(storedNotifications.map((notification) => notification.orderId).filter(Boolean));
    const derivedNotifications = [
      ...orders.filter((order) => !notifiedOrderIds.has(String(order.id))).map((order) => ({ id: `order-${order.id}`, type: "new_order", title: "Assigned order", message: `Order ${order.orderNumber} is assigned to your account.`, isRead: false, createdAt: order.createdAt })),
      ...products.filter((product) => Number(product.stock || 0) <= Number(product.lowStockLimit || 5))
        .map((product) => ({ id: `stock-${product.id}`, type: "low_stock", title: "Low stock", message: `${product.name} has ${product.stock} units remaining.`, isRead: false, createdAt: product.updatedAt })),
    ];
    const profileData = profileSnapshot.data() || {};
    res.json({
      success: true,
      profile: {
        supplierId: identity.uid,
        companyName: String(profileData.companyName || ""),
        contactPerson: String(profileData.contactPerson || ""),
        phone: String(profileData.phone || ""),
        email: identity.email,
        address: String(profileData.address || ""),
        bankDetails: profileData.bankDetails && typeof profileData.bankDetails === "object" ? profileData.bankDetails : {},
        businessRegistrationNumber: String(profileData.businessRegistrationNumber || ""),
        profileStatus: identity.profileStatus,
      },
      products,
      requests,
      orders,
      notifications: [...storedNotifications, ...derivedNotifications].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))),
      summary: calculateSupplierSummary(products, requests, orders),
      pagination: {
        pageSize,
        productsCursor: ownedCommercialDocuments.at(-1)?.id || legacyProductSnapshot.docs.at(-1)?.id || null,
        requestsCursor: requestSnapshot.docs.at(-1)?.id || null,
        ordersCursor: privateOrders.docs.at(-1)?.id || directOrders.docs.at(-1)?.id || sharedOrders.docs.at(-1)?.id || null,
        notificationsCursor: notificationSnapshot.docs.at(-1)?.id || null,
        hasMore: {
          products: commercialProductSnapshots.some((snapshot) => snapshot.size === pageSize) || legacyProductSnapshot.size === pageSize,
          requests: requestSnapshot.size === pageSize,
          orders: privateOrders.size === pageSize || directOrders.size === pageSize || sharedOrders.size === pageSize,
          notifications: notificationSnapshot.size === pageSize,
        },
      },
      catalog: {
        categories: categorySnapshot.docs.filter((document) => document.data().isActive !== false).map((document) => ({
          id: document.id,
          name: String(document.data().name || document.id),
          subcategories: Array.isArray(document.data().subcategories) ? document.data().subcategories : [],
          specificationTemplate: Array.isArray(document.data().specificationTemplate) ? document.data().specificationTemplate : [],
        })),
        brands: brandSnapshot.docs.filter((document) => document.data().isActive !== false).map((document) => ({ id: document.id, name: String(document.data().name || document.id) })),
      },
    });
  }));

  app.put("/api/supplier-portal/profile", route(async (req, res, identity) => {
    assertProfileWritable(identity);
    const profile = sanitizeSupplierProfile(req.body || {});
    const profileReference = dependencies.db.collection("supplier_profiles").doc(identity.uid);
    await dependencies.db.runTransaction(async (transaction) => {
      const current = await transaction.get(profileReference);
      transaction.set(profileReference, {
        supplierId: identity.uid,
        email: identity.email,
        ...profile,
        profileStatus: String(current.data()?.profileStatus || "pending"),
        createdAt: current.exists ? current.data()?.createdAt || FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    res.json({ success: true });
  }));

  app.post("/api/supplier-portal/requests", route(async (req, res, identity) => {
    assertActive(identity);
    const requestId = typeof req.body?.requestId === "string" && req.body.requestId.trim()
      ? cleanId(req.body.requestId, "request ID")
      : dependencies.db.collection("supplier_product_requests").doc().id;
    const requestType = req.body?.requestType === "product_change" ? "product_change" : "new_product";
    const productId = requestType === "product_change" ? cleanId(req.body?.productId, "product ID") : "";
    const draft = sanitizeSupplierProductDraft(req.body?.draft || {});
    const requestReference = dependencies.db.collection("supplier_product_requests").doc(requestId);
    let baseProduct: Record<string, unknown> = {};
    let baseCommercial: Record<string, unknown> = {};
    if (productId) {
      const [productSnapshot, commercialSnapshot] = await Promise.all([
        dependencies.db.collection("products").doc(productId).get(),
        dependencies.db.collection(PRODUCT_PRIVATE_COLLECTION).doc(productId).get(),
      ]);
      const productAttribution = { ...(productSnapshot.data() || {}), ...(commercialSnapshot.data() || {}) };
      const mappedSources = await readSupplierProductSourceMapping(dependencies.db, productAttribution);
      if (!productSnapshot.exists || !supplierAccountManagesProduct(productAttribution, identity.uid, mappedSources)) {
        throw new ApiError("Product is not owned by this supplier", 403);
      }
      baseProduct = sanitizePublicProductData(productSnapshot.data() || {});
      baseCommercial = commercialSnapshot.data() || {};
    }
    await dependencies.db.runTransaction(async (transaction) => {
      const current = await transaction.get(requestReference);
      if (current.exists && (current.data()?.supplierId !== identity.uid || current.data()?.status !== "draft")) {
        throw new ApiError("Only your own draft requests can be edited", 403);
      }
      const productDocumentId = productId || String(current.data()?.productId || buildProductId(identity.uid, draft.name, draft.supplierSku));
      const now = new Date().toISOString();
      const productPayload = {
        ...baseProduct,
        id: productDocumentId,
        name: draft.name,
        sku: productId ? String(baseProduct.sku || "") : `${hashId(identity.uid).slice(0, 6)}-${normalizeSupplierSku(draft.supplierSku)}`,
        supplierId: productId ? String(baseCommercial.supplierId || "") : identity.uid,
        supplierSourceId: productId ? String(baseCommercial.supplierSourceId || "") : SUPPLIER_PORTAL_SOURCE_ID,
        fulfilmentMode: "supplier",
        supplierItemCode: draft.supplierSku || String(baseCommercial.supplierItemCode || ""),
        brand: draft.brand,
        ...(draft.model ? { model: draft.model } : {}),
        ...(draft.barcode ? { barcode: draft.barcode } : {}),
        productType: draft.productType,
        category: draft.category,
        subcategory: draft.subcategory,
        description: draft.description,
        ...(draft.shortDescription ? { shortDescription: draft.shortDescription } : {}),
        price: draft.price,
        stock: draft.stock,
        imageUrl: draft.imageUrl,
        imageUrls: draft.imageUrls,
        tags: draft.tags,
        keyFeatures: draft.keyFeatures,
        whatsIncluded: draft.whatsIncluded,
        specs: { ...(baseProduct.specs && typeof baseProduct.specs === "object" ? baseProduct.specs : {}), ...draft.specs },
        rating: productId ? Number(baseProduct.rating || 0) : 0,
        reviewsCount: productId ? Number(baseProduct.reviewsCount || 0) : 0,
        isActive: productId ? baseProduct.isActive !== false : true,
        createdAt: String(baseProduct.createdAt || now),
        updatedAt: now,
      };
      transaction.set(requestReference, {
        supplierId: identity.uid,
        supplierEmail: identity.email,
        requestType,
        productId: productDocumentId,
        productName: draft.name,
        supplierSku: draft.supplierSku,
        supplierSkuNormalized: normalizeSupplierSku(draft.supplierSku),
        productFingerprint: normalizeProductFingerprint(draft),
        status: "draft",
        productPayload,
        createdAt: current.exists ? current.data()?.createdAt || FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    res.json({ success: true, requestId });
  }));

  app.post("/api/supplier-portal/requests/:requestId/submit", route(async (req, res, identity) => {
    assertActive(identity);
    const requestId = cleanId(req.params.requestId, "request ID");
    const requestReference = dependencies.db.collection("supplier_product_requests").doc(requestId);
    const requestSnapshot = await requestReference.get();
    if (!requestSnapshot.exists || requestSnapshot.data()?.supplierId !== identity.uid) throw new ApiError("Product request not found", 404);
    if (requestSnapshot.data()?.status !== "draft") throw new ApiError("Only draft product requests can be submitted", 409);
    const requestData = requestSnapshot.data() || {};
    const draft = sanitizeSupplierProductDraft({ ...(requestData.productPayload || {}), supplierSku: requestData.supplierSku });
    const [categorySnapshot, brandSnapshot, allProductsSnapshot, allCommercialProductsSnapshot] = await Promise.all([
      dependencies.db.collection("categories").doc(draft.category).get(),
      dependencies.db.collection("brands").doc(draft.brand).get(),
      dependencies.db.collection("products").limit(2_000).get(),
      dependencies.db.collection(PRODUCT_PRIVATE_COLLECTION).limit(2_000).get(),
    ]);
    const errors = validateSupplierProductForSubmission(draft, categorySnapshot.data(), brandSnapshot.data());
    const productId = String(requestData.productId || "");
    const queuedProductId = String((requestData.productPayload as { id?: unknown } | undefined)?.id || productId);
    const baselineProductDocument = productId ? allProductsSnapshot.docs.find((document) => document.id === productId) : undefined;
    const supplierSkuNormalized = normalizeSupplierSku(draft.supplierSku);
    const fingerprint = normalizeProductFingerprint(draft);
    const commercialByProductId = new Map(allCommercialProductsSnapshot.docs.map((document) => [document.id, document.data()]));
    const duplicateProduct = allProductsSnapshot.docs.find((document) => document.id !== productId && (
      normalizeSupplierSku(commercialByProductId.get(document.id)?.supplierItemCode || document.data().supplierItemCode) === supplierSkuNormalized
      || normalizeProductFingerprint(sanitizeSupplierProductDraft(document.data())) === fingerprint
    ));
    if (duplicateProduct) errors.push("A matching product or supplier SKU already exists in the live catalogue.");
    if (errors.length) throw new ApiError(errors[0], 400);
    const skuClaimId = hashId(`${identity.uid}|${supplierSkuNormalized}`);
    const productClaimId = requestData.requestType === "new_product" ? hashId(fingerprint) : "";
    const queueId = `portal-${requestId}`;
    const observedAt = new Date().toISOString();
    const rawProduct = portalRawProduct(draft, identity.uid);
    const currentProduct = baselineProductDocument
      ? { ...baselineProductDocument.data(), ...(commercialByProductId.get(baselineProductDocument.id) || {}) }
      : undefined;
    const currentCommercial = commercialByProductId.get(productId) || {};
    const isProductChange = requestData.requestType === "product_change";
    if (isProductChange) {
      const mappedSources = await readSupplierProductSourceMapping(dependencies.db, currentProduct || {});
      if (!currentProduct || !supplierAccountManagesProduct(currentProduct, identity.uid, mappedSources)) {
        throw new ApiError("Product is not owned by this supplier", 403);
      }
    }
    const comparison = buildSupplierProductComparison(rawProduct, currentProduct);
    const requestedImageUrls = [draft.imageUrl, ...draft.imageUrls.filter((url) => url !== draft.imageUrl)];
    const existingManagedMedia = isProductChange
      ? extractSupplierMediaFromRecord(currentCommercial.supplierMedia)
      : [];
    const reusableManagedMedia = existingManagedMedia.length === requestedImageUrls.length
      && requestedImageUrls.every((url, index) => (
        url === existingManagedMedia[index]?.firebaseStorageUrl
        || url === existingManagedMedia[index]?.originalSupplierUrl
      ))
      ? existingManagedMedia
      : [];
    const newProductOfferCandidate = buildSupplierProductOffer({
      sourceId: SUPPLIER_PORTAL_SOURCE_ID,
      supplierId: identity.uid,
      supplierProductId: rawProduct.supplierProductId,
      sku: draft.supplierSku,
      barcode: draft.barcode,
      productId: queuedProductId,
      price: draft.price,
      cost: draft.price,
      stock: draft.stock,
      availability: rawProduct.availability,
      lastSyncAt: observedAt,
      reviewStatus: "review_pending",
      catalogPayload: requestData.productPayload,
      supplierSnapshot: rawProduct,
      timestamp: observedAt,
    });
    const activeOfferId = isProductChange
      ? parseSupplierOfferSelection(currentCommercial.supplierOfferSelection).activeOfferId
      : null;
    if (isProductChange && !activeOfferId) throw new ApiError("Product has no active approved supplier offer", 409);
    const offerReference = dependencies.db.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).doc(
      activeOfferId || newProductOfferCandidate.id,
    );
    const skuClaimReference = dependencies.db.collection("supplier_sku_claims").doc(skuClaimId);
    const changeProductReference = isProductChange ? dependencies.db.collection("products").doc(productId) : null;
    const changeCommercialReference = isProductChange ? dependencies.db.collection(PRODUCT_PRIVATE_COLLECTION).doc(productId) : null;
    const changeSourceId = isProductChange ? String(currentCommercial.supplierSourceId || "").trim() : "";
    const changeSourceReference = changeSourceId && changeSourceId !== SUPPLIER_PORTAL_SOURCE_ID
      ? dependencies.db.collection("supplierSources").doc(changeSourceId)
      : null;
    await dependencies.db.runTransaction(async (transaction) => {
      const [freshRequest, skuClaim, productClaim, profileSnapshot, offerSnapshot, freshProduct, freshCommercial, freshSource] = await Promise.all([
        transaction.get(requestReference),
        transaction.get(skuClaimReference),
        productClaimId ? transaction.get(dependencies.db.collection("supplier_product_claims").doc(productClaimId)) : Promise.resolve(null),
        transaction.get(dependencies.db.collection("supplier_profiles").doc(identity.uid)),
        transaction.get(offerReference),
        changeProductReference ? transaction.get(changeProductReference) : Promise.resolve(null),
        changeCommercialReference ? transaction.get(changeCommercialReference) : Promise.resolve(null),
        changeSourceReference ? transaction.get(changeSourceReference) : Promise.resolve(null),
      ]);
      if (!freshRequest.exists || freshRequest.data()?.supplierId !== identity.uid || freshRequest.data()?.status !== "draft") {
        throw new ApiError("Product request changed before submission; reload and try again", 409);
      }
      const skuClaimData = skuClaim.exists ? skuClaim.data() || {} : null;
      const claimedRequestId = String(skuClaimData?.requestId || "").trim();
      let owningRequestEvidence: { id: string; data: Record<string, unknown> } | null = null;
      const readableClaimedRequestId = Boolean(claimedRequestId) && claimedRequestId.length <= 160 && !claimedRequestId.includes("/");
      if (isProductChange && skuClaimData && !String(skuClaimData.canonicalProductId || "").trim() && readableClaimedRequestId) {
        const owningRequest = claimedRequestId === requestId
          ? freshRequest
          : await transaction.get(dependencies.db.collection("supplier_product_requests").doc(claimedRequestId));
        owningRequestEvidence = owningRequest.exists
          ? { id: owningRequest.id, data: owningRequest.data() || {} }
          : null;
      }
      const skuClaimResolution = resolveSupplierPortalSkuClaim({
        claim: skuClaimData,
        requestId,
        requestType: isProductChange ? "product_change" : "new_product",
        supplierId: identity.uid,
        canonicalProductId: isProductChange ? productId : undefined,
        owningRequest: owningRequestEvidence,
      });
      if (productClaim?.exists && productClaim.data()?.requestId !== requestId) throw new ApiError("A duplicate product request already exists", 409);
      const freshProductAttribution = {
        ...(freshProduct?.data() || {}),
        ...(freshCommercial?.data() || {}),
      };
      const freshMappedSources = freshSource?.exists ? [sourceAccountMapping(freshSource)] : [];
      if (isProductChange && (
        !freshProduct?.exists
        || !supplierAccountManagesProduct(freshProductAttribution, identity.uid, freshMappedSources)
        || parseSupplierOfferSelection(freshCommercial?.data()?.supplierOfferSelection).activeOfferId !== offerReference.id
      )) throw new ApiError("Product mapping changed before submission; reload and try again", 409);
      const existingOffer = projectSupplierOfferForAdmin(offerSnapshot.exists ? { id: offerSnapshot.id, ...offerSnapshot.data() } : null);
      if (isProductChange && (
        !existingOffer
        || existingOffer.reviewStatus !== "approved"
        || existingOffer.productId !== productId
        || existingOffer.sourceId !== String(freshCommercial?.data()?.supplierSourceId || "")
        || existingOffer.supplierId !== String(freshCommercial?.data()?.supplierId || "")
      )) throw new ApiError("Product is not routed through this supplier's approved offer", 403);
      if (isProductChange && normalizeSupplierSku(existingOffer?.sku) !== supplierSkuNormalized) {
        throw new ApiError("The supplier SKU cannot be changed for an approved product", 409);
      }
      const offerCandidate = isProductChange && existingOffer
        ? buildSupplierProductOffer({
          ...existingOffer,
          price: draft.price,
          cost: draft.price,
          stock: draft.stock,
          availability: rawProduct.availability,
          reviewStatus: "review_pending",
          catalogPayload: requestData.productPayload,
          // Draft observation must win for content/media. Spreading the prior
          // approved snapshot after rawProduct previously retained stale
          // mediaGallery URLs, so same-SKU image edits reused the old asset.
          supplierSnapshot: {
            ...existingOffer.supplierSnapshot,
            ...rawProduct,
            supplierId: existingOffer.supplierId,
            sourceId: existingOffer.sourceId,
            supplierProductId: existingOffer.supplierProductId,
            sku: existingOffer.sku,
            inventoryLevel: draft.stock,
            wholesalePrice: draft.price,
            recommendedRetailPrice: draft.price,
          },
          existing: existingOffer,
          timestamp: observedAt,
        })
        : newProductOfferCandidate;
      const observedOffer = buildSupplierProductOffer({
        ...offerCandidate,
        existing: existingOffer,
        stateVersion: existingOffer?.stateVersion,
        pendingObservation: existingOffer?.pendingObservation,
        timestamp: observedAt,
      });
      const pendingObservation = buildSupplierOfferPendingObservation({
        offer: observedOffer,
        kind: "catalog_upsert",
        reviewQueueItemId: queueId,
        observedAt,
        traversalId: `portal-request:${requestId}`,
      });
      const offerWrite = buildSupplierOfferObservationWrite({
        existing: existingOffer,
        observed: observedOffer,
        pending: pendingObservation,
        traversalId: `portal-request:${requestId}`,
        observedAt,
      });
      const now = FieldValue.serverTimestamp();
      transaction.set(skuClaimReference, {
        supplierId: identity.uid,
        requestId: skuClaimResolution.requestId,
        supplierSkuNormalized,
        ...(skuClaimResolution.canonicalProductId ? { canonicalProductId: skuClaimResolution.canonicalProductId } : {}),
        updatedAt: now,
      });
      if (productClaimId) transaction.set(dependencies.db.collection("supplier_product_claims").doc(productClaimId), { supplierId: identity.uid, requestId, fingerprint, updatedAt: now });
      transaction.update(requestReference, { status: "pending", submittedAt: now, updatedAt: now, rejectionReason: FieldValue.delete() });
      transaction.set(offerReference, offerWrite, { merge: true });
      const queueRecord = {
        id: queueId,
        portalRequestId: requestId,
        portalRequestType: requestData.requestType,
        supplierId: observedOffer.supplierId,
        supplierAccountId: identity.uid,
        supplierCode: draft.supplierSku,
        supplierSkuClaimId: skuClaimId,
        ...(productClaimId ? { productFingerprintClaimId: productClaimId } : {}),
        supplierName: String(profileSnapshot.data()?.companyName || identity.email || "Supplier"),
        productName: draft.name,
        costPrice: draft.price,
        marketPrice: draft.price,
        stock: draft.stock,
        imageUrl: draft.imageUrl,
        source: observedOffer.sourceId === SUPPLIER_PORTAL_SOURCE_ID ? "Supplier Portal" : "Mapped Supplier Source",
        connector: "supplier_portal",
        sourceId: observedOffer.sourceId,
        supplierOfferId: observedOffer.id,
        supplierOfferPendingRevision: pendingObservation.revision,
        supplierOfferStateExpectation: supplierOfferStateExpectation(existingOffer || {}),
        canonicalProductId: queuedProductId,
        productId: queuedProductId,
        changeType: requestData.requestType === "new_product" ? "NEW_PRODUCT" : "DESCRIPTION_CHANGED",
        comparisonStatus: comparison.status,
        comparison: {
          matchFound: Boolean(currentProduct),
          matchedProductId: currentProduct ? productId : null,
          comparisonStatus: comparison.status,
          changedFields: comparison.changedFields,
          fieldChanges: comparison.fieldChanges,
        },
        matchedProductId: requestData.requestType === "product_change" ? productId : null,
        productPayload: requestData.productPayload,
        managedMediaRequired: true,
        mediaStatus: reusableManagedMedia.length > 0 ? "ready" : "queued",
        ...(reusableManagedMedia.length > 0 ? { managedMedia: reusableManagedMedia } : {}),
        supplierSnapshot: {
          // Prefer the submitted draft observation for media/content. Identity
          // fields below remain offer-owned.
          ...observedOffer.supplierSnapshot,
          ...rawProduct,
          supplierId: observedOffer.supplierId,
          sourceId: observedOffer.sourceId,
          supplierProductId: observedOffer.supplierProductId,
          supplierSku: observedOffer.sku,
          canonicalProductId: queuedProductId,
          ...(reusableManagedMedia.length > 0 ? { managedMedia: reusableManagedMedia } : {}),
        },
        productValidation: {
          readyToPublish: reusableManagedMedia.length > 0,
          missingFields: reusableManagedMedia.length > 0 ? [] : ["images"],
          errors: reusableManagedMedia.length > 0 ? [] : [{
            field: "images",
            code: "managed_media_required",
            message: "Managed product media is being prepared before administrator review.",
          }],
          warnings: [],
        },
        approvalBaseline: buildSupplierProductApprovalBaseline(
          queuedProductId,
          baselineProductDocument?.data(),
        ),
        status: "Pending",
        ...buildSupplierQueueLifecycle(observedAt),
        createdAt: now,
        updatedAt: now,
      };
      transaction.set(dependencies.db.collection("supplier_review_queue").doc(queueId), queueRecord);
      createSupplierAuditEvent(dependencies.db, transaction, {
        queueItemId: queueId,
        queueItem: queueRecord,
        action: "queued",
        previousState: null,
        newState: "queued",
        reason: "Supplier product submission is queued for managed-media preparation.",
      });
    });
    res.json({ success: true, status: "pending" });
  }));

  app.post("/api/supplier-portal/products/:productId/stock-proposal", route(async (req, res, identity) => {
    assertActive(identity);
    const productId = cleanId(req.params.productId, "product ID");
    const proposedStock = Number(req.body?.stock);
    if (!Number.isInteger(proposedStock) || proposedStock < 0) throw new ApiError("Stock must be a non-negative whole number", 400);
    const productReference = dependencies.db.collection("products").doc(productId);
    const commercialReference = dependencies.db.collection(PRODUCT_PRIVATE_COLLECTION).doc(productId);
    const requestReference = dependencies.db.collection("supplier_product_requests").doc();
    const queueId = `portal-${requestReference.id}`;
    const observedAt = new Date().toISOString();
    await dependencies.db.runTransaction(async (transaction) => {
      const [productSnapshot, commercialSnapshot] = await Promise.all([
        transaction.get(productReference),
        transaction.get(commercialReference),
      ]);
      const productAttribution = { ...(productSnapshot.data() || {}), ...(commercialSnapshot.data() || {}) };
      const sourceId = String(productAttribution.supplierSourceId || "").trim();
      const sourceSnapshot = sourceId && sourceId !== SUPPLIER_PORTAL_SOURCE_ID
        ? await transaction.get(dependencies.db.collection("supplierSources").doc(sourceId))
        : null;
      const mappedSources = sourceSnapshot?.exists ? [sourceAccountMapping(sourceSnapshot)] : [];
      if (!productSnapshot.exists || !supplierAccountManagesProduct(productAttribution, identity.uid, mappedSources)) {
        throw new ApiError("Product is not owned by this supplier", 403);
      }
      const product = sanitizePublicProductData(productSnapshot.data() || {});
      const commercial = commercialSnapshot.data() || {};
      const currentManagedMedia = Array.isArray(commercial.supplierMedia) ? commercial.supplierMedia : [];
      const supplierItemCode = String(commercial.supplierItemCode || product.sku || "");
      const activeOfferId = parseSupplierOfferSelection(commercial.supplierOfferSelection).activeOfferId;
      if (!activeOfferId) throw new ApiError("Product has no active approved supplier offer", 409);
      const offerReference = dependencies.db.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).doc(activeOfferId);
      const offerSnapshot = await transaction.get(offerReference);
      const existingOffer = projectSupplierOfferForAdmin(offerSnapshot.exists ? { id: offerSnapshot.id, ...offerSnapshot.data() } : null);
      if (
        !existingOffer
        || existingOffer.reviewStatus !== "approved"
        || existingOffer.supplierId !== String(commercial.supplierId || "")
        || existingOffer.sourceId !== String(commercial.supplierSourceId || "")
        || existingOffer.productId !== productId
      ) {
        throw new ApiError("Product is not routed through this supplier's approved offer", 403);
      }
      // Prefer the raw offer field so a corrupt pending blob still fail-closes.
      assertNoUnresolvedSupplierStockProposal(
        offerSnapshot.data()?.pendingObservation ?? existingOffer.pendingObservation,
      );
      const productPayload = { ...product, id: productId, supplierItemCode, stock: proposedStock, updatedAt: observedAt };
      const observedOffer = buildSupplierProductOffer({
        ...existingOffer,
        stock: proposedStock,
        availability: proposedStock > 0 ? "in_stock" : "out_of_stock",
        reviewStatus: "review_pending",
        catalogPayload: productPayload,
        supplierSnapshot: { ...existingOffer.supplierSnapshot, inventoryLevel: proposedStock },
        existing: existingOffer,
        timestamp: observedAt,
      });
      const pendingObservation = buildSupplierOfferPendingObservation({
        offer: observedOffer,
        kind: "catalog_upsert",
        reviewQueueItemId: queueId,
        observedAt,
        traversalId: `portal-request:${requestReference.id}`,
      });
      const comparison = {
        status: "STOCK_CHANGED" as const,
        changedFields: ["Stock"],
        fieldChanges: [buildSupplierLifecycleFieldChange("stock", Number(product.stock || 0), proposedStock)],
      };
      const now = FieldValue.serverTimestamp();
      const queueRecord = {
        id: queueId,
        portalRequestId: requestReference.id,
        supplierId: existingOffer.supplierId,
        supplierAccountId: identity.uid,
        supplierCode: supplierItemCode,
        supplierName: identity.email,
        productName: String(product.name || ""),
        costPrice: Number(existingOffer.cost || 0),
        marketPrice: Number(existingOffer.price || product.price || 0),
        stock: proposedStock,
        imageUrl: String(product.imageUrl || ""),
        source: existingOffer.sourceId === SUPPLIER_PORTAL_SOURCE_ID ? "Supplier Portal" : "Mapped Supplier Source",
        connector: "supplier_portal",
        sourceId: existingOffer.sourceId,
        supplierOfferId: existingOffer.id,
        supplierOfferPendingRevision: pendingObservation.revision,
        supplierOfferStateExpectation: supplierOfferStateExpectation(existingOffer),
        canonicalProductId: productId,
        productId,
        changeType: comparison.status,
        comparisonStatus: comparison.status,
        comparison: {
          matchFound: true,
          matchedProductId: productId,
          comparisonStatus: comparison.status,
          changedFields: comparison.changedFields,
          fieldChanges: comparison.fieldChanges,
        },
        matchedProductId: productId,
        productPayload: {
          ...productPayload,
          ...(commercial.supplierFieldOwnership
            ? { supplierFieldOwnership: commercial.supplierFieldOwnership }
            : {}),
        },
        ...(currentManagedMedia.length > 0 ? {
          managedMedia: currentManagedMedia,
          mediaStatus: "ready",
        } : {}),
        supplierSnapshot: {
          ...existingOffer.supplierSnapshot,
          supplierId: existingOffer.supplierId,
          sourceId: existingOffer.sourceId,
          supplierProductId: existingOffer.supplierProductId,
          supplierSku: supplierItemCode,
          canonicalProductId: productId,
          previousStock: Number(product.stock || 0),
          proposedStock,
          ...(currentManagedMedia.length > 0 ? { managedMedia: currentManagedMedia } : {}),
        },
        productValidation: { readyToPublish: true, missingFields: [], errors: [], warnings: [] },
        approvalBaseline: buildSupplierProductApprovalBaseline(productId, productSnapshot.data()),
        status: "Pending",
        queueState: "review_pending",
        retryCount: 0,
        retryLimit: 5,
        queueCreatedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      transaction.set(requestReference, {
        supplierId: identity.uid,
        supplierEmail: identity.email,
        requestType: "stock_change",
        productId,
        productName: String(product.name || ""),
        supplierSku: supplierItemCode,
        status: "pending",
        productPayload,
        submittedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      transaction.set(offerReference, buildSupplierOfferObservationWrite({
        existing: existingOffer,
        observed: observedOffer,
        pending: pendingObservation,
        traversalId: `portal-request:${requestReference.id}`,
        observedAt,
      }), { merge: true });
      transaction.set(dependencies.db.collection("supplier_review_queue").doc(queueId), queueRecord);
      createSupplierAuditEvent(dependencies.db, transaction, {
        queueItemId: queueId, queueItem: queueRecord, action: "queued", previousState: null, newState: "queued",
        reason: "Supplier stock proposal entered the approval workflow.",
      });
      createSupplierAuditEvent(dependencies.db, transaction, {
        queueItemId: queueId, queueItem: queueRecord, action: "review_pending", previousState: "queued", newState: "review_pending",
        reason: "Supplier stock proposal is awaiting administrator review.",
      });
    });
    res.json({ success: true, status: "pending" });
  }));

  app.post("/api/supplier-portal/orders/:orderId/groups/:groupId/fulfilment", route(async (req, res, identity) => {
    assertActive(identity);
    const orderId = cleanId(req.params.orderId, "order ID");
    const groupId = cleanId(req.params.groupId, "fulfilment group ID");
    const result = await transitionSupplierOrderFulfilment(
      dependencies.db,
      orderId,
      identity.uid,
      groupId,
      req.body?.status,
      req.body?.expectedGroupRevision,
      req.body?.expectedOrderPrivateRevision,
      req.body?.reason,
    );
    res.json({ success: true, ...result });
  }));

  app.post("/api/supplier-portal/orders/:orderId/groups/:groupId/tracking", route(async (req, res, identity) => {
    assertActive(identity);
    const orderId = cleanId(req.params.orderId, "order ID");
    const groupId = cleanId(req.params.groupId, "fulfilment group ID");
    const body = assertTrackingBody(req.body);
    const result = await recordSupplierOrderTracking(
      dependencies.db,
      orderId,
      identity.uid,
      groupId,
      body.courierName,
      body.trackingNumber,
      body.expectedGroupRevision,
      body.expectedOrderPrivateRevision,
    );
    res.json({ success: true, ...result });
  }));

  app.post("/api/supplier-portal/orders/:orderId/groups/:groupId/tracking/correct", requireSupplierHubAdmin, async (req, res) => {
    const orderId = typeof req.params.orderId === "string" ? req.params.orderId.trim() : "";
    const groupId = typeof req.params.groupId === "string" ? req.params.groupId.trim() : "";
    if (!orderId || orderId.includes("/") || !groupId || groupId.includes("/")) {
      res.status(400).json({ error: "A valid order and fulfilment group are required" });
      return;
    }
    try {
      const body = assertTrackingBody(req.body);
      const result = await correctAdminOrderTracking(
        dependencies.db,
        orderId,
        groupId,
        String(res.locals.supplierAdmin?.uid || "unknown-admin"),
        body.courierName,
        body.trackingNumber,
        body.expectedGroupRevision,
        body.expectedOrderPrivateRevision,
      );
      res.json({ success: true, ...result });
    } catch (error) {
      sendApiError(res, error, {
        logMessage: "Admin tracking correction failed.",
        fallbackMessage: "Tracking could not be corrected",
        context: { orderId, groupId },
      });
    }
  });

  app.post("/api/supplier-portal/notifications/:notificationId/read", route(async (req, res, identity) => {
    assertProfileWritable(identity);
    const notificationId = cleanId(req.params.notificationId, "notification ID");
    const reference = dependencies.db.collection("supplier_notifications").doc(notificationId);
    await dependencies.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists || snapshot.data()?.supplierId !== identity.uid) throw new ApiError("Notification not found", 404);
      transaction.update(reference, { isRead: true, readAt: FieldValue.serverTimestamp() });
    });
    res.json({ success: true });
  }));
}
