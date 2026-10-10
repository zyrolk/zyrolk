import { Firestore, Transaction } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import {
  buildSupplierReviewBusinessQueueProjection,
  supplierReviewRecordIsReadyForReview,
  SupplierQueueRecord,
} from "../../scheduled/supplierReviewQueue";
import {
  isLowStockHoldSource,
  isSupplierProductLive,
  lowSupplierStockValidationError,
  supplierStockAllowsPublication,
} from "../suppliers/supplierLowStockPolicy";
import {
  isCanonicalActiveCategory,
  StoreCategoryMappingCandidate,
  validateSupplierProductForApproval,
} from "../suppliers/supplierProductMapping";
import { classifySupplierMediaReadiness } from "../suppliers/supplierMediaReadiness";
import {
  Launch1000ManifestEntry,
  Launch1000ManifestSnapshot,
  launch1000RecordFingerprint,
  loadLaunch1000Snapshot,
} from "./launch1000Snapshot";
import { LAUNCH1000_TAXONOMY_GOVERNANCE_COLLECTION } from "./launch1000Governance";

export const LAUNCH1000_APPLY_OPERATIONS_COLLECTION = "launch1000_apply_operations";
export const LAUNCH1000_APPLY_AUDIT_COLLECTION = "launch1000_apply_audit";
export const LAUNCH1000_PILOT_BATCH_MAX = 20;

export interface Launch1000Operator {
  uid: string;
  email: string;
}

export interface Launch1000Precondition {
  expectedUpdatedAt: string;
  expectedFingerprint: string;
}

export interface Launch1000ApplyRequest {
  manifestRevision: string;
  productIds: string[];
  operationId: string;
  preconditions: Record<string, Launch1000Precondition>;
}

export interface Launch1000DryRunRequest {
  manifestRevision: string;
  productIds: string[];
}

export type Launch1000ProductOutcome = "ELIGIBLE" | "NEEDS_ATTENTION" | "STALE_OR_CONFLICT" | "APPLIED" | "IDEMPOTENT";

export interface Launch1000ProductResult {
  productId: string;
  sku: string;
  outcome: Launch1000ProductOutcome;
  reasonCodes: string[];
  expectedUpdatedAt: string | null;
  expectedFingerprint: string | null;
  intendedTaxonomy?: { categoryId: string; subcategoryId: string; proposalId: string | null };
  deterministicSpecNormalization?: Record<string, string>;
  validationErrors?: Array<Record<string, unknown>>;
  projectionClasses?: string[];
}

type Launch1000Reader = (
  reference: FirebaseFirestore.DocumentReference,
) => Promise<FirebaseFirestore.DocumentSnapshot>;

interface ProductEvaluation {
  result: Launch1000ProductResult;
  current: Record<string, unknown>;
  nextPayload?: Record<string, unknown>;
  nextValidation?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  category?: Record<string, unknown>;
  productId: string;
}

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const asString = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const cleanId = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new ApiError(`${field} is invalid.`, 400);
  const result = value.trim();
  if (!result || result.length > 160 || result.includes("/")) throw new ApiError(`${field} is invalid.`, 400);
  return result;
};

const cleanRevision = (value: unknown): string => cleanId(value, "manifestRevision");

const parseProductIds = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > LAUNCH1000_PILOT_BATCH_MAX) {
    throw new ApiError(`Launch-1000 pilot batches are limited to ${LAUNCH1000_PILOT_BATCH_MAX} products.`, 400);
  }
  const ids = value.map((item) => cleanId(item, "product ID"));
  if (new Set(ids).size !== ids.length) throw new ApiError("Launch-1000 product IDs must be unique.", 400);
  return ids;
};

