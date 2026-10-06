import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { assertNewSupplierPublicationStock } from "../functions/src/api/suppliers/supplierApproval";
import { SupplierReviewQuickCard, SupplierReviewQuickCardProps } from "../src/components/SupplierReviewQuickCard";
import {
  classifySupplierReviewRecordForCounts,
  listSupplierQueuePage,
  projectSupplierReviewLowStockHold,
  reviewRecordMatchesBusinessFilter,
  SUPPLIER_REVIEW_CLASSIFICATION_FIELDS,
  SupplierReviewBusinessFilter,
} from "../functions/src/scheduled/supplierReviewQueue";
import {
  matchesProductReviewFilter,
  PRODUCT_REVIEW_FILTERS,
  ProductReviewFilter,
  supplierReviewApiState,
  supplierReviewCanQuickApprove,
  supplierReviewLowStockHoldQueueCount,
  supplierReviewStatusLabel,
} from "../src/services/supplierHubPresentation";

const REVISION_A = "a".repeat(64);
const REVISION_B = "b".repeat(64);
const ACTIVE_FILTERS: SupplierReviewBusinessFilter[] = [
  "new_products",
  "product_updates",
  "removed_products",
  "conflicts",
  "needs_attention",
  "low_stock_hold",
];
const ALL_FILTERS: SupplierReviewBusinessFilter[] = [...ACTIVE_FILTERS, "approved_history"];

type Overrides = {
  comparisonStatus?: string;
  stock?: unknown;
  stockKnown?: boolean;
  sourceId?: string;
  live?: boolean;
  extra?: Record<string, unknown>;
};

const reviewRecord = (overrides: Overrides = {}): Record<string, any> => {
  const comparisonStatus = overrides.comparisonStatus ?? "NEW_PRODUCT";
  const stock = overrides.stock ?? 0;
  const stockKnown = overrides.stockKnown ?? true;
  const live = overrides.live ?? false;
  return {
    id: "dropex-b2",
    sourceId: overrides.sourceId ?? "dropex",
    status: "Pending",
    queueState: "review_pending",
    supplierOfferPendingRevision: REVISION_A,
    comparisonStatus,
    comparison: {
      comparisonStatus,
      matchFound: live,
      matchedProductLive: live,
      fieldChanges: comparisonStatus === "NEW_PRODUCT" ? [] : [{ field: "price", label: "Price" }],
    },
    approvalBaseline: { exists: live },
    stock,
    productPayload: { stock, supplierMetadata: { supplierStockAvailable: stockKnown } },
    supplierSnapshot: { providedFields: stockKnown ? ["stock"] : [], inventoryLevel: stock },
    productValidation: { readyToPublish: true, missingFields: [], errors: [] },
    ...overrides.extra,
  };
};

/** The server list returns projected records; the client filters that projection. */
const serverMatches = (record: Record<string, any>, filter: SupplierReviewBusinessFilter) => (
  reviewRecordMatchesBusinessFilter(record, filter)
);
const clientMatches = (record: Record<string, any>, filter: SupplierReviewBusinessFilter) => (
  matchesProductReviewFilter(projectSupplierReviewLowStockHold(record), filter as ProductReviewFilter)
);
const activeViews = (record: Record<string, any>) => ACTIVE_FILTERS.filter((filter) => serverMatches(record, filter));

const assertOnlyLowStockHold = (record: Record<string, any>, label: string) => {
  assert.deepEqual(activeViews(record), ["low_stock_hold"], label);
  for (const filter of ACTIVE_FILTERS) {
    assert.equal(clientMatches(record, filter), filter === "low_stock_hold", `${label} client ${filter}`);
  }
  assert.equal(classifySupplierReviewRecordForCounts(record as never), "low_stock_hold", label);
};

