import express from "express";
import path from "path";
import fs from "fs";
import { createHash } from "crypto";
import { createServer as createViteServer } from "vite";
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getAppCheck } from "firebase-admin/app-check";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import {
  assertCustomerCanCancelOrder, buildOrderStatusPlan, requireCurrentProductStock,
} from "./functions/src/api/orders/orderStatusLogic";
import { registerReviewSystemRoutes } from "./functions/src/api/routes/reviewSystem";
import {
  buildInitialPayHereOrderFields,
  createPayHereSessionForOrder,
  getPayHereAvailability,
} from "./functions/src/api/routes/payments";
import {
  CHECKOUT_ABUSE_COLLECTION,
  COD_CONFIRMATION_WINDOW_MS,
  calculateCheckoutTotals as calculateTrustedCheckoutTotals,
  getCouponDocumentId,
  nextCheckoutAbuseCounter,
  normalizeCouponCode,
  OFFLINE_CHECKOUT_NETWORK_LIMIT,
  OFFLINE_CHECKOUT_PHONE_LIMIT,
  resolveCouponDiscount,
} from "./functions/src/api/checkout/checkoutLogic";
import { appendPaymentTimeline, createPaymentTimelineEvent } from "./functions/src/api/payments/payhereLogic";
import { registerSupplierRoutes } from "./functions/src/api/routes/supplier";
import { registerSupplierPortalRoutes } from "./functions/src/api/routes/supplierPortal";
import { registerAdminConfigurationRoutes } from "./functions/src/api/routes/adminConfiguration";
import { hasAdminAccess } from "./functions/src/api/security/adminAuthorization";
import { registerContactRoutes } from "./functions/src/api/routes/contact";

const app = express();
const PORT = 3000;
const debugLog = (...values: unknown[]): void => {
  if (process.env.NODE_ENV !== "production") console.info(...values);
};

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    res.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://www.google.com https://www.gstatic.com https://www.googletagmanager.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://*.googleapis.com https://*.google.com https://*.gstatic.com https://*.googletagmanager.com https://*.google-analytics.com https://*.firebaseio.com wss://*.firebaseio.com; frame-src https://www.google.com https://www.gstatic.com; upgrade-insecure-requests");
  }
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  next();
});

// Keep the established request shape while rejecting unexpectedly large bodies early.
app.use(express.json({ limit: "100kb" }));

// Load Firebase configuration
const firebaseConfigPath = path.join(process.cwd(), "firebase-applet-config.json");
if (!fs.existsSync(firebaseConfigPath)) {
  console.error("Firebase config file not found. Please run set_up_firebase first.");
  process.exit(1);
}
const firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, "utf-8"));

// Initialize Firebase Admin SDK
if (getApps().length === 0) {
  initializeApp({
    projectId: firebaseConfig.projectId,
  });
}
const adminDb = getFirestore();
const adminAuth = getAuth();
const adminAppCheck = getAppCheck();
const MAX_CART_ITEMS = 50;
const MAX_ITEM_QUANTITY = 99;
const CHECKOUT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const CHECKOUT_RATE_LIMIT_MAX_REQUESTS = 10;
const CHECKOUT_IDEMPOTENCY_COLLECTION = "checkout_idempotency";
const ALLOWED_PAYMENT_METHODS = new Set(["cod", "whatsapp_confirm", "payhere"]);
const DEFAULT_ALLOWED_ORIGINS = ["https://zyro.lk", "https://www.zyro.lk", "https://zyrolk-e0164.web.app"];
const LOCAL_EXPRESS_ALLOWED_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];
const isLocalSupplierApiRuntime = process.env.NODE_ENV !== "production";
const isExactLocalhost = (hostname: string): boolean => {
  const host = hostname.trim().toLowerCase();
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)
    || /^localhost:\d+$/u.test(host)
    || /^127\.0\.0\.1:\d+$/u.test(host)
    || /^\[::1\](?::\d+)?$/u.test(host);
};

