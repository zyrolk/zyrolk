import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { adminDb } from "../functions/src/api/firebase";
import { DropexConnectorService } from "../functions/src/api/suppliers/dropex/DropexConnectorService";
import {
  buildSupplierProductOffer,
} from "../functions/src/api/suppliers/supplierOfferEngine";
import {
  DROPEX_INVENTORY_REFRESH_SOURCE_LOCK_ID,
  runDropexInventoryRefresh,
  scheduledSupplierInventoryRefresh,
} from "../functions/src/scheduled/supplierInventoryRefresh";

type Data = Record<string, any>;
type DocRef = { kind: "doc"; collectionName: string; id: string; key: string; get?: () => Promise<Snapshot> };
type QueryRef = {
  kind: "query";
  collectionName: string;
  filters: Array<{ field: string; value: unknown }>;
  cursor: string | null;
  pageLimit: number;
  get: () => Promise<QuerySnapshot>;
  where: (field: string, operator: string, value: unknown) => QueryRef;
  limit: (value: number) => QueryRef;
  orderBy: (field: { __name__: true } | string, direction?: "asc" | "desc") => QueryRef;
  startAfter: (value: string) => QueryRef;
};
type Snapshot = { exists: boolean; id: string; data: () => Data | undefined; ref: DocRef };
type QuerySnapshot = { docs: Snapshot[] };

const makeFakeFirestore = (initial: Record<string, Data>) => {
  const documents = new Map(Object.entries(initial));
  let generatedId = 0;
  const docRef = (collectionName: string, id: string): DocRef => ({
    kind: "doc",
    collectionName,
    id,
    key: `${collectionName}/${id}`,
  });
  const snapshot = (reference: DocRef): Snapshot => ({
    exists: documents.has(reference.key),
    id: reference.id,
    ref: reference,
    data: () => documents.get(reference.key),
  });
  const query = (collectionName: string, filters: Array<{ field: string; value: unknown }> = [], cursor: string | null = null, pageLimit = 100): QueryRef => {
    const value: QueryRef = {
      kind: "query",
      collectionName,
      filters,
      cursor,
      pageLimit,
      get: async () => executeQuery(value),
      where: (field, operator, filterValue) => {
        assert.equal(operator, "==");
        return query(collectionName, [...filters, { field, value: filterValue }], cursor, pageLimit);
      },
      limit: (nextLimit) => query(collectionName, filters, cursor, nextLimit),
      orderBy: () => query(collectionName, filters, cursor, pageLimit),
      startAfter: (nextCursor) => query(collectionName, filters, nextCursor, pageLimit),
    };
    return value;
  };
  const executeQuery = (reference: QueryRef): QuerySnapshot => {
    const entries = [...documents.entries()]
      .filter(([key]) => key.startsWith(`${reference.collectionName}/`))
      .filter(([, value]) => reference.filters.every((filter) => value[filter.field] === filter.value))
      .sort(([left], [right]) => left.localeCompare(right));
    const filtered = reference.cursor
      ? entries.filter(([key]) => key.slice(reference.collectionName.length + 1) > reference.cursor!)
      : entries;
    return {
      docs: filtered.slice(0, reference.pageLimit).map(([key]) => snapshot(
        docRef(reference.collectionName, key.slice(reference.collectionName.length + 1)),
      )),
    };
  };
  const merge = (reference: DocRef, data: Data, shouldMerge: boolean) => {
    documents.set(reference.key, shouldMerge ? { ...(documents.get(reference.key) || {}), ...data } : data);
  };
  const db = {
    collection: (collectionName: string) => ({
      doc: (id?: string) => {
        const reference = docRef(collectionName, id || `generated-${++generatedId}`);
        reference.get = async () => snapshot(reference);
        return reference;
      },
      get: async () => executeQuery(query(collectionName)),
      where: (field: string, operator: string, value: unknown) => {
        assert.equal(operator, "==");
        return query(collectionName, [{ field, value }]);
      },
      orderBy: (field: { __name__: true } | string) => query(collectionName).orderBy(field),
    }),
    runTransaction: async <T>(callback: (transaction: {
      get: (reference: DocRef | QueryRef) => Promise<Snapshot | QuerySnapshot>;
      set: (reference: DocRef, data: Data, options?: { merge?: boolean }) => void;
      create: (reference: DocRef, data: Data) => void;
      update: (reference: DocRef, data: Data) => void;
    }) => Promise<T>): Promise<T> => callback({
      get: async (reference) => reference.kind === "query" ? executeQuery(reference) : snapshot(reference),
      set: (reference, data, options) => merge(reference, data, options?.merge === true),
      create: (reference, data) => merge(reference, data, false),
      update: (reference, data) => merge(reference, data, true),
    }),
  };
  return { db, documents };
};

const offer = buildSupplierProductOffer({
  sourceId: "dropex",
  supplierId: "dropex",
  supplierProductId: "2656",
  sku: "SHX2208",
  productId: "live-product",
  price: 1500,
  cost: 1000,
  stock: 10,
  stockKnown: true,
  availability: "in_stock",
  reviewStatus: "approved",
  enabled: true,
  health: { availability: "available", sourceAvailability: "available", inventoryObservedAt: "2026-09-25T00:00:00.000Z" },
  supplierSnapshot: { providedFields: ["stock"], inventoryLevel: 10 },
  catalogPayload: { name: "i7 Single Side Bluetooth - Black" },
  lastSyncAt: "2026-09-25T00:00:00.000Z",
  stateVersion: 3,
  timestamp: "2026-09-25T00:00:00.000Z",
});

const baseDocuments = (overrides: Record<string, Data> = {}) => ({
  "supplierSources/dropex": {
    enabled: true,
    sourceStatus: "active",
    websiteUrl: "https://www.dropex.lk",
    endpoint: "",
  },
  [`supplier_product_offers/${offer.id}`]: offer,
  "products/live-product": {
    id: "live-product",
    name: "i7 Single Side Bluetooth - Black",
    isActive: true,
    active: true,
    visible: true,
    stock: 8,
    availability: "in_stock",
    price: 1500,
    supplierSourceId: "dropex",
    supplierItemCode: "SHX2208",
  },
  "product_private/live-product": {
    supplierId: "dropex",
    supplierSourceId: "dropex",
    supplierOfferSelection: { activeOfferId: offer.id, lockedOfferId: null },
    supplierMetadata: {
      activeOfferId: offer.id,
      supplierProductId: "2656",
      sku: "SHX2208",
      inventoryLevel: 10,
      localDemand: { version: 1, quantity: 2, status: "tracked" },
    },
  },
  ...overrides,
});

