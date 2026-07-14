import express from "express";
import path from "path";
import fs from "fs";
import { createHash } from "crypto";
import { createServer as createViteServer } from "vite";
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { A2ZConnectorService } from "./src/services/connectors/a2z-website/A2ZConnectorService";
import { getApprovedSupplierHosts, validateSupplierRequestTarget } from "./src/server/security/supplierUrlProtection";
import { getSupplierProductLimit } from "./src/services/supplierSyncSettings";

const app = express();
const PORT = 3000;

// Parse JSON request bodies
app.use(express.json());

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
const MAX_CART_ITEMS = 50;
const MAX_ITEM_QUANTITY = 99;
const CHECKOUT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const CHECKOUT_RATE_LIMIT_MAX_REQUESTS = 10;
const CHECKOUT_IDEMPOTENCY_COLLECTION = "checkout_idempotency";
const ALLOWED_PAYMENT_METHODS = new Set(["cod", "whatsapp_confirm"]);
const ADMIN_EMAIL = "zyrolkofficial@gmail.com";

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

function validatePaymentMethod(paymentMethod: unknown): "cod" | "whatsapp_confirm" {
  if (paymentMethod === undefined || paymentMethod === null || paymentMethod === "") {
    return "cod";
  }

  if (typeof paymentMethod !== "string" || !ALLOWED_PAYMENT_METHODS.has(paymentMethod)) {
    throw new CheckoutError("Payment method must be cod or whatsapp_confirm");
  }

  return paymentMethod as "cod" | "whatsapp_confirm";
}

function validateCheckoutDetails(body: Record<string, unknown>): void {
  const customerPhone = requireNonEmptyString(body.customerPhone, "Phone", 30);
  requireNonEmptyString(body.customerName, "Customer name", 120);
  requireNonEmptyString(body.customerAddress, "Address", 500);
  requireNonEmptyString(body.district, "District", 80);
  validatePaymentMethod(body.paymentMethod);

  const phoneDigits = customerPhone.replace(/\D/g, "");
  if (phoneDigits.length < 9 || phoneDigits.length > 15) {
    throw new CheckoutError("Phone must contain a valid contact number");
  }

  if (body.customerEmail !== undefined && body.customerEmail !== null && body.customerEmail !== "") {
    const email = String(body.customerEmail).trim();
    if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new CheckoutError("Customer email must be valid when provided");
    }
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
    cartItems,
  };

  return hashValue(JSON.stringify(requestShape));
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