test("B2-1..3 NEW_PRODUCT: stock 0 and 3 are held outside New Products and Needs Attention; stock 4 is a new product", () => {
  assertOnlyLowStockHold(reviewRecord({ stock: 0 }), "new stock 0");
  const three = reviewRecord({ stock: 3 });
  assertOnlyLowStockHold(three, "new stock 3");
  assert.equal(serverMatches(three, "needs_attention"), false);
  assert.equal(clientMatches(three, "needs_attention"), false);

  const four = reviewRecord({ stock: 4 });
  assert.deepEqual(activeViews(four), ["new_products"]);
  assert.equal(clientMatches(four, "new_products"), true);
  assert.equal(clientMatches(four, "low_stock_hold"), false);
  assert.equal(classifySupplierReviewRecordForCounts(four as never), "actionable");
});

test("B2-4..7 unpublished updates are held regardless of comparison status and return at stock 4", () => {
  assertOnlyLowStockHold(reviewRecord({ comparisonStatus: "PRICE_CHANGED", stock: 0 }), "price stock 0");
  const priceTwo = reviewRecord({ comparisonStatus: "PRICE_CHANGED", stock: 2 });
  assertOnlyLowStockHold(priceTwo, "price stock 2");
  assert.equal(serverMatches(priceTwo, "product_updates"), false);
  assert.equal(serverMatches(priceTwo, "needs_attention"), false);

  const priceFour = reviewRecord({ comparisonStatus: "PRICE_CHANGED", stock: 4 });
  assert.deepEqual(activeViews(priceFour), ["product_updates"]);
  assert.equal(clientMatches(priceFour, "product_updates"), true);

  assertOnlyLowStockHold(reviewRecord({ comparisonStatus: "DESCRIPTION_CHANGED", stock: 0 }), "description stock 0");
});

test("B2-8..11 low_stock_hold contains held records only and each held record is counted once", () => {
  const held = reviewRecord({ stock: 1 });
  const ready = reviewRecord({ stock: 9 });
  assert.equal(serverMatches(held, "low_stock_hold"), true);
  assert.equal(serverMatches(ready, "low_stock_hold"), false);
  assert.equal(clientMatches(ready, "low_stock_hold"), false);

  const records = [held, ready, reviewRecord({ comparisonStatus: "PRICE_CHANGED", stock: 0 }), reviewRecord({ comparisonStatus: "PRICE_CHANGED", stock: 6 })];
  const classes = records.map((record) => classifySupplierReviewRecordForCounts(record as never));
  assert.deepEqual(classes, ["low_stock_hold", "actionable", "low_stock_hold", "actionable"]);
  for (const record of records) {
    const views = activeViews(record);
    assert.equal(views.length, 1, "every active record belongs to exactly one active business view");
  }
});

test("B2-12..13 stock recovery 0 -> 5 moves the same record from Low Stock Hold back to Product Updates and actionable", () => {
  const held = reviewRecord({ comparisonStatus: "PRICE_CHANGED", stock: 0 });
  const heldProjection = projectSupplierReviewLowStockHold(held);
  const recovered: Record<string, any> = {
    ...heldProjection,
    stock: 5,
    productPayload: { ...heldProjection.productPayload, stock: 5 },
    supplierSnapshot: { ...heldProjection.supplierSnapshot, inventoryLevel: 5 },
  };
  assert.equal(classifySupplierReviewRecordForCounts(held as never), "low_stock_hold");
  assert.equal(classifySupplierReviewRecordForCounts(recovered as never), "actionable");
  assert.equal(recovered.id, held.id);
  assert.deepEqual(activeViews(recovered), ["product_updates"], "stale stored hold validation does not keep it in Needs Attention");
  assert.equal(clientMatches(recovered, "product_updates"), true);
  assert.equal(clientMatches(recovered, "low_stock_hold"), false);
  assert.equal(clientMatches(recovered, "needs_attention"), false);
});