const connectorFor = (fetchInventory: (target: { supplierProductId: string; sku: string }) => Promise<{ supplierProductId: string; sku: string; stock: number }>) => ({
  id: "dropex",
  name: "Dropex",
  connectorType: "dropex",
  enabled: true,
  priority: 100,
  capabilities: ["inventory.read"],
  fetchProducts: async () => ({ products: [], targetUrl: "" }),
  fetchProductPage: async () => ({ products: [], targetUrl: "", nextCursor: null, complete: true }),
  fetchExactInventoryForRefresh: fetchInventory,
  testConnection: async () => ({ success: true, status: "Connected" as const, productsCount: 0, sampleProduct: null }),
});

const canRunEmulator = Boolean(
  process.env.FIRESTORE_EMULATOR_HOST
  && process.env.FUNCTIONS_EMULATOR_HOST
  && String(process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT).startsWith("demo-"),
);

test("15-minute refresh uses exact active approved offers and preserves local demand", async () => {
  const inactiveOffer = buildSupplierProductOffer({
    sourceId: "dropex", supplierId: "dropex", supplierProductId: "inactive-id", sku: "INACTIVE",
    productId: "inactive-product", price: 100, cost: 50, stock: 9, stockKnown: true,
    availability: "in_stock", reviewStatus: "approved", enabled: true, lastSyncAt: "2026-09-25T00:00:00.000Z", timestamp: "2026-09-25T00:00:00.000Z",
  });
  const fixture = makeFakeFirestore(baseDocuments({
    [`supplier_product_offers/${inactiveOffer.id}`]: inactiveOffer,
    "products/inactive-product": { id: "inactive-product", isActive: false, stock: 9 },
    "product_private/inactive-product": { supplierId: "dropex", supplierSourceId: "dropex", supplierOfferSelection: { activeOfferId: inactiveOffer.id }, supplierMetadata: { supplierProductId: "inactive-id", sku: "INACTIVE", inventoryLevel: 9, localDemand: { version: 1, quantity: 0, status: "tracked" } } },
  }));
  const requests: Array<{ supplierProductId: string; sku: string }> = [];
  const result = await runDropexInventoryRefresh(1_000, fixture.db as never, 20, async () => connectorFor(async (target) => {
    requests.push(target);
    return { ...target, stock: 11 };
  }));
    assert.equal(result.attempted, 1);
    assert.equal(result.updated, 1);
    assert.equal(result.skippedItems, 1);
    assert.deepEqual(requests, [{ supplierProductId: "2656", sku: "SHX2208" }]);
    assert.equal(fixture.documents.get("products/live-product")?.stock, 9);
  assert.equal(fixture.documents.get(`supplier_product_offers/${offer.id}`)?.stock, 11);
  assert.deepEqual(fixture.documents.get("product_private/live-product")?.supplierMetadata.localDemand, { version: 1, quantity: 2, status: "tracked" });
  assert.equal(fixture.documents.has("supplier_review_queue/anything"), false);
  const auditCount = [...fixture.documents.keys()].filter((key) => key.startsWith("supplier_operations_audit/")).length;
  const repeated = await runDropexInventoryRefresh(2_000, fixture.db as never, 20, async () => connectorFor(async (target) => ({
    ...target,
    stock: 11,
  })));
  assert.equal(repeated.attempted, 1);
  assert.equal(repeated.unchanged, 1);
  assert.equal(repeated.updated, 0);
  assert.equal([...fixture.documents.keys()].filter((key) => key.startsWith("supplier_operations_audit/")).length, auditCount);
});

test("inactive and legacy-bootstrap products are skipped before any supplier fetch", async () => {
  const legacyOffer = buildSupplierProductOffer({
    sourceId: "dropex", supplierId: "dropex", supplierProductId: "legacy-id", sku: "LEGACY",
    productId: "legacy-product", price: 100, cost: 50, stock: 10, stockKnown: true,
    availability: "in_stock", reviewStatus: "approved", enabled: true, lastSyncAt: "2026-09-25T00:00:00.000Z", timestamp: "2026-09-25T00:00:00.000Z",
  });
  const fixture = makeFakeFirestore(baseDocuments({
    "products/live-product": { id: "live-product", isActive: false, stock: 8 },
    [`supplier_product_offers/${legacyOffer.id}`]: legacyOffer,
    "products/legacy-product": { id: "legacy-product", isActive: true, stock: 8 },
    "product_private/legacy-product": { supplierId: "dropex", supplierSourceId: "dropex", supplierOfferSelection: { activeOfferId: legacyOffer.id }, supplierMetadata: { supplierProductId: "legacy-id", sku: "LEGACY", inventoryLevel: 10, localDemand: { version: 1, quantity: 2, status: "legacy_bootstrap_required" } } },
  }));
  let fetchCount = 0;
  const result = await runDropexInventoryRefresh(2_000, fixture.db as never, 20, async () => connectorFor(async (target) => {
    fetchCount += 1;
    return { ...target, stock: 10 };
  }));
    assert.equal(result.attempted, 0);
    assert.equal(result.skippedItems, 2);
    assert.equal(fetchCount, 0);
  assert.equal(fixture.documents.get("products/legacy-product")?.stock, 8);
});

