import { createHash } from "node:crypto";

export const CONTACT_RATE_LIMIT_COLLECTION = "contact_inquiry_limits";
export const CONTACT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const CONTACT_RATE_LIMIT_MAX_REQUESTS = 5;

export interface ContactInquiryInput {
  name: string;
  phone: string;
  email: string;
  message: string;
}

export interface ContactRateLimitState {
  count: number;
  windowStartedAt: string;
}

export class ContactInquiryError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "ContactInquiryError";
  }
}

const cleanSingleLine = (value: unknown, field: string, maximum: number): string => {
  if (typeof value !== "string") throw new ContactInquiryError(`${field} is required.`);
  const normalized = value.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized) throw new ContactInquiryError(`${field} is required.`);
  if (normalized.length > maximum) throw new ContactInquiryError(`${field} cannot exceed ${maximum} characters.`);
  return normalized;
};

export function validateContactInquiry(value: unknown): ContactInquiryInput {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const name = cleanSingleLine(input.name, "Name", 120);
  const phone = cleanSingleLine(input.phone, "Phone", 30);
  const phoneDigits = phone.replace(/\D/gu, "");
  if (phoneDigits.length < 9 || phoneDigits.length > 15) {
    throw new ContactInquiryError("Phone must contain a valid contact number.");
  }

  const emailValue = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (emailValue.length > 160 || (emailValue && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(emailValue))) {
    throw new ContactInquiryError("Email must be valid when provided.");
  }

  if (typeof input.message !== "string") throw new ContactInquiryError("Message is required.");
  const message = input.message
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .trim();
  if (!message) throw new ContactInquiryError("Message is required.");
  if (message.length > 2000) throw new ContactInquiryError("Message cannot exceed 2000 characters.");

  return { name, phone, email: emailValue, message };
}

const timestampMillis = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === "object" && "toMillis" in value
    && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return Number((value as { toMillis: () => number }).toMillis());
  }
  return 0;
};

export function nextContactRateLimitState(
  previous: ContactRateLimitState | Record<string, unknown> | null,
  now = Date.now(),
): ContactRateLimitState {
  const startedAt = timestampMillis(previous?.windowStartedAt);
  const count = Math.max(0, Number(previous?.count) || 0);
  if (!startedAt || now - startedAt >= CONTACT_RATE_LIMIT_WINDOW_MS) {
    return { count: 1, windowStartedAt: new Date(now).toISOString() };
  }
  if (count >= CONTACT_RATE_LIMIT_MAX_REQUESTS) {
    throw new ContactInquiryError("Too many enquiries were sent. Please wait before trying again.", 429);
  }
  return { count: count + 1, windowStartedAt: new Date(startedAt).toISOString() };
}

export function contactRateLimitDocumentId(scope: "network" | "phone", value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) throw new ContactInquiryError("Contact request identity is unavailable.", 400);
  return createHash("sha256").update(`contact:${scope}:${normalized}`, "utf8").digest("hex");
}
