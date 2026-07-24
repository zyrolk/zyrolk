import { createHash } from "crypto";
import * as express from "express";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { ApiError, sendApiError } from "../errors";
import { requireSupplierHubAdmin } from "../middleware/supplierHubAdminAuth";
import { PRODUCT_PRIVATE_COLLECTION, sanitizePublicProductData } from "../products/productCommercialData";
import { buildSupplierAuditEvent, createSupplierAuditEvent } from "../suppliers/supplierAuditTrail";
import { buildSupplierProductApprovalBaseline } from "../suppliers/supplierApprovalConcurrency";
import {
  assertSupplierOrderTransition,
  calculateSupplierSummary,
  normalizeProductFingerprint,
  normalizeSupplierSku,
  sanitizeSupplierProductDraft,
  sanitizeSupplierProfile,
  supplierOwnsOrder,
  validateSupplierProductForSubmission,
} from "../suppliers/supplierPortalLogic";

interface SupplierPortalDependencies {
  db: FirebaseFirestore.Firestore;
  auth: { verifyIdToken(token: string): Promise<{ uid: string; email?: string }> };
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

const readPageSize = (value: unknown): number => {
  const requested = Number(value);
  return Number.isInteger(requested) ? Math.min(100, Math.max(10, requested)) : 100;
};

const readCursor = (value: unknown): string => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : "";

const applyDocumentCursor = <T extends FirebaseFirestore.Query>(query: T, cursor: string): T => (
  cursor ? query.startAfter(cursor) as T : query
);

const hashId = (value: string): string => createHash("sha256").update(value).digest("hex");

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

const projectOrder = (id: string, order: Record<string, unknown>, supplierId: string): Record<string, unknown> => {
  const sourceItems = Array.isArray(order.items) ? order.items as Array<Record<string, unknown>> : [];
  const explicitlyAssignedItems = sourceItems.filter((item) => item.supplierId === supplierId);
  const items = explicitlyAssignedItems.length > 0 ? explicitlyAssignedItems : sourceItems;
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
    supplierFulfilmentStatus: String(order.supplierFulfilmentStatus || "pending"),
    paymentMethod: String(order.paymentMethod || ""),
    paymentStatus: String(order.paymentStatus || ""),
    createdAt: toIso(order.createdAt),
    supplierFulfilmentUpdatedAt: toIso(order.supplierFulfilmentUpdatedAt),
  };
};

const assertActive = (identity: SupplierIdentity): void => {
  if (identity.profileStatus !== "active") throw new ApiError("Supplier profile must be active before using this action", 403);
};

