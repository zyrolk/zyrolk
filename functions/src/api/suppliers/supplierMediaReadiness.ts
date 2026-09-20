export const SUPPLIER_MEDIA_FAILURE_CODE = {
  IMAGE_TOO_LARGE: "IMAGE_TOO_LARGE",
  VALIDATION: "VALIDATION",
  UNKNOWN: "UNKNOWN",
} as const;

export type SupplierMediaFailureCode = typeof SUPPLIER_MEDIA_FAILURE_CODE[keyof typeof SUPPLIER_MEDIA_FAILURE_CODE];

export interface SupplierMediaFailureLike {
  code?: unknown;
  originalSupplierUrl?: unknown;
  retryable?: unknown;
  sourceIndex?: unknown;
  isPrimary?: unknown;
}

export interface SupplierMediaAssetLike {
  firebaseStorageUrl?: unknown;
  imageStatus?: unknown;
  isPrimary?: unknown;
  originalSupplierUrl?: unknown;
}

export interface SupplierMediaReadinessInput {
  supplierId?: unknown;
  sourceImageUrls?: unknown;
  managedMedia?: unknown;
  mediaFailures?: unknown;
}

export interface SupplierMediaReadinessResult {
  status: "blocked" | "publication_safe" | "publication_safe_with_media_warnings";
  publicationSafe: boolean;
  hasUsablePrimary: boolean;
  usableAssetCount: number;
  warningFailures: SupplierMediaFailureLike[];
  blockingFailures: SupplierMediaFailureLike[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
);

const isUsableAsset = (value: unknown): value is SupplierMediaAssetLike => {
  if (!isRecord(value)) return false;
  const status = String(value.imageStatus || "").trim().toLowerCase();
  return ["ready", "published"].includes(status)
    && /^https:\/\/\S+$/u.test(String(value.firebaseStorageUrl || "").trim());
};

const isDropexSupplier = (value: unknown): boolean => String(value || "").trim().toLowerCase() === "dropex";

/**
 * Only structured, server-produced metadata can make an image failure a
 * non-blocking warning. Legacy failures without this metadata fail closed.
 */
export const isOptionalSupplierMediaWarning = (
  value: unknown,
  sourceImageUrls?: readonly unknown[],
  supplierId?: unknown,
): boolean => {
  if (!isRecord(value)) return false;
  const sourceIndex = Number(value.sourceIndex);
  const originalUrl = String(value.originalSupplierUrl || "").trim();
  const sourceUrl = sourceIndex > 0 ? String(sourceImageUrls?.[sourceIndex - 1] || "").trim() : "";
  return value.code === SUPPLIER_MEDIA_FAILURE_CODE.IMAGE_TOO_LARGE
    && isDropexSupplier(supplierId)
    && value.retryable === false
    && value.isPrimary === false
    && Number.isInteger(sourceIndex)
    && sourceIndex > 1
    && Boolean(originalUrl)
    && (sourceImageUrls === undefined || (Boolean(sourceUrl) && originalUrl === sourceUrl));
};

export function classifySupplierMediaReadiness(input: SupplierMediaReadinessInput): SupplierMediaReadinessResult {
  const sourceImageUrls = Array.isArray(input.sourceImageUrls) ? input.sourceImageUrls : [];
  const assets = (Array.isArray(input.managedMedia) ? input.managedMedia : []).filter(isUsableAsset);
  const failures = (Array.isArray(input.mediaFailures) ? input.mediaFailures : []).filter(isRecord);
  const warningFailures = failures.filter((failure) => isOptionalSupplierMediaWarning(failure, sourceImageUrls, input.supplierId));
  const blockingFailures = failures.filter((failure) => !isOptionalSupplierMediaWarning(failure, sourceImageUrls, input.supplierId));
  const trustedPrimarySourceUrl = typeof sourceImageUrls[0] === "string" ? sourceImageUrls[0].trim() : "";
  const hasUsablePrimary = Boolean(trustedPrimarySourceUrl)
    && assets.some((asset) => asset.isPrimary === true
      && String(asset.originalSupplierUrl || "").trim() === trustedPrimarySourceUrl);
  const publicationSafe = hasUsablePrimary && assets.length > 0 && blockingFailures.length === 0;
  return {
    status: publicationSafe
      ? warningFailures.length > 0 ? "publication_safe_with_media_warnings" : "publication_safe"
      : "blocked",
    publicationSafe,
    hasUsablePrimary,
    usableAssetCount: assets.length,
    warningFailures,
    blockingFailures,
  };
}
