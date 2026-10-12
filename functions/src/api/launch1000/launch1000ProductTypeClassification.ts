import { createHash } from "node:crypto";
import { Firestore, Transaction } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import {
  buildSupplierReviewBusinessQueueProjection,
  decorateSupplierReviewQueueAdminMedia,
  SupplierQueueRecord,
} from "../../scheduled/supplierReviewQueue";
import { isCanonicalActiveCategory } from "../suppliers/supplierProductMapping";
import {
  createSupplierAuditEvent,
  SupplierAuditActor,
} from "../suppliers/supplierAuditTrail";
import { parseSupplierProductFieldOwnership } from "../suppliers/supplierFieldOwnership";
import {
  supplierReviewCanonicalProductIds,
  supplierReviewRecordIsLiveEquivalent,
} from "../suppliers/supplierReviewLiveEquivalence";
import {
  getSupplierQueueIdentityCandidate,
  resolveSupplierQueueIdentity,
  ResolvedSupplierQueueIdentity,
  SupplierQueueIdentityDocumentReader,
} from "../suppliers/supplierQueueIdentity";
import { recomputeProductValidation } from "../suppliers/supplierReviewDraft";
import {
  Launch1000ManifestEntry,
  Launch1000ManifestSnapshot,
  launch1000RecordFingerprint,
  loadLaunch1000Snapshot,
} from "./launch1000Snapshot";

export const LAUNCH1000_PRODUCT_TYPE_CLASSIFICATION_FIELD = "Product Type" as const;
export const LAUNCH1000_PRODUCT_TYPE_CLASSIFICATION_AUDIT_ACTION = "classification_approved" as const;

/**
 * This is intentionally an exact historical Pilot-10 allowlist. The checked-in
 * manifest remains the authority for the value; this map prevents the endpoint
 * from becoming a general-purpose Product Type editor or supplier mapping API.
 */
export const LAUNCH1000_PRODUCT_TYPE_CLASSIFICATION_ALLOWLIST = Object.freeze({
  "dropex-adl0019": "tool or hardware",
  "dropex-aju0010": "audio device",
  "dropex-aju0013": "audio device",
  "dropex-aju0021": "audio device",
  "dropex-aju0027": "household product",
  "dropex-ajuch-3338": "household product",
} as const);

export type Launch1000ProductTypeEvidenceKind = "product_title" | "product_description" | "managed_image";

export interface Launch1000ProductTypeEvidenceReference {
  kind: Launch1000ProductTypeEvidenceKind;
  ref: string;
}
export interface Launch1000ProductTypeClassificationInput {
  decision: "approve";
  confirmed: true;
  manifestRevision: string;
  productType: string;
  evidence: Launch1000ProductTypeEvidenceReference[];
  rationale: string;
  expectedPendingRevision: string;
  expectedUpdatedAt: string;
  expectedFingerprint: string;
}

export interface Launch1000ProductTypeClassificationRecord {
  source: "zyro-derived";
  decision: "approved";
  confirmed: true;
  field: typeof LAUNCH1000_PRODUCT_TYPE_CLASSIFICATION_FIELD;
  value: string;
  manifestRevision: string;
  sourcePendingRevision: string;
  sourceUpdatedAt: string;
  sourceFingerprint: string;
  sourceEvidenceFingerprint: string;
  evidence: Launch1000ProductTypeEvidenceReference[];
  evidenceSnapshot: Launch1000ProductTypeEvidenceSnapshot[];
  identity: Launch1000ProductTypeIdentity;
  rationale: string;
  approvedBy: string;
  approvedByEmail: string;
  approvedAt: string;
  auditEventId?: string;
}

export interface Launch1000ProductTypeEvidenceSnapshot {
  kind: Launch1000ProductTypeEvidenceKind;
  ref: string;
  provenance: "supplier-observed" | "zyro-admin-edited" | "managed-media";
  observedValueHash: string;
  contentHash?: string;
  imageStatus?: string;
}

export interface Launch1000ProductTypeIdentity {
  sourceId: string;
  supplierProductId: string;
  deterministicOfferId: string | null;
  supplierOfferId: string | null;
  canonicalProductId: string;
  resolution: "deterministic_offer" | "legacy_fallback";
}

export const LAUNCH1000_PRODUCT_TYPE_CLASSIFICATION_AUDIT_COLLECTION = "supplier_approval_audit";

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const asString = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const cleanText = (value: unknown, field: string, maxLength: number): string => {
  if (typeof value !== "string") throw new ApiError(`${field} must be text.`, 400);
  const cleaned = value.normalize("NFKC").trim();
  if (!cleaned || cleaned.length > maxLength || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(cleaned)) {
    throw new ApiError(`${field} is invalid.`, 400);
  }
  return cleaned;
};

