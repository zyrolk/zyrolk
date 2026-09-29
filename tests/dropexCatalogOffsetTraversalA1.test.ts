import assert from "node:assert/strict";
import test from "node:test";
import { DropexConnectorService } from "../functions/src/api/suppliers/dropex/DropexConnectorService";
import { DropexSupplierConnector } from "../functions/src/api/suppliers/dropex/DropexSupplierConnector";
import { SERVER_FILTERED_FULL_CATALOG_CAPABILITIES } from "../functions/src/api/suppliers/supplierSyncCapabilities";
import { validateDropexManualSupplierSyncLimit } from "../functions/src/api/suppliers/supplierSyncRequest";
import {
  createSupplierCatalogTraversalCheckpoint,
  runSupplierCatalogTraversal,
  SupplierCatalogTraversalCheckpoint,
} from "../functions/src/scheduled/supplierCatalogTraversal";
import type {
  SupplierCatalogFilterRequest,
  SupplierCatalogPageRequest,
  SupplierCatalogPageResult,
} from "../functions/src/api/suppliers/types";
import type { SupplierOutboundPolicy, SupplierOutboundResponse } from "../functions/src/api/security/supplierOutboundRequest";

const outboundPolicy = {} as SupplierOutboundPolicy;
const credentials = { username: "dropex-user", password: "dropex-pass" };

const response = (status: number, body: string): SupplierOutboundResponse => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers(),
  text: async () => body,
  json: async <T = unknown>() => JSON.parse(body) as T,
});

const loginToken = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, account: { id: 42 } })).toString("base64url"),
  "signature",
].join(".");

const rowSku = (offset: number): string => `DPX-${String(offset).padStart(4, "0")}`;
const skuRange = (from: number, toExclusive: number): string[] => (
  Array.from({ length: toExclusive - from }, (_, index) => rowSku(from + index))
);

function catalogRow(offset: number, invalidOffsets: ReadonlySet<number>) {
  if (invalidOffsets.has(offset)) return { productDetail: { id: 50_000 + offset } };
  return {
    price: 450,
    productDetail: {
      id: 10_000 + offset,
      name: `Product ${offset}`,
      sku: rowSku(offset),
      description: "Supplier description",
      image: `row-${offset}.jpg`,
      sellingPrice: 890,
      onHandInventory: 12,
      productCategoryId: 7,
    },
  };
}

/**
 * Models the production Dropex reseller catalogue contract exactly:
 * `page=N&size=S` returns supplier rows [N*S, N*S+S). It never accepts an item offset.
 */
function dropexCatalogApi(total: number, options: { invalidOffsets?: readonly number[] } = {}) {
  const invalidOffsets = new Set(options.invalidOffsets || []);
  const requests: Array<{ page: number; size: number }> = [];
  const service = new DropexConnectorService({
    supplierId: "dropex",
    sourceId: "dropex",
    credentialReference: "dropex-production",
  }, {
    fetchOutbound: async (url) => {
      if (url.endsWith("/auth/login")) return response(200, JSON.stringify({ access_token: loginToken }));
      if (url.endsWith("/api/v1/product-categories")) {
        return response(200, JSON.stringify([{ id: 7, name: "Mobile Accessories", subCategories: [] }]));
      }
      if (url.includes("/api/v1/re-seller-products/get")) {
        const parsed = new URL(url);
        const page = Number(parsed.searchParams.get("page"));
        const size = Number(parsed.searchParams.get("size"));
        requests.push({ page, size });
        const start = page * size;
        const content = Array.from(
          { length: Math.max(0, Math.min(size, total - start)) },
          (_, index) => catalogRow(start + index, invalidOffsets),
        );
        return response(200, JSON.stringify({
          content,
          totalElements: total,
          number: page,
          size,
          last: start + size >= total,
        }));
      }
      if (url.includes("/api/v1/products/") && url.endsWith("/dto")) {
        return response(200, JSON.stringify({ sellingPrice: 890 }));
      }
      throw new Error(`Unexpected Dropex request: ${url}`);
    },
  });
  const connector = {
    syncCapabilities: new DropexSupplierConnector("https://dropex.example", { outboundPolicy, credentialReference: "dropex-production" }).syncCapabilities,
    fetchProductPage: (request: SupplierCatalogPageRequest): Promise<SupplierCatalogPageResult> => (
      service.fetchCatalogPage(credentials, outboundPolicy, request)
    ),
  };
  return { service, connector, requests };
}

