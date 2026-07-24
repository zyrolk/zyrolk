import { createHash } from "node:crypto";
import * as path from "node:path";
import { Firestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
const sharp: typeof import("sharp").default = require("sharp");
import { appLogger } from "../logging";
import { fetchSupplierOutbound, SupplierOutboundResponse } from "../security/supplierOutboundRequest";

export const SUPPLIER_MEDIA_COLLECTION = "supplier_media_assets";
export const SUPPLIER_MEDIA_AUDIT_COLLECTION = "supplier_media_audit";
export const MAX_SUPPLIER_GALLERY_IMAGES = 20;
export const MAX_SUPPLIER_IMAGE_BYTES = 10 * 1024 * 1024;

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);
const MIME_BY_SHARP_FORMAT: Readonly<Record<string, string>> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};
const VARIANT_WIDTHS = {
  thumbnail: 320,
  medium: 960,
  large: 1_600,
} as const;

export type SupplierMediaVariantName = "thumbnail" | "medium" | "large";
export type SupplierMediaStatus = "ready" | "published";

export interface SupplierMediaVariant {
  storagePath: string;
  storageUrl: string;
  width: number;
  height: number;
  mimeType: "image/webp";
  fileSize: number;
}

export interface SupplierManagedMediaAsset {
  assetId: string;
  supplierId: string;
  sourceId: string;
  productId: string;
  originalSupplierUrl: string;
  originalStoragePath: string;
  originalStorageUrl: string;
  firebaseStorageUrl: string;
  contentHash: string;
  width: number;
  height: number;
  mimeType: string;
  fileSize: number;
  uploadTimestamp: string;
  imageStatus: SupplierMediaStatus;
  isPrimary: boolean;
  sortOrder: number;
  variants: Record<SupplierMediaVariantName, SupplierMediaVariant>;
}

export interface SupplierMediaFailure {
  originalSupplierUrl: string;
  reason: string;
  retryable: boolean;
  failedAt: string;
}

export interface SupplierMediaAcquisitionRequest {
  queueItemId: string;
  supplierId: string;
  sourceId: string;
  productId: string;
  imageUrls: readonly string[];
  maxImages?: number;
  now?: number;
  retryCount?: number;
}

export interface SupplierMediaAcquisitionResult {
  assets: SupplierManagedMediaAsset[];
  failures: SupplierMediaFailure[];
  duplicateCount: number;
}

export interface SupplierMediaPipelineDependencies {
  fetchImage: (url: string, sourceId: string) => Promise<SupplierOutboundResponse>;
  findAsset: (contentHash: string) => Promise<SupplierManagedMediaAsset | null>;
  saveFile: (storagePath: string, body: Buffer, contentType: string, metadata: Record<string, string>) => Promise<string>;
  saveAsset: (asset: SupplierManagedMediaAsset) => Promise<void>;
  recordAudit: (event: Record<string, unknown>) => Promise<void>;
}

export class SupplierMediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplierMediaValidationError";
  }
}

export class SupplierMediaRetryableError extends Error {
  readonly failures: SupplierMediaFailure[];

  constructor(failures: SupplierMediaFailure[]) {
    super(`Supplier media acquisition failed for ${failures.length} image(s) and will be retried.`);
    this.name = "SupplierMediaRetryableError";
    this.failures = failures;
  }
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const cleanSegment = (value: string, fallback: string): string => {
  const cleaned = value.normalize("NFKC").trim().replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return (cleaned || fallback).slice(0, 120);
};

const cleanOriginalFilename = (url: string, mimeType: string): string => {
  const extensions: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
  };
  let filename = "supplier-image";
  try {
    filename = decodeURIComponent(path.posix.basename(new URL(url).pathname)) || filename;
  } catch {
    // The URL has already been validated; retain the safe fallback filename.
  }
  const parsed = path.posix.parse(filename);
  const base = cleanSegment(parsed.name, "supplier-image").slice(0, 80);
  const extension = extensions[mimeType] || ".img";
  return `${base}${extension}`;
};

