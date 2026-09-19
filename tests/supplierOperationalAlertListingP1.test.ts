import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deleteApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth } from "firebase/auth";
import {
  encodeOperationalAlertCursor,
  loadSupplierOperationalAlerts,
  projectSupplierOperationalAlertForAdmin,
} from "../functions/src/api/suppliers/supplierOperations";
import { adminAuth, adminDb } from "../functions/src/api/firebase";
import {
  buildOperationalAlertQuery,
  mergeOperationalAlertPage,
  operationalAlertResponseIsCurrent,
} from "../src/components/supplier-operations/SupplierOperationsDashboard";

type AlertRecord = Record<string, unknown>;

const createFakeFirestore = (records: Map<string, AlertRecord>) => {
  const reads: string[] = [];
  let writes = 0;
  const snapshotFor = (id: string) => ({
    exists: records.has(id),
    id,
    data: () => records.get(id),
  });
  const collection = {
    doc: (id: string) => ({
      get: async () => snapshotFor(id),
    }),
    orderBy: () => {
      let afterId: string | null = null;
      let pageLimit = 50;
      const query = {
        orderBy: () => query,
        startAfter: (snapshot: { id: string }) => {
          afterId = snapshot.id;
          return query;
        },
        limit: (value: number) => {
          pageLimit = value;
          return query;
        },
        get: async () => {
          reads.push("supplier_operational_alerts");
          const sorted = [...records.entries()]
            .sort((left, right) => {
              const dateOrder = String(right[1].lastOccurrence).localeCompare(String(left[1].lastOccurrence));
              return dateOrder || right[0].localeCompare(left[0]);
            });
          const startIndex = afterId ? sorted.findIndex(([id]) => id === afterId) + 1 : 0;
          const page = sorted.slice(Math.max(0, startIndex), Math.max(0, startIndex) + pageLimit);
          return {
            size: page.length,
            docs: page.map(([id, data]) => ({ id, data: () => data })),
          };
        },
      };
      return query;
    },
  };
  return {
    db: { collection: () => collection } as never,
    reads,
    get writes() { return writes; },
    markWrite: () => { writes += 1; },
  };
};

const makeAlert = (index: number, overrides: AlertRecord = {}): AlertRecord => ({
  alertId: `alert-${index}`,
  status: index % 3 === 0 ? "acknowledged" : "open",
  severity: index % 2 ? "critical" : "high",
  category: index % 2 ? "media_processing_failure" : "supplier_sync_failure",
  supplierId: index % 2 ? "dropex" : "a2z",
  firstOccurrence: new Date(Date.parse("2026-09-19T00:00:00.000Z") + index * 1_000).toISOString(),
  lastOccurrence: new Date(Date.parse("2026-09-19T00:00:00.000Z") + index * 1_000).toISOString(),
  occurrenceCount: index + 1,
  incidentGeneration: 1,
  title: `Alert ${index}`,
  message: `Message ${index}`,
  queueItemId: `queue-${index}`,
  ...overrides,
});

test("operational alert listing traverses more than 100 records without duplicates or omissions", async () => {
  const records = new Map(Array.from({ length: 212 }, (_, index) => [`alert-${index}`, makeAlert(index)]));
  const fake = createFakeFirestore(records);
  let cursor: string | null = null;
  const ids: string[] = [];
  const expected = [...records.entries()]
    .sort((left, right) => String(right[1].lastOccurrence).localeCompare(String(left[1].lastOccurrence)) || right[0].localeCompare(left[0]))
    .map(([id]) => id);
  do {
    const page = await loadSupplierOperationalAlerts(fake.db, { limit: "50", ...(cursor ? { after: cursor } : {}) });
    ids.push(...(page.items as Array<{ alertId: string }>).map((item) => item.alertId));
    cursor = page.nextCursor as string | null;
  } while (cursor);

  assert.equal(ids.length, 212);
  assert.equal(new Set(ids).size, 212);
  assert.deepEqual(ids, expected);
  assert.ok(fake.reads.length >= 3);
  assert.equal(fake.writes, 0);
});

test("operational alert listing applies status, category, severity, and supplier filters", async () => {
  const records = new Map([
    ["alert-a", makeAlert(1, { status: "acknowledged", severity: "critical", category: "media_processing_failure", supplierId: "dropex" })],
    ["alert-b", makeAlert(2, { status: "open", severity: "high", category: "supplier_sync_failure", supplierId: "a2z" })],
  ]);
  const fake = createFakeFirestore(records);
  const result = await loadSupplierOperationalAlerts(fake.db, {
    status: "acknowledged",
    category: "media_processing_failure",
    severity: "critical",
    supplierId: "dropex",
    limit: "10",
  });
  assert.deepEqual((result.items as Array<{ alertId: string }>).map((item) => item.alertId), ["alert-a"]);
  assert.equal(result.hasMore, false);
});