const cleanSha256 = (value: unknown, field: string): string => {
  const cleaned = cleanText(value, field, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(cleaned)) throw new ApiError(`${field} is invalid.`, 400);
  return cleaned;
};

const cleanTimestamp = (value: unknown, field: string): string => {
  const cleaned = cleanText(value, field, 80);
  if (!Number.isFinite(Date.parse(cleaned))) throw new ApiError(`${field} is invalid.`, 400);
  return cleaned;
};

const cleanPendingRevision = (value: unknown): string => {
  const cleaned = cleanText(value, "expectedPendingRevision", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(cleaned)) throw new ApiError("expectedPendingRevision is invalid.", 400);
  return cleaned;
};

const cleanEvidenceKind = (value: unknown): Launch1000ProductTypeEvidenceKind => {
  if (value === "product_title" || value === "product_description" || value === "managed_image") return value;
  throw new ApiError("Product Type evidence kind is invalid.", 400);
};

const cleanEvidence = (value: unknown): Launch1000ProductTypeEvidenceReference[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    throw new ApiError("At least one and no more than five Product Type evidence references are required.", 400);
  }
  const references = value.map((candidate) => {
    const record = asRecord(candidate);
    return {
      kind: cleanEvidenceKind(record.kind),
      ref: cleanText(record.ref, "Product Type evidence reference", 160),
    };
  });
  const keys = references.map((reference) => `${reference.kind}:${reference.ref}`);
  if (new Set(keys).size !== keys.length) throw new ApiError("Product Type evidence references must be unique.", 400);
  return references;
};

export const parseLaunch1000ProductTypeClassificationInput = (value: unknown): Launch1000ProductTypeClassificationInput => {
  const input = asRecord(value);
  const unknownFields = Object.keys(input).filter((field) => ![
    "decision",
    "confirmed",
    "manifestRevision",
    "productType",
    "evidence",
    "rationale",
    "expectedPendingRevision",
    "expectedUpdatedAt",
    "expectedFingerprint",
  ].includes(field));
  if (unknownFields.length > 0) throw new ApiError(`Product Type classification contains unsupported fields: ${unknownFields.join(", ")}.`, 400);
  if (input.decision !== "approve") throw new ApiError("Product Type classification approval is required.", 400);
  if (input.confirmed !== true) throw new ApiError("Explicit Product Type classification confirmation is required.", 400);
  return {
    decision: "approve",
    confirmed: true,
    manifestRevision: cleanText(input.manifestRevision, "manifestRevision", 160),
    productType: cleanText(input.productType, "productType", 160),
    evidence: cleanEvidence(input.evidence),
    rationale: (() => {
      const rationale = cleanText(input.rationale, "rationale", 500);
      if (rationale.length < 20) throw new ApiError("rationale must explain the approved evidence in at least 20 characters.", 400);
      return rationale;
    })(),
    expectedPendingRevision: cleanPendingRevision(input.expectedPendingRevision),
    expectedUpdatedAt: cleanTimestamp(input.expectedUpdatedAt, "expectedUpdatedAt"),
    expectedFingerprint: cleanSha256(input.expectedFingerprint, "expectedFingerprint"),
  };
};

const timestampString = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const candidate = value as { toDate?: () => Date; toMillis?: () => number };
    if (typeof candidate.toDate === "function") return candidate.toDate().toISOString();
    if (typeof candidate.toMillis === "function") return new Date(candidate.toMillis()).toISOString();
  }
  return "";
};

const nestedValue = (value: unknown, path: readonly string[]): unknown => {
  let current: unknown = value;
  for (const segment of path) {
    const record = asRecord(current);
    current = record[segment];
  }
  return current;
};

const textAt = (record: Record<string, unknown>, path: string): string => (
  asString(nestedValue(record, path.split(".")))
);

const evidenceTextPaths: Record<Exclude<Launch1000ProductTypeEvidenceKind, "managed_image">, readonly string[]> = {
  product_title: ["productPayload.name", "productPayload.title", "supplierSnapshot.productPayload.name", "supplierSnapshot.title"],
  product_description: ["productPayload.description", "productPayload.longDescription", "supplierSnapshot.productPayload.description", "supplierSnapshot.description"],
};

interface ProductTypeEvidenceRule {
  requiredTerms: readonly string[];
  forbiddenTerms: readonly string[];
  ambiguousTerms: readonly string[];
}