test("B2-14 live Dropex products at stock 0-3 are never on Low Stock Hold", () => {
  for (const stock of [0, 1, 2, 3]) {
    const live = reviewRecord({ comparisonStatus: "PRICE_CHANGED", stock, live: true });
    assert.deepEqual(activeViews(live), ["product_updates"], `live stock ${stock}`);
    assert.equal(clientMatches(live, "low_stock_hold"), false);
    assert.equal(classifySupplierReviewRecordForCounts(live as never), "actionable");
  }
  const nonDropex = reviewRecord({ sourceId: "a2z-dropshipping", stock: 1 });
  assert.deepEqual(activeViews(nonDropex), ["new_products"]);
});

test("B2-15..16 revision-scoped decisions: stale decisions do not hide a held revision, current decisions stay history", () => {
  const stale = reviewRecord({
    stock: 0,
    extra: { supplierOfferPendingRevision: REVISION_B, decisionAction: "rejected", decisionPendingRevision: REVISION_A },
  });
  assertOnlyLowStockHold(stale, "stale decision");
  assert.equal(serverMatches(stale, "approved_history"), false);

  const current = reviewRecord({
    stock: 0,
    extra: { status: "Rejected", queueState: "rejected", decisionAction: "rejected", decisionPendingRevision: REVISION_A },
  });
  assert.deepEqual(activeViews(current), []);
  assert.equal(serverMatches(current, "approved_history"), true);
  assert.equal(clientMatches(current, "approved_history"), true);
  assert.equal(clientMatches(current, "low_stock_hold"), false);
  assert.equal(classifySupplierReviewRecordForCounts(current as never), null);
});

test("B2-18 legacy records without matchedProductLive are classified by list-time recomputation", () => {
  const legacyUnmatched = reviewRecord({ stock: 2 });
  delete legacyUnmatched.comparison.matchedProductLive;
  legacyUnmatched.productValidation = { readyToPublish: true };
  assertOnlyLowStockHold(legacyUnmatched, "legacy unmatched");

  const legacyMatched = reviewRecord({ comparisonStatus: "PRICE_CHANGED", stock: 2 });
  delete legacyMatched.comparison.matchedProductLive;
  legacyMatched.comparison.matchFound = true;
  assert.deepEqual(activeViews(legacyMatched), ["product_updates"]);

  const storedHoldButRecovered = reviewRecord({
    stock: 7,
    extra: {
      productValidation: {
        lowStockHold: true,
        readyToPublish: false,
        missingFields: ["stock"],
        errors: [{ field: "stock", code: "LOW_SUPPLIER_STOCK_FOR_PUBLICATION", message: "Supplier stock must be at least 4 units before publication." }],
      },
    },
  });
  assert.deepEqual(activeViews(storedHoldButRecovered), ["new_products"], "a stale stored hold is not trusted");
});

test("B2-19 conflicts, removals and history keep their existing precedence", () => {
  const heldConflict = reviewRecord({ stock: 0, extra: { status: "CONFLICT", queueState: "conflict" } });
  assert.deepEqual(activeViews(heldConflict), ["conflicts"]);
  assert.equal(clientMatches(heldConflict, "conflicts"), true);
  assert.equal(clientMatches(heldConflict, "low_stock_hold"), false);
  assert.equal(classifySupplierReviewRecordForCounts(heldConflict as never), "actionable");

  const removal = reviewRecord({ comparisonStatus: "SUPPLIER_OFFER_REMOVED", stock: 0 });
  assert.deepEqual(activeViews(removal), ["removed_products"]);
  assert.equal(clientMatches(removal, "removed_products"), true);

  const approved = reviewRecord({ stock: 0, extra: { status: "Approved", queueState: "approved" } });
  assert.deepEqual(activeViews(approved), []);
  assert.equal(serverMatches(approved, "approved_history"), true);

  const mediaFailure = reviewRecord({ stock: 8, extra: { mediaStatus: "failed" } });
  assert.deepEqual(activeViews(mediaFailure), ["new_products", "needs_attention"], "non-held Needs Attention is unchanged");
});