test("operational alert listing preserves sparse-filter continuation across source batches", async () => {
  const records = new Map(Array.from({ length: 260 }, (_, index) => [
    `alert-${index}`,
    makeAlert(index, { supplierId: [20, 120, 220].includes(index) ? "target" : "other" }),
  ]));
  const fake = createFakeFirestore(records);
  const first = await loadSupplierOperationalAlerts(fake.db, { supplierId: "target", limit: "2" });
  const second = await loadSupplierOperationalAlerts(fake.db, { supplierId: "target", limit: "2", after: first.nextCursor });
  const ids = [
    ...(first.items as Array<{ alertId: string }>).map((item) => item.alertId),
    ...(second.items as Array<{ alertId: string }>).map((item) => item.alertId),
  ];
  assert.deepEqual(ids, ["alert-220", "alert-120", "alert-20"]);
  assert.equal(new Set(ids).size, 3);
  assert.equal(first.scannedCount, 200);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
});

test("operational alert listing exposes continuation after the 5,000-record scan cap", async () => {
  const records = new Map(Array.from({ length: 5_101 }, (_, index) => [`alert-${index}`, makeAlert(index, { supplierId: "other" })]));
  const fake = createFakeFirestore(records);
  const first = await loadSupplierOperationalAlerts(fake.db, { supplierId: "missing", limit: "50" });
  assert.deepEqual(first.items, []);
  assert.equal(first.scannedCount, 5_000);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const second = await loadSupplierOperationalAlerts(fake.db, { supplierId: "missing", limit: "50", after: first.nextCursor });
  assert.deepEqual(second.items, []);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
});

test("operational alert listing enforces the maximum limit and uses an opaque cursor", async () => {
  const records = new Map([["alert-a", makeAlert(1)]]);
  const fake = createFakeFirestore(records);
  await assert.rejects(() => loadSupplierOperationalAlerts(fake.db, { limit: "101" }), /between 1 and 100/u);
  const cursor = encodeOperationalAlertCursor("alert-a");
  assert.notEqual(cursor, "alert-a");
  assert.deepEqual(await loadSupplierOperationalAlerts(fake.db, { after: cursor }), {
    items: [],
    nextCursor: null,
    hasMore: false,
    returnedCount: 0,
    scannedCount: 0,
  });
  await assert.rejects(() => loadSupplierOperationalAlerts(fake.db, { after: "not-a-cursor" }), /cursor is invalid/u);
  await assert.rejects(() => loadSupplierOperationalAlerts(fake.db, { status: ["open", "resolved"] }), /provided exactly once/u);
});

test("operational alert projection is sanitized and does not expose technical metadata or credentials", () => {
  const projected = projectSupplierOperationalAlertForAdmin({
    id: "alert-a",
    data: () => ({
      status: "open",
      severity: "critical",
      category: "supplier_sync_failure",
      title: "  Supplier failure\n",
      message: "Safe message",
      supplierId: "dropex",
      technicalMetadata: { password: "secret", token: "secret" },
      assignedAdmin: { uid: "admin-1", email: "private@example.com" },
    }),
  });
  assert.equal(projected.alertId, "alert-a");
  assert.equal(projected.title, "Supplier failure");
  assert.equal("technicalMetadata" in projected, false);
  assert.equal("email" in projected, false);
  assert.equal("password" in projected, false);
});

test("operational alert UI state boundary replaces on filter changes, appends on Load More, and rejects stale responses", () => {
  const first = mergeOperationalAlertPage([], {
    items: [{ id: "open-1" }],
    nextCursor: "cursor-open",
  }, false);
  assert.deepEqual(first.items.map((item) => item.id), ["open-1"]);
  assert.equal(first.cursor, "cursor-open");

  const filtered = mergeOperationalAlertPage(first.items, {
    items: [{ id: "critical-1" }],
    nextCursor: "cursor-critical",
  }, false);
  assert.deepEqual(filtered.items.map((item) => item.id), ["critical-1"]);
  assert.equal(filtered.cursor, "cursor-critical");

  const appended = mergeOperationalAlertPage(filtered.items, {
    items: [{ id: "critical-2" }],
    nextCursor: null,
  }, true);
  assert.deepEqual(appended.items.map((item) => item.id), ["critical-1", "critical-2"]);
  assert.equal(appended.cursor, null);
  assert.equal(operationalAlertResponseIsCurrent(2, 1), false);
  assert.equal(operationalAlertResponseIsCurrent(2, 2), true);

  const freshFilterQuery = buildOperationalAlertQuery({ status: "critical" });
  const continuationQuery = buildOperationalAlertQuery({ status: "critical" }, "cursor-critical");
  assert.match(freshFilterQuery, /status=critical/u);
  assert.doesNotMatch(freshFilterQuery, /after=/u);
  assert.match(continuationQuery, /after=cursor-critical/u);
});

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
const canRunEmulator = Boolean(firestoreHost && authHost && functionsHost && projectId?.startsWith("demo-"));