const parsePreconditions = (value: unknown, productIds: readonly string[]): Record<string, Launch1000Precondition> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("A successful dry-run precondition set is required before apply.", 400);
  }
  const input = value as Record<string, unknown>;
  return Object.fromEntries(productIds.map((productId) => {
    const item = asRecord(input[productId]);
    const expectedUpdatedAt = asString(item.expectedUpdatedAt);
    const expectedFingerprint = asString(item.expectedFingerprint);
    if (!expectedUpdatedAt || !expectedFingerprint) throw new ApiError(`Dry-run precondition is missing for ${productId}.`, 400);
    return [productId, { expectedUpdatedAt, expectedFingerprint }];
  }));
};

export const parseLaunch1000DryRunRequest = (value: unknown): Launch1000DryRunRequest => {
  const input = asRecord(value);
  return {
    manifestRevision: cleanRevision(input.manifestRevision),
    productIds: parseProductIds(input.productIds),
  };
};

export const parseLaunch1000ApplyRequest = (value: unknown): Launch1000ApplyRequest => {
  const input = asRecord(value);
  const manifestRevision = cleanRevision(input.manifestRevision);
  const productIds = parseProductIds(input.productIds);
  const operationId = cleanId(input.operationId, "operation ID");
  return {
    manifestRevision,
    productIds,
    operationId,
    preconditions: parsePreconditions(input.preconditions, productIds),
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

const categoryCandidate = (snapshot: FirebaseFirestore.DocumentSnapshot): StoreCategoryMappingCandidate => {
  const data = snapshot.data() || {};
  return {
    id: snapshot.id,
    name: asString(data.name) || snapshot.id,
    isActive: data.isActive === true,
    taxonomyCandidate: data.taxonomyCandidate === true,
    subcategories: Array.isArray(data.subcategories) ? data.subcategories as StoreCategoryMappingCandidate["subcategories"] : [],
    specificationTemplate: Array.isArray(data.specificationTemplate)
      ? data.specificationTemplate as StoreCategoryMappingCandidate["specificationTemplate"]
      : [],
    keywords: Array.isArray(data.keywords) ? data.keywords.map(String) : [],
  };
};

const buildValidationPayload = (current: Record<string, unknown>, payload: Record<string, unknown>): Record<string, unknown> => ({
  ...payload,
  name: payload.name || current.productName || current.title || "",
  description: payload.description ?? current.description ?? "",
  imageUrl: payload.imageUrl || current.imageUrl || "",
  price: payload.price ?? current.price ?? current.marketPrice,
  costPrice: payload.costPrice ?? current.costPrice,
  stock: payload.stock ?? current.stock,
  isActive: payload.isActive ?? current.isActive,
  active: payload.active ?? current.active,
  visible: payload.visible ?? current.visible,
});

const mediaError = (record: Record<string, unknown>, payload: Record<string, unknown>): Record<string, unknown> | null => {
  const supplierSnapshot = asRecord(record.supplierSnapshot);
  const sourceImageUrls = Array.isArray(record.mediaSourceImageUrls)
    ? record.mediaSourceImageUrls
    : Array.isArray(payload.imageUrls)
      ? payload.imageUrls
      : String(payload.imageUrl || "").trim() ? [payload.imageUrl] : [];
  const readiness = classifySupplierMediaReadiness({
    supplierId: record.sourceId || supplierSnapshot.supplierId,
    sourceImageUrls,
    managedMedia: record.managedMedia || payload.supplierMedia || payload.media,
    mediaFailures: record.mediaFailures,
  });
  return readiness.publicationSafe && record.mediaStatus === "ready" && record.mediaQueueClass === "ready"
    ? null
    : {
      field: "images",
      code: "managed_media_required",
      message: readiness.publicationSafe ? "Managed media queue readiness is required." : "A valid managed product image is required before publishing.",
    };
};

const validationFor = (
  current: Record<string, unknown>,
  payload: Record<string, unknown>,
  category: FirebaseFirestore.DocumentSnapshot,
  brand: FirebaseFirestore.DocumentSnapshot | null,
): Record<string, unknown> => {
  const categoryValue = categoryCandidate(category);
  const brands = brand?.exists
    ? [{ id: brand.id, name: asString(brand.data()?.name) || brand.id, isActive: brand.data()?.isActive !== false }]
    : [];
  const computedErrors = validateSupplierProductForApproval(
    buildValidationPayload(current, payload),
    [categoryValue],
    brands,
  );
  const lowStock = isLowStockHoldSource(current.sourceId || asRecord(current.supplierSnapshot).sourceId)
    && !isSupplierProductLive({ isActive: payload.isActive === true, visible: payload.visible === true })
    && !supplierStockAllowsPublication({ stock: payload.stock, stockKnown: Number.isInteger(payload.stock) });
  const errors = [
    ...computedErrors,
    ...(mediaError(current, payload) ? [mediaError(current, payload) as Record<string, unknown>] : []),
    ...(lowStock ? [lowSupplierStockValidationError()] : []),
  ].filter((error, index, entries) => entries.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(error)) === index);
  const previous = asRecord(current.productValidation);
  return {
    ...previous,
    readyToPublish: !lowStock && errors.length === 0,
    missingFields: [...new Set(errors.map((error) => asString(error.field)).filter(Boolean))],
    errors,
    ...(Object.hasOwn(previous, "lowStockHold") || lowStock ? { lowStockHold: lowStock } : {}),
  };
};

const evidenceText = (current: Record<string, unknown>, payload: Record<string, unknown>): string => {
  const snapshot = asRecord(current.supplierSnapshot);
  const specs = asRecord(payload.specs);
  return [
    payload.name,
    payload.title,
    payload.description,
    payload.productType,
    payload.keyFeatures,
    snapshot.productType,
    snapshot.description,
    snapshot.specifications,
    ...Object.values(specs),
  ].flatMap((value) => Array.isArray(value) ? value : [value]).map(String).join(" ").toLocaleLowerCase("en");
};

const applySpecNormalization = (
  current: Record<string, unknown>,
  payload: Record<string, unknown>,
  normalization: Record<string, string>,
): { specs: Record<string, unknown>; error?: string } => {
  const specs = { ...asRecord(payload.specs) };
  const evidence = evidenceText(current, payload);
  for (const [field, value] of Object.entries(normalization)) {
    const currentValue = asString(specs[field]);
    if (currentValue && currentValue.toLocaleLowerCase("en") === value.toLocaleLowerCase("en")) continue;
    if (!evidence.includes(value.toLocaleLowerCase("en"))) return { specs, error: "SPEC_EVIDENCE_MISSING" };
    specs[field] = value;
  }
  return { specs };
};

const targetFor = async (
  read: Launch1000Reader,
  db: Firestore,
  entry: Launch1000ManifestEntry,
  snapshot: Launch1000ManifestSnapshot,
): Promise<{ categoryId: string; subcategoryId: string; proposalId: string | null; proposalRevision: string | null } | { reason: string }> => {
  if (!entry.taxonomyProposalId) return {
    categoryId: entry.parentCategoryId,
    subcategoryId: entry.subcategoryId,
    proposalId: null,
    proposalRevision: null,
  };
  const expectedProposal = snapshot.taxonomyProposals.find((proposal) => proposal.proposalId === entry.taxonomyProposalId);
  if (!expectedProposal) return { reason: "PROPOSAL_NOT_IN_SNAPSHOT" };
  const governanceSnapshot = await read(db.collection(LAUNCH1000_TAXONOMY_GOVERNANCE_COLLECTION).doc(entry.taxonomyProposalId));
  const governance = governanceSnapshot.exists ? governanceSnapshot.data() || {} : {};
  const createdSubcategoryId = asString(governance.createdSubcategoryId);
  if (governance.status !== "CREATED" || asString(governance.proposalRevision) !== expectedProposal.revision || !createdSubcategoryId) {
    return { reason: "PROPOSAL_NOT_CREATED" };
  }
  if (asString(governance.parentCategoryId) !== entry.parentCategoryId) return { reason: "PROPOSAL_PARENT_CONFLICT" };
  return {
    categoryId: entry.parentCategoryId,
    subcategoryId: createdSubcategoryId,
    proposalId: entry.taxonomyProposalId,
    proposalRevision: asString(governance.proposalRevision),
  };
};

const categoryContainsSubcategory = (category: Record<string, unknown>, subcategoryId: string): boolean => {
  const subcategories = Array.isArray(category.subcategories) ? category.subcategories : [];
  const activeSubcategories = subcategories.filter((entry) => (
    entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry as Record<string, unknown>).isActive === true
      && (entry as Record<string, unknown>).taxonomyCandidate !== true
  ));
  if (activeSubcategories.length === 0) return !subcategoryId;
  return activeSubcategories.some((entry) => String((entry as Record<string, unknown>).id || "") === subcategoryId);
};