test("B2 count classification is identical on the summary's projected fields", () => {
  const pick = (record: Record<string, any>) => {
    const projected: Record<string, any> = {};
    for (const path of SUPPLIER_REVIEW_CLASSIFICATION_FIELDS) {
      const segments = path.split(".");
      let source: any = record;
      for (const segment of segments) source = source?.[segment];
      if (source === undefined) continue;
      let target = projected;
      segments.slice(0, -1).forEach((segment) => { target = target[segment] ??= {}; });
      target[segments.at(-1)!] = source;
    }
    return projected;
  };
  const records = [
    reviewRecord({ stock: 0 }),
    reviewRecord({ stock: 4 }),
    reviewRecord({ comparisonStatus: "PRICE_CHANGED", stock: 2, live: true }),
    reviewRecord({ stock: 0, stockKnown: false }),
    reviewRecord({ stock: 0, extra: { status: "CONFLICT", queueState: "conflict" } }),
    reviewRecord({ comparisonStatus: "SUPPLIER_OFFER_REMOVED", stock: 0 }),
    reviewRecord({ stock: 0, extra: { supplierOfferPendingRevision: REVISION_B, decisionAction: "approved", decisionPendingRevision: REVISION_A } }),
    reviewRecord({ stock: 0, extra: { status: "Rejected", queueState: "rejected", decisionAction: "rejected", decisionPendingRevision: REVISION_A } }),
    reviewRecord({ sourceId: "a2z-dropshipping", stock: 1 }),
  ];
  for (const record of records) {
    assert.equal(
      classifySupplierReviewRecordForCounts(pick(record) as never),
      classifySupplierReviewRecordForCounts(record as never),
      JSON.stringify(pick(record)),
    );
  }
  const operations = readFileSync("functions/src/api/suppliers/supplierOperations.ts", "utf8");
  assert.equal(operations.match(/\.select\(\.\.\.SUPPLIER_REVIEW_CLASSIFICATION_FIELDS\)/gu)?.length, 2);
  assert.match(operations, /lowStockHold: lowStockHoldReviewCount/u);
});

type StoredDocument = Record<string, unknown>;
const createReviewQueueFirestore = (records: Array<{ id: string; data: StoredDocument }>) => {
  const documentSnapshot = (id: string) => {
    const record = records.find((entry) => entry.id === id);
    return { exists: Boolean(record), id, data: () => record?.data };
  };
  const query = (statuses: string[] | null = null, cursorId: string | null = null, pageLimit: number | null = null): any => ({
    where: (_field: string, operator: string, value: unknown) => query(operator === "in" ? value as string[] : [String(value)], cursorId, pageLimit),
    orderBy: () => query(statuses, cursorId, pageLimit),
    startAfter: (cursor: { id: string }) => query(statuses, cursor.id, pageLimit),
    limit: (limit: number) => query(statuses, cursorId, limit),
    get: async () => {
      let selected = [...records]
        .filter((entry) => !statuses || statuses.includes(String(entry.data.status)))
        .sort((left, right) => String(right.data.createdAt).localeCompare(String(left.data.createdAt)) || right.id.localeCompare(left.id));
      if (cursorId) {
        const cursorIndex = selected.findIndex((entry) => entry.id === cursorId);
        selected = cursorIndex >= 0 ? selected.slice(cursorIndex + 1) : [];
      }
      if (pageLimit !== null) selected = selected.slice(0, pageLimit);
      const docs = selected.map((entry) => documentSnapshot(entry.id));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  });
  return {
    collection: () => ({
      doc: (id: string) => ({ get: async () => documentSnapshot(id) }),
      where: (field: string, operator: string, value: unknown) => query().where(field, operator, value),
      orderBy: () => query(),
    }),
  };
};

const collectAllPages = async (db: never, businessFilter: SupplierReviewBusinessFilter, limit: number) => {
  const pages: string[][] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await listSupplierQueuePage(db, { view: "review", state: "active", businessFilter, limit, ...(after ? { after } : {}) });
    pages.push(page.items.map((item) => item.id));
    if (!page.nextCursor) break;
    after = page.nextCursor;
  }
  return pages;
};

