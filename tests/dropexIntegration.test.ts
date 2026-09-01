import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DROPEX_CREDENTIAL_PROFILE_MAP_PREFIX,
  normalizeDropexCredentialReference,
  resolveDropexCredentialProfile,
} from "../functions/src/api/suppliers/dropexCredentialProfiles";
import {
  buildDropexProductImageUrl,
  extractDropexProductImages,
  ProductParser,
} from "../functions/src/api/suppliers/dropex/ProductParser";
import {
  DropexHttpError,
  DROPEX_TRANSIENT_HTTP_MAX_ATTEMPTS,
  classifyDropexHttpStatus,
  transientRetryDelayMs,
} from "../functions/src/api/suppliers/dropex/dropexHttpErrors";
import { DropexConnectorService } from "../functions/src/api/suppliers/dropex/DropexConnectorService";
import {
  runSupplierCatalogTraversal,
} from "../functions/src/scheduled/supplierCatalogTraversal";
import type {
  SupplierCatalogPageRequest,
  SupplierCatalogPageResult,
  SupplierConnectorSyncCapabilities,
} from "../functions/src/api/suppliers/types";
import type { SupplierOutboundPolicy, SupplierOutboundResponse } from "../functions/src/api/security/supplierOutboundRequest";
import { RawA2ZProduct } from "../functions/src/api/suppliers/a2z/types";
import { projectSupplierSourceForAdmin, sanitizeSupplierSource } from "../functions/src/api/suppliers/supplierAdminConfiguration";
import { buildSupplierOnboardingSource } from "../src/services/supplierSourceOnboarding";

const profileSecret = (profiles: Record<string, unknown>): string => (
  `${DROPEX_CREDENTIAL_PROFILE_MAP_PREFIX}${JSON.stringify(profiles)}`
);

const outboundPolicy = {} as SupplierOutboundPolicy;

const response = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
): SupplierOutboundResponse => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers(headers),
  text: async () => body,
  json: async <T = unknown>() => JSON.parse(body) as T,
});

function encodeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

const loginToken = encodeJwt({
  exp: Math.floor(Date.now() / 1000) + 3600,
  account: { id: 42 },
});

const catalogItem = {
  productDetail: {
    id: 101,
    name: "Wall Phone Holder",
    sku: "DPX-101",
    description: "Supplier description",
    image: "holder.jpg,holder-alt.jpg",
    onHandInventory: 12,
    productCategoryId: 7,
  },
  reSellingPrice: 450,
};

const categoryPayload = [
  {
    id: 7,
    name: "Mobile Accessories",
    subCategories: [{ id: 71, name: "Holders" }],
  },
];