const evaluate = async (
  read: Launch1000Reader,
  db: Firestore,
  entry: Launch1000ManifestEntry,
  current: Record<string, unknown> | null,
  product: Record<string, unknown> | null,
  snapshot: Launch1000ManifestSnapshot,
  expected?: Launch1000Precondition,
): Promise<ProductEvaluation> => {
  const empty = (outcome: Launch1000ProductOutcome, reasonCodes: string[], expectedUpdatedAt: string | null = null, expectedFingerprint: string | null = null): ProductEvaluation => ({
    result: {
      productId: entry.productId,
      sku: entry.sku,
      outcome,
      reasonCodes,
      expectedUpdatedAt,
      expectedFingerprint,
      deterministicSpecNormalization: entry.deterministicSpecNormalization,
    },
    current: current || {},
    productId: entry.productId,
  });
  if (!current) return empty("NEEDS_ATTENTION", ["REVIEW_RECORD_NOT_FOUND"]);
  const currentUpdatedAt = timestampString(current.updatedAt) || null;
  const currentFingerprint = launch1000RecordFingerprint(current);
  if (expected && (expected.expectedUpdatedAt !== currentUpdatedAt || expected.expectedFingerprint !== currentFingerprint)) {
    return empty("STALE_OR_CONFLICT", ["STALE_OR_CONFLICT"], currentUpdatedAt, currentFingerprint);
  }
  const payload = asRecord(current.productPayload);
  const currentState = asString(current.queueState || current.status || current.reviewStatus).toLocaleLowerCase("en");
  const sourceId = asString(current.sourceId || asRecord(current.supplierSnapshot).sourceId).toLocaleLowerCase("en");
  const reasons: string[] = [];
  if (sourceId !== "dropex") reasons.push("SUPPLIER_SOURCE_NOT_DROPEX");
  if (!["review_pending", "pending"].includes(currentState)) reasons.push("REVIEW_NOT_PENDING");
  if ([current.status, current.queueState, current.reviewStatus].some((value) => asString(value).toLocaleLowerCase("en") === "approved")) reasons.push("ALREADY_DECIDED");
  if (payload.isActive === true || payload.published === true || payload.approved === true || (product && isSupplierProductLive(product))) reasons.push("LIVE_EQUIVALENT");
  const priorLaunch1000Apply = asRecord(current.launch1000Apply);
  if (priorLaunch1000Apply.manifestRevision === snapshot.manifestRevision && priorLaunch1000Apply.outcome === "READY_FOR_REVIEW") {
    reasons.push("ALREADY_LAUNCH1000_APPLIED");
  }
  const target = await targetFor(read, db, entry, snapshot);
  if ("reason" in target) reasons.push(target.reason);
  if (reasons.length > 0) return empty("NEEDS_ATTENTION", reasons, currentUpdatedAt, currentFingerprint);

  const targetValue = target as { categoryId: string; subcategoryId: string; proposalId: string | null; proposalRevision: string | null };
  const categorySnapshot = await read(db.collection("categories").doc(targetValue.categoryId));
  const category = categorySnapshot.exists ? categorySnapshot.data() || {} : {};
  if (!categorySnapshot.exists || !isCanonicalActiveCategory(category)) reasons.push("CATEGORY_INVALID_OR_INACTIVE");
  if (!categoryContainsSubcategory(category, targetValue.subcategoryId)) reasons.push("SUBCATEGORY_INVALID_OR_INACTIVE");
  if (reasons.length > 0) return {
    ...empty("NEEDS_ATTENTION", reasons, currentUpdatedAt, currentFingerprint),
    result: {
      ...empty("NEEDS_ATTENTION", reasons, currentUpdatedAt, currentFingerprint).result,
      intendedTaxonomy: { categoryId: targetValue.categoryId, subcategoryId: targetValue.subcategoryId, proposalId: targetValue.proposalId },
    },
  };
  const brandId = asString(payload.brand);
  const brand = brandId ? await read(db.collection("brands").doc(brandId)) : null;
  const specResult = applySpecNormalization(current, { ...payload, category: targetValue.categoryId, subcategory: targetValue.subcategoryId }, entry.deterministicSpecNormalization);
  if (specResult.error) reasons.push(specResult.error);
  if (reasons.length > 0) return {
    ...empty("NEEDS_ATTENTION", reasons, currentUpdatedAt, currentFingerprint),
    result: {
      ...empty("NEEDS_ATTENTION", reasons, currentUpdatedAt, currentFingerprint).result,
      intendedTaxonomy: { categoryId: targetValue.categoryId, subcategoryId: targetValue.subcategoryId, proposalId: targetValue.proposalId },
    },
  };
  const nextPayload = {
    ...payload,
    category: targetValue.categoryId,
    subcategory: targetValue.subcategoryId,
    specs: specResult.specs,
    supplierFieldOwnership: {
      ...asRecord(payload.supplierFieldOwnership),
      category: { owner: "admin", sourceId: null, updatedAt: currentUpdatedAt, updatedBy: "launch1000", reason: "review_decision" },
      subcategory: { owner: "admin", sourceId: null, updatedAt: currentUpdatedAt, updatedBy: "launch1000", reason: "review_decision" },
    },
  };
  const validation = validationFor(current, nextPayload, categorySnapshot, brand);
  const projectedRecord = {
    ...current,
    productPayload: nextPayload,
    productValidation: validation,
  } as SupplierQueueRecord;
  const projection = buildSupplierReviewBusinessQueueProjection(projectedRecord, true);
  const ready = supplierReviewRecordIsReadyForReview({ ...projectedRecord, ...projection } as SupplierQueueRecord);
  const validationErrors = Array.isArray(validation.errors) ? validation.errors as Array<Record<string, unknown>> : [];
  if (!ready) {
    return {
      current,
      productId: entry.productId,
      result: {
        productId: entry.productId,
        sku: entry.sku,
        outcome: "NEEDS_ATTENTION",
        reasonCodes: validationErrors.map((error) => asString(error.code)).filter(Boolean).concat(["PUBLICATION_VALIDATION_BLOCKED"]),
        expectedUpdatedAt: currentUpdatedAt,
        expectedFingerprint: currentFingerprint,
        intendedTaxonomy: { categoryId: targetValue.categoryId, subcategoryId: targetValue.subcategoryId, proposalId: targetValue.proposalId },
        deterministicSpecNormalization: entry.deterministicSpecNormalization,
        validationErrors,
        projectionClasses: Array.isArray(projection.businessQueueClasses) ? projection.businessQueueClasses as string[] : [],
      },
      nextPayload,
      nextValidation: validation,
      projection,
      category,
    };
  }
  return {
    current,
    productId: entry.productId,
    result: {
      productId: entry.productId,
      sku: entry.sku,
      outcome: "ELIGIBLE",
      reasonCodes: [],
      expectedUpdatedAt: currentUpdatedAt,
      expectedFingerprint: currentFingerprint,
      intendedTaxonomy: { categoryId: targetValue.categoryId, subcategoryId: targetValue.subcategoryId, proposalId: targetValue.proposalId },
      deterministicSpecNormalization: entry.deterministicSpecNormalization,
      validationErrors: [],
      projectionClasses: Array.isArray(projection.businessQueueClasses) ? projection.businessQueueClasses as string[] : [],
    },
    nextPayload,
    nextValidation: validation,
    projection,
    category,
  };
};