test("one exact inventory failure is isolated and a later item still updates", async () => {
  const secondOffer = buildSupplierProductOffer({
    sourceId: "dropex", supplierId: "dropex", supplierProductId: "second-id", sku: "SECOND",
    productId: "second-product", price: 100, cost: 50, stock: 4, stockKnown: true,
    availability: "in_stock", reviewStatus: "approved", enabled: true, lastSyncAt: "2026-09-25T00:00:00.000Z", timestamp: "2026-09-25T00:00:00.000Z",
  });
  const fixture = makeFakeFirestore(baseDocuments({
    [`supplier_product_offers/${secondOffer.id}`]: secondOffer,
    "products/second-product": { id: "second-product", isActive: true, stock: 4, supplierSourceId: "dropex", supplierItemCode: "SECOND" },
    "product_private/second-product": { supplierId: "dropex", supplierSourceId: "dropex", supplierOfferSelection: { activeOfferId: secondOffer.id }, supplierMetadata: { activeOfferId: secondOffer.id, supplierProductId: "second-id", sku: "SECOND", inventoryLevel: 4, localDemand: { version: 1, quantity: 0, status: "tracked" } } },
  }));
  const result = await runDropexInventoryRefresh(3_000, fixture.db as never, 20, async () => connectorFor(async (target) => {
    if (target.supplierProductId === "2656") throw new Error("temporary supplier timeout");
    return { ...target, stock: 7 };
  }));
    assert.equal(result.attempted, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.updated, 1);
  assert.equal(fixture.documents.get("products/second-product")?.stock, 7);
});

test("active refresh lease prevents overlapping runs", async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const fixture = makeFakeFirestore(baseDocuments({
    [`supplier_sync_locks/${DROPEX_INVENTORY_REFRESH_SOURCE_LOCK_ID}`]: { status: "running", owner: "other-run", lockedUntil: future },
  }));
  const result = await runDropexInventoryRefresh(Date.now(), fixture.db as never, 20);
  assert.equal(result.skipped, true);
  assert.equal(result.attempted, 0);
});