app.use(async (req, res, next) => {
  // Firebase Hosting serves the storefront before forwarding only /api/** to this runtime.
  // Mirror that boundary in the local Express preview: public HTML and assets must not require App Check.
  const isApiRequest = req.path === "/api" || req.path.startsWith("/api/");
  if (!isApiRequest) {
    next();
    return;
  }

  const configuredOrigins = (process.env.API_ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean);
  const productionAllowedOrigins = configuredOrigins.length > 0 ? configuredOrigins : DEFAULT_ALLOWED_ORIGINS;
  const allowedOrigins = isLocalSupplierApiRuntime
    ? [...new Set([...productionAllowedOrigins, ...LOCAL_EXPRESS_ALLOWED_ORIGINS])]
    : productionAllowedOrigins;
  const origin = req.header("Origin");
  if (origin && !allowedOrigins.includes(origin)) {
    res.status(403).json({ error: "Origin is not allowed" });
    return;
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key, X-Firebase-AppCheck");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  // server.ts is a local preview/development runtime only. Its bypass remains
  // constrained to exact loopback hosts; deployed Functions enforce App Check.
  const isLocalDevelopmentRequest = isLocalSupplierApiRuntime && isExactLocalhost(req.hostname || "");
  // This value is server-owned and cannot be supplied by the browser. The
  // shared Supplier Hub auth middleware uses it to avoid the Admin SDK's
  // credential-backed revocation lookup only in the local Express preview.
  res.locals.supplierHubLocalExpressPreview = isLocalDevelopmentRequest;
  if (isLocalDevelopmentRequest || process.env.REQUIRE_APP_CHECK === "false" || req.path === "/sitemap.xml") {
    next();
    return;
  }
  const token = req.header("X-Firebase-AppCheck");
  if (!token) {
    res.status(401).json({ error: "App verification is required" });
    return;
  }
  try {
    await adminAppCheck.verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: "App verification failed" });
  }
});

registerReviewSystemRoutes(app, {
  db: adminDb,
  verifyIdToken: (token) => adminAuth.verifyIdToken(token),
});
registerContactRoutes(app, { db: adminDb });
// PayHere routes are intentionally not registered while the storefront is COD-only.
// Firebase Hosting routes production Supplier Hub traffic directly to the Functions API.
// The local server intentionally exposes the same canonical route modules only for development.
if (isLocalSupplierApiRuntime) {
  registerSupplierRoutes(app);
  registerSupplierPortalRoutes(app, { db: adminDb, auth: adminAuth });
}
registerAdminConfigurationRoutes(app, { auth: adminAuth, db: adminDb });

app.post("/api/monitoring/client-error", (req, res) => {
  const context = typeof req.body?.context === "string" ? req.body.context.trim().slice(0, 100) : "client-error";
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "Error";
  const code = typeof req.body?.code === "string" ? req.body.code.trim().slice(0, 80) : "";
  console.warn("[Storefront client exception]", { context, name, code });
  res.status(202).json({ accepted: true });
});