interface RunOptions {
  pageSize: number;
  continuationContract?: "manual" | "automatic";
  totalProductLimit?: number | null;
  syncJobId?: string;
  catalogContinuation?: "continue" | "restart";
  initial?: Partial<SupplierCatalogTraversalCheckpoint>;
  filters?: SupplierCatalogFilterRequest;
  pauseAfterPages?: number;
  keepProduct?: (sku: string) => boolean;
}

async function runDropexTraversal(api: ReturnType<typeof dropexCatalogApi>, options: RunOptions) {
  const consumed: string[] = [];
  const kept: string[] = [];
  const persisted: SupplierCatalogTraversalCheckpoint[] = [];
  let pagesThisRun = 0;
  let reconciled = false;
  const result = await runSupplierCatalogTraversal({
    connector: api.connector,
    pageSize: options.pageSize,
    totalProductLimit: options.totalProductLimit ?? null,
    deletionReconciliationEligible: false,
    filters: options.filters,
    requestFingerprint: "dropex-manual-request",
    continuationFingerprint: "dropex-catalogue-scope",
    continuationContract: options.continuationContract ?? "manual",
    syncJobId: options.syncJobId || "job-1",
    catalogContinuation: options.catalogContinuation,
    initial: options.initial,
    shouldPause: options.pauseAfterPages === undefined ? undefined : () => pagesThisRun >= options.pauseAfterPages!,
    processPage: async (page) => {
      pagesThisRun += 1;
      const skus = page.products.map((product) => product.sku);
      consumed.push(...skus);
      const survivors = skus.filter((sku) => options.keepProduct?.(sku) ?? true);
      kept.push(...survivors);
      return { productsScanned: survivors.length, productsImported: survivors.length, invalidProducts: page.invalidProducts };
    },
    persistCheckpoint: async (checkpoint) => { persisted.push(structuredClone(checkpoint)); },
    reconcileDeletedProducts: async () => { reconciled = true; },
  });
  return { ...result, consumed, kept, persisted, reconciled };
}

const assertNoDuplicates = (values: readonly string[]) => {
  assert.equal(new Set(values).size, values.length, `duplicate supplier rows consumed: ${values.join(",")}`);
};

test("A1-01 page size 5 with limit 12 consumes raw rows 0..11 exactly once", async () => {
  const api = dropexCatalogApi(40);
  const run = await runDropexTraversal(api, { pageSize: 5, totalProductLimit: 12 });

  assert.deepEqual(run.consumed, skuRange(0, 12));
  assertNoDuplicates(run.consumed);
  assert.equal(run.limited, true);
  assert.equal(run.checkpoint.productsObserved, 12);
  assert.equal(api.requests.every((request) => request.size === 5), true, "supplier page size must stay stable");
});

test("A1-02 continuation after the 12-row run starts at raw offset 12", async () => {
  const api = dropexCatalogApi(40);
  const first = await runDropexTraversal(api, { pageSize: 5, totalProductLimit: 12 });
  assert.equal(first.checkpoint.cursor, "offset:12");

  const second = await runDropexTraversal(api, {
    pageSize: 5,
    totalProductLimit: 5,
    syncJobId: "job-2",
    catalogContinuation: "continue",
    initial: first.checkpoint,
  });
  assert.equal(second.consumed[0], rowSku(12));
});

test("A1-03 continuation reaches the unconsumed suffix of the previously fetched supplier page", async () => {
  const api = dropexCatalogApi(40);
  const first = await runDropexTraversal(api, { pageSize: 5, totalProductLimit: 12 });
  const second = await runDropexTraversal(api, {
    pageSize: 5,
    totalProductLimit: 10,
    syncJobId: "job-2",
    catalogContinuation: "continue",
    initial: first.checkpoint,
  });

  assert.deepEqual(second.consumed, skuRange(12, 22));
  assertNoDuplicates([...first.consumed, ...second.consumed]);
  assert.equal(second.checkpoint.cursor, "offset:22");
});