export function validateSupplierMediaUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new SupplierMediaValidationError("Supplier image URL is missing.");
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new SupplierMediaValidationError("Supplier image URL is invalid.");
  }
  if (parsed.protocol !== "https:") throw new SupplierMediaValidationError("Supplier images must use HTTPS.");
  if (parsed.username || parsed.password) throw new SupplierMediaValidationError("Supplier image URLs cannot contain credentials.");
  return parsed.toString();
}

export function validateSupplierImageMimeType(value: string | null): string {
  const mimeType = String(value || "").split(";", 1)[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new SupplierMediaValidationError("Supplier image MIME type is not supported.");
  }
  return mimeType;
}

export function supplierMediaRetryDelayMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(30_000 * (2 ** (safeAttempt - 1)), 60 * 60 * 1_000);
}

export function orderSupplierManagedMedia(assets: readonly SupplierManagedMediaAsset[]): SupplierManagedMediaAsset[] {
  return [...assets]
    .sort((left, right) => left.sortOrder - right.sortOrder || left.contentHash.localeCompare(right.contentHash))
    .slice(0, MAX_SUPPLIER_GALLERY_IMAGES)
    .map((asset, index) => ({ ...asset, isPrimary: index === 0, sortOrder: index }));
}

export function toPublishedProductMedia(assets: readonly SupplierManagedMediaAsset[]): Array<Record<string, unknown>> {
  return orderSupplierManagedMedia(assets).map((asset) => ({
    assetId: asset.assetId,
    contentHash: asset.contentHash,
    width: asset.width,
    height: asset.height,
    mimeType: asset.mimeType,
    fileSize: asset.fileSize,
    imageStatus: "published",
    isPrimary: asset.isPrimary,
    sortOrder: asset.sortOrder,
    firebaseStorageUrl: asset.firebaseStorageUrl,
    variants: asset.variants,
  }));
}

export function applyManagedMediaToProductPayload(
  payload: Readonly<Record<string, unknown>>,
  assets: readonly SupplierManagedMediaAsset[],
): Record<string, unknown> {
  const ordered = orderSupplierManagedMedia(assets);
  const imageUrls = ordered.map((asset) => asset.firebaseStorageUrl);
  return {
    ...payload,
    imageUrl: imageUrls[0] || "",
    imageUrls,
    media: toPublishedProductMedia(ordered).map((asset) => ({ ...asset, imageStatus: "ready" })),
    supplierMedia: ordered,
  };
}

const firebaseStorageUrl = (bucketName: string, storagePath: string): string =>
  `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(storagePath)}?alt=media`;

const configuredStorageBucket = (): string | undefined => {
  if (process.env.FIREBASE_STORAGE_BUCKET?.trim()) return process.env.FIREBASE_STORAGE_BUCKET.trim();
  try {
    const config = JSON.parse(process.env.FIREBASE_CONFIG || "{}") as { storageBucket?: unknown };
    if (typeof config.storageBucket === "string" && config.storageBucket.trim()) return config.storageBucket.trim();
  } catch {
    // Fall through to the project-scoped Firebase Storage bucket.
  }
  const projectId = process.env.GCLOUD_PROJECT
    || process.env.GOOGLE_CLOUD_PROJECT
    || process.env.FIREBASE_PROJECT_ID
    || "zyrolk-e0164";
  return `${projectId}.firebasestorage.app`;
};

const defaultFetchImage = async (url: string, sourceId: string): Promise<SupplierOutboundResponse> => {
  const parsed = new URL(validateSupplierMediaUrl(url));
  return fetchSupplierOutbound(parsed.toString(), {
    method: "GET",
    headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif" },
    signal: AbortSignal.timeout(20_000),
  }, {
    approvedHosts: [parsed.hostname],
    connector: "supplier-media",
    sourceId,
    maxRedirects: 3,
  });
};