test("direct Dropex inventory read uses the known product DTO and never the catalogue", async () => {
  const urls: string[] = [];
  const payload = Buffer.from(JSON.stringify({ account: { id: "account-1" }, exp: Math.floor(Date.now() / 1000) + 3_600 })).toString("base64url");
  const token = `header.${payload}.signature`;
  const service = new DropexConnectorService(
    { supplierId: "dropex", sourceId: "dropex", credentialReference: "dropex-production" },
    {
      fetchOutbound: async (url) => {
        urls.push(url);
        if (url.endsWith("/auth/login")) return new Response(JSON.stringify({ access_token: token }), { status: 200 });
        return new Response(JSON.stringify({ productDetail: { id: "2656", sku: "SHX2208", onHandInventory: 0 } }), { status: 200 });
      },
      now: () => Date.now(),
    },
  );
  const observation = await service.fetchExactInventoryForRefresh(
    { username: "test-user", password: "test-password" },
    { approvedHosts: ["inventoryservice.dreamworld.lk", "user-service.dreamworld.lk"], connector: "dropex", sourceId: "dropex" },
    { supplierProductId: "2656", sku: "SHX2208" },
  );
  assert.deepEqual(observation, { supplierProductId: "2656", sku: "SHX2208", stock: 0 });
  assert.equal(urls.some((url) => url.includes("/re-seller-products/get")), false);
  assert.equal(urls.some((url) => url.endsWith("/api/v1/products/2656/dto")), true);
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const snapshotOf = (documents: Map<string, Data>, keys: string[]) => clone(keys.map((key) => documents.get(key) ?? null));

const dropexProductDocuments = (input: {
  productId: string;
  supplierProductId: string;
  sku: string;
  offerStock?: number;
  inventoryLevel?: number;
  publicStock?: number;
  localDemand?: number;
  isActive?: boolean;
  reviewStatus?: string;
  enabled?: boolean;
}) => {
  const productOffer = buildSupplierProductOffer({
    sourceId: "dropex",
    supplierId: "dropex",
    supplierProductId: input.supplierProductId,
    sku: input.sku,
    productId: input.productId,
    price: 1500,
    cost: 1000,
    stock: input.offerStock ?? 10,
    stockKnown: true,
    availability: (input.offerStock ?? 10) > 0 ? "in_stock" : "out_of_stock",
    reviewStatus: (input.reviewStatus ?? "approved") as never,
    enabled: input.enabled ?? true,
    catalogPayload: { name: `${input.sku} approved title` },
    lastSyncAt: "2026-09-25T00:00:00.000Z",
    stateVersion: 2,
    timestamp: "2026-09-25T00:00:00.000Z",
  });
  const documents: Record<string, Data> = {
    [`supplier_product_offers/${productOffer.id}`]: productOffer,
    [`products/${input.productId}`]: {
      id: input.productId,
      name: `${input.sku} approved title`,
      isActive: input.isActive ?? true,
      stock: input.publicStock ?? 8,
      availability: "in_stock",
      price: 1500,
      images: ["https://cdn.zyro.lk/approved.jpg"],
      category: "audio",
      brand: "approved-brand",
      supplierSourceId: "dropex",
      supplierItemCode: input.sku,
    },
    [`product_private/${input.productId}`]: {
      supplierId: "dropex",
      supplierSourceId: "dropex",
      costPrice: 1000,
      supplierOfferSelection: { activeOfferId: productOffer.id, lockedOfferId: null },
      supplierMetadata: {
        activeOfferId: productOffer.id,
        supplierProductId: input.supplierProductId,
        sku: input.sku,
        inventoryLevel: input.inventoryLevel ?? input.offerStock ?? 10,
        localDemand: { version: 1, quantity: input.localDemand ?? 2, status: "tracked" },
      },
    },
  };
  return { offer: productOffer, documents };
};

const sourceDocuments = () => ({
  "supplierSources/dropex": { enabled: true, sourceStatus: "active", websiteUrl: "https://www.dropex.lk", endpoint: "" },
  "supplier_settings/config": { autoSyncEnabled: false },
});

test("non-Dropex, unapproved, and disabled offers are skipped before any supplier fetch", async () => {
  const pending = dropexProductDocuments({ productId: "pending-product", supplierProductId: "p-1", sku: "PENDING", reviewStatus: "pending" });
  const disabled = dropexProductDocuments({ productId: "disabled-product", supplierProductId: "d-1", sku: "DISABLED", enabled: false });
  const foreignPublic = dropexProductDocuments({ productId: "foreign-product", supplierProductId: "f-1", sku: "FOREIGN" });
  foreignPublic.documents["products/foreign-product"].supplierSourceId = "a2z";
  const a2zOffer = buildSupplierProductOffer({
    sourceId: "a2z", supplierId: "a2z", supplierProductId: "a2z-1", sku: "A2Z", productId: "a2z-product",
    price: 100, cost: 50, stock: 5, stockKnown: true, availability: "in_stock", reviewStatus: "approved", enabled: true,
    lastSyncAt: "2026-09-25T00:00:00.000Z", timestamp: "2026-09-25T00:00:00.000Z",
  });
  const fixture = makeFakeFirestore({
    ...sourceDocuments(),
    ...pending.documents,
    ...disabled.documents,
    ...foreignPublic.documents,
    [`supplier_product_offers/${a2zOffer.id}`]: a2zOffer,
    "products/a2z-product": { id: "a2z-product", isActive: true, stock: 5, supplierSourceId: "a2z" },
  });
  const before = snapshotOf(fixture.documents, [`supplier_product_offers/${a2zOffer.id}`, "products/a2z-product"]);
  let fetchCount = 0;
  const result = await runDropexInventoryRefresh(1_000, fixture.db as never, 20, async () => connectorFor(async (target) => {
    fetchCount += 1;
    return { ...target, stock: 1 };
  }));
  assert.equal(fetchCount, 0);
  assert.equal(result.attempted, 0);
  assert.equal(result.skippedItems, 1);
  assert.deepEqual(snapshotOf(fixture.documents, [`supplier_product_offers/${a2zOffer.id}`, "products/a2z-product"]), before);
});

test("supplier stock observations project through local demand", async () => {
  const cases = [
    { offerStock: 10, inventoryLevel: 10, publicStock: 10, localDemand: 0, supplier: 7, expected: 7, availability: "in_stock" },
    { offerStock: 12, inventoryLevel: 12, publicStock: 10, localDemand: 2, supplier: 10, expected: 8, availability: "in_stock" },
    { offerStock: 10, inventoryLevel: 10, publicStock: 8, localDemand: 2, supplier: 8, expected: 6, availability: "in_stock" },
    { offerStock: 10, inventoryLevel: 10, publicStock: 8, localDemand: 2, supplier: 0, expected: 0, availability: "out_of_stock" },
  ];
  for (const scenario of cases) {
    const seeded = dropexProductDocuments({ productId: "p", supplierProductId: "sp", sku: "SKU", ...scenario });
    const fixture = makeFakeFirestore({ ...sourceDocuments(), ...seeded.documents });
    const result = await runDropexInventoryRefresh(1_000, fixture.db as never, 20, async () => connectorFor(async (target) => ({
      ...target,
      stock: scenario.supplier,
    })));
    assert.equal(result.updated, 1, JSON.stringify(scenario));
    const product = fixture.documents.get("products/p")!;
    const metadata = fixture.documents.get("product_private/p")!.supplierMetadata;
    assert.equal(product.stock, scenario.expected, JSON.stringify(scenario));
    assert.equal(product.availability, scenario.availability, JSON.stringify(scenario));
    assert.equal(metadata.inventoryLevel, scenario.supplier);
    assert.deepEqual(metadata.localDemand, { version: 1, quantity: scenario.localDemand, status: "tracked" });
    assert.equal(fixture.documents.get(`supplier_product_offers/${seeded.offer.id}`)!.stock, scenario.supplier);
  }
});

test("malformed stock and supplier failures preserve last-known-good state", async () => {
  const failures: Array<() => Promise<{ supplierProductId: string; sku: string; stock: number }>> = [
    async () => ({ supplierProductId: "sp", sku: "SKU", stock: -1 }),
    async () => ({ supplierProductId: "sp", sku: "SKU", stock: 2.5 }),
    async () => ({ supplierProductId: "sp", sku: "SKU", stock: Number.NaN }),
    async () => ({ supplierProductId: "other", sku: "SKU", stock: 3 }),
    async () => { throw new Error("Dropex 503"); },
  ];
  for (const fetchInventory of failures) {
    const seeded = dropexProductDocuments({ productId: "p", supplierProductId: "sp", sku: "SKU" });
    const fixture = makeFakeFirestore({ ...sourceDocuments(), ...seeded.documents });
    const keys = Object.keys(seeded.documents);
    const before = snapshotOf(fixture.documents, keys);
    const result = await runDropexInventoryRefresh(1_000, fixture.db as never, 20, async () => connectorFor(fetchInventory));
    assert.equal(result.failed, 1);
    assert.equal(result.updated, 0);
    assert.deepEqual(snapshotOf(fixture.documents, keys), before);
    assert.equal([...fixture.documents.keys()].some((key) => key.startsWith("supplier_operations_audit/")), false);
  }

  const payload = Buffer.from(JSON.stringify({ account: { id: "account-1" }, exp: Math.floor(Date.now() / 1000) + 3_600 })).toString("base64url");
  const token = `header.${payload}.signature`;
  for (const onHandInventory of ["abc", -4, 1.5, null]) {
    const service = new DropexConnectorService(
      { supplierId: "dropex", sourceId: "dropex", credentialReference: "dropex-production" },
      {
        fetchOutbound: async (url) => url.endsWith("/auth/login")
          ? new Response(JSON.stringify({ access_token: token }), { status: 200 })
          : new Response(JSON.stringify({ productDetail: { id: "2656", sku: "SHX2208", onHandInventory } }), { status: 200 }),
        now: () => Date.now(),
      },
    );
    await assert.rejects(service.fetchExactInventoryForRefresh(
      { username: "test-user", password: "test-password" },
      { approvedHosts: ["inventoryservice.dreamworld.lk", "user-service.dreamworld.lk"], connector: "dropex", sourceId: "dropex" },
      { supplierProductId: "2656", sku: "SHX2208" },
    ));
  }
});

test("non-stock supplier fields are ignored and no catalogue, review, or traversal side effects occur", async () => {
  const seeded = dropexProductDocuments({ productId: "p", supplierProductId: "sp", sku: "SKU" });
  const fixture = makeFakeFirestore({ ...sourceDocuments(), ...seeded.documents });
  const connector = {
    ...connectorFor(async (target) => ({
      ...target,
      stock: 7,
      price: 1,
      cost: 1,
      name: "Supplier rename",
      images: ["https://evil.example/new.jpg"],
      category: "other",
      brand: "other",
    } as never)),
    fetchProducts: async () => { throw new Error("catalogue traversal is forbidden"); },
    fetchProductPage: async () => { throw new Error("catalogue traversal is forbidden"); },
  };
  const result = await runDropexInventoryRefresh(1_000, fixture.db as never, 20, async () => connector);
  assert.equal(result.updated, 1);
  assert.equal(result.failed, 0);
  const product = fixture.documents.get("products/p")!;
  assert.equal(product.stock, 5);
  assert.equal(product.price, 1500);
  assert.equal(product.name, "SKU approved title");
  assert.deepEqual(product.images, ["https://cdn.zyro.lk/approved.jpg"]);
  assert.equal(product.category, "audio");
  assert.equal(product.brand, "approved-brand");
  assert.equal(product.isActive, true);
  const privateProduct = fixture.documents.get("product_private/p")!;
  assert.equal(privateProduct.costPrice, 1000);
  assert.deepEqual(privateProduct.supplierOfferSelection, { activeOfferId: seeded.offer.id, lockedOfferId: null });
  const storedOffer = fixture.documents.get(`supplier_product_offers/${seeded.offer.id}`)!;
  assert.equal(storedOffer.price, 1500);
  assert.equal(storedOffer.cost, 1000);
  assert.deepEqual(storedOffer.catalogPayload, seeded.offer.catalogPayload);
  assert.equal(storedOffer.supplierCatalogTraversalId, undefined);
  assert.equal([...fixture.documents.keys()].some((key) => key.startsWith("supplier_review_queue/")), false);
});

test("stock-only refresh never fails over or reprices when another approved offer exists", async () => {
  const seeded = dropexProductDocuments({ productId: "p", supplierProductId: "sp", sku: "SKU" });
  const alternate = buildSupplierProductOffer({
    sourceId: "a2z", supplierId: "a2z", supplierProductId: "alt", sku: "ALT", productId: "p",
    price: 999, cost: 500, stock: 50, stockKnown: true, availability: "in_stock", reviewStatus: "approved", enabled: true,
    lastSyncAt: "2026-09-25T00:00:00.000Z", timestamp: "2026-09-25T00:00:00.000Z",
  });
  const fixture = makeFakeFirestore({
    ...sourceDocuments(),
    ...seeded.documents,
    [`supplier_product_offers/${alternate.id}`]: alternate,
  });
  const result = await runDropexInventoryRefresh(1_000, fixture.db as never, 20, async () => connectorFor(async (target) => ({ ...target, stock: 0 })));
  assert.equal(result.updated, 1);
  const product = fixture.documents.get("products/p")!;
  assert.equal(product.stock, 0);
  assert.equal(product.price, 1500);
  assert.equal(fixture.documents.get("product_private/p")!.supplierOfferSelection.activeOfferId, seeded.offer.id);
  assert.equal(fixture.documents.get("product_private/p")!.costPrice, 1000);
  assert.deepEqual(fixture.documents.get(`supplier_product_offers/${alternate.id}`), alternate);
});

test("stale refresh lease is recovered and released", async () => {
  const seeded = dropexProductDocuments({ productId: "p", supplierProductId: "sp", sku: "SKU" });
  const fixture = makeFakeFirestore({
    ...sourceDocuments(),
    ...seeded.documents,
    [`supplier_sync_locks/${DROPEX_INVENTORY_REFRESH_SOURCE_LOCK_ID}`]: {
      status: "running",
      owner: "crashed-run",
      lockedUntil: new Date(Date.now() - 60_000).toISOString(),
    },
  });
  const result = await runDropexInventoryRefresh(Date.now(), fixture.db as never, 20, async () => connectorFor(async (target) => ({ ...target, stock: 7 })));
  assert.equal(result.skipped, false);
  assert.equal(result.updated, 1);
  const lock = fixture.documents.get(`supplier_sync_locks/${DROPEX_INVENTORY_REFRESH_SOURCE_LOCK_ID}`)!;
  assert.equal(lock.status, "idle");
  assert.equal(lock.owner, result.runId);
});

test("checkout and cancellation committed during the supplier fetch are not lost", async () => {
  const checkout = dropexProductDocuments({ productId: "p", supplierProductId: "sp", sku: "SKU", publicStock: 8, localDemand: 2 });
  const checkoutFixture = makeFakeFirestore({ ...sourceDocuments(), ...checkout.documents });
  await runDropexInventoryRefresh(1_000, checkoutFixture.db as never, 20, async () => connectorFor(async (target) => {
    const privateProduct = clone(checkoutFixture.documents.get("product_private/p")!);
    privateProduct.supplierMetadata.localDemand = { version: 1, quantity: 3, status: "tracked" };
    checkoutFixture.documents.set("product_private/p", privateProduct);
    checkoutFixture.documents.set("products/p", { ...checkoutFixture.documents.get("products/p")!, stock: 7 });
    return { ...target, stock: 11 };
  }));
  assert.equal(checkoutFixture.documents.get("products/p")!.stock, 8);
  assert.deepEqual(checkoutFixture.documents.get("product_private/p")!.supplierMetadata.localDemand, { version: 1, quantity: 3, status: "tracked" });

  const cancellation = dropexProductDocuments({ productId: "p", supplierProductId: "sp", sku: "SKU", publicStock: 8, localDemand: 2 });
  const cancellationFixture = makeFakeFirestore({ ...sourceDocuments(), ...cancellation.documents });
  await runDropexInventoryRefresh(1_000, cancellationFixture.db as never, 20, async () => connectorFor(async (target) => {
    const privateProduct = clone(cancellationFixture.documents.get("product_private/p")!);
    privateProduct.supplierMetadata.localDemand = { version: 1, quantity: 0, status: "tracked" };
    cancellationFixture.documents.set("product_private/p", privateProduct);
    cancellationFixture.documents.set("products/p", { ...cancellationFixture.documents.get("products/p")!, stock: 10 });
    return { ...target, stock: 9 };
  }));
  assert.equal(cancellationFixture.documents.get("products/p")!.stock, 9);
  assert.deepEqual(cancellationFixture.documents.get("product_private/p")!.supplierMetadata.localDemand, { version: 1, quantity: 0, status: "tracked" });
});

test("product deactivated during the supplier fetch is not written", async () => {
  const seeded = dropexProductDocuments({ productId: "p", supplierProductId: "sp", sku: "SKU" });
  const fixture = makeFakeFirestore({ ...sourceDocuments(), ...seeded.documents });
  const result = await runDropexInventoryRefresh(1_000, fixture.db as never, 20, async () => connectorFor(async (target) => {
    fixture.documents.set("products/p", { ...fixture.documents.get("products/p")!, isActive: false });
    return { ...target, stock: 3 };
  }));
  assert.equal(result.updated, 0);
  assert.equal(result.unchanged, 1);
  assert.equal(fixture.documents.get("products/p")!.stock, 8);
  assert.equal(fixture.documents.get(`supplier_product_offers/${seeded.offer.id}`)!.stock, 10);
});

test("quarantined inactive i7 product and its order stay untouched and Global Auto Sync stays OFF", async () => {
  const quarantined = dropexProductDocuments({
    productId: "zyro-27fd11710127de4ead9a0cf6e5777a81",
    supplierProductId: "2656",
    sku: "SHX2208",
    isActive: false,
  });
  const fixture = makeFakeFirestore({
    ...sourceDocuments(),
    ...quarantined.documents,
    "orders/HPrPuYZpYYndRz7rkOo2": { orderNumber: "ZY100005", status: "quarantined" },
  });
  const keys = [...Object.keys(quarantined.documents), "orders/HPrPuYZpYYndRz7rkOo2", "supplier_settings/config", "supplierSources/dropex"];
  const before = snapshotOf(fixture.documents, keys);
  let fetchCount = 0;
  const result = await runDropexInventoryRefresh(1_000, fixture.db as never, 20, async () => connectorFor(async (target) => {
    fetchCount += 1;
    return { ...target, stock: 50 };
  }));
  assert.equal(fetchCount, 0);
  assert.equal(result.attempted, 0);
  assert.deepEqual(snapshotOf(fixture.documents, keys), before);
  assert.equal(fixture.documents.get("supplier_settings/config")!.autoSyncEnabled, false);
  const unexpectedWrites = [...fixture.documents.keys()].filter((key) => !keys.includes(key)
    && key !== `supplier_sync_locks/${DROPEX_INVENTORY_REFRESH_SOURCE_LOCK_ID}`);
  assert.deepEqual(unexpectedWrites, []);
});

const withoutLocalDemand = (documents: Record<string, Data>, productId: string, localDemand?: unknown) => {
  const privateProduct = clone(documents[`product_private/${productId}`]);
  if (localDemand === undefined) delete privateProduct.supplierMetadata.localDemand;
  else privateProduct.supplierMetadata.localDemand = localDemand;
  documents[`product_private/${productId}`] = privateProduct;
  return documents;
};

const countingConnector = (stock: number | ((target: { supplierProductId: string; sku: string }) => number)) => {
  const requests: string[] = [];
  const factory = async () => connectorFor(async (target) => {
    requests.push(target.supplierProductId);
    return { ...target, stock: typeof stock === "function" ? stock(target) : stock };
  });
  return { requests, factory };
};

test("missing localDemand is eligible only when the canonical resolver proves tracked(0), and is persisted transactionally", async () => {
  const seeded = dropexProductDocuments({ productId: "p", supplierProductId: "sp", sku: "SKU", inventoryLevel: 10, publicStock: 10 });
  const fixture = makeFakeFirestore({ ...sourceDocuments(), ...withoutLocalDemand(seeded.documents, "p") });
  const connector = countingConnector(7);
  const result = await runDropexInventoryRefresh(1_000, fixture.db as never, 20, connector.factory);
  assert.deepEqual(connector.requests, ["sp"]);
  assert.equal(result.updated, 1);
  assert.equal(fixture.documents.get("products/p")!.stock, 7);
  assert.equal(fixture.documents.get("products/p")!.price, 1500);
  assert.deepEqual(fixture.documents.get("product_private/p")!.supplierMetadata.localDemand, { version: 1, quantity: 0, status: "tracked" });
});

test("missing or malformed localDemand without canonical proof is skipped before any supplier fetch", async () => {
  const scenarios: Array<{ label: string; build: () => Record<string, Data> }> = [
    {
      label: "inferred legacy bootstrap (supplier 10, public 8)",
      build: () => withoutLocalDemand(dropexProductDocuments({ productId: "p", supplierProductId: "sp", sku: "SKU", inventoryLevel: 10, publicStock: 8 }).documents, "p"),
    },
    {
      label: "unknown public stock is not defaulted to zero demand",
      build: () => {
        const documents = withoutLocalDemand(dropexProductDocuments({ productId: "p", supplierProductId: "sp", sku: "SKU", inventoryLevel: 10, publicStock: 10 }).documents, "p");
        delete documents["products/p"].stock;
        return documents;
      },
    },
    {
      label: "unknown supplier baseline",
      build: () => {
        const documents = withoutLocalDemand(dropexProductDocuments({ productId: "p", supplierProductId: "sp", sku: "SKU", inventoryLevel: 10, publicStock: 10 }).documents, "p");
        delete documents["product_private/p"].supplierMetadata.inventoryLevel;
        return documents;
      },
    },
    {
      label: "malformed stored localDemand",
      build: () => withoutLocalDemand(dropexProductDocuments({ productId: "p", supplierProductId: "sp", sku: "SKU", inventoryLevel: 10, publicStock: 10 }).documents, "p", { version: 1, quantity: -1, status: "tracked" }),
    },
    {
      label: "explicit legacy bootstrap state",
      build: () => withoutLocalDemand(dropexProductDocuments({ productId: "p", supplierProductId: "sp", sku: "SKU", inventoryLevel: 10, publicStock: 10 }).documents, "p", { version: 1, quantity: 0, status: "legacy_bootstrap_required" }),
    },
  ];
  for (const scenario of scenarios) {
    const documents = scenario.build();
    const fixture = makeFakeFirestore({ ...sourceDocuments(), ...documents });
    const before = snapshotOf(fixture.documents, Object.keys(documents));
    const connector = countingConnector(3);
    const result = await runDropexInventoryRefresh(1_000, fixture.db as never, 20, connector.factory);
    assert.deepEqual(connector.requests, [], scenario.label);
    assert.equal(result.attempted, 0, scenario.label);
    assert.equal(result.skippedItems, 1, scenario.label);
    assert.deepEqual(snapshotOf(fixture.documents, Object.keys(documents)), before, scenario.label);
  }
});

test("inactive i7-style product without localDemand stays rejected before fetch even though inference is safe", async () => {
  const quarantined = dropexProductDocuments({
    productId: "zyro-27fd11710127de4ead9a0cf6e5777a81",
    supplierProductId: "2656",
    sku: "SHX2208",
    inventoryLevel: 10,
    publicStock: 10,
    isActive: false,
  });
  const documents = withoutLocalDemand(quarantined.documents, "zyro-27fd11710127de4ead9a0cf6e5777a81");
  const fixture = makeFakeFirestore({ ...sourceDocuments(), ...documents });
  const before = snapshotOf(fixture.documents, Object.keys(documents));
  const connector = countingConnector(50);
  const result = await runDropexInventoryRefresh(1_000, fixture.db as never, 20, connector.factory);
  assert.deepEqual(connector.requests, []);
  assert.equal(result.attempted, 0);
  assert.deepEqual(snapshotOf(fixture.documents, Object.keys(documents)), before);
});

test("inferred demand stays transactional when a checkout commits during the supplier fetch", async () => {
  const seeded = dropexProductDocuments({ productId: "p", supplierProductId: "sp", sku: "SKU", inventoryLevel: 10, publicStock: 10 });
  const fixture = makeFakeFirestore({ ...sourceDocuments(), ...withoutLocalDemand(seeded.documents, "p") });
  await runDropexInventoryRefresh(1_000, fixture.db as never, 20, async () => connectorFor(async (target) => {
    const privateProduct = clone(fixture.documents.get("product_private/p")!);
    privateProduct.supplierMetadata.localDemand = { version: 1, quantity: 1, status: "tracked" };
    fixture.documents.set("product_private/p", privateProduct);
    fixture.documents.set("products/p", { ...fixture.documents.get("products/p")!, stock: 9 });
    return { ...target, stock: 7 };
  }));
  assert.equal(fixture.documents.get("products/p")!.stock, 6);
  assert.deepEqual(fixture.documents.get("product_private/p")!.supplierMetadata.localDemand, { version: 1, quantity: 1, status: "tracked" });
});

test("explicit tracked localDemand without a stored supplier baseline projects the fresh observation through that demand", async () => {
  const seeded = dropexProductDocuments({ productId: "p", supplierProductId: "sp", sku: "SKU", publicStock: 8, localDemand: 2 });
  delete seeded.documents["product_private/p"].supplierMetadata.inventoryLevel;
  const fixture = makeFakeFirestore({ ...sourceDocuments(), ...seeded.documents });
  const connector = countingConnector(8);
  const result = await runDropexInventoryRefresh(1_000, fixture.db as never, 20, connector.factory);
  assert.deepEqual(connector.requests, ["sp"]);
  assert.equal(result.skippedItems, 0);
  assert.equal(result.updated, 1);
  const product = fixture.documents.get("products/p")!;
  assert.equal(product.stock, 6);
  assert.equal(product.availability, "in_stock");
  assert.equal(product.price, 1500);
  const metadata = fixture.documents.get("product_private/p")!.supplierMetadata;
  assert.equal(metadata.inventoryLevel, 8);
  assert.deepEqual(metadata.localDemand, { version: 1, quantity: 2, status: "tracked" });
  assert.deepEqual(fixture.documents.get("product_private/p")!.supplierOfferSelection, { activeOfferId: seeded.offer.id, lockedOfferId: null });
  const storedOffer = fixture.documents.get(`supplier_product_offers/${seeded.offer.id}`)!;
  assert.equal(storedOffer.stock, 8);
  assert.equal(storedOffer.price, 1500);
  assert.equal(storedOffer.supplierCatalogTraversalId, undefined);
  assert.equal([...fixture.documents.keys()].some((key) => key.startsWith("supplier_review_queue/")), false);
});

const liveSet = (approved: number, activeCount: number, unapproved: number) => {
  const documents: Record<string, Data> = { ...sourceDocuments() };
  for (let index = 0; index < approved; index += 1) {
    const seeded = dropexProductDocuments({
      productId: `p-${index}`,
      supplierProductId: `sp-${index}`,
      sku: `SKU-${index}`,
      inventoryLevel: 10,
      publicStock: 10,
      isActive: index < activeCount,
    });
    Object.assign(documents, index % 2 === 0 ? withoutLocalDemand(seeded.documents, `p-${index}`) : seeded.documents);
    if (index % 2 !== 0) documents[`product_private/p-${index}`].supplierMetadata.localDemand = { version: 1, quantity: 0, status: "tracked" };
  }
  for (let index = 0; index < unapproved; index += 1) {
    documents[`supplier_product_offers/aaaa-unapproved-${String(index).padStart(5, "0")}`] = {
      sourceId: "dropex",
      supplierId: "dropex",
      supplierProductId: `u-${index}`,
      sku: `U-${index}`,
      reviewStatus: "pending",
      enabled: true,
      stock: 5,
    };
  }
  return documents;
};

test("current production size: 92 approved offers, 84 active, 3188 unapproved are all covered in one run", async () => {
  const fixture = makeFakeFirestore(liveSet(92, 84, 3188));
  const connector = countingConnector(7);
  const result = await runDropexInventoryRefresh(1_000, fixture.db as never, undefined, connector.factory);
  assert.equal(result.attempted, 84);
  assert.equal(result.updated, 84);
  assert.equal(result.failed, 0);
  assert.equal(result.skippedItems, 8);
  assert.equal(result.cursor, null);
  assert.equal(result.truncated, false);
  assert.equal(new Set(connector.requests).size, 84);
  assert.equal(connector.requests.some((id) => id.startsWith("u-")), false);
  assert.equal(fixture.documents.get("products/p-0")!.stock, 7);
  assert.equal(fixture.documents.get("products/p-90")!.stock, 10);
});

test("per-run supplier request cap is hard and the cursor continues past it", async () => {
  const fixture = makeFakeFirestore(liveSet(105, 105, 0));
  const first = countingConnector(7);
  const firstRun = await runDropexInventoryRefresh(1_000, fixture.db as never, 1_000, first.factory);
  assert.equal(firstRun.attempted, 100);
  assert.equal(firstRun.truncated, true);
  assert.notEqual(firstRun.cursor, null);
  const second = countingConnector(7);
  const secondRun = await runDropexInventoryRefresh(2_000, fixture.db as never, 1_000, second.factory);
  assert.equal(secondRun.attempted, 5);
  assert.equal(secondRun.cursor, null);
  assert.equal(new Set([...first.requests, ...second.requests]).size, 105);
});

test("small batches rotate through every eligible offer without starvation", async () => {
  const fixture = makeFakeFirestore(liveSet(5, 5, 40));
  const seen: string[] = [];
  const attempts: number[] = [];
  for (let run = 0; run < 3; run += 1) {
    const connector = countingConnector(7);
    const result = await runDropexInventoryRefresh(1_000 + run, fixture.db as never, 2, connector.factory);
    attempts.push(result.attempted);
    seen.push(...connector.requests);
  }
  assert.deepEqual(attempts, [2, 2, 1]);
  assert.deepEqual([...new Set(seen)].sort(), ["sp-0", "sp-1", "sp-2", "sp-3", "sp-4"]);
  assert.equal(seen.length, 5);
});

test("runtime budget stops new supplier requests and resumes from the last processed offer", async () => {
  const fixture = makeFakeFirestore(liveSet(3, 3, 0));
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const first = countingConnector(() => {
      offset += 8 * 60 * 1000;
      return 7;
    });
    const firstRun = await runDropexInventoryRefresh(realNow(), fixture.db as never, 100, first.factory);
    assert.equal(firstRun.attempted, 1);
    assert.equal(firstRun.truncated, true);
    assert.equal(first.requests.length, 1);
    offset = 0;
    const second = countingConnector(7);
    const secondRun = await runDropexInventoryRefresh(realNow() + 1, fixture.db as never, 100, second.factory);
    assert.equal(secondRun.attempted, 2);
    assert.deepEqual([...first.requests, ...second.requests].sort(), ["sp-0", "sp-1", "sp-2"]);
  } finally {
    Date.now = realNow;
  }
});

test("scheduled refresh binds only the Dropex Secret Manager credentials", () => {
  const endpoint = (scheduledSupplierInventoryRefresh as unknown as {
    __endpoint: {
      secretEnvironmentVariables?: Array<{ key: string }>;
      scheduleTrigger?: { schedule?: string; timeZone?: string };
    };
  }).__endpoint;
  const secretKeys = (endpoint.secretEnvironmentVariables || []).map((secret) => secret.key).sort();
  assert.deepEqual(secretKeys, ["DROPEX_PASSWORD", "DROPEX_USERNAME"]);
  assert.equal(secretKeys.some((key) => key.startsWith("A2Z_")), false);
  assert.equal(endpoint.scheduleTrigger?.schedule, "every 15 minutes");
  assert.equal(endpoint.scheduleTrigger?.timeZone, "Asia/Colombo");
});

test("emulator applies the exact refresh through stock authority without queue or content writes", {
  skip: canRunEmulator ? undefined : "Firestore and Functions Emulators are required.",
  timeout: 180_000,
}, async () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const productId = `inventory-refresh-product-${suffix}`;
  const supplierProductId = `inventory-refresh-supplier-${suffix}`;
  const sku = `INV-${suffix}`;
  const refreshOffer = buildSupplierProductOffer({
    sourceId: "dropex",
    supplierId: "dropex",
    supplierProductId,
    sku,
    productId,
    price: 1_500,
    cost: 900,
    stock: 10,
    stockKnown: true,
    availability: "in_stock",
    reviewStatus: "approved",
    enabled: true,
    health: { availability: "available", sourceAvailability: "available" },
    supplierSnapshot: { providedFields: ["stock"], inventoryLevel: 10 },
    lastSyncAt: "2026-09-25T00:00:00.000Z",
    stateVersion: 1,
    timestamp: "2026-09-25T00:00:00.000Z",
  });
  await Promise.all([
    adminDb.collection("supplierSources").doc("dropex").set({
      enabled: true,
      sourceStatus: "active",
      websiteUrl: "https://www.dropex.lk",
      endpoint: "",
    }, { merge: true }),
    adminDb.collection("supplier_product_offers").doc(refreshOffer.id).set(refreshOffer),
    adminDb.collection("products").doc(productId).set({
      id: productId,
      name: "Inventory refresh fixture",
      isActive: true,
      stock: 8,
      availability: "in_stock",
      price: 1_500,
      supplierSourceId: "dropex",
      supplierItemCode: sku,
    }),
    adminDb.collection("product_private").doc(productId).set({
      supplierId: "dropex",
      supplierSourceId: "dropex",
      supplierOfferSelection: { activeOfferId: refreshOffer.id, lockedOfferId: null },
      supplierMetadata: {
        activeOfferId: refreshOffer.id,
        supplierProductId,
        sku,
        inventoryLevel: 10,
        localDemand: { version: 1, quantity: 2, status: "tracked" },
      },
    }),
  ]);
  const result = await runDropexInventoryRefresh(Date.now(), adminDb, 20, async () => connectorFor(async (target) => ({
    ...target,
    stock: 12,
  })));
  assert.equal(result.attempted, 1);
  assert.equal(result.updated, 1);
  assert.equal((await adminDb.collection("products").doc(productId).get()).data()?.stock, 10);
  assert.equal((await adminDb.collection("supplier_product_offers").doc(refreshOffer.id).get()).data()?.stock, 12);
  assert.deepEqual((await adminDb.collection("product_private").doc(productId).get()).data()?.supplierMetadata.localDemand, { version: 1, quantity: 2, status: "tracked" });
  assert.equal((await adminDb.collection("supplier_review_queue").where("canonicalProductId", "==", productId).get()).empty, true);
});