test("A1-04 changing the effective page size between continuation jobs keeps the absolute next row", async () => {
  const api = dropexCatalogApi(40);
  const first = await runDropexTraversal(api, { pageSize: 5, totalProductLimit: 12 });
  const second = await runDropexTraversal(api, {
    pageSize: 10,
    totalProductLimit: 5,
    syncJobId: "job-2",
    catalogContinuation: "continue",
    initial: first.checkpoint,
  });

  assert.deepEqual(second.consumed, skuRange(12, 17));
  assert.equal(second.checkpoint.cursor, "offset:17");

  const third = await runDropexTraversal(api, {
    pageSize: 3,
    totalProductLimit: 4,
    syncJobId: "job-3",
    catalogContinuation: "continue",
    initial: second.checkpoint,
  });
  assert.deepEqual(third.consumed, skuRange(17, 21));
});

test("A1-05 a limit smaller than the page size consumes only the first rows without shrinking the supplier page", async () => {
  const api = dropexCatalogApi(120);
  const run = await runDropexTraversal(api, { pageSize: 50, totalProductLimit: 5 });

  assert.deepEqual(run.consumed, skuRange(0, 5));
  assert.equal(run.checkpoint.cursor, "offset:5");
  assert.deepEqual(api.requests, [{ page: 0, size: 50 }]);
});

test("A1-06 a limit on an exact page boundary stops at that boundary", async () => {
  const api = dropexCatalogApi(40);
  const run = await runDropexTraversal(api, { pageSize: 5, totalProductLimit: 10 });

  assert.deepEqual(run.consumed, skuRange(0, 10));
  assert.equal(run.checkpoint.cursor, "offset:10");
  assert.deepEqual(api.requests, [{ page: 0, size: 5 }, { page: 1, size: 5 }]);
});

test("A1-07 a limit crossing several pages consumes a contiguous prefix", async () => {
  const api = dropexCatalogApi(40);
  const run = await runDropexTraversal(api, { pageSize: 5, totalProductLimit: 23 });

  assert.deepEqual(run.consumed, skuRange(0, 23));
  assert.equal(run.checkpoint.cursor, "offset:23");
  assert.equal(api.requests.every((request) => request.size === 5), true);
});

test("A1-08 intake filters do not change raw cursor advancement", async () => {
  const unfilteredApi = dropexCatalogApi(40);
  const unfiltered = await runDropexTraversal(unfilteredApi, { pageSize: 5, totalProductLimit: 12 });
  const filteredApi = dropexCatalogApi(40);
  const filtered = await runDropexTraversal(filteredApi, {
    pageSize: 5,
    totalProductLimit: 12,
    filters: { search: "even" },
    keepProduct: (sku) => Number(sku.slice(4)) % 2 === 0,
  });

  assert.equal(filtered.checkpoint.cursor, unfiltered.checkpoint.cursor);
  assert.equal(filtered.checkpoint.productsObserved, 12);
  assert.equal(filtered.checkpoint.productsScanned, 6);
  assert.deepEqual(filtered.consumed, skuRange(0, 12));
  assert.equal(filtered.checkpoint.deletionReconciliationEligible, false);
  assert.equal(filtered.reconciled, false);
});

test("A1-09 filtered-out and invalid rows count as consumed and are not seen again on continuation", async () => {
  const api = dropexCatalogApi(40, { invalidOffsets: [3, 11] });
  const first = await runDropexTraversal(api, {
    pageSize: 5,
    totalProductLimit: 12,
    filters: { search: "even" },
    keepProduct: (sku) => Number(sku.slice(4)) % 2 === 0,
  });
  assert.equal(first.checkpoint.productsObserved, 12);
  assert.equal(first.checkpoint.invalidProducts, 2);
  assert.deepEqual(first.consumed, skuRange(0, 12).filter((sku) => !["DPX-0003", "DPX-0011"].includes(sku)));

  const second = await runDropexTraversal(api, {
    pageSize: 5,
    totalProductLimit: 6,
    syncJobId: "job-2",
    catalogContinuation: "continue",
    filters: { search: "even" },
    keepProduct: (sku) => Number(sku.slice(4)) % 2 === 0,
    initial: first.checkpoint,
  });
  assert.deepEqual(second.consumed, skuRange(12, 18));
  assert.equal(second.consumed.some((sku) => first.consumed.includes(sku)), false);
  assert.equal(second.reconciled, false);
});