const defaultDependencies = (db: Firestore): SupplierMediaPipelineDependencies => {
  const bucket = getStorage().bucket(configuredStorageBucket());
  return {
    fetchImage: defaultFetchImage,
    findAsset: async (contentHash) => {
      const snapshot = await db.collection(SUPPLIER_MEDIA_COLLECTION).doc(contentHash).get();
      if (!snapshot.exists) return null;
      const asset = snapshot.data() as SupplierManagedMediaAsset;
      const storagePaths = [
        asset.originalStoragePath,
        asset.variants?.thumbnail?.storagePath,
        asset.variants?.medium?.storagePath,
        asset.variants?.large?.storagePath,
      ].filter((value): value is string => typeof value === "string" && value.length > 0);
      if (storagePaths.length !== 4) return null;
      const existence = await Promise.all(storagePaths.map(async (storagePath) => (await bucket.file(storagePath).exists())[0]));
      return existence.every(Boolean) ? asset : null;
    },
    saveFile: async (storagePath, body, contentType, metadata) => {
      await bucket.file(storagePath).save(body, {
        resumable: false,
        contentType,
        metadata: {
          cacheControl: "public,max-age=31536000,immutable",
          metadata,
        },
        validation: "crc32c",
      });
      return firebaseStorageUrl(bucket.name, storagePath);
    },
    saveAsset: async (asset) => {
      await db.collection(SUPPLIER_MEDIA_COLLECTION).doc(asset.assetId).set(asset, { merge: false });
    },
    recordAudit: async (event) => {
      await db.collection(SUPPLIER_MEDIA_AUDIT_COLLECTION).add(event);
    },
  };
};

const downloadSupplierImage = async (
  url: string,
  sourceId: string,
  dependencies: SupplierMediaPipelineDependencies,
): Promise<{ body: Buffer; mimeType: string; width: number; height: number }> => {
  const response = await dependencies.fetchImage(url, sourceId);
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    if (retryable) throw new Error(`Supplier image server returned HTTP ${response.status}.`);
    throw new SupplierMediaValidationError(`Supplier image server rejected the request with HTTP ${response.status}.`);
  }
  const declaredMimeType = validateSupplierImageMimeType(response.headers.get("content-type"));
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SUPPLIER_IMAGE_BYTES) {
    throw new SupplierMediaValidationError("Supplier image exceeds the maximum allowed size.");
  }
  if (!response.arrayBuffer) throw new Error("Supplier image transport did not provide a binary response.");
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0 || body.length > MAX_SUPPLIER_IMAGE_BYTES) {
    throw new SupplierMediaValidationError(body.length === 0
      ? "Supplier image response was empty."
      : "Supplier image exceeds the maximum allowed size.");
  }
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(body, { limitInputPixels: 40_000_000 }).metadata();
  } catch {
    throw new SupplierMediaValidationError("Supplier image content could not be decoded.");
  }
  const detectedMimeType = metadata.format ? MIME_BY_SHARP_FORMAT[metadata.format] : undefined;
  if (!detectedMimeType || !ALLOWED_IMAGE_MIME_TYPES.has(detectedMimeType)) {
    throw new SupplierMediaValidationError("Supplier image encoding is not supported.");
  }
  if (detectedMimeType !== declaredMimeType) {
    throw new SupplierMediaValidationError("Supplier image MIME type does not match its content.");
  }
  if (!metadata.width || !metadata.height) throw new SupplierMediaValidationError("Supplier image dimensions could not be determined.");
  return { body, mimeType: detectedMimeType, width: metadata.width, height: metadata.height };
};

