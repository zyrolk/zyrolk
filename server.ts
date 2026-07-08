import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { A2ZConnectorService } from "./src/services/connectors/a2z-website/A2ZConnectorService";
import { getApprovedSupplierHosts, validateSupplierRequestTarget } from "./src/server/security/supplierUrlProtection";

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
const ADMIN_EMAIL = "zyrolkofficial@gmail.com";

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

function validateCheckoutCartItems(cartItems: unknown): CheckoutCartItem[] {
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    throw new CheckoutError("Cart items are required and must not be empty");
  }

  if (cartItems.length > MAX_CART_ITEMS) {
    throw new CheckoutError(`Cart cannot contain more than ${MAX_CART_ITEMS} items`);
  }

  return cartItems.map((item, index) => {
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
}

// Secure transaction-based checkout endpoint
app.post("/api/checkout", async (req, res) => {
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
  try {
    validatedCartItems = validateCheckoutCartItems(cartItems);
  } catch (error: any) {
    return res.status(error.statusCode || 400).json({ error: error.message || "Invalid cart items" });
  }

  if (!customerName || !customerPhone || !customerAddress || !district) {
    return res.status(400).json({ error: "Required customer details (name, phone, address, district) are missing" });
  }

  try {
    const finalizedOrder = await adminDb.runTransaction(async (transaction) => {
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
        paymentMethod: paymentMethod || "cod",
        createdAt: new Date().toISOString()
      };

      transaction.set(orderRef, orderData);

      return {
        id: orderRef.id,
        ...orderData
      };
    });

    res.json({ success: true, order: finalizedOrder });
  } catch (error: any) {
    console.error("Checkout Transaction Failed:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to process checkout transaction" });
  }
});

// Helper to retrieve credentials from Firebase for any A2Z-related supplier
async function getA2ZCredentials() {
  let credentials = {
    username: process.env.A2Z_USERNAME || "",
    password: process.env.A2Z_PASSWORD || ""
  };
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
          username: config.username || settings.username || data.username || process.env.A2Z_USERNAME || "",
          password: config.password || settings.password || data.password || process.env.A2Z_PASSWORD || ""
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

    const userSnap = await adminDb.collection("users").doc(decodedToken.uid).get();
    const userRole = userSnap.exists ? userSnap.data()?.role : null;

    if (userRole === "admin") {
      next();
      return;
    }

    res.status(403).json({ error: "Admin access required" });
  } catch (error) {
    console.warn("[Supplier API] Failed admin authentication:", error);
    res.status(401).json({ error: "Invalid or expired authentication token" });
  }
};

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
      error: error.message || "Supplier URL is not allowed."
    });
  }

  const isA2Z = validatedTarget.targetUrl.toLowerCase().includes("a2z");

  if (isA2Z) {
    try {
      console.log("[A2Z-Connector] Orchestrating secure, authenticated catalog sync from A2Z Supplier...");
      const credentials = await getA2ZCredentials();
      const products = await A2ZConnectorService.fetchCatalog(validatedTarget.targetUrl, credentials);
      return res.json({ success: true, products });
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

    return res.json({ success: true, products: data });

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