const limitedCheckpointAtOffset12 = async () => {
  const api = dropexCatalogApi(40);
  return (await runDropexTraversal(api, { pageSize: 5, totalProductLimit: 12, syncJobId: "job-old" })).checkpoint;
};

test("A1-10 a new restart job begins at catalogue offset zero", async () => {
  const api = dropexCatalogApi(40);
  const run = await runDropexTraversal(api, {
    pageSize: 5,
    totalProductLimit: 7,
    syncJobId: "job-restart",
    catalogContinuation: "restart",
    initial: await limitedCheckpointAtOffset12(),
  });

  assert.deepEqual(run.consumed, skuRange(0, 7));
  assert.equal(run.checkpoint.productsObserved, 7);
  assert.equal(run.checkpoint.syncJobId, "job-restart");
});

test("A1-11 the same restart job resumes its own saved progress after a pause", async () => {
  const api = dropexCatalogApi(40);
  const firstAttempt = await runDropexTraversal(api, {
    pageSize: 5,
    totalProductLimit: 17,
    syncJobId: "job-restart",
    catalogContinuation: "restart",
    initial: await limitedCheckpointAtOffset12(),
    pauseAfterPages: 1,
  });
  assert.equal(firstAttempt.paused, true);
  assert.deepEqual(firstAttempt.consumed, skuRange(0, 5));
  assert.equal(firstAttempt.checkpoint.cursor, "offset:5");

  const resumed = await runDropexTraversal(api, {
    pageSize: 5,
    totalProductLimit: 17,
    syncJobId: "job-restart",
    catalogContinuation: "restart",
    initial: firstAttempt.checkpoint,
  });
  assert.deepEqual(resumed.consumed, skuRange(5, 17));
  assert.equal(resumed.checkpoint.productsObserved, 17);
  assert.equal(resumed.checkpoint.traversalId, firstAttempt.checkpoint.traversalId);
  assert.equal(resumed.checkpoint.resumeCount, 1);
  assertNoDuplicates([...firstAttempt.consumed, ...resumed.consumed]);
});

test("A1-12 a later new restart job starts from zero again", async () => {
  const api = dropexCatalogApi(40);
  const earlier = await runDropexTraversal(api, {
    pageSize: 5,
    totalProductLimit: 9,
    syncJobId: "job-restart-1",
    catalogContinuation: "restart",
  });
  assert.equal(earlier.checkpoint.cursor, "offset:9");

  const later = await runDropexTraversal(api, {
    pageSize: 5,
    totalProductLimit: 4,
    syncJobId: "job-restart-2",
    catalogContinuation: "restart",
    initial: earlier.checkpoint,
  });
  assert.deepEqual(later.consumed, skuRange(0, 4));
  assert.notEqual(later.checkpoint.traversalId, earlier.checkpoint.traversalId);
});

test("A1-13 lease recovery of an in-progress checkpoint preserves progress for continue and restart jobs", async () => {
  for (const catalogContinuation of ["continue", "restart"] as const) {
    const api = dropexCatalogApi(40);
    const partial = await runDropexTraversal(api, {
      pageSize: 5,
      totalProductLimit: 15,
      syncJobId: `job-${catalogContinuation}`,
      catalogContinuation,
      pauseAfterPages: 2,
    });
    const crashedCheckpoint = { ...partial.checkpoint, status: "in_progress" as const, terminationReason: null };

    const recovered = await runDropexTraversal(api, {
      pageSize: 5,
      totalProductLimit: 15,
      syncJobId: `job-${catalogContinuation}`,
      catalogContinuation,
      initial: crashedCheckpoint,
    });
    assert.deepEqual(recovered.consumed, skuRange(10, 15), catalogContinuation);
    assert.equal(recovered.checkpoint.productsObserved, 15, catalogContinuation);
  }
});

test("A1-14 Dropex manual requests still require an explicit total product limit", () => {
  assert.throws(
    () => validateDropexManualSupplierSyncLimit(["dropex"], { mode: "full", catalogContinuation: "continue" }),
    /Product count limit is required for Dropex manual synchronization/,
  );
  assert.throws(
    () => validateDropexManualSupplierSyncLimit(["custom-source"], { mode: "full" }, ["dropex"]),
    /Product count limit is required/,
  );
  assert.doesNotThrow(() => validateDropexManualSupplierSyncLimit(["dropex"], { mode: "full", totalProductLimit: 12 }));
});

