import { createHash } from "crypto";

export const QUALIFYING_REVIEW_ORDER_STATUSES = new Set([
  "confirmed",
  "processing",
  "packed",
  "shipped",
  "delivered",
]);

export class ReviewSystemError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function cleanReviewText(value: unknown, field: string, minLength: number, maxLength: number): string {
  if (typeof value !== "string") throw new ReviewSystemError(`${field} is required`);
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (cleaned.length < minLength || cleaned.length > maxLength) {
    throw new ReviewSystemError(`${field} must be between ${minLength} and ${maxLength} characters`);
  }
  return cleaned;
}

export function cleanProductId(value: unknown): string {
  return cleanReviewText(value, "Product ID", 1, 128);
}

export function normalizeRating(value: unknown): number {
  const rating = Number(value);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new ReviewSystemError("Rating must be a whole number from 1 to 5");
  }
  return rating;
}

export function deterministicCustomerDocumentId(userId: string, resourceId: string): string {
  return createHash("sha256").update(`${userId}:${resourceId}`).digest("hex").slice(0, 48);
}

export function orderContainsProduct(order: Record<string, unknown>, productId: string): boolean {
  if (!QUALIFYING_REVIEW_ORDER_STATUSES.has(String(order.status || "").toLowerCase())) return false;
  const items = Array.isArray(order.items) ? order.items : [];
  return items.some((item) => (
    item !== null &&
    typeof item === "object" &&
    String((item as Record<string, unknown>).productId || "").trim() === productId
  ));
}

export function selectVerifiedPurchaseOrder(
  orders: Array<{ id: string; data: Record<string, unknown> }>,
  productId: string,
): string | null {
  return orders.find(({ data }) => orderContainsProduct(data, productId))?.id || null;
}

export function normalizeVote(value: unknown): "helpful" | "not_helpful" {
  if (value !== "helpful" && value !== "not_helpful") {
    throw new ReviewSystemError("A valid vote is required");
  }
  return value;
}

export function calculateVoteDeltas(
  previous: unknown,
  next: "helpful" | "not_helpful",
): { helpful: number; notHelpful: number; removeVote: boolean } {
  if (previous === next) {
    return { helpful: next === "helpful" ? -1 : 0, notHelpful: next === "not_helpful" ? -1 : 0, removeVote: true };
  }
  return {
    helpful: (next === "helpful" ? 1 : 0) - (previous === "helpful" ? 1 : 0),
    notHelpful: (next === "not_helpful" ? 1 : 0) - (previous === "not_helpful" ? 1 : 0),
    removeVote: false,
  };
}
