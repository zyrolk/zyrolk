import { createHash } from "node:crypto";
import { ApiError } from "../errors";
import {
  parseOrderPrivateFulfilment,
  projectCustomerShipments,
  type CustomerShipmentProjection,
} from "./orderFulfilmentGroups";

export const GUEST_RECOVERY_TOKEN_BYTES = 32;
export const GUEST_RECOVERY_TOKEN_LENGTH = 43;
export const GUEST_RECOVERY_GENERIC_ERROR = "Order details could not be verified.";

export interface GuestRecoveryMetadata {
  version: 1;
  tokenHash: string;
  issuedAt: string;
}

export interface GuestOrderTrackingItem {
  name: string;
  imageUrl: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface GuestOrderTrackingShipment {
  status: "shipped" | "delivered";
  courier: string;
  trackingNumber: string;
  trackingUrl: string | null;
  shippedAt: string;
  deliveredAt: string | null;
}

export interface GuestOrderTrackingProjection {
  orderNumber: string;
  placedAt: string;
  status: "pending" | "confirmed" | "processing" | "packed" | "shipped" | "delivered" | "cancelled";
  items: GuestOrderTrackingItem[];
  itemsSubtotal: number;
  discount: number;
  deliveryFee: number;
  totalPrice: number;
  shipments: GuestOrderTrackingShipment[];
}

export class GuestOrderRecoveryError extends ApiError {
  constructor() {
    super(GUEST_RECOVERY_GENERIC_ERROR, 401, GUEST_RECOVERY_GENERIC_ERROR);
  }
}

const isBase64Url = (value: string): boolean => /^[A-Za-z0-9_-]+$/u.test(value);

export function validateGuestRecoveryToken(value: unknown): string {
  if (typeof value !== "string"
    || value.length !== GUEST_RECOVERY_TOKEN_LENGTH
    || !isBase64Url(value)) {
    throw new GuestOrderRecoveryError();
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw new GuestOrderRecoveryError();
  }
  if (decoded.length !== GUEST_RECOVERY_TOKEN_BYTES) throw new GuestOrderRecoveryError();
  return value;
}

export function hashGuestRecoveryToken(token: string): string {
  return createHash("sha256").update(validateGuestRecoveryToken(token)).digest("hex");
}

export function buildGuestRecoveryMetadata(token: string, issuedAt: string): GuestRecoveryMetadata {
  return {
    version: 1,
    tokenHash: hashGuestRecoveryToken(token),
    issuedAt,
  };
}

const cleanText = (value: unknown, maximum: number): string => (
  typeof value === "string" ? value.trim().replace(/\s+/gu, " ").slice(0, maximum) : ""
);

const safeNumber = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

const safeImageUrl = (value: unknown): string => {
  const candidate = cleanText(value, 2_000);
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate, "https://zyro.lk");
    return parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
};

const safeStatus = (value: unknown): GuestOrderTrackingProjection["status"] => {
  const status = cleanText(value, 30).toLowerCase();
  return ["pending", "confirmed", "processing", "packed", "shipped", "delivered", "cancelled"].includes(status)
    ? status as GuestOrderTrackingProjection["status"]
    : "pending";
};

const projectShipments = (
  privateOrder: Parameters<typeof projectCustomerShipments>[0],
  groups: Parameters<typeof projectCustomerShipments>[1],
): GuestOrderTrackingShipment[] => projectCustomerShipments(privateOrder, groups).map((shipment: CustomerShipmentProjection) => ({
  status: shipment.status,
  courier: cleanText(shipment.courierName, 80),
  trackingNumber: cleanText(shipment.trackingNumber, 120),
  trackingUrl: shipment.trackingUrl,
  shippedAt: cleanText(shipment.shippedAt, 80),
  deliveredAt: cleanText(shipment.deliveredAt, 80) || null,
}));

export function projectGuestOrderTracking(
  orderId: string,
  orderData: FirebaseFirestore.DocumentData,
  privateData: FirebaseFirestore.DocumentData,
): GuestOrderTrackingProjection {
  if (cleanText(orderData.customerUid, 200) !== "guest") throw new GuestOrderRecoveryError();
  const orderNumber = cleanText(orderData.orderNumber, 80);
  const placedAt = cleanText(orderData.createdAt, 80);
  if (!orderNumber || !placedAt) throw new GuestOrderRecoveryError();

  let privateOrder;
  try {
    privateOrder = parseOrderPrivateFulfilment(orderId, privateData);
  } catch {
    throw new GuestOrderRecoveryError();
  }

  const rawItems = Array.isArray(orderData.items) ? orderData.items : [];
  const items = rawItems.flatMap((rawItem: unknown): GuestOrderTrackingItem[] => {
    if (!rawItem || typeof rawItem !== "object") return [];
    const item = rawItem as Record<string, unknown>;
    const name = cleanText(item.name, 240) || "Product";
    const quantity = Math.max(1, Math.min(99, Math.floor(safeNumber(item.quantity)) || 1));
    const unitPrice = safeNumber(item.price);
    return [{ name, imageUrl: safeImageUrl(item.imageUrl), quantity, unitPrice, lineTotal: unitPrice * quantity }];
  });

  return {
    orderNumber,
    placedAt,
    status: safeStatus(orderData.status),
    items,
    itemsSubtotal: safeNumber(orderData.itemsSubtotal),
    discount: safeNumber(orderData.discountAmount),
    deliveryFee: safeNumber(orderData.deliveryFee),
    totalPrice: safeNumber(orderData.totalPrice),
    shipments: projectShipments(privateOrder, privateOrder.fulfilmentGroups),
  };
}

export async function lookupGuestOrderByRecoveryToken(
  db: FirebaseFirestore.Firestore,
  token: unknown,
): Promise<GuestOrderTrackingProjection> {
  const tokenHash = hashGuestRecoveryToken(validateGuestRecoveryToken(token));
  const matches = await db.collection("order_private")
    .where("guestRecovery.tokenHash", "==", tokenHash)
    .limit(2)
    .get();
  if (matches.size !== 1) throw new GuestOrderRecoveryError();

  const privateSnapshot = matches.docs[0];
  const privateData = privateSnapshot.data();
  if (privateData?.guestRecovery?.version !== 1 || privateData.guestRecovery.tokenHash !== tokenHash) {
    throw new GuestOrderRecoveryError();
  }
  const orderSnapshot = await db.collection("orders").doc(privateSnapshot.id).get();
  if (!orderSnapshot.exists) throw new GuestOrderRecoveryError();
  return projectGuestOrderTracking(privateSnapshot.id, orderSnapshot.data() || {}, privateData);
}