test("A1-15 continue without a new limit does not inherit the previous batch cap where the limit is optional", () => {
  const limitedCheckpoint = createSupplierCatalogTraversalCheckpoint({
    traversalId: "traversal-limited",
    cursor: "25",
    productsObserved: 25,
    productsObservedAtBatchStart: 20,
    syncMode: "full",
    continuationFingerprint: "a2z-catalogue-scope",
    syncJobId: "job-old",
    totalProductLimit: 5,
    terminationReason: "limit_reached",
    status: "limited",
  }, {
    continuationFingerprint: "a2z-catalogue-scope",
    continuationContract: "manual",
    syncJobId: "job-new",
    catalogContinuation: "continue",
  });
  assert.equal(limitedCheckpoint.cursor, "25");
  assert.equal(limitedCheckpoint.productsObservedAtBatchStart, 25);
  assert.equal(limitedCheckpoint.totalProductLimit, null);

  const explicitCap = createSupplierCatalogTraversalCheckpoint({
    cursor: "25",
    productsObserved: 25,
    syncMode: "full",
    continuationFingerprint: "a2z-catalogue-scope",
    syncJobId: "job-old",
    totalProductLimit: 5,
    terminationReason: "limit_reached",
    status: "limited",
  }, {
    continuationFingerprint: "a2z-catalogue-scope",
    continuationContract: "manual",
    syncJobId: "job-new",
    catalogContinuation: "continue",
    totalProductLimit: 8,
  });
  assert.equal(explicitCap.totalProductLimit, 8);

  const sameJobResume = createSupplierCatalogTraversalCheckpoint({
    cursor: "10",
    productsObserved: 10,
    syncMode: "full",
    continuationFingerprint: "a2z-catalogue-scope",
    syncJobId: "job-running",
    totalProductLimit: 30,
    status: "paused",
  }, {
    continuationFingerprint: "a2z-catalogue-scope",
    syncJobId: "job-running",
    catalogContinuation: "continue",
    totalProductLimit: 30,
  });
  assert.equal(sameJobResume.totalProductLimit, 30);
  assert.equal(sameJobResume.cursor, "10");
});

test("A1-16 a legacy Dropex page-number checkpoint fails closed and a restart writes the canonical offset cursor", async () => {
  const legacyCheckpoint: Partial<SupplierCatalogTraversalCheckpoint> = {
    traversalId: "legacy-traversal",
    cursor: "3",
    pagesProcessed: 3,
    productsObserved: 12,
    productsObservedAtBatchStart: 0,
    syncMode: "full",
    requestFingerprint: "dropex-manual-request",
    continuationFingerprint: "dropex-catalogue-scope",
    syncJobId: "job-legacy",
    totalProductLimit: 12,
    terminationReason: "limit_reached",
    status: "limited",
  };
  const snapshot = structuredClone(legacyCheckpoint);
  const api = dropexCatalogApi(40);

  await assert.rejects(
    runDropexTraversal(api, {
      pageSize: 5,
      totalProductLimit: 5,
      syncJobId: "job-next",
      catalogContinuation: "continue",
      initial: legacyCheckpoint,
    }),
    /page-number cursor.*Start from beginning/i,
  );
  assert.equal(api.requests.length, 0);
  assert.deepEqual(legacyCheckpoint, snapshot);

  const restarted = await runDropexTraversal(api, {
    pageSize: 5,
    totalProductLimit: 5,
    syncJobId: "job-restart",
    catalogContinuation: "restart",
    initial: legacyCheckpoint,
  });
  assert.deepEqual(restarted.consumed, skuRange(0, 5));
  assert.equal(restarted.persisted.at(-1)?.cursor, "offset:5");
});

