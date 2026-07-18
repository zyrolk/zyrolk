import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type PayHereMode = "sandbox" | "live";
export type PayHerePaymentStatus = "awaiting_payment" | "pending" | "paid" | "cancelled" | "failed" | "chargedback" | "expired";

export interface PayHereConfig {
  mode: PayHereMode;
  merchantId: string;
  merchantSecret: string;
  publicSiteUrl: string;
}

export interface PayHereNotification {
  merchantId: string;
  gatewayOrderId: string;
  paymentId: string;
  amount: string;
  currency: string;
  statusCode: string;
  signature: string;
  method: string;
  statusMessage: string;
  maskedCard: string;
}

export interface PayHerePaymentSession {
  provider: "payhere";
  mode: PayHereMode;
  actionUrl: string;
  fields: Record<string, string>;
}

export interface PayHereOrderInput {
  id: string;
  gatewayOrderId: string;
  totalPrice: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerAddress: string;
  city?: string;
  orderNumber?: string;
}

export class PaymentError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const md5Upper = (value: string): string => createHash("md5").update(value, "utf8").digest("hex").toUpperCase();
const clean = (value: unknown, maxLength: number): string => typeof value === "string"
  ? value.trim().replace(/[\u0000-\u001F\u007F]/g, "").slice(0, maxLength)
  : "";

export function formatPayHereAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new PaymentError("Payment amount must be greater than zero");
  return value.toFixed(2);
}

export function normalizePublicSiteUrl(value: string, mode: PayHereMode): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PaymentError("PUBLIC_SITE_URL must be a valid absolute URL", 503);
  }
  if (parsed.protocol !== "https:" && !(mode === "sandbox" && parsed.protocol === "http:")) {
    throw new PaymentError("PayHere live mode requires an HTTPS PUBLIC_SITE_URL", 503);
  }
  return parsed.origin;
}

export function loadPayHereConfig(environment: NodeJS.ProcessEnv, merchantSecret: string): PayHereConfig | null {
  const merchantId = clean(environment.PAYHERE_MERCHANT_ID, 80);
  const secret = clean(merchantSecret || environment.PAYHERE_MERCHANT_SECRET, 240);
  if (!merchantId && !secret) return null;
  if (!merchantId || !secret) throw new PaymentError("PayHere merchant credentials are incomplete", 503);
  const rawMode = clean(environment.PAYHERE_MODE, 20).toLowerCase() || "sandbox";
  if (rawMode !== "sandbox" && rawMode !== "live") throw new PaymentError("PAYHERE_MODE must be sandbox or live", 503);
  const mode = rawMode as PayHereMode;
  const publicSiteUrl = normalizePublicSiteUrl(clean(environment.PUBLIC_SITE_URL, 500), mode);
  return { mode, merchantId, merchantSecret: secret, publicSiteUrl };
}

export function createPayHereCheckoutHash(config: PayHereConfig, gatewayOrderId: string, amount: number, currency = "LKR"): string {
  const formattedAmount = formatPayHereAmount(amount);
  return md5Upper(`${config.merchantId}${gatewayOrderId}${formattedAmount}${currency}${md5Upper(config.merchantSecret)}`);
}

export function createGuestPaymentAccessToken(config: PayHereConfig, orderId: string): string {
  return createHmac("sha256", config.merchantSecret).update(`zyro-payment-access:${orderId}`).digest("hex");
}

export function verifyGuestPaymentAccessToken(config: PayHereConfig, orderId: string, token: unknown): boolean {
  const supplied = clean(token, 128);
  const expected = createGuestPaymentAccessToken(config, orderId);
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied, "utf8"), Buffer.from(expected, "utf8"));
}

export function parsePayHereNotification(value: Record<string, unknown>): PayHereNotification {
  const notification = {
    merchantId: clean(value.merchant_id, 80),
    gatewayOrderId: clean(value.order_id, 200),
    paymentId: clean(value.payment_id, 200),
    amount: clean(value.payhere_amount, 40),
    currency: clean(value.payhere_currency, 10).toUpperCase(),
    statusCode: clean(value.status_code, 10),
    signature: clean(value.md5sig, 64).toUpperCase(),
    method: clean(value.method, 40),
    statusMessage: clean(value.status_message, 240),
    maskedCard: clean(value.card_no, 40),
  };
  if (!notification.merchantId || !notification.gatewayOrderId || !notification.amount || !notification.currency || !notification.statusCode || !notification.signature) {
    throw new PaymentError("Incomplete PayHere notification");
  }
  if (notification.paymentId === "" && notification.statusCode === "2") throw new PaymentError("Successful PayHere notification is missing a payment ID");
  return notification;
}

