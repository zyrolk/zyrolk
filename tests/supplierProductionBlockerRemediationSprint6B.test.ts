import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildSupplierProductOffer,
  reconcileSupplierProductOfferFailover,
} from '../functions/src/api/suppliers/supplierOfferEngine';
import {
  heartbeatSupplierReviewQueueLease,
  listSupplierQueuePage,
  recoverExpiredSupplierReviewQueueLeases,
} from '../functions/src/scheduled/supplierReviewQueue';
import { heartbeatSupplierQueueWorkerLock } from '../functions/src/scheduled/supplierQueueWorker';
import {
  isSupplierSourceAvailableForCommerce,
  supplierSourceEligibilityChanged,
} from '../functions/src/triggers/supplierOfferFailover';

type StoredDocument = Record<string, unknown>;
type Filter = { field: string; operator: string; value: unknown };
type Order = { field: string; direction: 'asc' | 'desc' };
type DocumentReference = { kind: 'document'; collectionName: string; id: string; key: string };
type QueryReference = {
  kind: 'query';
  collectionName: string;
  filters: Filter[];
  orders: Order[];
  pageLimit: number | null;
  cursorId: string | null;
  where: (field: string, operator: string, value: unknown) => QueryReference;
  orderBy: (field: unknown, direction?: 'asc' | 'desc') => QueryReference;
  limit: (value: number) => QueryReference;
  startAfter: (cursor: { id: string }) => QueryReference;
  get: () => Promise<QuerySnapshot>;
};
type DocumentSnapshot = { exists: boolean; id: string; ref: DocumentReference; data: () => StoredDocument | undefined };
type QuerySnapshot = { docs: DocumentSnapshot[]; size: number; empty: boolean };

const createFakeFirestore = (initial: Record<string, StoredDocument>) => {
  const documents = new Map<string, StoredDocument>(Object.entries(initial));
  let generatedId = 0;
  const writes: Array<{ operation: 'set' | 'create' | 'update'; key: string; data: StoredDocument }> = [];
  const documentReference = (collectionName: string, id: string): DocumentReference => ({
    kind: 'document', collectionName, id, key: `${collectionName}/${id}`,
  });
  const documentSnapshot = (reference: DocumentReference): DocumentSnapshot => {
    const data = documents.get(reference.key);
    return {
      exists: data !== undefined,
      id: reference.id,
      ref: reference,
      data: () => data,
    };
  };
  const comparable = (value: unknown): unknown => value && typeof value === 'object' && 'toMillis' in value
    ? (value as { toMillis: () => number }).toMillis()
    : value;
  const executeQuery = async (query: QueryReference): Promise<QuerySnapshot> => {
    let entries = [...documents.entries()]
      .filter(([key]) => key.startsWith(`${query.collectionName}/`))
      .map(([key, data]) => ({ id: key.slice(query.collectionName.length + 1), data }));
    for (const filter of query.filters) {
      entries = entries.filter((entry) => {
        const left = comparable(entry.data[filter.field]);
        const right = comparable(filter.value);
        if (filter.operator === '==') return left === right;
        if (filter.operator === 'in') return Array.isArray(right) && right.includes(left);
        if (filter.operator === '<=') return String(left || '') <= String(right || '');
        return false;
      });
    }
    entries.sort((left, right) => {
      for (const order of query.orders) {
        const leftValue = order.field === '__name__' ? left.id : String(left.data[order.field] || '');
        const rightValue = order.field === '__name__' ? right.id : String(right.data[order.field] || '');
        const compared = String(leftValue).localeCompare(String(rightValue));
        if (compared) return order.direction === 'desc' ? -compared : compared;
      }
      return left.id.localeCompare(right.id);
    });
    if (query.cursorId) {
      const cursorIndex = entries.findIndex((entry) => entry.id === query.cursorId);
      entries = cursorIndex >= 0 ? entries.slice(cursorIndex + 1) : [];
    }
    if (query.pageLimit !== null) entries = entries.slice(0, query.pageLimit);
    const docs = entries.map((entry) => documentSnapshot(documentReference(query.collectionName, entry.id)));
    return { docs, size: docs.length, empty: docs.length === 0 };
  };
  const queryReference = (
    collectionName: string,
    filters: Filter[] = [],
    orders: Order[] = [],
    pageLimit: number | null = null,
    cursorId: string | null = null,
  ): QueryReference => {
    const query: QueryReference = {
      kind: 'query', collectionName, filters, orders, pageLimit, cursorId,
      where: (field, operator, value) => queryReference(collectionName, [...filters, { field, operator, value }], orders, pageLimit, cursorId),
      orderBy: (field, direction = 'asc') => queryReference(collectionName, filters, [...orders, {
        field: typeof field === 'string' ? field : '__name__', direction,
      }], pageLimit, cursorId),
      limit: (value) => queryReference(collectionName, filters, orders, value, cursorId),
      startAfter: (cursor) => queryReference(collectionName, filters, orders, pageLimit, cursor.id),
      get: () => executeQuery(query),
    };
    return query;
  };
  const mergeWrite = (reference: DocumentReference, data: StoredDocument, merge = false): void => {
    documents.set(reference.key, merge ? { ...(documents.get(reference.key) || {}), ...data } : data);
  };
  const db = {
    collection: (collectionName: string) => ({
      doc: (id?: string) => {
        const reference = documentReference(collectionName, id || `generated-${++generatedId}`);
        return { ...reference, get: async () => documentSnapshot(reference) };
      },
      where: (field: string, operator: string, value: unknown) => queryReference(collectionName).where(field, operator, value),
      orderBy: (field: string, direction?: 'asc' | 'desc') => queryReference(collectionName).orderBy(field, direction),
    }),
    runTransaction: async <T>(operation: (transaction: {
      get: (reference: DocumentReference | QueryReference) => Promise<DocumentSnapshot | QuerySnapshot>;
      set: (reference: DocumentReference, data: StoredDocument, options?: { merge?: boolean }) => void;
      create: (reference: DocumentReference, data: StoredDocument) => void;
      update: (reference: DocumentReference, data: StoredDocument) => void;
    }) => Promise<T>) => operation({
      get: async (reference) => reference.kind === 'query' ? executeQuery(reference) : documentSnapshot(reference),
      set: (reference, data, options) => {
        writes.push({ operation: 'set', key: reference.key, data });
        mergeWrite(reference, data, options?.merge);
      },
      create: (reference, data) => {
        if (documents.has(reference.key)) throw new Error('Document already exists.');
        writes.push({ operation: 'create', key: reference.key, data });
        mergeWrite(reference, data);
      },
      update: (reference, data) => {
        writes.push({ operation: 'update', key: reference.key, data });
        mergeWrite(reference, data, true);
      },
    }),
  };
  return { db, documents, writes };
};