test("A1-17 Dropex connector maps absolute offsets onto page x size and slices within the fetched page", async () => {
  const api = dropexCatalogApi(40);
  const fromStart = await api.service.fetchCatalogPage(credentials, outboundPolicy, { cursor: null, pageSize: 5 });
  assert.deepEqual(fromStart.products.map((product) => product.sku), skuRange(0, 5));
  assert.equal(fromStart.nextCursor, "offset:5");

  const connectionProbe = await api.service.fetchCatalogPage(credentials, outboundPolicy, { cursor: "0", pageSize: 1 });
  assert.deepEqual(connectionProbe.products.map((product) => product.sku), [rowSku(0)]);

  const midPage = await api.service.fetchCatalogPage(credentials, outboundPolicy, { cursor: "offset:12", pageSize: 5 });
  assert.deepEqual(api.requests.at(-1), { page: 2, size: 5 });
  assert.deepEqual(midPage.products.map((product) => product.sku), skuRange(12, 15));
  assert.equal(midPage.nextCursor, "offset:15");
  assert.equal(midPage.complete, false);

  const budgeted = await api.service.fetchCatalogPage(credentials, outboundPolicy, { cursor: "offset:12", pageSize: 5, maxRows: 2 });
  assert.deepEqual(api.requests.at(-1), { page: 2, size: 5 });
  assert.deepEqual(budgeted.products.map((product) => product.sku), skuRange(12, 14));
  assert.equal(budgeted.nextCursor, "offset:14");

  const lastRows = await api.service.fetchCatalogPage(credentials, outboundPolicy, { cursor: "offset:37", pageSize: 5 });
  assert.deepEqual(lastRows.products.map((product) => product.sku), skuRange(37, 40));
  assert.equal(lastRows.complete, true);
  assert.equal(lastRows.nextCursor, null);

  const budgetBeforeEnd = await api.service.fetchCatalogPage(credentials, outboundPolicy, { cursor: "offset:35", pageSize: 5, maxRows: 2 });
  assert.equal(budgetBeforeEnd.complete, false, "rows left on the final supplier page must stay reachable");
  assert.equal(budgetBeforeEnd.nextCursor, "offset:37");

  await assert.rejects(
    api.service.fetchCatalogPage(credentials, outboundPolicy, { cursor: "3", pageSize: 5 }),
    /page-number cursor/i,
  );
});

test("A1-19 automatic inferred Dropex continuation retains the saved limit", async () => {
  const api = dropexCatalogApi(40);
  const manual = await runDropexTraversal(api, { pageSize: 5, totalProductLimit: 5, syncJobId: "job-manual" });
  assert.equal(manual.checkpoint.status, "limited");
  assert.equal(manual.checkpoint.totalProductLimit, 5);
  assert.equal(manual.checkpoint.cursor, "offset:5");

  const automatic = await runDropexTraversal(api, {
    pageSize: 5,
    totalProductLimit: null,
    syncJobId: "job-scheduled",
    catalogContinuation: "continue",
    continuationContract: "automatic",
    initial: manual.checkpoint,
  });
  assert.equal(automatic.limited, true);
  assert.equal(automatic.checkpoint.totalProductLimit, 5);
  assert.deepEqual(automatic.consumed, skuRange(5, 10));
  assert.equal(automatic.checkpoint.cursor, "offset:10");
  assert.equal(automatic.checkpoint.productsObserved, 10);
  assert.equal(automatic.reconciled, false);

  assert.throws(
    () => validateDropexManualSupplierSyncLimit(["dropex"], { mode: "full", catalogContinuation: "continue" }),
    /Product count limit is required for Dropex manual synchronization/,
  );

  const manualNonDropex = createSupplierCatalogTraversalCheckpoint({
    cursor: "25",
    productsObserved: 25,
    syncMode: "full",
    continuationFingerprint: "a2z-catalogue-scope",
    syncJobId: "job-old",
    totalProductLimit: 5,
    terminationReason: "limit_reached",
    status: "limited",
  }, {
    continuationFingerprint: "a2z-catalogue-scope",
    continuationContract: "manual",
    syncJobId: "job-new",
    catalogContinuation: "continue",
  });
  assert.equal(manualNonDropex.totalProductLimit, null);
});

test("A1-18 only the Dropex connector declares absolute raw-offset positioning", () => {
  const dropex = new DropexSupplierConnector("https://dropex.example", { outboundPolicy, credentialReference: "dropex-production" });
  assert.equal(dropex.syncCapabilities.catalogPosition, "absolute_raw_offset");
  assert.equal(dropex.syncCapabilities.categoryFilter, "server_side");
  assert.equal(dropex.syncCapabilities.incremental.supported, false);
  assert.equal(SERVER_FILTERED_FULL_CATALOG_CAPABILITIES.catalogPosition, undefined);
});