/** Narrow source-fact rules for the six historical records, not a general classifier. */
const productTypeEvidenceRules: Readonly<Record<string, ProductTypeEvidenceRule>> = Object.freeze({
  "dropex-adl0019": {
    requiredTerms: ["cabinet", "jack", "support"],
    forbiddenTerms: ["subwoofer", "earbud", "clean", "brush", "clothe", "rack"],
    ambiguousTerms: ["case", "cover", "accessory", "part", "replacement", "spare"],
  },
  "dropex-aju0010": {
    requiredTerms: ["subwoofer"],
    forbiddenTerms: ["earbud", "cabinet", "jack", "clean", "brush", "clothe", "rack"],
    ambiguousTerms: ["case", "cover", "accessory", "part", "replacement", "spare"],
  },
  "dropex-aju0013": {
    requiredTerms: ["earbud"],
    forbiddenTerms: ["subwoofer", "cabinet", "jack", "clean", "brush", "clothe", "rack"],
    ambiguousTerms: ["case", "cover", "accessory", "part", "replacement", "spare"],
  },
  "dropex-aju0021": {
    requiredTerms: ["earbud"],
    forbiddenTerms: ["subwoofer", "cabinet", "jack", "clean", "brush", "clothe", "rack"],
    ambiguousTerms: ["case", "cover", "accessory", "part", "replacement", "spare"],
  },
  "dropex-aju0027": {
    requiredTerms: ["clean", "brush"],
    forbiddenTerms: ["subwoofer", "earbud", "cabinet", "jack", "clothe", "rack"],
    ambiguousTerms: ["case", "cover", "accessory", "part", "replacement", "spare"],
  },
  "dropex-ajuch-3338": {
    requiredTerms: ["clothe", "rack"],
    forbiddenTerms: ["subwoofer", "earbud", "cabinet", "jack", "clean", "brush"],
    ambiguousTerms: ["case", "cover", "accessory", "part", "replacement", "spare"],
  },
});

const managedMediaRecords = (record: Record<string, unknown>): Record<string, unknown>[] => {
  const payload = asRecord(record.productPayload);
  const snapshot = asRecord(record.supplierSnapshot);
  return [record.managedMedia, payload.supplierMedia, payload.media, snapshot.managedMedia]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value));
};

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
};

const normalizedEvidenceWords = (value: string): string[] => value
  .normalize("NFKC")
  .toLocaleLowerCase("en")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim()
  .split(/\s+/u)
  .filter(Boolean);

const containsEvidenceTerm = (words: readonly string[], term: string): boolean => {
  const normalizedTerm = normalizedEvidenceWords(term)[0] || "";
  return Boolean(normalizedTerm) && words.some((word) => word === normalizedTerm || word.startsWith(normalizedTerm));
};

const containsNegatedEvidenceTerm = (value: string, term: string): boolean => {
  const words = normalizedEvidenceWords(value);
  const normalizedTerm = normalizedEvidenceWords(term).join(" ");
  return words.some((word, index) => (
    ["not", "no", "without", "exclude", "excluding"].includes(word)
      && words.slice(index + 1, index + 4).join(" ").replace(/^(?:a|an|the)\s+/u, "") === normalizedTerm
  ));
};