const approvedOffer = (sourceId: string, priority: number, overrides: Record<string, unknown> = {}) => buildSupplierProductOffer({
  sourceId,
  supplierId: sourceId,
  supplierProductId: `${sourceId}-item`,
  sku: `${sourceId}-sku`,
  productId: 'product-1',
  price: 150,
  cost: 100,
  stock: 20,
  availability: 'available',
  priority,
  health: { availability: 'available', sourceAvailability: 'available' },
  lastSyncAt: '2026-07-26T00:00:00.000Z',
  reviewStatus: 'approved',
  catalogPayload: { originalPrice: 200 },
  supplierSnapshot: {},
  timestamp: '2026-07-26T00:00:00.000Z',
  ...overrides,
});

test('Sprint 6B atomically fails over to the highest-priority eligible approved offer and preserves reserved stock', async () => {
  const unavailable = approvedOffer('current', 100, { stock: 0, availability: 'out_of_stock' });
  const approved = approvedOffer('approved', 200);
  const unapproved = approvedOffer('unapproved', 500, { reviewStatus: 'review_pending' });
  const { db, documents, writes } = createFakeFirestore({
    'products/product-1': { id: 'product-1', price: 120, stock: 8, availability: 'in_stock', isActive: true, active: true, visible: true },
    'product_private/product-1': {
      supplierOfferSelection: { activeOfferId: unavailable.id, lockedOfferId: null, failoverEnabled: true },
      supplierMetadata: { activeOfferId: unavailable.id, inventoryLevel: 10 },
    },
    [`supplier_product_offers/${unavailable.id}`]: { ...unavailable },
    [`supplier_product_offers/${approved.id}`]: { ...approved },
    [`supplier_product_offers/${unapproved.id}`]: { ...unapproved },
  });

  const result = await reconcileSupplierProductOfferFailover(db as never, 'product-1', 'stock changed');

  assert.equal(result.changed, true);
  assert.equal(result.activeOfferId, approved.id);
  assert.equal(documents.get('products/product-1')?.price, 150);
  assert.equal(documents.get('products/product-1')?.stock, 18);
  assert.equal((documents.get('product_private/product-1')?.supplierOfferSelection as { activeOfferId?: string }).activeOfferId, approved.id);
  const audit = writes.find((write) => write.operation === 'create' && write.key.startsWith('supplier_operations_audit/'));
  assert.equal(audit?.data.action, 'automatic_offer_failover');
  assert.equal(audit?.data.previousOfferId, unavailable.id);
});

test('Sprint 6B never exposes an unapproved offer and safely restores a recovered configured offer', async () => {
  const offer = approvedOffer('current', 100, { stock: 0, availability: 'out_of_stock' });
  const { db, documents, writes } = createFakeFirestore({
    'products/product-1': { id: 'product-1', price: 120, stock: 7, availability: 'in_stock', isActive: true, active: true, visible: true },
    'product_private/product-1': {
      supplierOfferSelection: { activeOfferId: offer.id, lockedOfferId: null, failoverEnabled: true },
      supplierMetadata: { activeOfferId: offer.id, inventoryLevel: 10 },
    },
    [`supplier_product_offers/${offer.id}`]: { ...offer },
  });

  const unavailable = await reconcileSupplierProductOfferFailover(db as never, 'product-1');
  assert.equal(unavailable.activeOfferId, null);
  assert.equal(documents.get('products/product-1')?.visible, false);
  assert.equal((documents.get('product_private/product-1')?.supplierOfferSelection as { activeOfferId?: string }).activeOfferId, offer.id);

  documents.set(`supplier_product_offers/${offer.id}`, { ...approvedOffer('current', 100, { id: offer.id, stock: 12 }) });
  const recovered = await reconcileSupplierProductOfferFailover(db as never, 'product-1');
  assert.equal(recovered.activeOfferId, offer.id);
  assert.equal(documents.get('products/product-1')?.stock, 12);
  assert.equal(documents.get('products/product-1')?.visible, true, JSON.stringify(writes));
});

