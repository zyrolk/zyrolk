import assert from "node:assert/strict";
import test from "node:test";
import { supplierReviewOverviewCountStatus } from "../functions/src/api/suppliers/supplierOperations";
import {
  decorateSupplierReviewQueueAdminMedia,
  isStableManagedSupplierMediaUrl,
} from "../functions/src/scheduled/supplierReviewQueue";

const completeCounts = () => ({
  actionableReviewCount: 1,
  needsAttentionReviewCount: 2,
  lowStockHoldReviewCount: 3,
  mediaReadyCount: 4,
  mediaProcessingCount: 5,
  mediaIssueCount: 6,
  approvedCount: 7,
});

const managedAsset = (firebaseStorageUrl: string, overrides: Record<string, unknown> = {}) => ({
  assetId: "asset-1",
  imageStatus: "ready",
  firebaseStorageUrl,
  originalStoragePath: "supplier-media/dropex/product-1/original/source.jpg",
  variants: { large: { storagePath: "supplier-media/dropex/product-1/large/image.webp" } },
  ...overrides,
});

test("stable managed canonical media URL is reusable without signing", async () => {
  const asset = managedAsset("https://firebasestorage.googleapis.com/v0/b/zyrolk-e0164.firebasestorage.app/o/supplier-media%2Fdropex%2Fproduct-1%2Flarge%2Fimage.webp?alt=media");
  assert.equal(isStableManagedSupplierMediaUrl(asset), true);
  let signCalls = 0;
  const [item] = await decorateSupplierReviewQueueAdminMedia([
    { id: "review-1", managedMedia: [asset] },
  ], async () => { signCalls += 1; return "https://signed.example/review"; }, { skipSigningForUsableCanonicalUrl: true });
  assert.equal(signCalls, 0);
  assert.equal((item.managedMedia as Array<Record<string, unknown>>)[0].firebaseStorageUrl, asset.firebaseStorageUrl);
});

test("supplier-origin and unknown legacy HTTPS URLs still use safe signing", async () => {
  for (const url of ["https://supplier.example/image.jpg", "https://legacy.example/image.jpg"]) {
    const asset = managedAsset(url);
    assert.equal(isStableManagedSupplierMediaUrl(asset), false, url);
    let signCalls = 0;
    await decorateSupplierReviewQueueAdminMedia([
      { id: "review-2", managedMedia: [asset] },
    ], async () => { signCalls += 1; return "https://signed.example/review"; }, { skipSigningForUsableCanonicalUrl: true });
    assert.equal(signCalls, 1, url);
  }
});

test("temporary signed URLs are never treated as stable canonical media", () => {
  const signed = managedAsset("https://firebasestorage.googleapis.com/v0/b/zyrolk-e0164.firebasestorage.app/o/path?alt=media&X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Expires=900&X-Goog-Signature=abc");
  assert.equal(isStableManagedSupplierMediaUrl(signed), false);
  assert.equal(isStableManagedSupplierMediaUrl(managedAsset("https://firebasestorage.googleapis.com/v0/b/bucket/o/path?alt=media", { imageStatus: "processing" })), false);
  assert.equal(isStableManagedSupplierMediaUrl(managedAsset("https://firebasestorage.googleapis.com/v0/b/bucket/o/other%2Fimage.webp?alt=media")), false);
});

test("Supplier Overview countStatus is exact only when every required count is available", () => {
  assert.equal(supplierReviewOverviewCountStatus(completeCounts()), "exact");
  assert.equal(supplierReviewOverviewCountStatus({ ...completeCounts(), actionableReviewCount: null }), "partial");
  assert.equal(supplierReviewOverviewCountStatus({ ...completeCounts(), mediaProcessingCount: null }), "partial");
  assert.equal(supplierReviewOverviewCountStatus({ ...completeCounts(), approvedCount: null }), "partial");
});
