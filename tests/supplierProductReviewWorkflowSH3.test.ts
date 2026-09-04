import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseSupplierApprovalDraft } from '../functions/src/api/suppliers/supplierApproval';
import { listSupplierQueuePage } from '../functions/src/scheduled/supplierReviewQueue';
import {
  matchesProductReviewFilter,
  supplierReviewApiState,
  supplierReviewStatusLabel,
  supplierReviewCanRemove,
  supplierReviewIsTerminalDecision,
} from '../src/services/supplierHubPresentation';
import { createSupplierReviewDraft, updateSupplierReviewDraftField } from '../src/services/supplierReviewEditor';

const projectFile = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

type StoredReview = { id: string; data: Record<string, unknown> };

const reviewHistoryDb = (records: StoredReview[]) => {
  const document = (entry: StoredReview | undefined) => ({
    id: entry?.id || '',
    exists: Boolean(entry),
    data: () => entry?.data,
  });
  const query = (statuses: string[] = [], after = '', limit = 50) => ({
    where: (_field: string, operator: string, value: unknown) => query(
      operator === 'in' ? value as string[] : [String(value)],
      after,
      limit,
    ),
    orderBy: () => query(statuses, after, limit),
    startAfter: (cursor: { id: string }) => query(statuses, cursor.id, limit),
    limit: (nextLimit: number) => query(statuses, after, nextLimit),
    get: async () => {
      let selected = records
        .filter((record) => statuses.length === 0 || statuses.includes(String(record.data.status)))
        .sort((left, right) => String(right.data.createdAt).localeCompare(String(left.data.createdAt)));
      if (after) selected = selected.slice(selected.findIndex((record) => record.id === after) + 1);
      const docs = selected.slice(0, limit).map((record) => document(record));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  });
  return {
    collection: () => ({
      doc: (id: string) => ({ get: async () => document(records.find((record) => record.id === id)) }),
      where: (field: string, operator: string, value: unknown) => query().where(field, operator, value),
      orderBy: () => query(),
    }),
  };
};

test('Review History projects approved, rejected, and safely dismissed terminal decisions', async () => {
  const records: StoredReview[] = [
    { id: 'approved', data: { status: 'Approved', queueState: 'approved', createdAt: '3', decisionAction: 'approved' } },
    { id: 'rejected', data: { status: 'Rejected', queueState: 'rejected', createdAt: '2', decisionAction: 'rejected' } },
    { id: 'dismissed', data: { status: 'Rejected', queueState: 'suppressed', createdAt: '1', decisionAction: 'deleted' } },
  ];
  const page = await listSupplierQueuePage(reviewHistoryDb(records) as never, {
    view: 'review',
    state: 'history',
    businessFilter: 'approved_history',
    limit: 10,
  });

  assert.deepEqual(page.items.map((item) => item.id), ['approved', 'rejected', 'dismissed']);
  assert.equal(supplierReviewApiState('approved_history'), 'history');
  assert.equal(matchesProductReviewFilter(records[1].data, 'approved_history'), true);
  assert.equal(matchesProductReviewFilter(records[2].data, 'approved_history'), true);
  assert.equal(supplierReviewStatusLabel(records[2].data), 'Dismissed');
  assert.equal(supplierReviewIsTerminalDecision(records[2].data), true);
  assert.equal(matchesProductReviewFilter(records[2].data, 'needs_attention'), false);
  assert.equal(matchesProductReviewFilter(records[2].data, 'new_products'), false);
});

test('Needs Attention includes failed media while conflicts retain an explicit status', () => {
  assert.equal(matchesProductReviewFilter({ queueState: 'review_pending', mediaStatus: 'partial' }, 'needs_attention'), true);
  assert.equal(supplierReviewStatusLabel({ queueState: 'conflict' }), 'Conflict');
});

test('Product Review removal is limited to active observations and never terminal history', () => {
  assert.equal(supplierReviewCanRemove({ status: 'Pending', queueState: 'review_pending' }), true);
  assert.equal(supplierReviewCanRemove({ status: 'Pending', queueState: 'queued' }), true);
  assert.equal(supplierReviewCanRemove({ status: 'Approved', queueState: 'approved' }), false);
  assert.equal(supplierReviewCanRemove({ status: 'Rejected', queueState: 'suppressed', decisionAction: 'deleted' }), false);
});

test('Product Review SEO fields use the existing admin ownership and approval contract', () => {
  const item = {
    id: 'review-seo', productName: 'Supplier Phone', supplierCode: 'PHONE-1', supplierName: 'Supplier',
    costPrice: 100, marketPrice: 150, stock: 5, imageUrl: 'https://supplier.example/phone.jpg',
    comparison: { comparisonStatus: 'NEW_PRODUCT', fieldChanges: [] },
    productPayload: {
      id: 'phone-1', name: 'Supplier Phone', description: 'Description', price: 150, originalPrice: 175,
      stock: 5, category: 'phones', brand: 'brand-1', specs: {}, imageUrl: 'https://supplier.example/phone.jpg',
      imageUrls: ['https://supplier.example/phone.jpg'], metaDescription: 'Supplier SEO', keywords: ['phone'], rating: 0, reviewsCount: 0,
    },
  };
  const initial = createSupplierReviewDraft(item);
  assert.equal(initial.metaDescription, 'Supplier SEO');
  assert.deepEqual(initial.keywords, ['phone']);

  const editedMeta = updateSupplierReviewDraftField(initial, 'metaDescription', { metaDescription: 'Admin SEO description' });
  const edited = updateSupplierReviewDraftField(editedMeta, 'keywords', { keywords: ['smartphone', 'Sri Lanka'] });
  const parsed = parseSupplierApprovalDraft({ ...edited, primaryImageUrl: item.imageUrl, galleryImageUrls: [] });
  assert.equal(parsed?.metaDescription, 'Admin SEO description');
  assert.deepEqual(parsed?.keywords, ['smartphone', 'Sri Lanka']);
  assert.equal(parsed?.fieldOwnership?.metaDescription, 'admin');
  assert.equal(parsed?.fieldOwnership?.keywords, 'admin');
});

test('Product Review exposes only server-authoritative decisions and bounded truthful history/search UI', () => {
  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
  const quickCard = projectFile('src/components/SupplierReviewQuickCard.tsx');
  const historyModal = projectFile('src/components/SupplierReviewHistoryModal.tsx');
  const routes = projectFile('functions/src/api/routes/supplier.ts');
  const approval = projectFile('functions/src/api/suppliers/supplierApproval.ts');
  const reviewQueue = projectFile('functions/src/scheduled/supplierReviewQueue.ts');
  const rules = projectFile('firestore.rules');
  const indexes = JSON.parse(projectFile('firestore.indexes.json')) as { indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; order: string }> }> };

  assert.match(hub, /Search loaded products or supplier codes/);
  assert.match(hub, /Use Load more products to extend the bounded search/);
  assert.match(hub, /decideSupplierReviewQueueItem\(item\.id, 'delete'/);
  assert.match(hub, /Remove this item from Product Review\?/);
  assert.match(hub, /does not delete the supplier product or a published Zyro product/);
  assert.match(routes, /supplier-review-queue\/:queueItemId\/delete/);
  assert.match(hub, /expectedPendingRevision: item\.supplierOfferPendingRevision/);
  assert.match(quickCard, /View decision history/);
  assert.doesNotMatch(hub, /useEffect\(\(\) => onIdTokenChanged\(auth,/);
  assert.match(historyModal, /Immutable review timeline/);
  assert.match(historyModal, /supplierAdministratorLabel/);
  assert.match(routes, /supplier-review-queue\/:queueItemId\/audit/);
  assert.match(approval, /Only an active unpublished supplier review can be removed/);
  assert.match(reviewQueue, /url === existingAssets\[index\]\?\.originalSupplierUrl/);
  assert.match(rules, /match \/supplier_approval_audit\/\{docId\}[\s\S]*allow create, update, delete: if false;/);
  assert.equal(indexes.indexes.some((index) => index.collectionGroup === 'supplier_approval_audit'
    && index.fields.some((field) => field.fieldPath === 'queueItemId' && field.order === 'ASCENDING')
    && index.fields.some((field) => field.fieldPath === 'timestamp' && field.order === 'ASCENDING')), true);
});

test('Conflict detail identifies the reason and canonical product without automatic merge language', () => {
  const editor = projectFile('src/components/SupplierReviewEditorModal.tsx');
  assert.match(editor, /Conflict requires an explicit administrator decision/);
  assert.match(editor, /Canonical Zyro product/);
  assert.match(editor, /never merges or publishes this conflict automatically/);
});