const sourceEvidenceSnapshot = (record: Record<string, unknown>): Record<string, unknown> => ({
  identity: {
    sourceId: asString(record.sourceId || asRecord(record.supplierSnapshot).sourceId).toLocaleLowerCase("en"),
    supplierId: asString(record.supplierId || asRecord(record.supplierSnapshot).supplierId),
    supplierProductId: asString(record.supplierProductId || asRecord(record.supplierSnapshot).supplierProductId),
    supplierCode: asString(record.supplierCode),
    supplierOfferId: asString(record.supplierOfferId),
    canonicalProductId: asString(record.canonicalProductId),
    productId: asString(record.productId),
    productPayloadId: asString(asRecord(record.productPayload).id),
  },
  text: Object.fromEntries([...new Set(Object.values(evidenceTextPaths).flat())].sort().map((path) => [path, textAt(record, path)])),
  managedMedia: managedMediaRecords(record).map((media) => ({
    contentHash: asString(media.contentHash).toLowerCase(),
    imageStatus: asString(media.imageStatus).toLowerCase(),
    firebaseStorageUrl: asString(media.firebaseStorageUrl),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
});

/** Fingerprints only source identity/evidence fields; classification fields are excluded. */
export const launch1000ProductTypeSourceEvidenceFingerprint = (record: Record<string, unknown>): string => (
  sha256(stableJson(sourceEvidenceSnapshot(record)))
);

export const launch1000ProductTypeClassificationAuditEventId = (
  queueItemId: string,
  manifestRevision: string,
  sourceEvidenceFingerprint: string,
): string => `launch1000-classification-${sha256(`${queueItemId}|${manifestRevision}|${sourceEvidenceFingerprint}`).slice(0, 48)}`;

const validateEvidenceReferences = (
  record: Record<string, unknown>,
  evidence: readonly Launch1000ProductTypeEvidenceReference[],
  productId: string,
): { references: Launch1000ProductTypeEvidenceReference[]; snapshots: Launch1000ProductTypeEvidenceSnapshot[] } => {
  const snapshots: Launch1000ProductTypeEvidenceSnapshot[] = [];
  const textEvidence: Array<{ value: string; provenance: "supplier-observed" | "zyro-admin-edited" }> = [];
  for (const reference of evidence) {
  if (reference.kind === "managed_image") {
    const contentHash = reference.ref.startsWith("managedMedia:") ? reference.ref.slice("managedMedia:".length) : "";
    if (!/^[a-f0-9]{64}$/u.test(contentHash)) throw new ApiError("Managed image evidence reference is invalid.", 422);
    const match = managedMediaRecords(record).find((media) => (
      asString(media.contentHash).toLowerCase() === contentHash
      && ["ready", "published"].includes(asString(media.imageStatus).toLowerCase())
      && /^https:\/\/\S+$/iu.test(asString(media.firebaseStorageUrl))
    ));
    if (!match) throw new ApiError("Managed image evidence is not available and ready for review.", 422);
    snapshots.push({
      ...reference,
        provenance: "managed-media",
      observedValueHash: sha256(stableJson({
        contentHash,
        imageStatus: asString(match.imageStatus).toLowerCase(),
        firebaseStorageUrl: asString(match.firebaseStorageUrl),
      })),
      contentHash,
      imageStatus: asString(match.imageStatus).toLowerCase(),
    });
    continue;
  }
  const allowedPaths = evidenceTextPaths[reference.kind];
  if (!allowedPaths.includes(reference.ref)) throw new ApiError("Product Type evidence reference is not an allowed supplier field.", 422);
  const observedText = textAt(record, reference.ref);
  if (!observedText) {
    throw new ApiError("The referenced Product Type evidence is missing.", 422);
  }
  const productPayload = asRecord(record.productPayload);
  const ownership = parseSupplierProductFieldOwnership(productPayload.supplierFieldOwnership);
  const adminOwnedField = reference.ref === "productPayload.name" || reference.ref === "productPayload.title"
    ? "name"
    : reference.ref === "productPayload.description" || reference.ref === "productPayload.longDescription"
      ? "description"
      : null;
  const supplierSnapshotPaths = reference.ref === "productPayload.name" || reference.ref === "productPayload.title"
    ? ["supplierSnapshot.productPayload.name", "supplierSnapshot.title"]
    : reference.ref === "productPayload.description" || reference.ref === "productPayload.longDescription"
      ? ["supplierSnapshot.productPayload.description", "supplierSnapshot.description"]
      : [];
  const provenance = adminOwnedField && ownership[adminOwnedField]?.owner === "admin"
    ? "zyro-admin-edited"
    : supplierSnapshotPaths.some((path) => textAt(record, path) === observedText)
      ? "supplier-observed"
      : null;
  if (!provenance) {
    throw new ApiError("The selected Product Type evidence has no trustworthy supplier provenance.", 422);
  }
  textEvidence.push({ value: observedText, provenance });
  snapshots.push({ ...reference, provenance, observedValueHash: sha256(observedText) });
  }

  const rule = productTypeEvidenceRules[productId];
  if (!rule) throw new ApiError("Product Type evidence rules are unavailable for this Pilot-10 product.", 409);
  const supplierTextEvidence = textEvidence.filter((evidence) => evidence.provenance === "supplier-observed");
  if (supplierTextEvidence.length === 0) {
    throw new ApiError("A managed image cannot establish Product Type semantics without supporting title or description evidence.", 422);
  }
  const supplierWords = normalizedEvidenceWords(supplierTextEvidence.map((evidence) => evidence.value).join(" "));
  const allWords = normalizedEvidenceWords(textEvidence.map((evidence) => evidence.value).join(" "));
  const missingTerms = rule.requiredTerms.filter((term) => !containsEvidenceTerm(supplierWords, term));
  if (missingTerms.length > 0) {
    throw new ApiError(`The selected evidence does not establish the approved Product Type; missing identifying terms: ${missingTerms.join(", ")}.`, 422);
  }
  const contradictoryTerms = rule.forbiddenTerms.filter((term) => containsEvidenceTerm(allWords, term));
  if (contradictoryTerms.length > 0) {
    throw new ApiError(`The selected Product Type evidence is contradictory: ${contradictoryTerms.join(", ")}.`, 422);
  }
  const ambiguousTerms = rule.ambiguousTerms.filter((term) => containsEvidenceTerm(allWords, term));
  if (ambiguousTerms.length > 0 || rule.requiredTerms.some((term) => textEvidence.some((value) => containsNegatedEvidenceTerm(value.value, term)))) {
    throw new ApiError("The selected Product Type evidence is ambiguous and cannot establish the approved product semantics.", 422);
  }
  return { references: [...evidence], snapshots };
};

const manifestEntryFor = (
  productId: string,
  snapshot: Launch1000ManifestSnapshot,
): { entry: Launch1000ManifestEntry; productType: string } => {
  const expected = LAUNCH1000_PRODUCT_TYPE_CLASSIFICATION_ALLOWLIST[productId as keyof typeof LAUNCH1000_PRODUCT_TYPE_CLASSIFICATION_ALLOWLIST];
  if (!expected) throw new ApiError("Product Type classification is limited to the approved Launch-1000 Pilot-10 products.", 409);
  const entry = snapshot.entries.find((candidate) => candidate.productId === productId);
  const manifestValue = entry?.deterministicSpecNormalization[LAUNCH1000_PRODUCT_TYPE_CLASSIFICATION_FIELD];
  if (!entry || manifestValue !== expected) {
    throw new ApiError("The immutable Launch-1000 manifest does not authorize this Product Type classification.", 409);
  }
  return { entry, productType: expected };
};

const launch1000IdentityRecord = (
  resolved: ResolvedSupplierQueueIdentity,
): Launch1000ProductTypeIdentity => ({
  sourceId: resolved.sourceId.toLocaleLowerCase("en"),
  supplierProductId: resolved.supplierProductId,
  deterministicOfferId: resolved.deterministicOfferId || null,
  supplierOfferId: resolved.supplierOfferId || null,
  canonicalProductId: resolved.canonicalProductId,
  resolution: resolved.offer ? "deterministic_offer" : "legacy_fallback",
});

const resolveLaunch1000Identity = async (
  db: Firestore,
  reader: SupplierQueueIdentityDocumentReader,
  current: Record<string, unknown>,
  manifestProductId?: string,
): Promise<Launch1000ProductTypeIdentity> => {
  const candidate = getSupplierQueueIdentityCandidate(current);
  if (candidate.sourceId.toLocaleLowerCase("en") !== "dropex") {
    throw new ApiError("Product Type classification is limited to Dropex Launch-1000 items.", 409);
  }
  if (!candidate.supplierProductId) {
    throw new ApiError("The supplier product identity is missing from this review item.", 409);
  }

  let resolved: ResolvedSupplierQueueIdentity;
  try {
    resolved = await resolveSupplierQueueIdentity(db, reader, current);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("The supplier product identity could not be resolved safely.", 409);
  }

  if (!resolved.canonicalProductId || (manifestProductId && resolved.canonicalProductId !== manifestProductId)) {
    throw new ApiError("The resolved canonical product does not match the immutable Launch-1000 manifest entry.", 409);
  }
  const payload = asRecord(current.productPayload);
  const explicitProductIds = [current.canonicalProductId, current.productId, payload.id]
    .map(asString)
    .filter(Boolean);
  if (explicitProductIds.some((productId) => productId !== resolved.canonicalProductId)) {
    throw new ApiError("The supplier review contains conflicting canonical product identities.", 409);
  }
  if (candidate.claimedProductId && candidate.claimedProductId !== resolved.canonicalProductId) {
    throw new ApiError("The supplier review identity is inconsistent with its canonical product.", 409);
  }

  if (resolved.offer) {
    if (resolved.offer.sourceId.toLocaleLowerCase("en") !== "dropex"
      || (manifestProductId && resolved.offer.productId !== manifestProductId)
      || resolved.offer.supplierProductId !== resolved.supplierProductId
      || resolved.offer.id !== resolved.deterministicOfferId
      || (candidate.claimedOfferId && candidate.claimedOfferId !== resolved.offer.id)) {
      throw new ApiError("The deterministic supplier offer conflicts with the Launch-1000 identity.", 409);
    }
  } else if (candidate.claimedOfferId) {
    // resolveSupplierQueueIdentity rejects a missing claimed offer. This branch
    // remains defensive if the resolver contract changes.
    throw new ApiError("The claimed deterministic supplier offer could not be resolved.", 409);
  }

  return launch1000IdentityRecord(resolved);
};

export interface ResolvedLaunch1000QueueRecord {
  reference: FirebaseFirestore.DocumentReference;
  record: Record<string, unknown>;
  identity: Launch1000ProductTypeIdentity | null;
}

export interface Launch1000QueueRecordReader extends SupplierQueueIdentityDocumentReader {
  getQuery(query: FirebaseFirestore.Query): Promise<FirebaseFirestore.QuerySnapshot>;
}

/**
 * Resolves the one authoritative review document for a manifest product. The
 * canonical document ID is checked first, while legacy queue IDs are found
 * only through bounded indexed lookups. Exactly one claiming record must be
 * found; no queue scan or silent remapping is allowed.
 */
export async function resolveLaunch1000QueueRecord(
  db: Firestore,
  reader: Launch1000QueueRecordReader,
  manifestProductId: string,
): Promise<ResolvedLaunch1000QueueRecord | null> {
  const collection = db.collection("supplier_review_queue");
  const canonicalReference = collection.doc(manifestProductId);
  const canonicalSnapshot = await reader.get(canonicalReference);
  const candidates = new Map<string, FirebaseFirestore.DocumentSnapshot>();
  if (canonicalSnapshot.exists) {
    candidates.set(canonicalSnapshot.id, canonicalSnapshot);
  }
  const querySnapshots = await Promise.all([
    collection.where("canonicalProductId", "==", manifestProductId).limit(2),
    collection.where("productId", "==", manifestProductId).limit(2),
    collection.where("productPayload.id", "==", manifestProductId).limit(2),
  ].map((query) => reader.getQuery(query)));
  querySnapshots.forEach((querySnapshot) => querySnapshot.docs.forEach((snapshot) => candidates.set(snapshot.id, snapshot)));
  if (candidates.size === 0) return null;
  if (candidates.size > 1) {
    throw new ApiError("Multiple supplier review records claim the Launch-1000 canonical product.", 409);
  }
  const [candidate] = [...candidates.values()];
  const record = candidate.data() || {};
  const hasClassification = Object.keys(asRecord(record.launch1000ProductTypeClassification)).length > 0;
  const identity = hasClassification
    ? await resolveLaunch1000Identity(db, reader, record, manifestProductId)
    : null;
  return { reference: candidate.ref, record, identity };
}

const canonicalProductTypeSpecs = (payload: Record<string, unknown>, productType: string): Record<string, unknown> => {
  const specs = Object.fromEntries(Object.entries(asRecord(payload.specs)).filter(([key]) => (
    key.normalize("NFKC").trim().toLocaleLowerCase("en") !== LAUNCH1000_PRODUCT_TYPE_CLASSIFICATION_FIELD.toLocaleLowerCase("en")
  )));
  specs[LAUNCH1000_PRODUCT_TYPE_CLASSIFICATION_FIELD] = productType;
  return specs;
};

const sameEvidence = (left: unknown, right: readonly Launch1000ProductTypeEvidenceReference[]): boolean => (
  JSON.stringify(left || []) === JSON.stringify(right)
);

const sameEvidenceSnapshot = (left: unknown, right: readonly Launch1000ProductTypeEvidenceSnapshot[]): boolean => (
  JSON.stringify(left || []) === JSON.stringify(right)
);

export const isCurrentLaunch1000ProductTypeClassification = (
  current: Record<string, unknown>,
  entry: Launch1000ManifestEntry,
  snapshot: Launch1000ManifestSnapshot,
  currentIdentity: Launch1000ProductTypeIdentity | null,
): Launch1000ProductTypeClassificationRecord | null => {
  const candidate = asRecord(current.launch1000ProductTypeClassification) as Partial<Launch1000ProductTypeClassificationRecord>;
  const expected = entry.deterministicSpecNormalization[LAUNCH1000_PRODUCT_TYPE_CLASSIFICATION_FIELD];
  const currentUpdatedAt = timestampString(current.updatedAt);
  const currentPendingRevision = asString(current.supplierOfferPendingRevision);
  const identity = asRecord(candidate.identity);
  const currentIdentityCandidate = getSupplierQueueIdentityCandidate(current);
  let evidenceValidation: { references: Launch1000ProductTypeEvidenceReference[]; snapshots: Launch1000ProductTypeEvidenceSnapshot[] } | null = null;
  try {
    evidenceValidation = validateEvidenceReferences(
      current,
      Array.isArray(candidate.evidence) ? candidate.evidence as Launch1000ProductTypeEvidenceReference[] : [],
      entry.productId,
    );
  } catch {
    evidenceValidation = null;
  }
  const explicitCurrentProductIds = [current.canonicalProductId, current.productId, asRecord(current.productPayload).id]
    .map(asString)
    .filter(Boolean);
  if (snapshot.manifestRevision !== candidate.manifestRevision
    || candidate.source !== "zyro-derived"
    || candidate.decision !== "approved"
    || candidate.confirmed !== true
    || candidate.field !== LAUNCH1000_PRODUCT_TYPE_CLASSIFICATION_FIELD
    || candidate.value !== expected
    || candidate.sourcePendingRevision !== currentPendingRevision
    || candidate.approvedAt !== currentUpdatedAt
    || !candidate.sourceFingerprint
    || candidate.sourceEvidenceFingerprint !== launch1000ProductTypeSourceEvidenceFingerprint(current)
    || !Array.isArray(candidate.evidence)
    || !Array.isArray(candidate.evidenceSnapshot)
    || !evidenceValidation
    || !sameEvidenceSnapshot(candidate.evidenceSnapshot, evidenceValidation.snapshots)
    || !currentIdentity
    || identity.sourceId !== currentIdentity.sourceId.toLocaleLowerCase("en")
    || identity.supplierProductId !== currentIdentity.supplierProductId
    || identity.deterministicOfferId !== (currentIdentity.deterministicOfferId || null)
    || identity.supplierOfferId !== (currentIdentity.supplierOfferId || null)
    || identity.canonicalProductId !== entry.productId
    || explicitCurrentProductIds.some((productId) => productId !== entry.productId)
    || (currentIdentityCandidate.claimedProductId && currentIdentityCandidate.claimedProductId !== entry.productId)
    || !asString(identity.supplierProductId)
    || !asString(candidate.approvedBy)) return null;
  return candidate as Launch1000ProductTypeClassificationRecord;
};

export async function approveLaunch1000ProductTypeClassification(
  db: Firestore,
  queueItemId: string,
  input: Launch1000ProductTypeClassificationInput,
  reviewer: SupplierAuditActor,
  snapshot: Launch1000ManifestSnapshot = loadLaunch1000Snapshot(),
): Promise<{
  queueItemId: string;
  item: Record<string, unknown> & { id: string };
  classification: Launch1000ProductTypeClassificationRecord;
  idempotent: boolean;
}> {
  if (snapshot.manifestRevision !== input.manifestRevision) throw new ApiError("Launch-1000 manifest revision is stale.", 409);

  const reference = db.collection("supplier_review_queue").doc(queueItemId);
  let updatedRecord: Record<string, unknown> | null = null;
  let classification: Launch1000ProductTypeClassificationRecord | null = null;
  let idempotent = false;

  await db.runTransaction(async (transaction: Transaction) => {
    const snapshotDocument = await transaction.get(reference);
    if (!snapshotDocument.exists) throw new ApiError("Supplier review item could not be found.", 404);
    const current = snapshotDocument.data() || {};
    const identity = await resolveLaunch1000Identity(db, transaction, current);
    const { entry, productType } = manifestEntryFor(identity.canonicalProductId, snapshot);
    if (input.productType !== productType) throw new ApiError("Product Type must match the immutable Launch-1000 manifest value.", 409);
    const evidenceValidation = validateEvidenceReferences(current, input.evidence, entry.productId);
    const sourceEvidenceFingerprint = launch1000ProductTypeSourceEvidenceFingerprint(current);
    const identityRecord = identity;
    const auditEventId = launch1000ProductTypeClassificationAuditEventId(queueItemId, input.manifestRevision, sourceEvidenceFingerprint);
    const existing = asRecord(current.launch1000ProductTypeClassification) as Partial<Launch1000ProductTypeClassificationRecord>;
    const currentUpdatedAt = timestampString(current.updatedAt);
    if (existing.decision === "approved") {
      if (existing.manifestRevision === input.manifestRevision
        && existing.value === productType
        && existing.confirmed === true
        && existing.sourceFingerprint === input.expectedFingerprint
        && existing.sourceEvidenceFingerprint === sourceEvidenceFingerprint
        && existing.sourcePendingRevision === input.expectedPendingRevision
        && existing.sourceUpdatedAt === input.expectedUpdatedAt
        && existing.approvedAt === currentUpdatedAt
        && sameEvidence(existing.evidence, input.evidence)
        && sameEvidenceSnapshot(existing.evidenceSnapshot, evidenceValidation.snapshots)
        && JSON.stringify(existing.identity || null) === JSON.stringify(identityRecord)
        && existing.auditEventId === auditEventId
        && existing.rationale === input.rationale) {
        classification = existing as Launch1000ProductTypeClassificationRecord;
        updatedRecord = { ...current, id: queueItemId };
        idempotent = true;
        return;
      }
      throw new ApiError("A different or stale Product Type classification already exists for this review item.", 409);
    }

    const queueState = asString(current.queueState || current.status || current.reviewStatus).toLowerCase();
    if (!(queueState === "review_pending" || queueState === "pending")) {
      throw new ApiError("Only a pending supplier review item can approve a Product Type classification.", 409);
    }
    if ([current.status, current.queueState, current.reviewStatus].some((value) => asString(value).toLowerCase() === "approved")) {
      throw new ApiError("An approved review item cannot receive a Product Type classification.", 409);
    }
    if (asString(current.supplierOfferPendingRevision) !== input.expectedPendingRevision || currentUpdatedAt !== input.expectedUpdatedAt) {
      throw new ApiError("This supplier review changed after it was opened. Reload before approving the classification.", 409);
    }
    const currentFingerprint = launch1000RecordFingerprint(current);
    if (currentFingerprint !== input.expectedFingerprint) {
      throw new ApiError("This supplier review changed after it was opened. Reload before approving the classification.", 409);
    }

    const liveProducts = new Map<string, Record<string, unknown>>();
    for (const linkedProductId of supplierReviewCanonicalProductIds(current)) {
      const liveSnapshot = await transaction.get(db.collection("products").doc(linkedProductId));
      if (liveSnapshot.exists) liveProducts.set(linkedProductId, liveSnapshot.data() || {});
    }
    if (supplierReviewRecordIsLiveEquivalent(current, liveProducts)) {
      throw new ApiError("A canonical live product linkage blocks this Product Type classification.", 409);
    }

    const payload = asRecord(current.productPayload);
    const categoryId = asString(payload.category);
    if (!categoryId) throw new ApiError("A canonical category is required before approving Product Type.", 422);
    const categoryReference = db.collection("categories").doc(categoryId);
    const categorySnapshot = await transaction.get(categoryReference);
    if (!categorySnapshot.exists || !isCanonicalActiveCategory(categorySnapshot.data() as { isActive?: boolean; taxonomyCandidate?: boolean } | undefined)) {
      throw new ApiError("The current category is not an active canonical category.", 422);
    }

    const now = new Date().toISOString();
    const ownership = parseSupplierProductFieldOwnership(payload.supplierFieldOwnership);
    const nextPayload = {
      ...payload,
      productType,
      specs: canonicalProductTypeSpecs(payload, productType),
      supplierFieldOwnership: {
        ...ownership,
        specs: {
          owner: "admin" as const,
          sourceId: null,
          updatedAt: now,
          updatedBy: reviewer.uid.slice(0, 160),
          reason: "review_decision" as const,
        },
        productType: {
          owner: "admin" as const,
          sourceId: null,
          updatedAt: now,
          updatedBy: reviewer.uid.slice(0, 160),
          reason: "review_decision" as const,
        },
      },
    };
    const productValidation = await recomputeProductValidation(transaction, db, current, nextPayload, categorySnapshot);
    const nextClassification: Launch1000ProductTypeClassificationRecord = {
      source: "zyro-derived",
      decision: "approved",
      confirmed: true,
      field: LAUNCH1000_PRODUCT_TYPE_CLASSIFICATION_FIELD,
      value: productType,
      manifestRevision: input.manifestRevision,
      sourcePendingRevision: input.expectedPendingRevision,
      sourceUpdatedAt: input.expectedUpdatedAt,
      sourceFingerprint: input.expectedFingerprint,
      sourceEvidenceFingerprint,
      evidence: evidenceValidation.references,
      evidenceSnapshot: evidenceValidation.snapshots,
      identity: identityRecord,
      rationale: input.rationale,
      approvedBy: reviewer.uid.slice(0, 160),
      approvedByEmail: reviewer.email.slice(0, 320),
      approvedAt: now,
    };
    const projectedRecord = {
      ...current,
      id: queueItemId,
      productPayload: nextPayload,
      productValidation,
      updatedAt: now,
    } as SupplierQueueRecord;
    const projection = buildSupplierReviewBusinessQueueProjection(projectedRecord);
    createSupplierAuditEvent(db, transaction, {
      queueItemId,
      queueItem: { ...current, id: queueItemId, productPayload: nextPayload },
      action: "classification_approved",
      previousState: queueState,
      newState: queueState,
      admin: reviewer,
      reason: "Administrator approved a Zyro-derived Product Type classification for Launch-1000.",
      classificationDecision: {
        field: LAUNCH1000_PRODUCT_TYPE_CLASSIFICATION_FIELD,
        value: productType,
        source: "zyro-derived",
        confirmed: true,
        manifestRevision: input.manifestRevision,
        sourcePendingRevision: input.expectedPendingRevision,
        sourceUpdatedAt: input.expectedUpdatedAt,
        sourceFingerprint: input.expectedFingerprint,
        sourceEvidenceFingerprint,
        evidence: evidenceValidation.references,
        evidenceSnapshot: evidenceValidation.snapshots.map((snapshot) => ({ ...snapshot })),
        identity: { ...identityRecord },
        rationale: input.rationale,
      },
      auditEventId,
      timestamp: new Date(now),
      now: Date.parse(now),
    });
    classification = { ...nextClassification, auditEventId };
    updatedRecord = {
      ...current,
      id: queueItemId,
      productPayload: nextPayload,
      productValidation,
      launch1000ProductTypeClassification: classification,
      updatedAt: now,
      ...projection,
    };
    transaction.update(reference, {
      productPayload: nextPayload,
      productValidation,
      launch1000ProductTypeClassification: classification,
      updatedAt: now,
      ...projection,
    });
  });

  if (!updatedRecord || !classification) throw new ApiError("Product Type classification could not be saved.", 500);
  const [item] = await decorateSupplierReviewQueueAdminMedia([updatedRecord as Record<string, unknown> & { id: string }]);
  return {
    queueItemId,
    item: item as Record<string, unknown> & { id: string },
    classification,
    idempotent,
  };
}