test("B2-17 held records are filtered on the server before paging: full pages, no duplicates, no skips", async () => {
  const records: Array<{ id: string; data: StoredDocument }> = [];
  for (let index = 0; index < 180; index += 1) {
    const held = index % 3 !== 0;
    const { id: _id, ...data } = reviewRecord({ stock: held ? index % 4 : 10 + index });
    records.push({
      id: `review-${String(index).padStart(3, "0")}`,
      data: { ...data, createdAt: String(10_000 - index).padStart(5, "0") },
    });
  }
  const db = createReviewQueueFirestore(records) as never;
  const expectedNew = records.filter((record) => !reviewRecordMatchesBusinessFilter(record.data, "low_stock_hold")).map((record) => record.id);
  const expectedHeld = records.filter((record) => reviewRecordMatchesBusinessFilter(record.data, "low_stock_hold")).map((record) => record.id);
  assert.equal(expectedNew.length, 60);
  assert.equal(expectedHeld.length, 120);

  const newPages = await collectAllPages(db, "new_products", 25);
  assert.deepEqual(newPages.map((page) => page.length), [25, 25, 10], "no sparse New Products pages");
  assert.deepEqual(newPages.flat(), expectedNew);

  const heldPages = await collectAllPages(db, "low_stock_hold", 50);
  assert.deepEqual(heldPages.map((page) => page.length), [50, 50, 20]);
  assert.deepEqual(heldPages.flat(), expectedHeld);
  assert.equal(new Set([...newPages.flat(), ...heldPages.flat()]).size, 180, "every record appears in exactly one of the two views");

  const firstHeldPage = await listSupplierQueuePage(db, { view: "review", state: "active", businessFilter: "low_stock_hold", limit: 5 });
  for (const item of firstHeldPage.items) {
    assert.equal((item.productValidation as Record<string, unknown>).lowStockHold, true, "listed items carry the projected hold");
  }
});

test("B2-20 approval and publication safety are unchanged", () => {
  for (const stock of [0, 1, 2, 3]) {
    assert.throws(() => assertNewSupplierPublicationStock({ supplierSourceId: "dropex", stock, stockKnown: true }));
  }
  assert.doesNotThrow(() => assertNewSupplierPublicationStock({ supplierSourceId: "dropex", stock: 4, stockKnown: true }));
  const held = projectSupplierReviewLowStockHold(reviewRecord({ stock: 0 }));
  assert.equal(supplierReviewCanQuickApprove(held as never), false);
});

test("B2 UI: Low Stock Hold is a Product Review filter with a server-provided count", () => {
  assert.deepEqual(PRODUCT_REVIEW_FILTERS.find((filter) => filter.id === "low_stock_hold"), { id: "low_stock_hold", label: "Low Stock Hold" });
  assert.equal(PRODUCT_REVIEW_FILTERS[0].id, "actionable", "default filter prioritizes actionable work");
  assert.equal(supplierReviewApiState("low_stock_hold"), "active");
  assert.equal(supplierReviewLowStockHoldQueueCount({ actionable: 122, lowStockHold: 211 }), 211);
  assert.equal(supplierReviewLowStockHoldQueueCount({ actionable: 3 }), null);
  assert.equal(supplierReviewLowStockHoldQueueCount({ lowStockHold: -1 }), null);

  const hub = readFileSync("src/components/SupplierHubFiveStars.tsx", "utf8");
  assert.match(hub, /filter: 'actionable' as ProductReviewFilter/u);
  assert.match(hub, /new URLSearchParams\(\{ view: 'review', limit: '50' \}\)/u);
  assert.match(hub, /if \(queryFilter\) parameters\.set\('filter', queryFilter\)/u);
  assert.match(hub, /setSupplierReviewLowStockHoldCount\(supplierReviewLowStockHoldQueueCount\(result\.queues\)\)/u);
  assert.match(hub, /filter\.id === 'low_stock_hold' && supplierReviewLowStockHoldCount !== null/u);
  const routes = readFileSync("functions/src/api/routes/supplier.ts", "utf8");
  assert.match(routes, /"low_stock_hold",\s*"approved_history"/u);
});

