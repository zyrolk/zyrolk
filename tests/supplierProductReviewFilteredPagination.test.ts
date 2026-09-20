import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { listSupplierQueuePage, reviewRecordIsActionable } from '../functions/src/scheduled/supplierReviewQueue';

type StoredDocument = Record<string, unknown>;
type QuerySnapshot = { docs: DocumentSnapshot[]; size: number; empty: boolean };
type DocumentSnapshot = { exists: boolean; id: string; data: () => StoredDocument | undefined };

const createReviewQueueFirestore = (records: Array<{ id: string; data: StoredDocument }>) => {
  const documentSnapshot = (id: string): DocumentSnapshot => {
    const record = records.find((entry) => entry.id === id);
    return { exists: Boolean(record), id, data: () => record?.data };
  };
  const query = (
    statuses: string[] | null = null,
    cursorId: string | null = null,
    pageLimit: number | null = null,
    sortField = 'createdAt',
    sortDirection = 'desc',
  ) => ({
    where: (_field: string, operator: string, value: unknown) => query(
      operator === 'in' ? value as string[] : [String(value)],
      cursorId,
      pageLimit,
      sortField,
      sortDirection,
    ),
    orderBy: (field: string | { toString: () => string }, direction: string) => {
      const fieldName = String(field);
      return fieldName === '__name__'
        ? query(statuses, cursorId, pageLimit, sortField, direction)
        : query(statuses, cursorId, pageLimit, fieldName, direction);
    },
    startAfter: (cursor: { id: string }) => query(statuses, cursor.id, pageLimit, sortField, sortDirection),
    limit: (limit: number) => query(statuses, cursorId, limit, sortField, sortDirection),
    get: async (): Promise<QuerySnapshot> => {
      let selected = [...records]
        .filter((entry) => !statuses || statuses.includes(String(entry.data.status)))
        .sort((left, right) => {
          const primary = String(right.data[sortField] || '').localeCompare(String(left.data[sortField] || ''));
          return primary || (sortDirection === 'desc'
            ? right.id.localeCompare(left.id)
            : left.id.localeCompare(right.id));
        });
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

const activeReview = (index: number, comparisonStatus: string): { id: string; data: StoredDocument } => ({
  id: `review-${String(index).padStart(3, '0')}`,
  data: {
    status: 'Pending',
    queueState: 'review_pending',
    createdAt: String(1_000 - index).padStart(4, '0'),
    comparison: { comparisonStatus },
    productValidation: { readyToPublish: true, missingFields: [], errors: [] },
  },
});

test('Product Review scans beyond a non-matching first server batch and returns the filtered review', async () => {
  const records = Array.from({ length: 50 }, (_, index) => activeReview(index, 'PRICE_CHANGED'));
  records.push(activeReview(50, 'NEW_PRODUCT'));

  const page = await listSupplierQueuePage(createReviewQueueFirestore(records) as never, {
    view: 'review', state: 'active', businessFilter: 'new_products', limit: 1,
  });

  assert.deepEqual(page.items.map((item) => item.id), ['review-050']);
  assert.equal(page.nextCursor, null);
});

test('Product Review filtered cursor continues after the last scanned document without duplicates', async () => {
  const records = Array.from({ length: 50 }, (_, index) => activeReview(index, 'PRICE_CHANGED'));
  records.push(activeReview(50, 'NEW_PRODUCT'));
  records.push(...Array.from({ length: 50 }, (_, index) => activeReview(index + 51, 'STOCK_CHANGED')));
  records.push(activeReview(101, 'NEW_PRODUCT'));

  const db = createReviewQueueFirestore(records) as never;
  const first = await listSupplierQueuePage(db, {
    view: 'review', state: 'active', businessFilter: 'new_products', limit: 1,
  });
  const second = await listSupplierQueuePage(db, {
    view: 'review', state: 'active', businessFilter: 'new_products', limit: 1, after: first.nextCursor || undefined,
  });

  assert.deepEqual(first.items.map((item) => item.id), ['review-050']);
  assert.equal(first.nextCursor, 'review-050');
  assert.deepEqual(second.items.map((item) => item.id), ['review-101']);
  assert.equal(second.nextCursor, null);
});

test('terminal dismissed observations are excluded from active business filters', async () => {
  const dismissed = activeReview(0, 'NEW_PRODUCT');
  dismissed.data = {
    ...dismissed.data,
    status: 'Rejected',
    queueState: 'suppressed',
    decisionAction: 'deleted',
    productValidation: { readyToPublish: false, missingFields: ['category'], errors: [] },
  };
  const page = await listSupplierQueuePage(createReviewQueueFirestore([dismissed]) as never, {
    view: 'review', state: 'history', businessFilter: 'approved_history', limit: 10,
  });
  assert.deepEqual(page.items.map((item) => item.id), ['review-000']);
  const activePage = await listSupplierQueuePage(createReviewQueueFirestore([dismissed]) as never, {
    view: 'review', state: 'active', businessFilter: 'needs_attention', limit: 10,
  });
  assert.deepEqual(activePage.items, []);
});

test('legacy terminal status fields cannot overlap active views or actionable counts', async () => {
  const rejected = activeReview(0, 'PRICE_CHANGED');
  rejected.data = { ...rejected.data, reviewStatus: 'rejected', decisionAction: 'rejected' };
  const dismissed = activeReview(1, 'NEW_PRODUCT');
  dismissed.data = { ...dismissed.data, reviewStatus: 'deleted', decisionAction: 'deleted' };
  const activeUpdate = activeReview(2, 'STOCK_CHANGED');
  const activeAttention = activeReview(3, 'DESCRIPTION_CHANGED');
  activeAttention.data = { ...activeAttention.data, productValidation: { readyToPublish: false, missingFields: ['description'], errors: [] } };
  const records = [rejected, dismissed, activeUpdate, activeAttention];

  const activeUpdates = await listSupplierQueuePage(createReviewQueueFirestore(records) as never, {
    view: 'review', state: 'active', businessFilter: 'product_updates', limit: 10,
  });
  assert.deepEqual(activeUpdates.items.map((item) => item.id), ['review-002', 'review-003']);

  const attention = await listSupplierQueuePage(createReviewQueueFirestore(records) as never, {
    view: 'review', state: 'active', businessFilter: 'needs_attention', limit: 10,
  });
  assert.deepEqual(attention.items.map((item) => item.id), ['review-003']);

  const history = await listSupplierQueuePage(createReviewQueueFirestore(records) as never, {
    view: 'review', state: 'history', businessFilter: 'approved_history', limit: 10,
  });
  assert.deepEqual(history.items.map((item) => item.id), ['review-000', 'review-001']);
  assert.equal(reviewRecordIsActionable(rejected.data as never), false);
  assert.equal(reviewRecordIsActionable(dismissed.data as never), false);
  assert.equal(reviewRecordIsActionable(activeUpdate.data as never), true);
  assert.equal(reviewRecordIsActionable(activeAttention.data as never), true);
});

test('legacy dismissed and suppressed-only records are history-only', async () => {
  const dismissed = activeReview(4, 'NEW_PRODUCT');
  dismissed.data = { ...dismissed.data, decisionAction: 'dismissed' };
  const suppressed = activeReview(5, 'PRICE_CHANGED');
  suppressed.data = { ...suppressed.data, status: 'suppressed' };
  const records = [dismissed, suppressed];

  const history = await listSupplierQueuePage(createReviewQueueFirestore(records) as never, {
    view: 'review', state: 'history', businessFilter: 'approved_history', limit: 10,
  });
  assert.deepEqual(history.items.map((item) => item.id), ['review-004', 'review-005']);
  for (const record of records) {
    assert.equal(reviewRecordIsActionable(record.data as never), false);
    const active = await listSupplierQueuePage(createReviewQueueFirestore([record]) as never, {
      view: 'review', state: 'active', businessFilter: 'needs_attention', limit: 10,
    });
    assert.deepEqual(active.items, []);
  }
});

test('legacy top-level comparison fields remain filterable without terminal overlap', async () => {
  const active = activeReview(0, 'UNCHANGED');
  active.data = { ...active.data, comparison: null, comparisonStatus: 'PRICE_CHANGED', changedFields: ['Cost Price'] };
  const page = await listSupplierQueuePage(createReviewQueueFirestore([active]) as never, {
    view: 'review', state: 'active', businessFilter: 'product_updates', limit: 10,
  });
  assert.deepEqual(page.items.map((item) => item.id), ['review-000']);
});

test('Product Review API core keeps existing generic pagination behaviour when no business filter is supplied', async () => {
  const records = [activeReview(0, 'PRICE_CHANGED'), activeReview(1, 'NEW_PRODUCT')];
  const page = await listSupplierQueuePage(createReviewQueueFirestore(records) as never, {
    view: 'review', state: 'active', limit: 1,
  });

  assert.deepEqual(page.items.map((item) => item.id), ['review-000']);
  assert.equal(page.nextCursor, 'review-000');
});

test('Product Review can order filtered pages by recently updated records', async () => {
  const records = [
    { ...activeReview(0, 'NEW_PRODUCT'), data: { ...activeReview(0, 'NEW_PRODUCT').data, updatedAt: '2026-09-01T00:00:00.000Z' } },
    { ...activeReview(1, 'NEW_PRODUCT'), data: { ...activeReview(1, 'NEW_PRODUCT').data, updatedAt: '2026-09-03T00:00:00.000Z' } },
  ];
  const page = await listSupplierQueuePage(createReviewQueueFirestore(records) as never, {
    view: 'review', state: 'active', businessFilter: 'new_products', sort: 'updated', limit: 2,
  });

  assert.deepEqual(page.items.map((item) => item.id), ['review-001', 'review-000']);
  assert.equal(page.nextCursor, null);
});

test('recently updated cursor pagination is stable across equal timestamps without duplicates or skips', async () => {
  const records = [0, 1, 2, 3].map((index) => ({
    ...activeReview(index, 'NEW_PRODUCT'),
    data: { ...activeReview(index, 'NEW_PRODUCT').data, updatedAt: '2026-09-03T00:00:00.000Z' },
  }));
  const db = createReviewQueueFirestore(records) as never;
  const first = await listSupplierQueuePage(db, {
    view: 'review', state: 'active', businessFilter: 'new_products', sort: 'updated', limit: 2,
  });
  const second = await listSupplierQueuePage(db, {
    view: 'review', state: 'active', businessFilter: 'new_products', sort: 'updated', limit: 2,
    after: first.nextCursor || undefined,
  });

  assert.deepEqual(first.items.map((item) => item.id), ['review-003', 'review-002']);
  assert.deepEqual(second.items.map((item) => item.id), ['review-001', 'review-000']);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 4);
  assert.equal(first.nextCursor, 'review-002');
  assert.equal(second.nextCursor, null);
});

test('Product Review sends the selected filter and polling reloads every already-loaded page', () => {
  const component = readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8');
  const routes = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');

  assert.match(component, /new URLSearchParams\(\{ view: 'review', limit: '50', filter: reviewFilter \}\)/);
  assert.match(component, /parameters\.set\('sort', 'updated'\)/);
  assert.match(component, /Recently updated/);
  assert.match(component, /supplierReviewLoadedPagesRef\.current \+ pagesLoaded/);
  assert.match(component, /loadSupplierQueueView\(\{ pageCount: supplierReviewLoadedPagesRef\.current \}\)/);
  assert.match(routes, /readSupplierReviewBusinessFilter\(req\.query\.filter\)/);
  assert.match(routes, /readSupplierReviewQueueSort\(req\.query\.sort\)/);
  assert.match(routes, /\.\.\.\(businessFilter \? \{ businessFilter \} : \{\}\)/);
});

test('default Product Review ordering remains createdAt-based and recent sorting is server-selected', () => {
  const queue = readFileSync('functions/src/scheduled/supplierReviewQueue.ts', 'utf8');
  const indexes = readFileSync('firestore.indexes.json', 'utf8');
  assert.match(queue, /sort === "updated" \? "updatedAt" : "createdAt"/);
  assert.match(queue, /orderBy\(FieldPath\.documentId\(\), "desc"\)/);
  assert.match(indexes, /"fieldPath": "updatedAt",\s*"order": "DESCENDING"/);
});
