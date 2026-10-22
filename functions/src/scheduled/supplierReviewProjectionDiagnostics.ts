export const SUPPLIER_REVIEW_PROJECTION_DIAGNOSTIC_SCHEMA_VERSION = 1;

export type SupplierReviewProjectionDiagnosticOutcome = "pre_commit_intent" | "commit_success";

export interface SupplierReviewProjectionSnapshot {
  classes?: unknown;
  version?: unknown;
}

export interface SupplierReviewProjectionDiagnosticInput {
  writer: string;
  operation: string;
  outcome: SupplierReviewProjectionDiagnosticOutcome;
  queueItemId?: unknown;
  runId?: unknown;
  correlationId?: unknown;
  expectedProjection: SupplierReviewProjectionSnapshot;
  persistedProjection: SupplierReviewProjectionSnapshot;
  previousProjection?: SupplierReviewProjectionSnapshot | null;
  categoryDecisionRequired?: boolean | null;
  zeroStock?: boolean | null;
  existingDocument?: boolean | null;
  transactionAttempts?: number | null;
}

export interface SupplierReviewProjectionDiagnosticLogger {
  info(message: string, context: Record<string, unknown>): void;
  warn(message: string, context: Record<string, unknown>): void;
}

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_CLASS_COUNT = 20;
const MAX_CLASS_LENGTH = 64;

const safeIdentifier = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH) return null;
  return /^[a-zA-Z0-9._:-]+$/u.test(normalized) ? normalized : null;
};

const safeClasses = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= MAX_CLASS_LENGTH && /^[a-z0-9_]+$/u.test(entry))
    .slice(0, MAX_CLASS_COUNT);
};

const safeVersion = (value: unknown): number | null => {
  const version = Number(value);
  return Number.isInteger(version) && version >= 0 && version <= 100 ? version : null;
};

const projectionsMatch = (
  expected: SupplierReviewProjectionSnapshot,
  actual: SupplierReviewProjectionSnapshot,
): boolean => {
  const expectedClasses = safeClasses(expected.classes).sort();
  const actualClasses = safeClasses(actual.classes).sort();
  return safeVersion(expected.version) === safeVersion(actual.version)
    && expectedClasses.length === actualClasses.length
    && expectedClasses.every((value, index) => value === actualClasses[index]);
};

const deriveZeroStock = (input: SupplierReviewProjectionDiagnosticInput): boolean | null => {
  if (typeof input.zeroStock === "boolean") return input.zeroStock;
  return null;
};

export const buildSupplierReviewProjectionDiagnostic = (
  input: SupplierReviewProjectionDiagnosticInput,
): Record<string, unknown> => {
  const expectedClasses = safeClasses(input.expectedProjection.classes);
  const persistedClasses = safeClasses(input.persistedProjection.classes);
  const previousClasses = input.previousProjection ? safeClasses(input.previousProjection.classes) : [];
  const diagnostic = {
    event: "supplier_review_projection_write_diagnostic",
    diagnosticSchemaVersion: SUPPLIER_REVIEW_PROJECTION_DIAGNOSTIC_SCHEMA_VERSION,
    writer: safeIdentifier(input.writer),
    operation: safeIdentifier(input.operation),
    outcome: input.outcome,
    queueItemId: safeIdentifier(input.queueItemId),
    runId: safeIdentifier(input.runId),
    correlationId: safeIdentifier(input.correlationId),
    expectedProjectionVersion: safeVersion(input.expectedProjection.version),
    expectedClasses,
    persistedProjectionVersion: safeVersion(input.persistedProjection.version),
    persistedClasses,
    previousProjectionVersion: input.previousProjection ? safeVersion(input.previousProjection.version) : null,
    previousClasses,
    categoryDecisionRequired: typeof input.categoryDecisionRequired === "boolean"
      ? input.categoryDecisionRequired
      : expectedClasses.includes("category_decision_required"),
    zeroStock: deriveZeroStock(input),
    existingDocument: typeof input.existingDocument === "boolean" ? input.existingDocument : null,
    projectionMismatch: !projectionsMatch(input.expectedProjection, input.persistedProjection),
    previousProjectionMismatch: input.previousProjection
      ? !projectionsMatch(input.expectedProjection, input.previousProjection)
      : false,
    transactionAttempts: Number.isInteger(input.transactionAttempts) && Number(input.transactionAttempts) > 0
      ? Number(input.transactionAttempts)
      : null,
  };
  return diagnostic;
};

/**
 * Emit only sanitized, bounded fields. Diagnostics are best effort and must
 * never alter queue processing when the logging backend is unavailable.
 */
export const emitSupplierReviewProjectionDiagnostic = (
  logger: SupplierReviewProjectionDiagnosticLogger,
  input: SupplierReviewProjectionDiagnosticInput,
): void => {
  try {
    const diagnostic = buildSupplierReviewProjectionDiagnostic(input);
    const mismatch = diagnostic.projectionMismatch === true || diagnostic.previousProjectionMismatch === true;
    const message = mismatch
      ? "Supplier review projection write differed from canonical projection."
      : "Supplier review projection write recorded.";
    if (mismatch) logger.warn(message, diagnostic);
    else logger.info(message, diagnostic);
  } catch {
    // Observability must never break a supplier write or queue lifecycle.
  }
};