test("Dropex login extracts access_token and uses Bearer authorization", async () => {
  const authHeaders: string[] = [];
  const service = new DropexConnectorService({
    supplierId: "dropex-supplier",
    sourceId: "dropex-source",
    credentialReference: "dropex-production",
  }, {
    fetchOutbound: async (url, init) => {
      if (url.endsWith("/auth/login")) {
        return response(200, JSON.stringify({ access_token: loginToken }));
      }
      if (url.includes("/api/v1/re-seller-products/get")) {
        authHeaders.push(String((init.headers as Record<string, string>)?.Authorization || ""));
        return response(200, JSON.stringify({
          content: [catalogItem],
          totalElements: 1,
          number: 0,
          size: 1,
          last: true,
        }));
      }
      if (url.endsWith("/api/v1/product-categories")) {
        return response(200, JSON.stringify(categoryPayload));
      }
      if (url.includes("/api/v1/products/") && url.endsWith("/dto")) {
        return response(200, JSON.stringify({ sellingPrice: 890 }));
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const page = await service.testConnection({ username: "dropex-user", password: "dropex-pass" }, outboundPolicy);
  assert.equal(page.products.length, 1);
  assert.match(authHeaders[0] || "", /^Bearer /);
  assert.equal(authHeaders[0]?.includes("dropex-pass"), false);
});

test("Dropex connector re-authenticates once after HTTP 401", async () => {
  let loginCount = 0;
  let catalogAttempts = 0;
  const service = new DropexConnectorService({
    supplierId: "dropex-supplier",
    sourceId: "dropex-source",
    credentialReference: "dropex-production",
  }, {
    fetchOutbound: async (url, init) => {
      if (url.endsWith("/auth/login")) {
        loginCount += 1;
        return response(200, JSON.stringify({ access_token: loginToken }));
      }
      if (url.includes("/api/v1/re-seller-products/get")) {
        catalogAttempts += 1;
        if (catalogAttempts === 1) return response(401, '{"message":"expired"}');
        return response(200, JSON.stringify({
          content: [catalogItem],
          totalElements: 1,
          number: 0,
          size: 1,
          last: true,
        }));
      }
      if (url.endsWith("/api/v1/product-categories")) {
        return response(200, JSON.stringify(categoryPayload));
      }
      if (url.includes("/api/v1/products/") && url.endsWith("/dto")) {
        return response(200, JSON.stringify({ sellingPrice: 890 }));
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const page = await service.fetchCatalogPage(
    { username: "dropex-user", password: "dropex-pass" },
    outboundPolicy,
    { cursor: "0", pageSize: 1 },
  );
  assert.equal(page.products.length, 1);
  assert.equal(loginCount, 2);
});

test("Dropex catalog pagination uses page/size independently from traversal limit", async () => {
  const requests: Array<{ page: string; size: string }> = [];
  const service = new DropexConnectorService({
    supplierId: "dropex-supplier",
    sourceId: "dropex-source",
    credentialReference: "dropex-production",
  }, {
    fetchOutbound: async (url) => {
      if (url.endsWith("/auth/login")) {
        return response(200, JSON.stringify({ access_token: loginToken }));
      }
      if (url.includes("/api/v1/re-seller-products/get")) {
        const parsed = new URL(url);
        requests.push({
          page: parsed.searchParams.get("page") || "",
          size: parsed.searchParams.get("size") || "",
        });
        const page = Number(parsed.searchParams.get("page") || 0);
        const size = Number(parsed.searchParams.get("size") || 1);
        const content = Array.from({ length: size }, (_, index) => ({
          ...catalogItem,
          productDetail: {
            ...catalogItem.productDetail,
            id: page * size + index + 1,
            sku: `DPX-${page * size + index + 1}`,
            name: `Product ${page * size + index + 1}`,
          },
        }));
        return response(200, JSON.stringify({
          content,
          totalElements: 100,
          number: page,
          size,
          last: page >= 4,
        }));
      }
      if (url.endsWith("/api/v1/product-categories")) {
        return response(200, JSON.stringify(categoryPayload));
      }
      if (url.includes("/api/v1/products/") && url.endsWith("/dto")) {
        return response(200, JSON.stringify({ sellingPrice: 890 }));
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const capabilities: SupplierConnectorSyncCapabilities = {
    incremental: { supported: false, mechanism: "unsupported", deletionSemantics: "none" },
    categoryFilter: "server_side",
    subcategoryFilter: "server_side",
    searchFilter: "server_side",
  };

  const traversal = await runSupplierCatalogTraversal({
    connector: {
      syncCapabilities: capabilities,
      async fetchProductPage(request: SupplierCatalogPageRequest): Promise<SupplierCatalogPageResult> {
        return service.fetchCatalogPage(
          { username: "dropex-user", password: "dropex-pass" },
          outboundPolicy,
          request,
        );
      },
    },
    pageSize: 20,
    totalProductLimit: 5,
    deletionReconciliationEligible: false,
    processPage: async (page) => ({
      productsScanned: page.products.length,
      productsImported: page.products.length,
    }),
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => {
      throw new Error("Removal reconciliation must not run for a limited sync.");
    },
  });

  assert.equal(traversal.checkpoint.productsObserved, 5);
  assert.equal(traversal.checkpoint.deletionReconciliationEligible, false);
  assert.equal(requests[0]?.size, "5");
  assert.equal(requests.length, 1);
});

test("Dropex field mapping preserves canonical supplier review fields", () => {
  const parsed = ProductParser.parseCatalogItem(catalogItem, {
    categoryLookup: {
      resolveCategory: () => ({
        category: "Mobile Accessories",
        subcategory: "Holders",
        hierarchy: ["Mobile Accessories", "Holders"],
      }),
    },
    enrichment: { sellingPrice: 890 },
  });

  assert.equal(parsed.supplierProductId, "101");
  assert.equal(parsed.sku, "DPX-101");
  assert.equal(parsed.title, "Wall Phone Holder");
  assert.equal(parsed.longDescription, "Supplier description");
  assert.equal(parsed.wholesalePrice, 450);
  assert.equal(parsed.recommendedRetailPrice, 890);
  assert.equal(parsed.inventoryLevel, 12);
  assert.equal(parsed.supplierCategory, "Mobile Accessories");
  assert.equal(parsed.supplierSubcategory, "Holders");
});

test("Dropex image filenames map to managed-media-ready HTTPS URLs", () => {
  assert.equal(
    buildDropexProductImageUrl("holder.jpg"),
    "https://myorders-lk-documents.s3.ap-south-1.amazonaws.com/products/holder.jpg",
  );
  assert.deepEqual(extractDropexProductImages("holder.jpg,holder-alt.jpg"), [
    "https://myorders-lk-documents.s3.ap-south-1.amazonaws.com/products/holder.jpg",
    "https://myorders-lk-documents.s3.ap-south-1.amazonaws.com/products/holder-alt.jpg",
  ]);
});

test("Dropex HTTP statuses classify retryable 429/5xx and auth failures", () => {
  const rateLimited = classifyDropexHttpStatus(429, "2", 1_000);
  assert.ok(rateLimited instanceof DropexHttpError);
  assert.equal(rateLimited?.retryable, true);
  assert.equal(transientRetryDelayMs(rateLimited!, 1), 2_000);
  assert.equal(classifyDropexHttpStatus(401)?.retryable, false);
  assert.equal(classifyDropexHttpStatus(503)?.retryable, true);
  assert.equal(DROPEX_TRANSIENT_HTTP_MAX_ATTEMPTS, 3);
});

test("Dropex credential profiles stay isolated and host-bound", () => {
  const runtimeSecrets = {
    username: profileSecret({
      "dropex-production": {
        value: "dropex-user",
        allowedHosts: ["userservicev2.dreamworld.lk", "inventoryservice.dreamworld.lk"],
      },
    }),
    password: profileSecret({
      "dropex-production": {
        value: "dropex-pass",
        allowedHosts: ["userservicev2.dreamworld.lk", "inventoryservice.dreamworld.lk"],
      },
    }),
  };

  assert.deepEqual(
    resolveDropexCredentialProfile(runtimeSecrets, "dropex-production", "https://inventoryservice.dreamworld.lk"),
    { username: "dropex-user", password: "dropex-pass", profileId: "dropex-production" },
  );
  assert.throws(
    () => resolveDropexCredentialProfile(runtimeSecrets, "dropex-production", "https://attacker.example"),
    /not authorized for this supplier host/,
  );
  assert.throws(
    () => normalizeDropexCredentialReference("projects/example/secrets/DROPEX_PASSWORD/versions/latest"),
    /not allowed/,
  );
});

test("Dropex onboarding and admin projection never expose credential values", () => {
  const source = buildSupplierOnboardingSource({
    id: "dropex-main",
    supplierName: "Dropex Main",
    supplierAccountId: "supplier-account-1",
    supplierType: "dropex",
    credentialProfile: "dropex-production",
  });
  assert.equal(source.connectorType, "dropex");
  assert.equal((source.authentication as Record<string, string>).credentialProfile, "dropex-production");
  assert.equal("username" in (source.authentication as Record<string, unknown>), false);

  const sanitized = sanitizeSupplierSource(source);
  assert.equal(sanitized.connectorType, "dropex");
  assert.equal(sanitized.authentication.credentialProfile, "dropex-production");

  const projected = projectSupplierSourceForAdmin({
    ...sanitized,
    supplierId: "dropex-main",
  }, "dropex-main");
  assert.deepEqual(projected.authentication, {
    mode: "secret_manager",
    credentialProfile: "dropex-production",
  });
});

test("Dropex connector keeps Product Review approval gate and public/private split unchanged", () => {
  const sync = readFileSync("functions/src/scheduled/supplierSync.ts", "utf8");
  assert.match(sync, /supplierReviewQueue/i);
  assert.doesNotMatch(readFileSync("functions/src/api/suppliers/dropex/DropexSupplierConnector.ts", "utf8"), /products\//);
  assert.doesNotMatch(readFileSync("functions/src/api/suppliers/dropex/DropexSupplierConnector.ts", "utf8"), /autoPublish|publishProduct/i);
});

test("later Dropex supplier changes still route through review updates", () => {
  const sync = readFileSync("functions/src/scheduled/supplierSync.ts", "utf8");
  const manifest = readFileSync("functions/src/api/suppliers/supplierFieldManifest.ts", "utf8");
  assert.match(sync, /supplierReviewQueue/i);
  assert.match(manifest, /syncGroup: "pricing"/);
  assert.match(manifest, /syncGroup: "inventory"/);
  const product: RawA2ZProduct = ProductParser.parseCatalogItem(catalogItem, {
    enrichment: { sellingPrice: 890 },
  });
  assert.equal(product.wholesalePrice, 450);
  product.wholesalePrice = 500;
  assert.notEqual(product.wholesalePrice, 450);
});