export function registerSupplierPortalRoutes(app: express.Express, dependencies: SupplierPortalDependencies): void {
  const authenticate = async (req: express.Request): Promise<SupplierIdentity> => {
    const decoded = await dependencies.auth.verifyIdToken(readBearerToken(req));
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
        const identity = await authenticate(req);
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
    const supplierId = typeof req.body?.supplierId === "string" ? req.body.supplierId.trim() : "";
    if (!orderId || orderId.includes("/") || !supplierId || supplierId.includes("/")) {
      res.status(400).json({ error: "A valid order and supplier are required" });
      return;
    }
    try {
      const orderReference = dependencies.db.collection("orders").doc(orderId);
      const supplierReference = dependencies.db.collection("users").doc(supplierId);
      const profileReference = dependencies.db.collection("supplier_profiles").doc(supplierId);
      await dependencies.db.runTransaction(async (transaction) => {
        const [orderSnapshot, supplierSnapshot, profileSnapshot] = await Promise.all([
          transaction.get(orderReference), transaction.get(supplierReference), transaction.get(profileReference),
        ]);
        if (!orderSnapshot.exists) throw new ApiError("Order not found", 404);
        if (supplierSnapshot.data()?.role !== "supplier") throw new ApiError("Selected account is not a supplier", 400);
        if (!profileSnapshot.exists || String(profileSnapshot.data()?.profileStatus || "pending").toLocaleLowerCase() !== "active") {
          throw new ApiError("Selected supplier profile is not active", 409);
        }
        if (["cancelled", "delivered"].includes(String(orderSnapshot.data()?.status || ""))) {
          throw new ApiError("Completed or cancelled orders cannot be reassigned", 409);
        }
        const assignedAt = FieldValue.serverTimestamp();
        transaction.update(orderReference, {
          supplierId,
          supplierIds: [supplierId],
          supplierFulfilmentStatus: "pending",
          supplierAssignedAt: assignedAt,
        });
        transaction.set(dependencies.db.collection("supplier_notifications").doc(`order-${orderId}-${supplierId}`), {
          supplierId,
          type: "new_order",
          title: "New assigned order",
          message: `Order ${String(orderSnapshot.data()?.orderNumber || orderId)} is assigned to your account.`,
          orderId,
          isRead: false,
          createdAt: assignedAt,
        });
      });
      res.json({ success: true, supplierId });
    } catch (error) {
      sendApiError(res, error, {
        logMessage: "Admin supplier order assignment failed.",
        fallbackMessage: "Order could not be assigned to the supplier",
        context: { orderId, supplierId },
      });
    }
  });

  app.get("/api/supplier-portal", route(async (req, res, identity) => {
    const pageSize = readPageSize(req.query.pageSize);
    const productCursor = readCursor(req.query.productsCursor);
    const requestCursor = readCursor(req.query.requestsCursor);
    const orderCursor = readCursor(req.query.ordersCursor);
    const notificationCursor = readCursor(req.query.notificationsCursor);
    const [profileSnapshot, commercialProductSnapshot, legacyProductSnapshot, requestSnapshot, directOrders, sharedOrders, notificationSnapshot, categorySnapshot, brandSnapshot] = await Promise.all([
      dependencies.db.collection("supplier_profiles").doc(identity.uid).get(),
      applyDocumentCursor(dependencies.db.collection(PRODUCT_PRIVATE_COLLECTION).where("supplierId", "==", identity.uid).orderBy(FieldPath.documentId()).limit(pageSize), productCursor).get(),
      applyDocumentCursor(dependencies.db.collection("products").where("supplierId", "==", identity.uid).orderBy(FieldPath.documentId()).limit(pageSize), productCursor).get(),
      applyDocumentCursor(dependencies.db.collection("supplier_product_requests").where("supplierId", "==", identity.uid).orderBy(FieldPath.documentId()).limit(pageSize), requestCursor).get(),
      applyDocumentCursor(dependencies.db.collection("orders").where("supplierId", "==", identity.uid).orderBy(FieldPath.documentId()).limit(pageSize), orderCursor).get(),
      applyDocumentCursor(dependencies.db.collection("orders").where("supplierIds", "array-contains", identity.uid).orderBy(FieldPath.documentId()).limit(pageSize), orderCursor).get(),
      applyDocumentCursor(dependencies.db.collection("supplier_notifications").where("supplierId", "==", identity.uid).orderBy(FieldPath.documentId()).limit(pageSize), notificationCursor).get(),
      dependencies.db.collection("categories").get(),
      dependencies.db.collection("brands").get(),
    ]);
    const commercialById = new Map(commercialProductSnapshot.docs.map((document) => [document.id, document.data()]));
    const productIds = new Set([
      ...commercialProductSnapshot.docs.map((document) => document.id),
      ...legacyProductSnapshot.docs.map((document) => document.id),
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
    const orderDocuments = new Map([...directOrders.docs, ...sharedOrders.docs].map((document) => [document.id, document]));
    const orders = [...orderDocuments.values()].filter((document) => supplierOwnsOrder(document.data(), identity.uid))
      .map((document) => projectOrder(document.id, document.data(), identity.uid))
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
        productsCursor: commercialProductSnapshot.docs.at(-1)?.id || legacyProductSnapshot.docs.at(-1)?.id || null,
        requestsCursor: requestSnapshot.docs.at(-1)?.id || null,
        ordersCursor: directOrders.docs.at(-1)?.id || sharedOrders.docs.at(-1)?.id || null,
        notificationsCursor: notificationSnapshot.docs.at(-1)?.id || null,
        hasMore: {
          products: commercialProductSnapshot.size === pageSize || legacyProductSnapshot.size === pageSize,
          requests: requestSnapshot.size === pageSize,
          orders: directOrders.size === pageSize || sharedOrders.size === pageSize,
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
      const ownerId = commercialSnapshot.data()?.supplierId || productSnapshot.data()?.supplierId;
      if (!productSnapshot.exists || ownerId !== identity.uid) throw new ApiError("Product is not owned by this supplier", 403);
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
        supplierId: identity.uid,
        supplierItemCode: draft.supplierSku || String(baseCommercial.supplierItemCode || ""),
        brand: draft.brand,
        model: draft.model || undefined,
        barcode: draft.barcode || undefined,
        productType: draft.productType,
        category: draft.category,
        subcategory: draft.subcategory,
        description: draft.description,
        shortDescription: draft.shortDescription || undefined,
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
    await dependencies.db.runTransaction(async (transaction) => {
      const [freshRequest, skuClaim, productClaim, profileSnapshot] = await Promise.all([
        transaction.get(requestReference),
        transaction.get(dependencies.db.collection("supplier_sku_claims").doc(skuClaimId)),
        productClaimId ? transaction.get(dependencies.db.collection("supplier_product_claims").doc(productClaimId)) : Promise.resolve(null),
        transaction.get(dependencies.db.collection("supplier_profiles").doc(identity.uid)),
      ]);
      if (!freshRequest.exists || freshRequest.data()?.supplierId !== identity.uid || freshRequest.data()?.status !== "draft") {
        throw new ApiError("Product request changed before submission; reload and try again", 409);
      }
      if (skuClaim.exists && skuClaim.data()?.requestId !== requestId) throw new ApiError("Supplier SKU is already in use", 409);
      if (productClaim?.exists && productClaim.data()?.requestId !== requestId) throw new ApiError("A duplicate product request already exists", 409);
      const now = FieldValue.serverTimestamp();
      transaction.set(dependencies.db.collection("supplier_sku_claims").doc(skuClaimId), { supplierId: identity.uid, requestId, supplierSkuNormalized, updatedAt: now });
      if (productClaimId) transaction.set(dependencies.db.collection("supplier_product_claims").doc(productClaimId), { supplierId: identity.uid, requestId, fingerprint, updatedAt: now });
      transaction.update(requestReference, { status: "pending", submittedAt: now, updatedAt: now, rejectionReason: FieldValue.delete() });
      const queueRecord = {
        id: queueId,
        portalRequestId: requestId,
        supplierId: identity.uid,
        supplierCode: draft.supplierSku,
        supplierSkuClaimId: skuClaimId,
        ...(productClaimId ? { productFingerprintClaimId: productClaimId } : {}),
        supplierName: String(profileSnapshot.data()?.companyName || identity.email || "Supplier"),
        productName: draft.name,
        costPrice: draft.price,
        marketPrice: draft.price,
        stock: draft.stock,
        imageUrl: draft.imageUrl,
        source: "Supplier Portal",
        connector: "supplier_portal",
        sourceId: "supplier-portal",
        changeType: requestData.requestType === "new_product" ? "NEW_PRODUCT" : "DESCRIPTION_CHANGED",
        comparisonStatus: requestData.requestType === "new_product" ? "NEW_PRODUCT" : "DESCRIPTION_CHANGED",
        matchedProductId: requestData.requestType === "product_change" ? productId : null,
        productPayload: requestData.productPayload,
        supplierSnapshot: { supplierId: identity.uid, supplierSku: draft.supplierSku, submittedPayload: requestData.productPayload },
        approvalBaseline: buildSupplierProductApprovalBaseline(
          queuedProductId,
          baselineProductDocument?.data(),
        ),
        status: "Pending",
        queueState: "review_pending",
        retryCount: 0,
        retryLimit: 5,
        queueCreatedAt: now,
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
        reason: "Supplier product submission entered the approval workflow.",
      });
      createSupplierAuditEvent(dependencies.db, transaction, {
        queueItemId: queueId,
        queueItem: queueRecord,
        action: "review_pending",
        previousState: "queued",
        newState: "review_pending",
        reason: "Supplier product submission is awaiting administrator review.",
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
    const [productSnapshot, commercialSnapshot] = await Promise.all([
      productReference.get(),
      dependencies.db.collection(PRODUCT_PRIVATE_COLLECTION).doc(productId).get(),
    ]);
    const ownerId = commercialSnapshot.data()?.supplierId || productSnapshot.data()?.supplierId;
    if (!productSnapshot.exists || ownerId !== identity.uid) throw new ApiError("Product is not owned by this supplier", 403);
    const product = sanitizePublicProductData(productSnapshot.data() || {});
    const supplierItemCode = String(commercialSnapshot.data()?.supplierItemCode || productSnapshot.data()?.supplierItemCode || product.sku || "");
    const requestReference = dependencies.db.collection("supplier_product_requests").doc();
    const queueId = `portal-${requestReference.id}`;
    const now = FieldValue.serverTimestamp();
    const productPayload = { ...product, id: productId, supplierItemCode, stock: proposedStock, updatedAt: new Date().toISOString() };
    const batch = dependencies.db.batch();
    batch.set(requestReference, {
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
    const queueRecord = {
      id: queueId,
      portalRequestId: requestReference.id,
      supplierId: identity.uid,
      supplierCode: supplierItemCode,
      supplierName: identity.email,
      productName: String(product.name || ""),
      costPrice: Number(product.price || 0),
      marketPrice: Number(product.price || 0),
      stock: proposedStock,
      imageUrl: String(product.imageUrl || ""),
      source: "Supplier Portal",
      connector: "supplier_portal",
      sourceId: "supplier-portal",
      changeType: "STOCK_CHANGED",
      comparisonStatus: "STOCK_CHANGED",
      matchedProductId: productId,
      productPayload,
      supplierSnapshot: { supplierId: identity.uid, previousStock: Number(product.stock || 0), proposedStock },
      approvalBaseline: buildSupplierProductApprovalBaseline(productId, productSnapshot.data()),
      status: "Pending",
      queueState: "review_pending",
      retryCount: 0,
      retryLimit: 5,
      queueCreatedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    batch.set(dependencies.db.collection("supplier_review_queue").doc(queueId), queueRecord);
    for (const eventInput of [
      { action: "queued" as const, previousState: null, newState: "queued", reason: "Supplier stock proposal entered the approval workflow." },
      { action: "review_pending" as const, previousState: "queued", newState: "review_pending", reason: "Supplier stock proposal is awaiting administrator review." },
    ]) {
      const auditReference = dependencies.db.collection("supplier_approval_audit").doc();
      batch.create(auditReference, buildSupplierAuditEvent({
        queueItemId: queueId,
        queueItem: queueRecord,
        ...eventInput,
      }, auditReference.id));
    }
    await batch.commit();
    res.json({ success: true, status: "pending" });
  }));

  app.post("/api/supplier-portal/orders/:orderId/fulfilment", route(async (req, res, identity) => {
    assertActive(identity);
    const orderId = cleanId(req.params.orderId, "order ID");
    const orderReference = dependencies.db.collection("orders").doc(orderId);
    let updatedStatus = "";
    await dependencies.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(orderReference);
      if (!snapshot.exists || !supplierOwnsOrder(snapshot.data() || {}, identity.uid)) throw new ApiError("Assigned order not found", 404);
      const order = snapshot.data() || {};
      updatedStatus = assertSupplierOrderTransition(order.supplierFulfilmentStatus, req.body?.status, order.status);
      transaction.update(orderReference, {
        supplierFulfilmentStatus: updatedStatus,
        supplierFulfilmentUpdatedAt: FieldValue.serverTimestamp(),
        supplierFulfilmentUpdatedBy: identity.uid,
      });
    });
    res.json({ success: true, status: updatedStatus });
  }));

  app.post("/api/supplier-portal/notifications/:notificationId/read", route(async (req, res, identity) => {
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