const entryMap = (snapshot: Launch1000ManifestSnapshot, revision: string, productIds: readonly string[]): Map<string, Launch1000ManifestEntry> => {
  if (snapshot.manifestRevision !== revision) throw new ApiError("Launch-1000 manifest revision is stale.", 409);
  const entries = new Map(snapshot.entries.map((entry) => [entry.productId, entry]));
  for (const productId of productIds) if (!entries.has(productId)) throw new ApiError(`Product ${productId} is not in the checked-in Launch-1000 manifest.`, 409);
  return entries;
};

const queueSnapshot = async (db: Firestore, productId: string): Promise<Record<string, unknown> | null> => {
  const snapshot = await db.collection("supplier_review_queue").doc(productId).get();
  return snapshot.exists ? snapshot.data() || {} : null;
};

export async function dryRunLaunch1000ProductApply(
  db: Firestore,
  input: Launch1000DryRunRequest,
  snapshot: Launch1000ManifestSnapshot = loadLaunch1000Snapshot(),
): Promise<{ mode: "dry_run"; manifestRevision: string; results: Launch1000ProductResult[]; counts: Record<string, number> }> {
  const entries = entryMap(snapshot, input.manifestRevision, input.productIds);
  const results: Launch1000ProductResult[] = [];
  for (const productId of input.productIds.slice().sort((left, right) => (entries.get(left)?.launchPriority || 0) - (entries.get(right)?.launchPriority || 0))) {
    const entry = entries.get(productId) as Launch1000ManifestEntry;
    const current = await queueSnapshot(db, productId);
    const payload = asRecord(current?.productPayload);
    const product = current && asString(payload.id) ? await db.collection("products").doc(asString(payload.id)).get() : null;
    const evaluation = await evaluate((reference) => reference.get(), db, entry, current, product?.exists ? product.data() || {} : null, snapshot);
    results.push(evaluation.result);
  }
  return {
    mode: "dry_run",
    manifestRevision: input.manifestRevision,
    results,
    counts: results.reduce<Record<string, number>>((counts, result) => {
      counts[result.outcome] = (counts[result.outcome] || 0) + 1;
      return counts;
    }, {}),
  };
}