test("operational alert endpoint exercises auth, filters, pagination, malformed input, and zero-write behavior", {
  skip: canRunEmulator ? undefined : "Firestore, Auth, and Functions Emulators are required.",
  timeout: 180_000,
}, async () => {
  const suffix = randomUUID().slice(0, 8);
  const supplierId = `alert-listing-${suffix}`;
  const app = initializeApp({ apiKey: "demo-key", projectId }, `alert-listing-${suffix}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
  const email = `${supplierId}@example.test`;
  const password = `Zyro-${randomUUID()}!`;
  const ordinaryApp = initializeApp({ apiKey: "demo-key", projectId }, `alert-listing-ordinary-${suffix}`);
  const ordinaryAuth = getAuth(ordinaryApp);
  connectAuthEmulator(ordinaryAuth, `http://${authHost}`, { disableWarnings: true });
  const ordinaryEmail = `${supplierId}-ordinary@example.test`;
  const path = "/supplier-operations/alerts";
  const apiBase = `http://${functionsHost}/${projectId}/us-central1/api/api`;
  const request = (query: string, token?: string) => fetch(`${apiBase}${path}${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  const snapshotCollections = async (): Promise<Record<string, Array<[string, string]>>> => {
    const names = [
      "supplier_operational_alerts",
      "supplier_operational_alert_events",
      "supplier_review_queue",
      "supplierSources",
      "supplier_sync_history",
    ];
    const result: Record<string, Array<[string, string]>> = {};
    for (const name of names) {
      const snapshot = await adminDb.collection(name).get();
      result[name] = snapshot.docs.map((document) => [document.id, JSON.stringify(document.data())]);
    }
    return result;
  };

  try {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    const ordinaryCredential = await createUserWithEmailAndPassword(ordinaryAuth, ordinaryEmail, password);
    await adminAuth.setCustomUserClaims(credential.user.uid, { supplierHubAdmin: true });
    const adminToken = await credential.user.getIdToken(true);
    const ordinaryToken = await ordinaryCredential.user.getIdToken();

    const unauthenticated = await request("");
    assert.equal(unauthenticated.status, 401);
    const ordinary = await request("", ordinaryToken);
    assert.equal(ordinary.status, 403);

    const seed = Array.from({ length: 120 }, (_, index) => {
      const id = `${supplierId}-${String(index).padStart(3, "0")}`;
      const occurrence = new Date(Date.parse("2026-09-19T00:00:00.000Z") + index * 1_000).toISOString();
      return adminDb.collection("supplier_operational_alerts").doc(id).set({
        alertId: id,
        status: index % 3 === 0 ? "acknowledged" : "open",
        severity: index % 2 === 0 ? "critical" : "high",
        category: index % 2 === 0 ? "supplier_sync_failure" : "media_processing_failure",
        supplierId,
        firstOccurrence: occurrence,
        lastOccurrence: occurrence,
        occurrenceCount: index + 1,
        incidentGeneration: 1,
        title: "Runtime alert",
        message: "Safe runtime alert",
      });
    });
    await Promise.all(seed);
    const before = await snapshotCollections();

    let cursor: string | null = null;
    const listed: string[] = [];
    do {
      const response = await request(`?limit=50&supplierId=${encodeURIComponent(supplierId)}${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`, adminToken);
      assert.equal(response.status, 200);
      const body = await response.json() as { items: Array<{ alertId: string }>; nextCursor: string | null; hasMore: boolean };
      listed.push(...body.items.map((item) => item.alertId));
      cursor = body.nextCursor;
      if (!body.hasMore) break;
    } while (cursor);
    assert.equal(listed.length, 120);
    assert.equal(new Set(listed).size, 120);
    assert.deepEqual(listed, [...listed].sort((left, right) => right.localeCompare(left)));

    const filtered = await request(`?status=open&category=supplier_sync_failure&severity=critical&supplierId=${encodeURIComponent(supplierId)}&limit=10`, adminToken);
    assert.equal(filtered.status, 200);
    const filteredBody = await filtered.json() as { items: Array<Record<string, unknown>> };
    assert.ok(filteredBody.items.length > 0);
    assert.ok(filteredBody.items.every((item) => item.status === "open" && item.category === "supplier_sync_failure" && item.severity === "critical" && item.supplierId === supplierId));

    for (const query of [
      "?status=open&status=resolved",
      "?category=supplier_sync_failure&category=media_processing_failure",
      "?severity=critical&severity=high",
      `?supplierId=${encodeURIComponent(supplierId)}&supplierId=other`,
      "?limit=50&limit=51",
      "?after=a&after=b",
      "?status=unknown",
      "?category=unknown",
      "?severity=unknown",
      "?supplierId=bad/value",
      "?limit=0",
      "?after=not-a-cursor",
    ]) {
      const response = await request(query, adminToken);
      assert.equal(response.status, 400, query);
    }

    const after = await snapshotCollections();
    assert.deepEqual(after, before);
  } finally {
    await deleteApp(app);
    await deleteApp(ordinaryApp);
  }
});
