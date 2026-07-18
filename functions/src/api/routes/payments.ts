import * as express from "express";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCheckoutRateLimiter, getClientRateLimitKey, hashValue } from "../checkout/checkoutLogic";
import {
  PaymentError,
  amountsMatch,
  appendPaymentTimeline,
  buildPayHerePaymentSession,
  createPaymentTimelineEvent,
  loadPayHereConfig,
  mapPayHereStatus,
  parsePayHereNotification,
  verifyGuestPaymentAccessToken,
  verifyPayHereNotification,
} from "../payments/payhereLogic";

const PAYMENT_RESERVATION_MS = 20 * 60 * 1000;
const FAILURE_STATUSES = new Set(["failed", "cancelled", "expired"]);
const enforcePaymentReadLimit = createCheckoutRateLimiter(new Map(), 60_000, 30);
const enforcePaymentMutationLimit = createCheckoutRateLimiter(new Map(), 60_000, 8);
const enforceWebhookLimit = createCheckoutRateLimiter(new Map(), 60_000, 120);

interface PaymentRouteDependencies {
  db: FirebaseFirestore.Firestore;
  auth: { verifyIdToken(token: string): Promise<{ uid: string }> };
  logger?: PaymentRouteLogger;
}

interface PaymentRouteLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const silentPaymentLogger: PaymentRouteLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function sendPaymentError(
  res: express.Response,
  error: unknown,
  logger: PaymentRouteLogger,
  options: { logMessage: string; fallbackMessage: string; fallbackStatusCode?: number; context?: Record<string, unknown> },
): void {
  const candidateStatus = Number((error as { statusCode?: unknown })?.statusCode);
  const statusCode = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599
    ? candidateStatus
    : options.fallbackStatusCode || 500;
  const candidateMessage = (error as { message?: unknown })?.message;
  const message = statusCode >= 500 || typeof candidateMessage !== "string" || !candidateMessage.trim()
    ? options.fallbackMessage
    : candidateMessage;
  logger.error(options.logMessage, { ...(options.context || {}), statusCode, errorName: error instanceof Error ? error.name : "Error" });
  res.status(statusCode).json({ error: message });
}