export function verifyPayHereNotification(config: PayHereConfig, notification: PayHereNotification): boolean {
  if (notification.merchantId !== config.merchantId) return false;
  const expected = md5Upper(
    `${notification.merchantId}${notification.gatewayOrderId}${notification.amount}${notification.currency}${notification.statusCode}${md5Upper(config.merchantSecret)}`,
  );
  if (notification.signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(notification.signature, "utf8"), Buffer.from(expected, "utf8"));
}

export function mapPayHereStatus(statusCode: string): PayHerePaymentStatus {
  if (statusCode === "2") return "paid";
  if (statusCode === "0") return "pending";
  if (statusCode === "-1") return "cancelled";
  if (statusCode === "-2") return "failed";
  if (statusCode === "-3") return "chargedback";
  throw new PaymentError("Unsupported PayHere payment status");
}

function splitCustomerName(value: string): { firstName: string; lastName: string } {
  const parts = clean(value, 120).split(/\s+/).filter(Boolean);
  return {
    firstName: parts.shift() || "Customer",
    lastName: parts.join(" ") || "Zyro.lk",
  };
}

export function buildPayHerePaymentSession(config: PayHereConfig, order: PayHereOrderInput): PayHerePaymentSession {
  const amount = formatPayHereAmount(order.totalPrice);
  const { firstName, lastName } = splitCustomerName(order.customerName);
  const accessToken = createGuestPaymentAccessToken(config, order.id);
  const returnParams = new URLSearchParams({ payment: "return", order: order.id, access: accessToken });
  const cancelParams = new URLSearchParams({ payment: "cancel", order: order.id, access: accessToken });
  return {
    provider: "payhere",
    mode: config.mode,
    actionUrl: config.mode === "live" ? "https://www.payhere.lk/pay/checkout" : "https://sandbox.payhere.lk/pay/checkout",
    fields: {
      merchant_id: config.merchantId,
      return_url: `${config.publicSiteUrl}/?${returnParams.toString()}`,
      cancel_url: `${config.publicSiteUrl}/?${cancelParams.toString()}`,
      notify_url: `${config.publicSiteUrl}/api/payments/payhere/notify`,
      first_name: firstName,
      last_name: lastName,
      email: clean(order.customerEmail, 160),
      phone: clean(order.customerPhone, 30),
      address: clean(order.customerAddress, 500),
      city: clean(order.city, 80) || clean(order.customerAddress, 80),
      country: "Sri Lanka",
      order_id: order.gatewayOrderId,
      items: clean(order.orderNumber, 80) || `Zyro.lk order ${order.id.slice(0, 8).toUpperCase()}`,
      currency: "LKR",
      amount,
      hash: createPayHereCheckoutHash(config, order.gatewayOrderId, order.totalPrice),
      custom_1: order.id,
      custom_2: "zyro-web-checkout",
    },
  };
}

export function amountsMatch(expected: number, received: string): boolean {
  const parsed = Number(received);
  return Number.isFinite(parsed) && formatPayHereAmount(expected) === parsed.toFixed(2);
}

export function createPaymentTimelineEvent(status: PayHerePaymentStatus, label: string, source: "checkout" | "payhere" | "system" | "customer", at = new Date()): Record<string, string> {
  return {
    id: `${at.getTime()}-${status}`,
    status,
    label: clean(label, 160) || status.replace(/_/g, " "),
    source,
    at: at.toISOString(),
  };
}

export function appendPaymentTimeline(existing: unknown, event: Record<string, string>, limit = 20): Record<string, string>[] {
  const timeline = Array.isArray(existing)
    ? existing.filter((entry): entry is Record<string, string> => Boolean(entry && typeof entry === "object")).slice(-(limit - 1))
    : [];
  return [...timeline, event];
}