// Secure transaction-based checkout endpoint
app.post("/api/checkout", async (req, res) => {
  try {
    enforceCheckoutRateLimit(req);
  } catch (error: any) {
    return res.status(error.statusCode || 429).json({ error: error.message || "Too many checkout attempts" });
  }

  const {
    customerUid,
    customerName,
    customerPhone,
    customerPhone2,
    customerEmail,
    customerAddress,
    district,
    city,
    paymentMethod,
    cartItems, // Array of { productId, quantity }
  } = req.body;

  let validatedCartItems: CheckoutCartItem[];
  let idempotencyKey: string | null;
  let requestHash: string;
  try {
    validateCheckoutDetails(req.body);
    validatedCartItems = validateCheckoutCartItems(cartItems);
    idempotencyKey = getIdempotencyKey(req);
    requestHash = createCheckoutRequestHash(req.body, validatedCartItems);
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

      let itemsSubtotal = 0;
      const verifiedItems = [];

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
        if (!Number.isFinite(currentStock) || currentStock < item.quantity) {
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
      }

      // 2. Fetch shipping options from website settings securely
      const settingsRef = adminDb.collection("settings").doc("website");
      const settingsSnap = await transaction.get(settingsRef);
      const settings = settingsSnap.exists ? settingsSnap.data() : null;

      const DISTRICT_DELIVERY: Record<string, number> = {
        "Colombo": 350,
        "Gampaha": 450,
        "Kalutara": 450,
        "Kandy": 550,
        "Galle": 550,
        "Matara": 550,
        "Jaffna": 650,
        "Kurunegala": 500,
        "Anuradhapura": 600,
        "Badulla": 600,
        "Ratnapura": 500,
        "Batticaloa": 650,
        "Trincomalee": 650,
        "Other": 600
      };

      const baseDeliveryCharge = (settings && settings.deliveryCharge !== undefined)
        ? Number(settings.deliveryCharge)
        : (DISTRICT_DELIVERY[district] || 500);

      const freeDeliveryThreshold = (settings && settings.freeDeliveryMin !== undefined)
        ? Number(settings.freeDeliveryMin)
        : 5000;

      const isEligibleForFreeDelivery = itemsSubtotal >= freeDeliveryThreshold;
      const deliveryFee = itemsSubtotal > 0
        ? (isEligibleForFreeDelivery ? 0 : baseDeliveryCharge)
        : 0;

      const grandTotalPrice = itemsSubtotal + deliveryFee;

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
      const orderNumber = `ZY${nextSeq}`;

      // 4. Atomically decrease product stock
      for (const item of validatedCartItems) {
        const productRef = adminDb.collection("products").doc(item.productId);
        const productSnap = await transaction.get(productRef); // read inside transaction
        const currentStock = productSnap.data()!.stock || 0;
        transaction.update(productRef, {
          stock: Math.max(0, currentStock - item.quantity)
        });
      }

      // 5. Store the finalized order document
      const orderRef = adminDb.collection("orders").doc();
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
        totalPrice: grandTotalPrice,
        status: "pending",
        stockDeducted: true,
        paymentMethod: paymentMethod || "cod",
        createdAt: new Date().toISOString()
      };

      transaction.set(orderRef, orderData);

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

    res.json({ success: true, order: finalizedOrder });
  } catch (error: any) {
    console.error("Checkout Transaction Failed:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to process checkout transaction" });
  }
});

// Helper to retrieve credentials from Firebase for any A2Z-related supplier
async function getA2ZCredentials() {
  const runtimeCredentials = {
    username: process.env.A2Z_USERNAME || "",
    password: process.env.A2Z_PASSWORD || ""
  };

  if (runtimeCredentials.username && runtimeCredentials.password) {
    return runtimeCredentials;
  }

  let credentials = { username: "", password: "" };
  try {
    const sourcesSnap = await adminDb.collection("supplierSources").get();
    sourcesSnap.forEach(doc => {
      const data = doc.data();
      const name = (data.supplierName || data.name || doc.id || "").toLowerCase();
      const url = (data.websiteUrl || data.config?.targetUrl || "").toLowerCase();
      
      if (name.includes("a2z") || url.includes("a2z") || doc.id.toLowerCase().includes("a2z")) {
        const config = data.config || {};
        const settings = data.settings || {};
        
        credentials = {
          username: config.username || settings.username || data.username || "",
          password: config.password || settings.password || data.password || ""
        };
      }
    });
  } catch (err) {
    console.warn("[A2Z-Connector] Could not read supplier credentials from Firestore; using environment variables if configured.");
  }

  if (!credentials.username || !credentials.password) {
    throw new Error("A2Z credentials are not configured. Set A2Z_USERNAME and A2Z_PASSWORD in the server environment or save credentials in supplierSources.");
  }

  return credentials;
}

const requireSupplierAdminAuth: express.RequestHandler = async (req, res, next) => {
  const authHeader = req.header("Authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const decodedToken = await adminAuth.verifyIdToken(match[1]);
    const email = (decodedToken.email || "").toLowerCase();

    if (email === ADMIN_EMAIL) {
      next();
      return;
    }

    res.status(403).json({ error: "Admin access required" });
  } catch (error) {
    console.warn("[Supplier API] Failed admin authentication:", error);
    res.status(401).json({ error: "Invalid or expired authentication token" });
  }
};