async function resolveOptionalCustomerUid(authorization: string | undefined, auth: PaymentRouteDependencies["auth"]): Promise<string | null> {
  const match = (authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  try {
    return (await auth.verifyIdToken(match[1])).uid;
  } catch {
    throw new PaymentError("Invalid or expired authentication token", 401);
  }
}

function requirePayHereConfig() {
  const config = loadPayHereConfig(process.env, process.env.PAYHERE_MERCHANT_SECRET || "");
  if (!config) throw new PaymentError("Online payments are not configured", 503);
  return config;
}

function safeOrderStatus(order: FirebaseFirestore.DocumentData) {
  return {
    id: String(order.id || ""),
    orderNumber: String(order.orderNumber || ""),
    status: String(order.status || "pending"),
    paymentMethod: String(order.paymentMethod || "cod"),
    paymentStatus: String(order.paymentStatus || "not_required"),
    paymentReference: String(order.paymentReference || ""),
    paymentTimeline: Array.isArray(order.paymentTimeline) ? order.paymentTimeline.slice(-20) : [],
    totalPrice: Number(order.totalPrice) || 0,
    createdAt: String(order.createdAt || ""),
  };
}

async function authorizeOrderAccess(order: FirebaseFirestore.DocumentData, authorization: string | undefined, accessToken: unknown, auth: PaymentRouteDependencies["auth"]): Promise<void> {
  const config = requirePayHereConfig();
  if (verifyGuestPaymentAccessToken(config, String(order.id || ""), accessToken)) return;
  const uid = await resolveOptionalCustomerUid(authorization, auth);
  if (!uid || order.customerUid !== uid) throw new PaymentError("Order not found", 404);
}

function paymentOrderInput(order: FirebaseFirestore.DocumentData) {
  return {
    id: String(order.id),
    gatewayOrderId: String(order.paymentGatewayOrderId),
    totalPrice: Number(order.totalPrice),
    customerName: String(order.customerName || "Customer"),
    customerEmail: String(order.customerEmail || ""),
    customerPhone: String(order.customerPhone || ""),
    customerAddress: String(order.customerAddress || ""),
    city: String(order.city || ""),
    orderNumber: String(order.orderNumber || ""),
  };
}

export function getPayHereAvailability(): { enabled: boolean; mode?: "sandbox" | "live" } {
  const config = loadPayHereConfig(process.env, process.env.PAYHERE_MERCHANT_SECRET || "");
  return config ? { enabled: true, mode: config.mode } : { enabled: false };
}

export function createPayHereSessionForOrder(order: FirebaseFirestore.DocumentData) {
  return buildPayHerePaymentSession(requirePayHereConfig(), paymentOrderInput(order));
}

export function registerPaymentRoutes(app: express.Express, dependencies: PaymentRouteDependencies): void {
  const { db, auth, logger = silentPaymentLogger } = dependencies;
  app.post("/api/payments/config", (_req, res) => {
    try {
      res.json(getPayHereAvailability());
    } catch (error: any) {
      sendPaymentError(res, error, logger, {
        logMessage: "PayHere configuration validation failed.",
        fallbackMessage: "Online payments are unavailable",
        fallbackStatusCode: 503,
        context: { route: "/api/payments/config" },
      });
    }
  });

  app.post("/api/payments/status", async (req, res) => {
    try {
      enforcePaymentReadLimit(getClientRateLimitKey(req.header("x-forwarded-for"), req.ip));
      const orderId = typeof req.body?.orderId === "string" ? req.body.orderId.trim() : "";
      if (!orderId || orderId.length > 200) throw new PaymentError("A valid order ID is required");
      const snapshot = await db.collection("orders").doc(orderId).get();
      if (!snapshot.exists) throw new PaymentError("Order not found", 404);
      const order = { id: snapshot.id, ...snapshot.data()! };
      await authorizeOrderAccess(order, req.header("Authorization"), req.body?.accessToken, auth);
      res.json({ success: true, order: safeOrderStatus(order) });
    } catch (error: any) {
      sendPaymentError(res, error, logger, {
        logMessage: "Payment status request failed.",
        fallbackMessage: "Payment status could not be loaded",
        context: { route: "/api/payments/status" },
      });
    }
  });

  app.post("/api/payments/:orderId/retry", async (req, res) => {
    try {
      enforcePaymentMutationLimit(getClientRateLimitKey(req.header("x-forwarded-for"), req.ip));
      const orderId = String(req.params.orderId || "").trim();
      if (!orderId || orderId.length > 200) throw new PaymentError("A valid order ID is required");
      const config = requirePayHereConfig();
      const orderSnapshot = await db.collection("orders").doc(orderId).get();
      if (!orderSnapshot.exists) throw new PaymentError("Order not found", 404);
      await authorizeOrderAccess({ id: orderSnapshot.id, ...orderSnapshot.data()! }, req.header("Authorization"), req.body?.accessToken, auth);

      const retriedOrder = await db.runTransaction(async (transaction) => {
        const orderRef = db.collection("orders").doc(orderId);
        const snapshot = await transaction.get(orderRef);
        if (!snapshot.exists) throw new PaymentError("Order not found", 404);
        const order = snapshot.data()!;
        if (order.paymentMethod !== "payhere") throw new PaymentError("This order does not use PayHere", 409);
        if (!FAILURE_STATUSES.has(String(order.paymentStatus || ""))) throw new PaymentError("This payment is not eligible for retry", 409);

        const productUpdates: Array<{ ref: FirebaseFirestore.DocumentReference; stock: number }> = [];
        for (const item of Array.isArray(order.items) ? order.items : []) {
          const productId = typeof item?.productId === "string" ? item.productId.trim() : "";
          const quantity = Number(item?.quantity);
          if (!productId || !Number.isInteger(quantity) || quantity <= 0) throw new PaymentError("Order inventory data is invalid", 409);
          const productRef = db.collection("products").doc(productId);
          const productSnapshot = await transaction.get(productRef);
          const stock = Number(productSnapshot.data()?.stock);
          if (!productSnapshot.exists || !Number.isFinite(stock) || stock < quantity) {
            throw new PaymentError(`Insufficient stock to retry payment for ${String(item?.name || "an item")}`, 409);
          }
          productUpdates.push({ ref: productRef, stock: stock - quantity });
        }

        const attempt = Math.max(1, Math.floor(Number(order.paymentAttempt) || 1)) + 1;
        const gatewayOrderId = `${orderId}-${attempt}`;
        const transactionRef = db.collection("payment_transactions").doc(gatewayOrderId);
        const transactionSnapshot = await transaction.get(transactionRef);
        if (transactionSnapshot.exists) throw new PaymentError("A payment retry is already in progress", 409);

        productUpdates.forEach((update) => transaction.update(update.ref, { stock: update.stock }));
        const now = new Date();
        const event = createPaymentTimelineEvent("awaiting_payment", `Payment attempt ${attempt} started`, "customer", now);
        const nextOrder = {
          ...order,
          id: orderId,
          paymentAttempt: attempt,
          paymentGatewayOrderId: gatewayOrderId,
          paymentStatus: "awaiting_payment",
          paymentTimeline: appendPaymentTimeline(order.paymentTimeline, event),
          stockReservationStatus: "reserved",
          stockReservationExpiresAt: Timestamp.fromMillis(now.getTime() + PAYMENT_RESERVATION_MS),
          stockRestorationApplied: false,
          status: "pending",
          statusUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };
        transaction.update(orderRef, {
          paymentAttempt: nextOrder.paymentAttempt,
          paymentGatewayOrderId: nextOrder.paymentGatewayOrderId,
          paymentStatus: nextOrder.paymentStatus,
          paymentTimeline: nextOrder.paymentTimeline,
          stockReservationStatus: nextOrder.stockReservationStatus,
          stockReservationExpiresAt: nextOrder.stockReservationExpiresAt,
          stockRestorationApplied: false,
          status: "pending",
          statusUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.create(transactionRef, {
          provider: "payhere",
          orderId,
          gatewayOrderId,
          attempt,
          amount: Number(order.totalPrice),
          currency: "LKR",
          status: "initialized",
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return nextOrder;
      });

      res.json({ success: true, order: safeOrderStatus(retriedOrder), paymentSession: buildPayHerePaymentSession(config, paymentOrderInput(retriedOrder)) });
    } catch (error: any) {
      sendPaymentError(res, error, logger, {
        logMessage: "PayHere retry failed.",
        fallbackMessage: "Payment could not be retried",
        context: { route: "/api/payments/:orderId/retry", orderId: req.params.orderId },
      });
    }
  });

  app.post("/api/payments/payhere/notify", express.urlencoded({ extended: false, limit: "20kb" }), async (req, res) => {
    try {
      enforceWebhookLimit(getClientRateLimitKey(req.header("x-forwarded-for"), req.ip));
      const config = requirePayHereConfig();
      const notification = parsePayHereNotification(req.body || {});
      if (!verifyPayHereNotification(config, notification)) throw new PaymentError("Invalid PayHere notification signature", 401);

      const mappedStatus = mapPayHereStatus(notification.statusCode);
      const outcome = await db.runTransaction(async (transaction) => {
        const paymentRef = db.collection("payment_transactions").doc(notification.gatewayOrderId);
        const paymentSnapshot = await transaction.get(paymentRef);
        if (!paymentSnapshot.exists) throw new PaymentError("Unknown PayHere order", 404);
        const payment = paymentSnapshot.data()!;
        if (payment.currency !== notification.currency || !amountsMatch(Number(payment.amount), notification.amount)) {
          throw new PaymentError("PayHere payment amount or currency does not match the order", 409);
        }

        const orderRef = db.collection("orders").doc(String(payment.orderId || ""));
        const orderSnapshot = await transaction.get(orderRef);
        if (!orderSnapshot.exists) throw new PaymentError("Payment order not found", 404);
        const order = orderSnapshot.data()!;
        if (order.paymentGatewayOrderId !== notification.gatewayOrderId) {
          transaction.update(paymentRef, {
            status: mappedStatus === "paid" ? "manual_review" : mappedStatus,
            gatewayStatus: mappedStatus,
            paymentId: notification.paymentId,
            method: notification.method,
            maskedCard: notification.maskedCard,
            statusMessage: notification.statusMessage,
            verifiedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          if (mappedStatus === "paid") {
            transaction.update(orderRef, {
              paymentReviewRequired: true,
              paymentTimeline: appendPaymentTimeline(order.paymentTimeline, createPaymentTimelineEvent(
                "failed",
                "Payment received for an older attempt; support review required",
                "payhere",
              )),
              updatedAt: FieldValue.serverTimestamp(),
            });
          }
          return { status: mappedStatus === "paid" ? "manual_review" : mappedStatus, duplicate: false };
        }

        const receiptRef = notification.paymentId
          ? db.collection("payment_receipts").doc(hashValue(notification.paymentId))
          : null;
        const receiptSnapshot = receiptRef ? await transaction.get(receiptRef) : null;
        if (receiptSnapshot?.exists && receiptSnapshot.data()?.gatewayOrderId !== notification.gatewayOrderId) {
          throw new PaymentError("Duplicate PayHere payment reference", 409);
        }
        if (payment.status === "paid" && mappedStatus === "paid") return { status: "paid", duplicate: true };

        const reservationWasReleased = FAILURE_STATUSES.has(String(order.paymentStatus || "")) || order.stockReservationStatus === "released";
        if (mappedStatus === "paid" && reservationWasReleased) {
          transaction.update(paymentRef, {
            status: "manual_review",
            gatewayStatus: mappedStatus,
            paymentId: notification.paymentId,
            statusMessage: notification.statusMessage,
            updatedAt: FieldValue.serverTimestamp(),
          });
          transaction.update(orderRef, {
            paymentReviewRequired: true,
            paymentTimeline: appendPaymentTimeline(order.paymentTimeline, createPaymentTimelineEvent("failed", "Late payment received after stock release; support review required", "payhere")),
            updatedAt: FieldValue.serverTimestamp(),
          });
          return { status: "manual_review", duplicate: false };
        }

        const shouldRestore = (mappedStatus === "failed" || mappedStatus === "cancelled")
          && order.stockReservationStatus === "reserved"
          && order.stockRestorationApplied !== true;
        const productUpdates: Array<{ ref: FirebaseFirestore.DocumentReference; stock: number }> = [];
        if (shouldRestore) {
          for (const item of Array.isArray(order.items) ? order.items : []) {
            const productId = typeof item?.productId === "string" ? item.productId.trim() : "";
            const quantity = Number(item?.quantity);
            if (!productId || !Number.isInteger(quantity) || quantity <= 0) continue;
            const productRef = db.collection("products").doc(productId);
            const productSnapshot = await transaction.get(productRef);
            if (productSnapshot.exists) {
              const stock = Number(productSnapshot.data()?.stock);
              productUpdates.push({ ref: productRef, stock: (Number.isFinite(stock) ? stock : 0) + quantity });
            }
          }
        }

        productUpdates.forEach((update) => transaction.update(update.ref, { stock: update.stock }));
        const timelineEvent = createPaymentTimelineEvent(
          mappedStatus,
          mappedStatus === "paid" ? "Payment verified by PayHere" : notification.statusMessage || `Payment ${mappedStatus}`,
          "payhere",
        );
        const orderUpdate: Record<string, unknown> = {
          paymentStatus: mappedStatus,
          paymentTimeline: appendPaymentTimeline(order.paymentTimeline, timelineEvent),
          paymentReference: notification.paymentId,
          paymentProvider: "payhere",
          paymentMethodDetail: notification.method,
          updatedAt: FieldValue.serverTimestamp(),
        };
        if (mappedStatus === "paid") {
          Object.assign(orderUpdate, {
            status: "confirmed",
            paidAt: FieldValue.serverTimestamp(),
            statusUpdatedAt: FieldValue.serverTimestamp(),
            stockReservationStatus: "committed",
          });
        } else if (shouldRestore) {
          Object.assign(orderUpdate, {
            status: "cancelled",
            statusUpdatedAt: FieldValue.serverTimestamp(),
            stockReservationStatus: "released",
            stockRestorationApplied: true,
            stockRestoredAt: FieldValue.serverTimestamp(),
          });
        }
        transaction.update(orderRef, orderUpdate);
        transaction.update(paymentRef, {
          status: mappedStatus,
          gatewayStatus: mappedStatus,
          paymentId: notification.paymentId,
          method: notification.method,
          maskedCard: notification.maskedCard,
          statusMessage: notification.statusMessage,
          verifiedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        if (receiptRef && !receiptSnapshot?.exists && mappedStatus === "paid") {
          transaction.create(receiptRef, {
            provider: "payhere",
            orderId: payment.orderId,
            gatewayOrderId: notification.gatewayOrderId,
            paymentIdHash: hashValue(notification.paymentId),
            createdAt: FieldValue.serverTimestamp(),
          });
        }
        return { status: mappedStatus, duplicate: false };
      });

      logger.info("PayHere notification verified.", {
        gatewayOrderId: notification.gatewayOrderId,
        paymentStatus: outcome.status,
        duplicate: outcome.duplicate,
      });
      res.status(200).send("OK");
    } catch (error: any) {
      logger.warn("PayHere notification rejected.", {
        reason: error instanceof Error ? error.message : "unknown",
        gatewayOrderId: typeof req.body?.order_id === "string" ? req.body.order_id.slice(0, 200) : "",
      });
      res.status(error?.statusCode || 400).send("REJECTED");
    }
  });
}

export function buildInitialPayHereOrderFields(orderId: string, totalPrice: number, now = new Date()) {
  const gatewayOrderId = `${orderId}-1`;
  return {
    paymentProvider: "payhere",
    paymentStatus: "awaiting_payment",
    paymentAttempt: 1,
    paymentGatewayOrderId: gatewayOrderId,
    paymentTimeline: [createPaymentTimelineEvent("awaiting_payment", "Secure PayHere payment initialized", "checkout", now)],
    stockReservationStatus: "reserved",
    stockReservationExpiresAt: Timestamp.fromMillis(now.getTime() + PAYMENT_RESERVATION_MS),
    stockRestorationApplied: false,
    paymentTransaction: {
      gatewayOrderId,
      amount: totalPrice,
      currency: "LKR",
      attempt: 1,
    },
  };
}
