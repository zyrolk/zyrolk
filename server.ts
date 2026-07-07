import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { A2ZConnectorService } from "./src/services/connectors/a2z-website/A2ZConnectorService";

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

  if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
    return res.status(400).json({ error: "Cart items are required and must not be empty" });
  }

  if (!customerName || !customerPhone || !customerAddress || !district) {
    return res.status(400).json({ error: "Required customer details (name, phone, address, district) are missing" });
  }

  try {
    const finalizedOrder = await adminDb.runTransaction(async (transaction) => {
      let itemsSubtotal = 0;
      const verifiedItems = [];

      // 1. Fetch, validate, and price each product inside the transaction
      for (const item of cartItems) {
        const productRef = adminDb.collection("products").doc(item.productId);
        const productSnap = await transaction.get(productRef);

        if (!productSnap.exists) {
          throw new Error(`Product with ID "${item.productId}" was not found.`);
        }

        const pData = productSnap.data()!;
        if (pData.stock === undefined || pData.stock < item.quantity) {
          throw new Error(`Insufficient stock for product "${pData.name}". Available: ${pData.stock || 0}, Requested: ${item.quantity}`);
        }

        const truePrice = Number(pData.price);
        if (isNaN(truePrice)) {
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
      for (const item of cartItems) {
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
    res.status(500).json({ error: error.message || "Failed to process checkout transaction" });
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

// Server-side proxy for testing supplier connections securely (bypasses CORS)
app.post("/api/test-supplier", async (req, res) => {
  const { websiteUrl, endpoint } = req.body;
  
  if (!websiteUrl) {
    return res.status(400).json({ error: "Website URL is required" });
  }

  const isA2Z = websiteUrl.toLowerCase().includes("a2z") || (endpoint || '').toLowerCase().includes("a2z");

  if (isA2Z) {
    try {
      console.log("[A2Z-Connector] Triggering secure connection test via A2Z Connector Service...");
      const credentials = await getA2ZCredentials();
      const products = await A2ZConnectorService.fetchCatalog(websiteUrl, credentials);
      
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

  // Combine URL and endpoint safely for generic suppliers
  let targetUrl = websiteUrl.trim().endsWith('/') ? websiteUrl.trim() : websiteUrl.trim() + '/';
  const cleanEndpoint = endpoint.trim();
  if (cleanEndpoint.startsWith('/')) {
    targetUrl += cleanEndpoint.substring(1);
  } else {
    targetUrl += cleanEndpoint;
  }

  try {
    console.log("Testing connection to target URL:", targetUrl);
    
    let fetchResponse: any = null;
    let data: any = null;
    let success = false;

    // 1. Try real external fetch with timeout
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      
      const resObj = await fetch(targetUrl, { signal: controller.signal });
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
app.post("/api/fetch-supplier", async (req, res) => {
  const { websiteUrl, endpoint } = req.body;
  
  if (!websiteUrl) {
    return res.status(400).json({ error: "Website URL is required" });
  }

  const isA2Z = websiteUrl.toLowerCase().includes("a2z") || (endpoint || '').toLowerCase().includes("a2z");

  if (isA2Z) {
    try {
      console.log("[A2Z-Connector] Orchestrating secure, authenticated catalog sync from A2Z Supplier...");
      const credentials = await getA2ZCredentials();
      const products = await A2ZConnectorService.fetchCatalog(websiteUrl, credentials);
      return res.json({ success: true, products });
    } catch (error: any) {
      console.error("[A2Z-Connector] Catalog fetch failed:", error);
      return res.status(500).json({
        success: false,
        error: error.message || "Failed to authenticate or retrieve from A2Z supplier."
      });
    }
  }

  // Combine URL and endpoint safely for generic suppliers
  let targetUrl = websiteUrl.trim().endsWith('/') ? websiteUrl.trim() : websiteUrl.trim() + '/';
  const cleanEndpoint = (endpoint || '').trim();
  if (cleanEndpoint) {
    if (cleanEndpoint.startsWith('/')) {
      targetUrl += cleanEndpoint.substring(1);
    } else {
      targetUrl += cleanEndpoint;
    }
  }

  try {
    console.log("Fetching from target URL:", targetUrl);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
    
    const resObj = await fetch(targetUrl, { signal: controller.signal });
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