app.post("/api/orders/:orderId/status", requireSupplierAdminAuth, async (req, res) => {
  const orderId = String(req.params.orderId || "").trim();
  const newStatus = typeof req.body?.status === "string" ? req.body.status.trim().toLowerCase() : "";
  const allowedStatuses = new Set(["pending", "confirmed", "packed", "shipped", "delivered", "cancelled"]);
  if (!orderId || !allowedStatuses.has(newStatus)) {
    return res.status(400).json({ error: "A valid order ID and status are required" });
  }

  try {
    const result = await adminDb.runTransaction(async (transaction) => {
      const orderRef = adminDb.collection("orders").doc(orderId);
      const orderSnap = await transaction.get(orderRef);
      if (!orderSnap.exists) throw new CheckoutError("Order not found", 404);
      const order = orderSnap.data()!;
      const currentStatus = String(order.status || "pending").toLowerCase();
      if (currentStatus === "cancelled" && newStatus !== "cancelled") {
        throw new CheckoutError("Cancelled orders cannot be moved to another status", 409);
      }

      const shouldRestoreStock = newStatus === "cancelled" && order.stockDeducted === true && order.stockRestorationApplied !== true;
      const quantities = new Map<string, number>();
      if (shouldRestoreStock) {
        for (const item of Array.isArray(order.items) ? order.items : []) {
          const productId = typeof item?.productId === "string" ? item.productId.trim() : "";
          const quantity = Number(item?.quantity);
          if (productId && Number.isInteger(quantity) && quantity > 0) {
            quantities.set(productId, (quantities.get(productId) || 0) + quantity);
          }
        }
      }

      const productStocks: Array<{ ref: FirebaseFirestore.DocumentReference; stock: number; quantity: number }> = [];
      for (const [productId, quantity] of quantities) {
        const productRef = adminDb.collection("products").doc(productId);
        const productSnap = await transaction.get(productRef);
        if (productSnap.exists) {
          const stock = Number(productSnap.data()?.stock);
          productStocks.push({ ref: productRef, stock: Number.isFinite(stock) ? stock : 0, quantity });
        }
      }

      productStocks.forEach(({ ref, stock, quantity }) => transaction.update(ref, { stock: stock + quantity }));
      transaction.update(orderRef, {
        status: newStatus,
        statusUpdatedAt: FieldValue.serverTimestamp(),
        ...(shouldRestoreStock ? { stockRestorationApplied: true, stockRestoredAt: FieldValue.serverTimestamp() } : {}),
      });
      return { status: newStatus, stockRestored: shouldRestoreStock };
    });
    return res.json({ success: true, ...result });
  } catch (error: any) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Failed to update order status" });
  }
});