const createVariant = async (body: Buffer, width: number): Promise<{ body: Buffer; width: number; height: number }> => {
  const optimized = await sharp(body, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width, withoutEnlargement: true, fit: "inside" })
    .webp({ quality: 82, effort: 4 })
    .toBuffer({ resolveWithObject: true });
  return {
    body: optimized.data,
    width: optimized.info.width,
    height: optimized.info.height,
  };
};

export async function acquireSupplierManagedMedia(
  db: Firestore,
  request: SupplierMediaAcquisitionRequest,
  dependencyOverrides?: Partial<SupplierMediaPipelineDependencies>,
): Promise<SupplierMediaAcquisitionResult> {
  const now = request.now ?? Date.now();
  const uploadTimestamp = new Date(now).toISOString();
  const maxImages = Math.min(
    Math.max(1, Math.floor(request.maxImages || MAX_SUPPLIER_GALLERY_IMAGES)),
    MAX_SUPPLIER_GALLERY_IMAGES,
  );
  const uniqueUrls = [...new Set(request.imageUrls.map((url) => String(url || "").trim()).filter(Boolean))].slice(0, maxImages);
  const assets: SupplierManagedMediaAsset[] = [];
  const failures: SupplierMediaFailure[] = [];
  if (uniqueUrls.length === 0) return { assets, failures, duplicateCount: 0 };
  const suppliedDependencies = dependencyOverrides || {};
  const hasCompleteDependencies = ["fetchImage", "findAsset", "saveFile", "saveAsset", "recordAudit"]
    .every((key) => typeof suppliedDependencies[key as keyof SupplierMediaPipelineDependencies] === "function");
  const dependencies = {
    ...(hasCompleteDependencies ? {} : defaultDependencies(db)),
    ...suppliedDependencies,
  } as SupplierMediaPipelineDependencies;
  let duplicateCount = 0;

  for (let index = 0; index < uniqueUrls.length; index += 1) {
    const suppliedUrl = uniqueUrls[index];
    const processingStartedAt = Date.now();
    try {
      const originalSupplierUrl = validateSupplierMediaUrl(suppliedUrl);
      const downloaded = await downloadSupplierImage(originalSupplierUrl, request.sourceId, dependencies);
      const contentHash = createHash("sha256").update(downloaded.body).digest("hex");
      const existing = await dependencies.findAsset(contentHash);
      if (existing?.variants?.large?.storageUrl) {
        duplicateCount += 1;
        assets.push({
          ...existing,
          originalSupplierUrl,
          supplierId: request.supplierId,
          sourceId: request.sourceId,
          productId: request.productId,
          isPrimary: index === 0,
          sortOrder: index,
        });
        await dependencies.recordAudit({
          event: "supplier_media_reused",
          queueItemId: request.queueItemId,
          sourceId: request.sourceId,
          supplierId: request.supplierId,
          productId: request.productId,
          contentHash,
          timestamp: uploadTimestamp,
          retryCount: Math.max(0, Number(request.retryCount) || 0),
          processingDurationMs: Math.max(0, Date.now() - processingStartedAt),
        });
        continue;
      }

      const supplierId = cleanSegment(request.supplierId, "supplier");
      const productId = cleanSegment(request.productId, "product");
      const originalFilename = cleanOriginalFilename(originalSupplierUrl, downloaded.mimeType);
      const basePath = `supplier-media/${supplierId}/${productId}/${contentHash}`;
      const originalStoragePath = `${basePath}/original/${originalFilename}`;
      const preparedVariants = new Map<SupplierMediaVariantName, Awaited<ReturnType<typeof createVariant>>>();
      try {
        for (const [variantName, width] of Object.entries(VARIANT_WIDTHS) as Array<[SupplierMediaVariantName, number]>) {
          preparedVariants.set(variantName, await createVariant(downloaded.body, width));
        }
      } catch {
        throw new SupplierMediaValidationError("Supplier image could not be optimized safely.");
      }
      const originalStorageUrl = await dependencies.saveFile(
        originalStoragePath,
        downloaded.body,
        downloaded.mimeType,
        { contentHash, sourceId: request.sourceId, supplierId: request.supplierId, productId: request.productId },
      );
      const variants = {} as Record<SupplierMediaVariantName, SupplierMediaVariant>;
      for (const variantName of Object.keys(VARIANT_WIDTHS) as SupplierMediaVariantName[]) {
        const variant = preparedVariants.get(variantName);
        if (!variant) throw new SupplierMediaValidationError("Supplier image optimization output is incomplete.");
        const storagePath = `${basePath}/${variantName}/image.webp`;
        const storageUrl = await dependencies.saveFile(
          storagePath,
          variant.body,
          "image/webp",
          { contentHash, sourceId: request.sourceId, supplierId: request.supplierId, productId: request.productId, variant: variantName },
        );
        variants[variantName] = {
          storagePath,
          storageUrl,
          width: variant.width,
          height: variant.height,
          mimeType: "image/webp",
          fileSize: variant.body.length,
        };
      }
      const asset: SupplierManagedMediaAsset = {
        assetId: contentHash,
        supplierId: request.supplierId,
        sourceId: request.sourceId,
        productId: request.productId,
        originalSupplierUrl,
        originalStoragePath,
        originalStorageUrl,
        firebaseStorageUrl: variants.large.storageUrl,
        contentHash,
        width: downloaded.width,
        height: downloaded.height,
        mimeType: downloaded.mimeType,
        fileSize: downloaded.body.length,
        uploadTimestamp,
        imageStatus: "ready",
        isPrimary: index === 0,
        sortOrder: index,
        variants,
      };
      await dependencies.saveAsset(asset);
      await dependencies.recordAudit({
        event: "supplier_media_acquired",
        queueItemId: request.queueItemId,
        sourceId: request.sourceId,
        supplierId: request.supplierId,
        productId: request.productId,
        contentHash,
        fileSize: downloaded.body.length,
        mimeType: downloaded.mimeType,
        timestamp: uploadTimestamp,
        retryCount: Math.max(0, Number(request.retryCount) || 0),
        processingDurationMs: Math.max(0, Date.now() - processingStartedAt),
      });
      assets.push(asset);
    } catch (error) {
      const retryable = !(error instanceof SupplierMediaValidationError);
      const failure: SupplierMediaFailure = {
        originalSupplierUrl: suppliedUrl,
        reason: (error instanceof Error ? error.message : "Supplier image download failed.").slice(0, 500),
        retryable,
        failedAt: uploadTimestamp,
      };
      failures.push(failure);
      await dependencies.recordAudit({
        event: "supplier_media_failed",
        queueItemId: request.queueItemId,
        sourceId: request.sourceId,
        supplierId: request.supplierId,
        productId: request.productId,
        failure,
        timestamp: uploadTimestamp,
        retryCount: Math.max(0, Number(request.retryCount) || 0),
        processingDurationMs: Math.max(0, Date.now() - processingStartedAt),
      });
      appLogger.warn("Supplier media acquisition failed.", {
        queueItemId: request.queueItemId,
        sourceId: request.sourceId,
        supplierId: request.supplierId,
        productId: request.productId,
        hostname: (() => { try { return new URL(suppliedUrl).hostname; } catch { return "invalid"; } })(),
        retryable,
        reason: failure.reason,
      });
    }
  }

  const retryableFailures = failures.filter((failure) => failure.retryable);
  if (retryableFailures.length > 0) throw new SupplierMediaRetryableError(retryableFailures);
  return { assets: orderSupplierManagedMedia(assets), failures, duplicateCount };
}

export function extractSupplierMediaFromRecord(value: unknown): SupplierManagedMediaAsset[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is SupplierManagedMediaAsset => {
    const item = record(entry);
    return typeof item.contentHash === "string"
      && typeof item.firebaseStorageUrl === "string"
      && typeof record(item.variants).large === "object";
  });
}