const operationReference = (db: Firestore, operationId: string) => db.collection(LAUNCH1000_APPLY_OPERATIONS_COLLECTION).doc(operationId);

const ensureOperation = async (db: Firestore, input: Launch1000ApplyRequest, operator: Launch1000Operator): Promise<{ completed: boolean; results: Launch1000ProductResult[] }> => {
  const reference = operationReference(db, input.operationId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (snapshot.exists) {
      const current = snapshot.data() || {};
      if (current.manifestRevision !== input.manifestRevision || JSON.stringify(current.productIds || []) !== JSON.stringify(input.productIds.slice().sort())) {
        throw new ApiError("Launch-1000 operation ID was already used with a different request.", 409);
      }
      return {
        completed: current.status === "completed",
        results: Array.isArray(current.results) ? current.results as Launch1000ProductResult[] : [],
      };
    }
    transaction.create(reference, {
      operationId: input.operationId,
      manifestRevision: input.manifestRevision,
      productIds: input.productIds.slice().sort(),
      status: "in_progress",
      operatorUid: operator.uid,
      operatorEmail: operator.email,
      results: [],
      completedCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return { completed: false, results: [] };
  });
};

const appendOperationResult = async (
  db: Firestore,
  input: Launch1000ApplyRequest,
  result: Launch1000ProductResult,
  complete: boolean,
): Promise<void> => {
  const reference = operationReference(db, input.operationId);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) throw new ApiError("Launch-1000 operation record is missing.", 500);
    const current = snapshot.data() || {};
    const results = Array.isArray(current.results) ? current.results as Launch1000ProductResult[] : [];
    const nextResults = results.some((item) => item.productId === result.productId)
      ? results
      : [...results, result];
    transaction.update(reference, {
      results: nextResults,
      completedCount: nextResults.length,
      status: complete ? "completed" : "in_progress",
      updatedAt: new Date().toISOString(),
      ...(complete ? { completedAt: new Date().toISOString() } : {}),
    });
  });
};

