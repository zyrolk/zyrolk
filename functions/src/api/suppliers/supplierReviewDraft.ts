import { Firestore } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import {
  parseSupplierProductFieldOwnership,
  SupplierProductFieldOwnership,
} from "./supplierFieldOwnership";
import { isCanonicalActiveCategory } from "./supplierProductMapping";
import { decorateSupplierReviewQueueAdminMedia } from "../../scheduled/supplierReviewQueue";

const DRAFT_FIELDS = new Set([
  "categoryId",
  "subcategoryId",
  "expectedPendingRevision",
  "expectedUpdatedAt",
]);

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const cleanText = (value: unknown, field: string, options: { required?: boolean; maxLength?: number } = {}): string => {
  if (typeof value !== "string") throw new ApiError(`${field} must be text.`, 400);
  const cleaned = value.trim();
  if (options.required !== false && !cleaned) throw new ApiError(`${field} is required.`, 400);
  if (cleaned.length > (options.maxLength || 160)) throw new ApiError(`${field} is invalid.`, 400);
  return cleaned;
};

const cleanRevision = (value: unknown): string => {
  const revision = cleanText(value, "expectedPendingRevision");
  if (!/^[a-f0-9]{64}$/u.test(revision)) throw new ApiError("expectedPendingRevision is invalid.", 400);
  return revision;
};

const cleanUpdatedAt = (value: unknown): string => {
  const updatedAt = cleanText(value, "expectedUpdatedAt", { maxLength: 80 });
  if (!Number.isFinite(Date.parse(updatedAt))) throw new ApiError("expectedUpdatedAt is invalid.", 400);
  return updatedAt;
};

export interface SupplierReviewDraftInput {
  categoryId: string;
  subcategoryId: string;
  expectedPendingRevision: string;
  expectedUpdatedAt: string;
}

export interface SupplierReviewDraftReviewer {
  uid: string;
  email: string;
}

export function parseSupplierReviewDraftInput(value: unknown): SupplierReviewDraftInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("Supplier review draft is invalid.", 400);
  }
  const input = value as Record<string, unknown>;
  const unknownFields = Object.keys(input).filter((field) => !DRAFT_FIELDS.has(field));
  if (unknownFields.length > 0) throw new ApiError(`Supplier review draft contains unsupported fields: ${unknownFields.join(", ")}.`, 400);
  return {
    categoryId: cleanText(input.categoryId, "categoryId"),
    subcategoryId: input.subcategoryId === undefined
      ? ""
      : cleanText(input.subcategoryId, "subcategoryId", { required: false }),
    expectedPendingRevision: cleanRevision(input.expectedPendingRevision),
    expectedUpdatedAt: cleanUpdatedAt(input.expectedUpdatedAt),
  };
}

const timestampString = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const candidate = value as { toDate?: () => Date; toMillis?: () => number };
    if (typeof candidate.toDate === "function") return candidate.toDate().toISOString();
    if (typeof candidate.toMillis === "function") return new Date(candidate.toMillis()).toISOString();
  }
  return "";
};

const taxonomyOwnership = (
  existing: unknown,
  reviewer: SupplierReviewDraftReviewer,
  updatedAt: string,
): SupplierProductFieldOwnership => {
  const ownership = parseSupplierProductFieldOwnership(existing);
  return {
    ...ownership,
    category: {
      owner: "admin",
      sourceId: null,
      updatedAt,
      updatedBy: reviewer.uid.slice(0, 160),
      reason: "review_decision",
    },
    subcategory: {
      owner: "admin",
      sourceId: null,
      updatedAt,
      updatedBy: reviewer.uid.slice(0, 160),
      reason: "review_decision",
    },
  };
};

const validateCanonicalTaxonomy = async (
  transaction: FirebaseFirestore.Transaction,
  db: Firestore,
  categoryId: string,
  subcategoryId: string,
): Promise<void> => {
  const categorySnapshot = await transaction.get(db.collection("categories").doc(categoryId));
  if (!categorySnapshot.exists || !isCanonicalActiveCategory(categorySnapshot.data() as { isActive?: boolean; taxonomyCandidate?: boolean } | undefined)) {
    throw new ApiError("Select an active canonical Zyro category.", 422);
  }
  const category = categorySnapshot.data() || {};
  const subcategories = Array.isArray(category.subcategories) ? category.subcategories : [];
  const activeSubcategories = subcategories.filter((entry) => (
    entry && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).isActive !== false
  )) as Array<Record<string, unknown>>;
  if (activeSubcategories.length > 0 && !activeSubcategories.some((entry) => String(entry.id || "").trim() === subcategoryId)) {
    throw new ApiError("Select an active subcategory belonging to the category.", 422);
  }
  if (subcategoryId && !activeSubcategories.some((entry) => String(entry.id || "").trim() === subcategoryId)) {
    throw new ApiError("Select an active subcategory belonging to the category.", 422);
  }
};

export async function saveSupplierReviewDraft(
  db: Firestore,
  queueItemId: string,
  input: SupplierReviewDraftInput,
  reviewer: SupplierReviewDraftReviewer,
): Promise<{ queueItemId: string; item: Record<string, unknown> & { id: string } }> {
  const reference = db.collection("supplier_review_queue").doc(queueItemId);
  let updatedRecord: Record<string, unknown> | null = null;

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) throw new ApiError("Supplier review item could not be found.", 404);
    const current = snapshot.data() || {};
    const queueState = String(current.queueState || "").trim().toLowerCase();
    const status = String(current.status || current.reviewStatus || "").trim().toLowerCase();
    if (!(queueState === "review_pending" || (!queueState && status === "pending"))) {
      throw new ApiError("Only a pending supplier review item can save a draft.", 409);
    }
    const currentRevision = String(current.supplierOfferPendingRevision || "").trim();
    if (!currentRevision || currentRevision !== input.expectedPendingRevision) {
      throw new ApiError("This supplier review changed after it was opened. Reload before saving.", 409);
    }
    const currentUpdatedAt = timestampString(current.updatedAt);
    if (!currentUpdatedAt || currentUpdatedAt !== input.expectedUpdatedAt) {
      throw new ApiError("This supplier review changed after it was opened. Reload before saving.", 409);
    }

    await validateCanonicalTaxonomy(transaction, db, input.categoryId, input.subcategoryId);
    const payload = asRecord(current.productPayload);
    const now = new Date().toISOString();
    const ownership = taxonomyOwnership(payload.supplierFieldOwnership, reviewer, now);
    const nextPayload = {
      ...payload,
      category: input.categoryId,
      subcategory: input.subcategoryId,
      supplierFieldOwnership: ownership,
    };
    updatedRecord = {
      ...current,
      id: queueItemId,
      productPayload: nextPayload,
      updatedAt: now,
    };
    transaction.update(reference, {
      productPayload: nextPayload,
      updatedAt: now,
    });
  });

  if (!updatedRecord) throw new ApiError("Supplier review draft could not be saved.", 500);
  const [item] = await decorateSupplierReviewQueueAdminMedia([updatedRecord as Record<string, unknown> & { id: string }]);
  return { queueItemId, item: item as Record<string, unknown> & { id: string } };
}