test("B2 UI: a held card keeps its Low Stock Hold label and no quick approval", () => {
  const held = projectSupplierReviewLowStockHold(reviewRecord({ comparisonStatus: "PRICE_CHANGED", stock: 0 }));
  const statusLabel = supplierReviewStatusLabel(held as never);
  assert.equal(statusLabel, "Low Stock Hold");
  const props: SupplierReviewQuickCardProps = {
    productName: "Held Dropex product",
    supplierItemCode: "DRX-1",
    managedImageUrl: "https://firebasestorage.googleapis.com/v0/b/demo/o/held.webp?alt=media",
    statusLabel,
    changeLabel: "Price changed",
    sellingPrice: 1_500,
    supplierCost: 1_000,
    supplierCostAvailable: true,
    supplierStockAvailable: true,
    profit: 500,
    marginPercent: 33.33,
    profitAvailable: true,
    stock: 0,
    brandLabel: "Brand",
    categoryLabel: "Electronics",
    subcategoryLabel: "Phones",
    storefrontVisible: false,
    storefrontStatusLabel: "Not published",
    supplierAttribution: "Dropex",
    blockingProblems: [],
    isPreparing: false,
    decisionReady: true,
    canQuickApprove: supplierReviewCanQuickApprove(held as never),
    canReject: true,
    needsResolution: true,
    processing: false,
    onApprove: () => undefined,
    onReject: () => undefined,
    onViewDetails: () => undefined,
    onViewHistory: () => undefined,
  };
  const markup = renderToStaticMarkup(React.createElement(SupplierReviewQuickCard, props));
  assert.match(markup, /Low Stock Hold/u);
  assert.match(markup, /Held Dropex product/u);
  assert.doesNotMatch(markup, />Approve</u);
  const modal = readFileSync("src/components/SupplierReviewEditorModal.tsx", "utf8");
  assert.match(modal, /supplierReviewIsLowStockHold\(item\)/u);
});

test("B2 server and client filters agree for every record and filter", () => {
  const records = [
    reviewRecord({ stock: 0 }),
    reviewRecord({ stock: 5 }),
    reviewRecord({ comparisonStatus: "PRICE_CHANGED", stock: 1 }),
    reviewRecord({ comparisonStatus: "PRICE_CHANGED", stock: 1, live: true }),
    reviewRecord({ comparisonStatus: "DESCRIPTION_CHANGED", stock: 3 }),
    reviewRecord({ stock: 0, extra: { status: "CONFLICT", queueState: "conflict" } }),
    reviewRecord({ comparisonStatus: "SUPPLIER_OFFER_REMOVED", stock: 2 }),
    reviewRecord({ stock: 0, extra: { supplierOfferPendingRevision: REVISION_B, decisionAction: "rejected", decisionPendingRevision: REVISION_A } }),
    reviewRecord({ stock: 0, extra: { status: "Rejected", queueState: "rejected", decisionAction: "rejected", decisionPendingRevision: REVISION_A } }),
    reviewRecord({ stock: 9, extra: { productValidation: { readyToPublish: false, missingFields: ["category"], errors: [] } } }),
  ];
  for (const record of records) {
    for (const filter of ALL_FILTERS) {
      assert.equal(clientMatches(record, filter), serverMatches(record, filter), `${filter} ${JSON.stringify(record.comparison)} ${record.stock}`);
    }
  }
});