const applyOne = async (
  db: Firestore,
  input: Launch1000ApplyRequest,
  entry: Launch1000ManifestEntry,
  operator: Launch1000Operator,
  snapshot: Launch1000ManifestSnapshot,
): Promise<Launch1000ProductResult> => {
  const result = await db.runTransaction(async (transaction: Transaction) => {
    const reference = db.collection("supplier_review_queue").doc(entry.productId);
    const currentSnapshot = await transaction.get(reference);
    const current = currentSnapshot.exists ? currentSnapshot.data() || {} : null;
    if (!current) {
      const result: Launch1000ProductResult = {
        productId: entry.productId,
        sku: entry.sku,
        outcome: "NEEDS_ATTENTION",
        reasonCodes: ["REVIEW_RECORD_NOT_FOUND"],
        expectedUpdatedAt: null,
        expectedFingerprint: null,
      };
      const now = new Date().toISOString();
      const auditReference = db.collection(LAUNCH1000_APPLY_AUDIT_COLLECTION).doc();
      transaction.create(auditReference, {
        id: auditReference.id,
        operationId: input.operationId,
        manifestRevision: input.manifestRevision,
        productId: entry.productId,
        sku: entry.sku,
        previousTaxonomy: null,
        newTaxonomy: null,
        deterministicSpecNormalization: entry.deterministicSpecNormalization,
        validationResult: result.outcome,
        reasonCodes: result.reasonCodes,
        operatorUid: operator.uid,
        operatorEmail: operator.email,
        timestamp: now,
        outcome: "skipped",
      });
      return result;
    }
    const payload = asRecord(current.productPayload);
    const productId = asString(payload.id) || entry.productId;
    const priorLaunch1000Apply = asRecord(current.launch1000Apply);
    if (priorLaunch1000Apply.manifestRevision === input.manifestRevision && priorLaunch1000Apply.outcome === "READY_FOR_REVIEW" && priorLaunch1000Apply.operationId === input.operationId) {
      return {
        productId: entry.productId,
        sku: entry.sku,
        outcome: "IDEMPOTENT" as const,
        reasonCodes: [],
        expectedUpdatedAt: timestampString(current.updatedAt) || null,
        expectedFingerprint: launch1000RecordFingerprint(current),
      };
    }
    const productSnapshot = await transaction.get(db.collection("products").doc(productId));
    const evaluation = await evaluate((reference) => transaction.get(reference), db, entry, current, productSnapshot.exists ? productSnapshot.data() || {} : null, snapshot, input.preconditions[entry.productId]);
    if (evaluation.result.outcome !== "ELIGIBLE" || !evaluation.nextPayload || !evaluation.nextValidation || !evaluation.projection) {
      const now = new Date().toISOString();
      const auditReference = db.collection(LAUNCH1000_APPLY_AUDIT_COLLECTION).doc();
      transaction.create(auditReference, {
        id: auditReference.id,
        operationId: input.operationId,
        manifestRevision: input.manifestRevision,
        productId: entry.productId,
        sku: entry.sku,
        previousTaxonomy: { categoryId: asString(asRecord(current.productPayload).category), subcategoryId: asString(asRecord(current.productPayload).subcategory) },
        newTaxonomy: evaluation.result.intendedTaxonomy || null,
        deterministicSpecNormalization: entry.deterministicSpecNormalization,
        validationResult: evaluation.result.outcome,
        reasonCodes: evaluation.result.reasonCodes,
        operatorUid: operator.uid,
        operatorEmail: operator.email,
        timestamp: now,
        outcome: "skipped",
      });
      return evaluation.result;
    }
    const now = new Date().toISOString();
    const launch1000Apply = {
      operationId: input.operationId,
      manifestRevision: input.manifestRevision,
      appliedBy: operator.uid,
      appliedAt: now,
      taxonomyDecisionSource: entry.taxonomyDecisionSource,
      taxonomyProposalId: entry.taxonomyProposalId,
      outcome: "READY_FOR_REVIEW",
    };
    transaction.update(reference, {
      productPayload: evaluation.nextPayload,
      productValidation: evaluation.nextValidation,
      ...evaluation.projection,
      launch1000Apply,
      updatedAt: now,
    });
    const auditReference = db.collection(LAUNCH1000_APPLY_AUDIT_COLLECTION).doc();
    transaction.create(auditReference, {
      id: auditReference.id,
      operationId: input.operationId,
      manifestRevision: input.manifestRevision,
      productId: entry.productId,
      sku: entry.sku,
      previousTaxonomy: { categoryId: asString(asRecord(current.productPayload).category), subcategoryId: asString(asRecord(current.productPayload).subcategory) },
      newTaxonomy: evaluation.result.intendedTaxonomy,
      deterministicSpecNormalization: entry.deterministicSpecNormalization,
      validationResult: "READY_FOR_REVIEW",
      operatorUid: operator.uid,
      operatorEmail: operator.email,
      timestamp: now,
      outcome: "applied",
    });
    return { ...evaluation.result, outcome: "APPLIED" as const };
  });
  return result;
};