app.get("/sitemap.xml", async (_req, res) => {
  try {
    const [snapshot, categoriesSnapshot] = await Promise.all([
      adminDb.collection("products").limit(5000).get(),
      adminDb.collection("categories").limit(500).get(),
    ]);
    const escapeXml = (value: string) => value.replace(/[<>&'\"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[character] || character));
    const productUrls = snapshot.docs.filter((product) => product.data().isActive !== false).map((product) => `<url><loc>${escapeXml(`https://zyro.lk/products/${encodeURIComponent(product.id)}`)}</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`);
    const categoryUrls = categoriesSnapshot.docs.filter((category) => category.data().isActive !== false).map((category) => `<url><loc>${escapeXml(`https://zyro.lk/categories/${encodeURIComponent(category.id)}`)}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`);
    const staticPaths = ["", "products", "categories", "about-us", "contact", "faq", "privacy-policy", "terms-conditions", "return-policy", "warranty-policy"];
    const staticUrls = staticPaths.map((path, index) => `<url><loc>${escapeXml(`https://zyro.lk/${path}`)}</loc><changefreq>${index < 3 ? "daily" : "monthly"}</changefreq><priority>${index === 0 ? "1.0" : index < 3 ? "0.9" : "0.5"}</priority></url>`);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${staticUrls.join("")}${categoryUrls.join("")}${productUrls.join("")}</urlset>`);
  } catch {
    res.status(503).type("text/plain").send("Sitemap temporarily unavailable");
  }
});

const checkoutRateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

interface CheckoutCartItem {
  productId: string;
  quantity: number;
}

class CheckoutError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function getClientRateLimitKey(req: express.Request): string {
  const forwardedFor = req.header("x-forwarded-for");
  const forwardedIp = forwardedFor ? forwardedFor.split(",")[0].trim() : "";
  return forwardedIp || req.ip || "unknown";
}

function enforceCheckoutRateLimit(req: express.Request): void {
  const now = Date.now();
  const key = getClientRateLimitKey(req);
  const bucket = checkoutRateLimitBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    checkoutRateLimitBuckets.set(key, {
      count: 1,
      resetAt: now + CHECKOUT_RATE_LIMIT_WINDOW_MS,
    });
    return;
  }

  bucket.count += 1;
  if (bucket.count > CHECKOUT_RATE_LIMIT_MAX_REQUESTS) {
    throw new CheckoutError("Too many checkout attempts. Please wait a moment and try again.", 429);
  }
}

function requireNonEmptyString(value: unknown, fieldName: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new CheckoutError(`${fieldName} is required`);
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    throw new CheckoutError(`${fieldName} is required`);
  }

  if (trimmedValue.length > maxLength) {
    throw new CheckoutError(`${fieldName} cannot exceed ${maxLength} characters`);
  }

  return trimmedValue;
}

function validatePaymentMethod(paymentMethod: unknown): "cod" | "whatsapp_confirm" | "payhere" {
  if (paymentMethod === undefined || paymentMethod === null || paymentMethod === "") {
    return "cod";
  }

  if (typeof paymentMethod !== "string" || !ALLOWED_PAYMENT_METHODS.has(paymentMethod)) {
    throw new CheckoutError("Payment method must be cod, whatsapp_confirm or payhere");
  }

  return paymentMethod as "cod" | "whatsapp_confirm" | "payhere";
}

function validateCheckoutDetails(body: Record<string, unknown>): void {
  const customerPhone = requireNonEmptyString(body.customerPhone, "Phone", 30);
  requireNonEmptyString(body.customerName, "Customer name", 120);
  requireNonEmptyString(body.customerAddress, "Address", 500);
  requireNonEmptyString(body.district, "District", 80);
  const validatedPaymentMethod = validatePaymentMethod(body.paymentMethod);

  if (body.city !== undefined && body.city !== null && String(body.city).trim().length > 80) {
    throw new CheckoutError("City cannot exceed 80 characters");
  }

  if (body.couponCode !== undefined && body.couponCode !== null && body.couponCode !== "") {
    normalizeCouponCode(body.couponCode);
  }

  const phoneDigits = customerPhone.replace(/\D/g, "");
  if (phoneDigits.length < 9 || phoneDigits.length > 15) {
    throw new CheckoutError("Phone must contain a valid contact number");
  }

  if (body.customerEmail !== undefined && body.customerEmail !== null && body.customerEmail !== "") {
    const email = String(body.customerEmail).trim();
    if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new CheckoutError("Customer email must be valid when provided");
    }
    if (validatedPaymentMethod === "payhere" && email.toLowerCase() === "guest@zyro.lk") {
      throw new CheckoutError("A customer email is required for PayHere payments");
    }
  } else if (validatedPaymentMethod === "payhere") {
    throw new CheckoutError("Customer email is required for PayHere payments");
  }

  if (body.customerPhone2 !== undefined && body.customerPhone2 !== null && body.customerPhone2 !== "") {
    const phone2Digits = String(body.customerPhone2).replace(/\D/g, "");
    if (phone2Digits.length < 9 || phone2Digits.length > 15) {
      throw new CheckoutError("Secondary phone must contain a valid contact number when provided");
    }
  }
}

function getIdempotencyKey(req: express.Request): string | null {
  const headerValue = req.header("Idempotency-Key");
  const bodyValue = req.body?.idempotencyKey;
  const rawKey = typeof headerValue === "string" && headerValue.trim()
    ? headerValue
    : (typeof bodyValue === "string" ? bodyValue : "");
  const key = rawKey.trim();

  if (!key) {
    return null;
  }

  if (key.length > 200) {
    throw new CheckoutError("Idempotency key cannot exceed 200 characters");
  }

  return key;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createCheckoutRequestHash(body: Record<string, unknown>, cartItems: CheckoutCartItem[]): string {
  const requestShape = {
    customerUid: body.customerUid || "guest",
    customerName: String(body.customerName || "").trim(),
    customerPhone: String(body.customerPhone || "").trim(),
    customerPhone2: String(body.customerPhone2 || "").trim(),
    customerEmail: String(body.customerEmail || "guest@zyro.lk").trim(),
    customerAddress: String(body.customerAddress || "").trim(),
    district: String(body.district || "").trim(),
    city: String(body.city || "").trim(),
    paymentMethod: validatePaymentMethod(body.paymentMethod),
    couponCode: body.couponCode ? normalizeCouponCode(body.couponCode) : "",
    cartItems,
  };

  return hashValue(JSON.stringify(requestShape));
}

async function resolveCheckoutCustomerUid(req: express.Request): Promise<string> {
  const match = (req.header("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!match) return "guest";
  try {
    return (await adminAuth.verifyIdToken(match[1])).uid;
  } catch {
    throw new CheckoutError("Invalid or expired authentication token", 401);
  }
}

async function calculateTrustedCouponSubtotal(cartItems: CheckoutCartItem[]): Promise<number> {
  let subtotal = 0;
  for (const item of cartItems) {
    const snapshot = await adminDb.collection("products").doc(item.productId).get();
    if (!snapshot.exists || snapshot.data()?.isActive === false) throw new CheckoutError("A cart item is no longer available", 409);
    const data = snapshot.data()!;
    const price = Number(data.price);
    const stock = Number(data.stock);
    if (!Number.isFinite(price) || price <= 0 || !Number.isInteger(stock) || stock < item.quantity) {
      throw new CheckoutError("A cart item has changed. Review your cart and try again.", 409);
    }
    subtotal += price * item.quantity;
  }
  return subtotal;
}

function validateCheckoutCartItems(cartItems: unknown): CheckoutCartItem[] {
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    throw new CheckoutError("Cart items are required and must not be empty");
  }

  if (cartItems.length > MAX_CART_ITEMS) {
    throw new CheckoutError(`Cart cannot contain more than ${MAX_CART_ITEMS} items`);
  }

  const normalizedItems = cartItems.map((item, index) => {
    const rawItem = item as Partial<CheckoutCartItem>;
    const productId = typeof rawItem.productId === "string" ? rawItem.productId.trim() : "";
    const quantity = typeof rawItem.quantity === "number" ? rawItem.quantity : NaN;

    if (!productId) {
      throw new CheckoutError(`Cart item ${index + 1} is missing a valid product ID`);
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY) {
      throw new CheckoutError(`Cart item ${index + 1} must have a quantity between 1 and ${MAX_ITEM_QUANTITY}`);
    }

    return { productId, quantity };
  });

  const consolidated = new Map<string, number>();
  normalizedItems.forEach(({ productId, quantity }) => {
    const combinedQuantity = (consolidated.get(productId) || 0) + quantity;
    if (combinedQuantity > MAX_ITEM_QUANTITY) {
      throw new CheckoutError(`Combined quantity for product "${productId}" cannot exceed ${MAX_ITEM_QUANTITY}`);
    }
    consolidated.set(productId, combinedQuantity);
  });

  return Array.from(consolidated, ([productId, quantity]) => ({ productId, quantity }));
}

app.post("/api/checkout/coupon", async (req, res) => {
  try {
    enforceCheckoutRateLimit(req);
    const code = normalizeCouponCode(req.body?.couponCode);
    const cartItems = validateCheckoutCartItems(req.body?.cartItems);
    const itemsSubtotal = await calculateTrustedCouponSubtotal(cartItems);
    const snapshot = await adminDb.collection("checkout_coupons").doc(getCouponDocumentId(code)).get();
    const discountAmount = resolveCouponDiscount(snapshot.exists ? snapshot.data() || null : null, itemsSubtotal);
    res.json({ success: true, code, discountAmount, itemsSubtotal });
  } catch (error: any) {
    res.status(error.statusCode || 400).json({ error: error.message || "Coupon could not be applied" });
  }
});

// Secure transaction-based checkout endpoint
app.post("/api/checkout", async (req, res) => {
  try {
    enforceCheckoutRateLimit(req);
  } catch (error: any) {
    return res.status(error.statusCode || 429).json({ error: error.message || "Too many checkout attempts" });
  }

  const {
    customerUid: requestedCustomerUid,
    customerName,
    customerPhone,
    customerPhone2,
    customerEmail,
    customerAddress,
    district,
    city,
    paymentMethod,
    cartItems, // Array of { productId, quantity }
    couponCode: requestedCouponCode,
  } = req.body;

  let customerUid: string;
  let validatedCartItems: CheckoutCartItem[];
  let idempotencyKey: string | null;
  let requestHash: string;
  let validatedPaymentMethod: "cod" | "whatsapp_confirm" | "payhere";
  try {
    customerUid = await resolveCheckoutCustomerUid(req);
    if (requestedCustomerUid && requestedCustomerUid !== "guest" && requestedCustomerUid !== customerUid) {
      throw new CheckoutError("Checkout customer identity does not match the signed-in account", 403);
    }
    validateCheckoutDetails(req.body);
    validatedPaymentMethod = validatePaymentMethod(paymentMethod);
    validatedCartItems = validateCheckoutCartItems(cartItems);
    idempotencyKey = getIdempotencyKey(req);
    requestHash = createCheckoutRequestHash(req.body, validatedCartItems);
    if (paymentMethod && paymentMethod !== "cod") throw new CheckoutError("Only Cash on Delivery is currently available", 400);
  } catch (error: any) {
    return res.status(error.statusCode || 400).json({ error: error.message || "Invalid checkout request" });
  }

  try {
    const finalizedOrder = await adminDb.runTransaction(async (transaction) => {
      const idempotencyRef = idempotencyKey
        ? adminDb.collection(CHECKOUT_IDEMPOTENCY_COLLECTION).doc(hashValue(idempotencyKey))
        : null;

      if (idempotencyRef) {
        const idempotencySnap = await transaction.get(idempotencyRef);
        if (idempotencySnap.exists) {
          const idempotencyData = idempotencySnap.data();

          if (idempotencyData?.requestHash !== requestHash) {
            throw new CheckoutError("Idempotency key was already used for a different checkout request", 409);
          }

          if (idempotencyData?.status === "succeeded" && idempotencyData.order) {
            return idempotencyData.order;
          }
        }
      }

      const offlineLimitRefs = validatedPaymentMethod === "payhere" ? [] : [
        {
          ref: adminDb.collection(CHECKOUT_ABUSE_COLLECTION).doc(hashValue(`offline-phone:${String(customerPhone).replace(/\D/gu, "")}`)),
          maximum: OFFLINE_CHECKOUT_PHONE_LIMIT,
        },
        {
          ref: adminDb.collection(CHECKOUT_ABUSE_COLLECTION).doc(hashValue(`offline-network:${getClientRateLimitKey(req)}`)),
          maximum: OFFLINE_CHECKOUT_NETWORK_LIMIT,
        },
      ];
      const offlineLimitSnapshots = await Promise.all(offlineLimitRefs.map(({ ref }) => transaction.get(ref)));
      const offlineLimitUpdates = offlineLimitRefs.map(({ ref, maximum }, index) => ({
        ref,
        data: nextCheckoutAbuseCounter(offlineLimitSnapshots[index].data() || null, maximum),
      }));

      let itemsSubtotal = 0;
      const verifiedItems = [];
      const productUpdates: Array<{ ref: FirebaseFirestore.DocumentReference; newStock: number }> = [];

      // 1. Fetch, validate, and price each product inside the transaction
      for (const item of validatedCartItems) {
        const productRef = adminDb.collection("products").doc(item.productId);
        const productSnap = await transaction.get(productRef);

        if (!productSnap.exists) {
          throw new CheckoutError(`Product with ID "${item.productId}" was not found.`, 404);
        }

        const pData = productSnap.data()!;
        if (pData.isActive === false) {
          throw new CheckoutError(`Product "${pData.name || item.productId}" is not available for purchase.`, 409);
        }

        const currentStock = Number(pData.stock);
        if (!Number.isInteger(currentStock) || currentStock < item.quantity) {
          throw new CheckoutError(`Insufficient stock for product "${pData.name}". Available: ${Number.isFinite(currentStock) ? currentStock : 0}, Requested: ${item.quantity}`, 409);
        }

        const truePrice = Number(pData.price);
        if (!Number.isFinite(truePrice) || truePrice <= 0) {
          throw new Error(`Product "${pData.name}" has an invalid price configuration in the database.`);
        }

        itemsSubtotal += truePrice * item.quantity;

        verifiedItems.push({
          productId: item.productId,
          name: pData.name,
          price: truePrice,
          quantity: item.quantity,
          imageUrl: pData.imageUrl || ""
        });
        productUpdates.push({ ref: productRef, newStock: currentStock - item.quantity });
      }

      // 2. Fetch shipping options from website settings securely
      const settingsRef = adminDb.collection("settings").doc("website");
      const settingsSnap = await transaction.get(settingsRef);
      const settings = settingsSnap.exists ? settingsSnap.data() : null;

      const couponCode = requestedCouponCode ? normalizeCouponCode(requestedCouponCode) : "";
      let discountAmount = 0;
      if (couponCode) {
        const couponRef = adminDb.collection("checkout_coupons").doc(getCouponDocumentId(couponCode));
        const couponSnapshot = await transaction.get(couponRef);
        discountAmount = resolveCouponDiscount(couponSnapshot.exists ? couponSnapshot.data() || null : null, itemsSubtotal);
      }
      const totals = calculateTrustedCheckoutTotals(itemsSubtotal, district, settings || null, discountAmount);

      // 3. Generate a sequential order number using a central counter document
      const counterRef = adminDb.collection("counters").doc("orders");
      const counterSnap = await transaction.get(counterRef);
      
      let currentSeq = 100000; // start index so first order is ZY100001
      if (counterSnap.exists) {
        const counterData = counterSnap.data()!;
        if (counterData.currentSeq !== undefined) {
          currentSeq = Number(counterData.currentSeq);
        }
      }
      
      const nextSeq = currentSeq + 1;
      transaction.set(counterRef, { currentSeq: nextSeq }, { merge: true });
      offlineLimitUpdates.forEach(({ ref, data }) => transaction.set(ref, data, { merge: true }));
      const orderNumber = `ZY${nextSeq}`;

      // 4. Atomically decrease product stock
      productUpdates.forEach((update) => transaction.update(update.ref, { stock: Math.max(0, update.newStock) }));

      // 5. Store the finalized order document
      const orderRef = adminDb.collection("orders").doc();
      const payHereFields = validatedPaymentMethod === "payhere"
        ? buildInitialPayHereOrderFields(orderRef.id, totals.grandTotalPrice)
        : null;
      const paymentTransaction = payHereFields?.paymentTransaction;
      const orderData = {
        orderNumber,
        customerUid: customerUid || "guest",
        customerName,
        customerPhone,
        customerPhone2: customerPhone2 || "",
        customerEmail: customerEmail || "guest@zyro.lk",
        customerAddress,
        district,
        city: city || "",
        items: verifiedItems,
        itemsSubtotal: totals.itemsSubtotal,
        discountAmount: totals.discountAmount,
        deliveryFee: totals.deliveryFee,
        totalPrice: totals.grandTotalPrice,
        ...(couponCode ? { couponCode } : {}),
        status: "pending",
        stockDeducted: true,
        paymentMethod: validatedPaymentMethod,
        ...(payHereFields ? {
          paymentProvider: payHereFields.paymentProvider,
          paymentStatus: payHereFields.paymentStatus,
          paymentAttempt: payHereFields.paymentAttempt,
          paymentGatewayOrderId: payHereFields.paymentGatewayOrderId,
          paymentTimeline: payHereFields.paymentTimeline,
          stockReservationStatus: payHereFields.stockReservationStatus,
          stockReservationExpiresAt: payHereFields.stockReservationExpiresAt,
          stockRestorationApplied: false,
        } : {
          paymentStatus: "not_required",
          stockReservationStatus: "reserved",
          stockReservationExpiresAt: new Date(Date.now() + COD_CONFIRMATION_WINDOW_MS),
          stockRestorationApplied: false,
        }),
        createdAt: new Date().toISOString()
      };

      transaction.set(orderRef, orderData);
      if (paymentTransaction) {
        transaction.create(adminDb.collection("payment_transactions").doc(paymentTransaction.gatewayOrderId), {
          provider: "payhere",
          orderId: orderRef.id,
          gatewayOrderId: paymentTransaction.gatewayOrderId,
          attempt: paymentTransaction.attempt,
          amount: paymentTransaction.amount,
          currency: paymentTransaction.currency,
          status: "initialized",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }

      const order = {
        id: orderRef.id,
        ...orderData
      };

      if (idempotencyRef) {
        transaction.set(idempotencyRef, {
          keyHash: hashValue(idempotencyKey!),
          requestHash,
          status: "succeeded",
          orderId: orderRef.id,
          orderNumber,
          order,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      }

      return order;
    });

    res.json({
      success: true,
      order: finalizedOrder,
      ...(finalizedOrder.paymentMethod === "payhere"
        ? { paymentSession: createPayHereSessionForOrder(finalizedOrder) }
        : {}),
    });
  } catch (error: any) {
    console.error("Checkout Transaction Failed:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to process checkout transaction" });
  }
});

const requireSupplierAdminAuth: express.RequestHandler = async (req, res, next) => {
  const authHeader = req.header("Authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const decodedToken = await adminAuth.verifyIdToken(match[1]);
    if (hasAdminAccess(decodedToken)) {
      next();
      return;
    }

    res.status(403).json({ error: "Admin access required" });
  } catch (error) {
    console.warn("[Supplier API] Failed admin authentication:", error);
    res.status(401).json({ error: "Invalid or expired authentication token" });
  }
};

const requireCustomerAuth: express.RequestHandler = async (req, res, next) => {
  const match = (req.header("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    const decodedToken = await adminAuth.verifyIdToken(match[1]);
    res.locals.customerUid = decodedToken.uid;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired authentication token" });
  }
};

app.post("/api/orders/:orderId/cancel", requireCustomerAuth, async (req, res) => {
  const orderId = String(req.params.orderId || "").trim();
  if (!orderId) return res.status(400).json({ error: "A valid order ID is required" });

  try {
    const result = await adminDb.runTransaction(async (transaction) => {
      const orderRef = adminDb.collection("orders").doc(orderId);
      const orderSnap = await transaction.get(orderRef);
      if (!orderSnap.exists) throw new CheckoutError("Order not found", 404);

      const order = orderSnap.data()!;
      const currentStatus = String(order.status || "pending").toLowerCase();
      assertCustomerCanCancelOrder(res.locals.customerUid, order.customerUid, currentStatus);
      const { shouldRestoreStock, quantities } = buildOrderStatusPlan(
        order.status, "cancelled", order.stockDeducted, order.stockRestorationApplied, order.items,
      );
      const cancellingUnsettledPayHere = shouldRestoreStock
        && order.paymentMethod === "payhere"
        && new Set(["awaiting_payment", "pending"]).has(String(order.paymentStatus || ""));
      const cancellingPaidPayHere = shouldRestoreStock && order.paymentMethod === "payhere" && order.paymentStatus === "paid";

      const productStocks: Array<{ ref: FirebaseFirestore.DocumentReference; stock: number; quantity: number }> = [];
      for (const [productId, quantity] of quantities) {
        const productRef = adminDb.collection("products").doc(productId);
        const productSnap = await transaction.get(productRef);
        const stock = requireCurrentProductStock(productSnap.exists, productSnap.data()?.stock);
        productStocks.push({ ref: productRef, stock, quantity });
      }

      productStocks.forEach(({ ref, stock, quantity }) => transaction.update(ref, { stock: stock + quantity }));
      transaction.update(orderRef, {
        status: "cancelled",
        statusUpdatedAt: FieldValue.serverTimestamp(),
        ...(shouldRestoreStock ? {
          stockRestorationApplied: true,
          stockRestoredAt: FieldValue.serverTimestamp(),
          stockReservationStatus: "released",
          stockReservationExpiresAt: FieldValue.delete(),
          ...(cancellingUnsettledPayHere ? {
            paymentStatus: "cancelled",
            paymentTimeline: appendPaymentTimeline(order.paymentTimeline, createPaymentTimelineEvent("cancelled", "Order cancelled and reserved stock released", "customer")),
          } : {}),
          ...(cancellingPaidPayHere ? {
            paymentReviewRequired: true,
            paymentReviewReason: "cancelled_paid_order",
          } : {}),
        } : {}),
      });
      if (cancellingUnsettledPayHere && typeof order.paymentGatewayOrderId === "string") {
        transaction.set(adminDb.collection("payment_transactions").doc(order.paymentGatewayOrderId), {
          status: "cancelled",
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      return { status: "cancelled", stockRestored: shouldRestoreStock };
    });
    return res.json({ success: true, ...result });
  } catch (error: any) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Failed to cancel order" });
  }
});

app.post("/api/orders/:orderId/status", requireSupplierAdminAuth, async (req, res) => {
  const orderId = String(req.params.orderId || "").trim();
  const newStatus = typeof req.body?.status === "string" ? req.body.status.trim().toLowerCase() : "";
  const allowedStatuses = new Set(["pending", "confirmed", "processing", "packed", "shipped", "delivered", "cancelled"]);
  if (!orderId || !allowedStatuses.has(newStatus)) {
    return res.status(400).json({ error: "A valid order ID and status are required" });
  }

  try {
    const result = await adminDb.runTransaction(async (transaction) => {
      const orderRef = adminDb.collection("orders").doc(orderId);
      const orderSnap = await transaction.get(orderRef);
      if (!orderSnap.exists) throw new CheckoutError("Order not found", 404);
      const order = orderSnap.data()!;
      const { shouldRestoreStock, quantities } = buildOrderStatusPlan(
        order.status, newStatus, order.stockDeducted, order.stockRestorationApplied, order.items,
      );
      const cancellingUnsettledPayHere = shouldRestoreStock
        && order.paymentMethod === "payhere"
        && new Set(["awaiting_payment", "pending"]).has(String(order.paymentStatus || ""));
      const cancellingPaidPayHere = shouldRestoreStock && order.paymentMethod === "payhere" && order.paymentStatus === "paid";
      const committingOfflineReservation = !shouldRestoreStock
        && order.paymentMethod !== "payhere"
        && order.stockReservationStatus === "reserved"
        && newStatus !== "pending"
        && newStatus !== "cancelled";
      const productStocks: Array<{ ref: FirebaseFirestore.DocumentReference; stock: number; quantity: number }> = [];
      for (const [productId, quantity] of quantities) {
        const productRef = adminDb.collection("products").doc(productId);
        const productSnap = await transaction.get(productRef);
        const stock = requireCurrentProductStock(productSnap.exists, productSnap.data()?.stock);
        productStocks.push({ ref: productRef, stock, quantity });
      }

      productStocks.forEach(({ ref, stock, quantity }) => transaction.update(ref, { stock: stock + quantity }));
      transaction.update(orderRef, {
        status: newStatus,
        statusUpdatedAt: FieldValue.serverTimestamp(),
        ...(committingOfflineReservation ? {
          stockReservationStatus: "committed",
          stockReservationExpiresAt: FieldValue.delete(),
          stockReservationCommittedAt: FieldValue.serverTimestamp(),
        } : {}),
        ...(shouldRestoreStock ? {
          stockRestorationApplied: true,
          stockRestoredAt: FieldValue.serverTimestamp(),
          stockReservationStatus: "released",
          stockReservationExpiresAt: FieldValue.delete(),
          ...(cancellingUnsettledPayHere ? {
            paymentStatus: "cancelled",
            paymentTimeline: appendPaymentTimeline(order.paymentTimeline, createPaymentTimelineEvent("cancelled", "Order cancelled and reserved stock released", "system")),
          } : {}),
          ...(cancellingPaidPayHere ? {
            paymentReviewRequired: true,
            paymentReviewReason: "cancelled_paid_order",
          } : {}),
        } : {}),
      });
      if (cancellingUnsettledPayHere && typeof order.paymentGatewayOrderId === "string") {
        transaction.set(adminDb.collection("payment_transactions").doc(order.paymentGatewayOrderId), {
          status: "cancelled",
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      return { status: newStatus, stockRestored: shouldRestoreStock };
    });
    return res.json({ success: true, ...result });
  } catch (error: any) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Failed to update order status" });
  }
});

// Configure Vite integration or asset serving based on the environment
async function initServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath, {
      setHeaders(res, filePath) {
        const isHashedAsset = filePath.includes(`${path.sep}assets${path.sep}`);
        res.setHeader("Cache-Control", isHashedAsset
          ? "public, max-age=31536000, immutable"
          : "no-cache");
      },
    }));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Express server listening on http://0.0.0.0:${PORT}`);
  });
}

initServer().catch((err) => {
  console.error("Failed to start fullstack server:", err);
});