// Server-side proxy for testing supplier connections securely (bypasses CORS)
app.post("/api/test-supplier", requireSupplierAdminAuth, async (req, res) => {
  const { websiteUrl, endpoint } = req.body;
  
  if (!websiteUrl) {
    return res.status(400).json({ error: "Website URL is required" });
  }

  let validatedTarget;
  try {
    validatedTarget = await validateSupplierRequestTarget(websiteUrl, endpoint || "", await getApprovedSupplierHosts(adminDb));
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      status: "Failed",
      error: error.message || "Supplier URL is not allowed."
    });
  }

  const isA2Z = validatedTarget.targetUrl.toLowerCase().includes("a2z");

  if (isA2Z) {
    try {
      console.log("[A2Z-Connector] Triggering secure connection test via A2Z Connector Service...");
      const credentials = await getA2ZCredentials();
      const products = await A2ZConnectorService.fetchCatalog(validatedTarget.targetUrl, credentials);
      
      return res.json({
        success: true,
        status: "Connected",
        productsCount: products.length,
        sampleProduct: products[0] || null
      });
    } catch (error: any) {
      console.error("[A2Z-Connector] Connection test failed:", error);
      return res.status(200).json({
        success: false,
        status: "Failed",
        error: error.message || "Authentication or fetch failed with A2Z supplier."
      });
    }
  }

  try {
    console.log("Testing connection to target URL:", validatedTarget.targetUrl);
    
    let fetchResponse: any = null;
    let data: any = null;
    let success = false;

    // 1. Try real external fetch with timeout
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      
      const resObj = await fetch(validatedTarget.targetUrl, { signal: controller.signal, redirect: "error" });
      clearTimeout(timeoutId);
      
      if (resObj.ok) {
        data = await resObj.json();
        fetchResponse = resObj;
        success = true;
      } else {
        console.warn(`External fetch failed with status: ${resObj.status}`);
      }
    } catch (fetchErr: any) {
      console.warn("External fetch failed, trying local fallback:", fetchErr.message || fetchErr);
    }

    if (!success || !fetchResponse) {
      return res.status(200).json({
        success: false,
        status: "Failed",
        error: "Failed to connect to the supplier endpoint. Server returned non-200 status or timed out."
      });
    }

    // Verify response contains supplier products list
    const isProductsArray = Array.isArray(data) && (data.length === 0 || (data[0] && (data[0].sku || data[0].title || data[0].name || data[0].id)));
    
    if (!isProductsArray) {
      return res.status(200).json({
        success: false,
        status: "Failed",
        error: "Response format is invalid. Expected a JSON array of product objects."
      });
    }

    return res.json({
      success: true,
      status: "Connected",
      productsCount: data.length,
      sampleProduct: data[0] || null
    });

  } catch (error: any) {
    console.error("Test connection error:", error);
    return res.status(200).json({
      success: false,
      status: "Failed",
      error: error.message || "An unexpected network or parsing error occurred."
    });
  }
});

// Server-side proxy for fetching supplier products securely (bypasses CORS)
app.post("/api/fetch-supplier", requireSupplierAdminAuth, async (req, res) => {
  const { websiteUrl, endpoint, productLimit, sourceId, batchId } = req.body;
  const requestedProductLimit = getSupplierProductLimit(
    productLimit === undefined || productLimit === null ? 'All' : String(productLimit),
    250,
  );
  console.info('[SupplierLimitTrace] api-request-received', {
    sourceId: String(sourceId || 'unknown'),
    batchId: String(batchId || 'unknown'),
    requestProductLimit: productLimit ?? null,
    resolvedProductLimit: requestedProductLimit,
  });
  
  if (!websiteUrl) {
    return res.status(400).json({ error: "Website URL is required" });
  }

  let validatedTarget;
  try {
    validatedTarget = await validateSupplierRequestTarget(websiteUrl, endpoint || "", await getApprovedSupplierHosts(adminDb));
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      error: error.message || "Supplier URL is not allowed."
    });
  }

  const isA2Z = validatedTarget.targetUrl.toLowerCase().includes("a2z");

  if (isA2Z) {
    try {
      console.log("[A2Z-Connector] Orchestrating secure, authenticated catalog sync from A2Z Supplier...");
      const credentials = await getA2ZCredentials();
      const products = await A2ZConnectorService.fetchCatalog(validatedTarget.targetUrl, credentials);
      return res.json({ success: true, products, requestedProductLimit });
    } catch (error: any) {
      console.error("[A2Z-Connector] Catalog fetch failed:", error);
      return res.status(500).json({
        success: false,
        error: error.message || "Failed to authenticate or retrieve from A2Z supplier."
      });
    }
  }

  try {
    console.log("Fetching from target URL:", validatedTarget.targetUrl);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
    
    const resObj = await fetch(validatedTarget.targetUrl, { signal: controller.signal, redirect: "error" });
    clearTimeout(timeoutId);
    
    if (!resObj.ok) {
      throw new Error(`Supplier API returned HTTP ${resObj.status}`);
    }
    
    const data = await resObj.json();
    
    if (!Array.isArray(data)) {
      throw new Error("Invalid response format. Expected a JSON array of product objects.");
    }

    return res.json({ success: true, products: data, requestedProductLimit });

  } catch (error: any) {
    console.error("Fetch supplier error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch from the supplier endpoint."
    });
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
    app.use(express.static(distPath));
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