export async function applyLaunch1000ProductPilot(
  db: Firestore,
  input: Launch1000ApplyRequest,
  operator: Launch1000Operator,
  snapshot: Launch1000ManifestSnapshot = loadLaunch1000Snapshot(),
): Promise<{ operationId: string; manifestRevision: string; status: "completed"; results: Launch1000ProductResult[]; counts: Record<string, number> }> {
  const entries = entryMap(snapshot, input.manifestRevision, input.productIds);
  const operation = await ensureOperation(db, input, operator);
  if (operation.completed) {
    return {
      operationId: input.operationId,
      manifestRevision: input.manifestRevision,
      status: "completed",
      results: operation.results,
      counts: operation.results.reduce<Record<string, number>>((counts, result) => {
        counts[result.outcome] = (counts[result.outcome] || 0) + 1;
        return counts;
      }, {}),
    };
  }
  const results = [...operation.results];
  for (const productId of input.productIds.slice().sort((left, right) => (entries.get(left)?.launchPriority || 0) - (entries.get(right)?.launchPriority || 0))) {
    if (results.some((result) => result.productId === productId)) continue;
    const result = await applyOne(db, input, entries.get(productId) as Launch1000ManifestEntry, operator, snapshot);
    results.push(result);
    await appendOperationResult(db, input, result, results.length === input.productIds.length);
  }
  return {
    operationId: input.operationId,
    manifestRevision: input.manifestRevision,
    status: "completed",
    results,
    counts: results.reduce<Record<string, number>>((counts, result) => {
      counts[result.outcome] = (counts[result.outcome] || 0) + 1;
      return counts;
    }, {}),
  };
}

export const launch1000ApplyWritesOnlyReviewProjection = true;