test('Sprint 6B source health detection covers disabled, paused, failed, and unhealthy supplier sources', () => {
  assert.equal(isSupplierSourceAvailableForCommerce({ enabled: true, sourceStatus: 'active', connectionStatus: 'connected', syncHealth: { availability: 'available' } }), true);
  assert.equal(isSupplierSourceAvailableForCommerce({ enabled: false, sourceStatus: 'active' }), false);
  assert.equal(isSupplierSourceAvailableForCommerce({ enabled: true, operationalState: 'paused' }), false);
  assert.equal(isSupplierSourceAvailableForCommerce({ enabled: true, connectionStatus: 'Failed' }), false);
  assert.equal(isSupplierSourceAvailableForCommerce({ enabled: true, syncHealth: { availability: 'unavailable' } }), false);
  assert.equal(supplierSourceEligibilityChanged({ enabled: true }, { enabled: false }), true);
});

test('Sprint 6B review queue API pages active items with a stable cursor and excludes terminal history', async () => {
  const initial: Record<string, StoredDocument> = {};
  for (let index = 0; index < 55; index += 1) {
    const id = `pending-${String(index).padStart(2, '0')}`;
    initial[`supplier_review_queue/${id}`] = {
      status: 'Pending', queueState: 'review_pending', createdAt: new Date(Date.UTC(2026, 6, 26, 0, index)).toISOString(),
    };
  }
  initial['supplier_review_queue/terminal'] = { status: 'Approved', queueState: 'approved', createdAt: '2026-07-27T00:00:00.000Z' };
  const { db } = createFakeFirestore(initial);
  const first = await listSupplierQueuePage(db as never, { view: 'review', state: 'active', limit: 20 });
  const second = await listSupplierQueuePage(db as never, { view: 'review', state: 'active', limit: 20, after: first.nextCursor || undefined });

  assert.equal(first.items.length, 20);
  assert.ok(first.nextCursor);
  assert.equal(second.items.length, 20);
  assert.equal(first.items.some((item) => item.id === 'terminal'), false);
  assert.equal(second.items.some((item) => first.items.some((firstItem) => firstItem.id === item.id)), false);
});

test('Sprint 6B lease heartbeats extend ownership and prevent stale recovery or duplicate workers', async () => {
  const now = Date.now();
  const { db, documents } = createFakeFirestore({
    'supplier_review_queue/review-1': {
      status: 'Pending', queueState: 'processing', leaseOwner: 'worker-a', leaseId: 'lease-a',
      leaseExpiresAt: new Date(now + 1_000).toISOString(), retryCount: 0, retryLimit: 3,
    },
    'supplier_sync_locks/scheduled_supplier_queue_worker': {
      status: 'running', owner: 'worker-a', lockedUntil: new Date(now + 1_000).toISOString(),
    },
  });

  assert.equal(await heartbeatSupplierReviewQueueLease(db as never, 'review-1', 'worker-a', 'lease-a', now, 10_000), true);
  assert.equal(await heartbeatSupplierReviewQueueLease(db as never, 'review-1', 'worker-b', 'lease-a', now, 10_000), false);
  assert.equal(await recoverExpiredSupplierReviewQueueLeases(db as never, now + 2_000), 0);
  assert.equal(documents.get('supplier_review_queue/review-1')?.queueState, 'processing');
  assert.equal(await heartbeatSupplierQueueWorkerLock(db as never, 'worker-a', now, 10_000), true);
  assert.equal(await heartbeatSupplierQueueWorkerLock(db as never, 'worker-b', now, 10_000), false);
});

test('Sprint 6B removes unbounded queue listeners and keeps queue access server-authoritative and indexed', () => {
  const component = readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8');
  const routes = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');
  const indexes = JSON.parse(readFileSync('firestore.indexes.json', 'utf8')) as { indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; order: string }> }> };
  assert.doesNotMatch(component, /onSnapshot\(\s*collection\(db, ["']supplier_(review_queue|import_queue|pending_changes)["']/);
  assert.match(component, /\/api\/supplier-review-queue\?/);
  assert.match(routes, /app\.get\("\/api\/supplier-review-queue", requireSupplierHubAdmin/);
  assert.equal(indexes.indexes.some((index) => index.collectionGroup === 'supplier_review_queue'
    && index.fields.some((field) => field.fieldPath === 'status')
    && index.fields.some((field) => field.fieldPath === 'createdAt' && field.order === 'DESCENDING')), true);
});
