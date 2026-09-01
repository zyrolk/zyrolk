import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Firestore } from "firebase-admin/firestore";
import sharp from "sharp";
import type { SupplierOutboundResponse } from "../functions/src/api/security/supplierOutboundRequest";
import {
  acquireSupplierManagedMedia,
  MAX_SUPPLIER_IMAGE_BYTES,
  parseDeclaredSupplierImageMimeType,
  SupplierMediaPipelineDependencies,
  validateSupplierImageMimeType,
} from "../functions/src/api/suppliers/supplierMediaPipeline";

const pngBody = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgEpHjEpFjgFAABk4A8YCCZIUAAAAASUVORK5CYII=",
  "base64",
);
const jpegBody = await sharp(pngBody).jpeg().toBuffer();

const response = (body: Buffer, contentType: string, status = 200): SupplierOutboundResponse => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers({ "content-type": contentType, "content-length": String(body.length) }),
  text: async () => body.toString("utf8"),
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  json: async <T>() => JSON.parse(body.toString("utf8")) as T,
});

const dependencies = (overrides: Partial<SupplierMediaPipelineDependencies> = {}): {
  dependencies: SupplierMediaPipelineDependencies;
  savedFiles: Array<{ path: string; body: Buffer; contentType: string }>;
  audits: Array<Record<string, unknown>>;
} => {
  const savedFiles: Array<{ path: string; body: Buffer; contentType: string }> = [];
  const audits: Array<Record<string, unknown>> = [];
  return {
    savedFiles,
    audits,
    dependencies: {
      fetchImage: async () => response(pngBody, "image/png"),
      findAsset: async () => null,
      saveFile: async (path, body, contentType) => {
        savedFiles.push({ path, body, contentType });
        return `https://storage.example/${encodeURIComponent(path)}`;
      },
      saveAsset: async () => undefined,
      recordAudit: async (event) => { audits.push(event); },
      ...overrides,
    },
  };
};

const request = {
  queueItemId: "queue-mime",
  supplierId: "supplier-a",
  sourceId: "source-a",
  productId: "product-a",
  imageUrls: ["https://ayp.lk/storage/products/a2z/3129.jpg"],
  now: Date.parse("2026-09-01T00:00:00.000Z"),
};

test("supplier image MIME normalization accepts image/jpeg header with PNG bytes", async () => {
  const fixture = dependencies({ fetchImage: async () => response(pngBody, "image/jpeg") });
  const result = await acquireSupplierManagedMedia({} as Firestore, request, fixture.dependencies);
  assert.equal(result.failures.length, 0);
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].mimeType, "image/png");
  assert.equal(fixture.audits.some((entry) => entry.event === "supplier_media_acquired" && entry.mimeTypeMismatch === true), true);
});

test("supplier image MIME normalization accepts image/png header with JPEG bytes", async () => {
  const fixture = dependencies({ fetchImage: async () => response(jpegBody, "image/png") });
  const result = await acquireSupplierManagedMedia({} as Firestore, request, fixture.dependencies);
  assert.equal(result.failures.length, 0);
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].mimeType, "image/jpeg");
});

test("supplier image MIME normalization rejects text/html with invalid non-image bytes", async () => {
  const htmlBody = Buffer.from("<html><body>not an image</body></html>", "utf8");
  const fixture = dependencies({ fetchImage: async () => response(htmlBody, "text/html") });
  const result = await acquireSupplierManagedMedia({} as Firestore, request, fixture.dependencies);
  assert.equal(result.assets.length, 0);
  assert.match(result.failures[0].reason, /could not be decoded|not supported/u);
  assert.equal(result.failures[0].retryable, false);
  assert.equal(fixture.savedFiles.length, 0);
});

test("supplier image MIME normalization rejects image/jpeg header with malformed bytes", async () => {
  const malformed = Buffer.from("not-a-real-jpeg", "utf8");
  const fixture = dependencies({ fetchImage: async () => response(malformed, "image/jpeg") });
  const result = await acquireSupplierManagedMedia({} as Firestore, request, fixture.dependencies);
  assert.equal(result.assets.length, 0);
  assert.match(result.failures[0].reason, /could not be decoded/u);
  assert.equal(result.failures[0].retryable, false);
});

test("supplier image MIME normalization rejects unsupported detected formats", async () => {
  const tiffBody = await sharp(pngBody).tiff().toBuffer();
  const fixture = dependencies({ fetchImage: async () => response(tiffBody, "image/tiff") });
  const result = await acquireSupplierManagedMedia({} as Firestore, request, fixture.dependencies);
  assert.equal(result.assets.length, 0);
  assert.match(result.failures[0].reason, /not supported/u);
  assert.equal(result.failures[0].retryable, false);
});

test("supplier image MIME normalization rejects oversized images", async () => {
  const oversizedResponse = response(pngBody, "image/png");
  oversizedResponse.headers.set("content-length", String(MAX_SUPPLIER_IMAGE_BYTES + 1));
  const fixture = dependencies({ fetchImage: async () => oversizedResponse });
  const result = await acquireSupplierManagedMedia({} as Firestore, request, fixture.dependencies);
  assert.equal(result.assets.length, 0);
  assert.match(result.failures[0].reason, /maximum allowed size/u);
  assert.equal(result.failures[0].retryable, false);
});

test("supplier image MIME normalization keeps TLS and SSRF protections unchanged", () => {
  const outbound = readFileSync("functions/src/api/security/supplierOutboundRequest.ts", "utf8");
  const pipeline = readFileSync("functions/src/api/suppliers/supplierMediaPipeline.ts", "utf8");
  assert.match(outbound, /validateSupplierOutboundUrl/u);
  assert.match(outbound, /createPinnedLookup/u);
  assert.doesNotMatch(outbound, /rejectUnauthorized:\s*false/u);
  assert.match(pipeline, /validateSupplierMediaUrl/u);
  assert.match(pipeline, /fetchSupplierOutbound/u);
  assert.match(pipeline, /approvedHosts/u);
  assert.doesNotMatch(pipeline, /rejectUnauthorized:\s*false/u);
  assert.throws(() => validateSupplierImageMimeType("image/svg+xml"), /not supported/u);
  assert.equal(parseDeclaredSupplierImageMimeType("text/html"), null);
});

test("supplier image MIME normalization allows partial gallery success with mismatched MIME on another URL", async () => {
  const goodUrl = "https://ayp.lk/storage/products/a2z/3129.jpg";
  const badUrl = "https://ayp.lk/storage/products/a2z/broken.jpg";
  const fixture = dependencies({
    fetchImage: async (url) => {
      if (url === badUrl) return response(Buffer.from("broken", "utf8"), "image/jpeg");
      return response(pngBody, "image/jpeg");
    },
  });
  const result = await acquireSupplierManagedMedia({} as Firestore, {
    ...request,
    imageUrls: [badUrl, goodUrl],
  }, fixture.dependencies);
  assert.equal(result.assets.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.assets[0].mimeType, "image/png");
  assert.equal(result.failures[0].retryable, false);
});
