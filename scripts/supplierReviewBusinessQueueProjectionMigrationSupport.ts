import {
  isSupplierReviewBusinessProjectionStatusActive,
  SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
  SupplierReviewBusinessProjectionStatus,
} from "../functions/src/api/suppliers/supplierReviewBusinessQueueProjection";

const PROJECTION_FIELDS = new Set(["businessQueueClasses", "businessQueueClassesVersion"]);

const normalizeForProjectionFingerprint = (value: unknown): unknown => {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeForProjectionFingerprint);
  if (value && typeof value === "object") {
    const timestamp = value as { toMillis?: unknown; seconds?: unknown; nanoseconds?: unknown };
    if (typeof timestamp.toMillis === "function") return { __timestampMillis: timestamp.toMillis() };
    if (typeof timestamp.seconds === "number") {
      return {
        __timestamp: `${timestamp.seconds}:${typeof timestamp.nanoseconds === "number" ? timestamp.nanoseconds : 0}`,
      };
    }
    return Object.fromEntries(Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, normalizeForProjectionFingerprint((value as Record<string, unknown>)[key])]));
  }
  return String(value);
};

/**
 * Fences projection-only writes against any source-record change observed
 * after the migration page was read. Projection fields are deliberately
 * excluded because they are the only fields this migration is allowed to
 * replace.
 */
export const supplierReviewProjectionSourceFingerprint = (
  record: Record<string, unknown>,
): string => JSON.stringify(Object.fromEntries(Object.keys(record)
  .filter((key) => !PROJECTION_FIELDS.has(key))
  .sort()
  .map((key) => [key, normalizeForProjectionFingerprint(record[key])])));

export type SupplierReviewBusinessProjectionMigrationMode =
  | "initial"
  | "mixed-version-repair"
  | "noop";

export const migrationModeFor = (
  existing: Partial<SupplierReviewBusinessProjectionStatus> | null | undefined,
  legacyRecordsPresent: boolean,
): SupplierReviewBusinessProjectionMigrationMode => {
  if (!isSupplierReviewBusinessProjectionStatusActive(existing)) return "initial";
  return legacyRecordsPresent ? "mixed-version-repair" : "noop";
};

export const canResumeSupplierReviewBusinessProjectionMigration = (
  existing: Partial<SupplierReviewBusinessProjectionStatus> | null | undefined,
): boolean => (
  existing?.status === "pending"
  && existing.version === SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION
);

export const projectionPatchRequiresWrite = (
  record: Record<string, unknown>,
  patch: Record<string, unknown>,
): boolean => (
  JSON.stringify(record.businessQueueClasses || [])
    !== JSON.stringify(patch.businessQueueClasses || [])
    || record.businessQueueClassesVersion !== patch.businessQueueClassesVersion
);
