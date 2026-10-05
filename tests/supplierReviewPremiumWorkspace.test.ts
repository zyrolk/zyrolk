import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SupplierReviewPagination, { buildSupplierReviewPaginationItems } from '../src/components/SupplierReviewPagination';

const hub = readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8');
const card = readFileSync('src/components/SupplierReviewQuickCard.tsx', 'utf8');

test('Product Review pagination keeps first, nearby, and last pages with ellipses', () => {
  assert.deepEqual(buildSupplierReviewPaginationItems(1, 1), [1]);
  assert.deepEqual(buildSupplierReviewPaginationItems(1, 3), [1, 2, 3]);
  assert.deepEqual(buildSupplierReviewPaginationItems(5, 30), [1, 'ellipsis', 4, 5, 6, 'ellipsis', 30]);
  assert.deepEqual(buildSupplierReviewPaginationItems(29, 30), [1, 'ellipsis', 26, 27, 28, 29, 30]);
});

test('Product Review pagination is accessible and supports unknown totals', () => {
  const known = renderToStaticMarkup(React.createElement(SupplierReviewPagination, {
    currentPage: 5,
    totalPages: 30,
    hasNext: true,
    hasPrevious: true,
    onPageChange: () => undefined,
  }));
  assert.match(known, /aria-current="page"/u);
  assert.match(known, /aria-label="Previous Product Review page"/u);
  assert.match(known, /aria-label="Next Product Review page"/u);
  assert.match(known, /Product Review page 30/u);

  const unknown = renderToStaticMarkup(React.createElement(SupplierReviewPagination, {
    currentPage: 5,
    totalPages: null,
    hasNext: true,
    hasPrevious: true,
    onPageChange: () => undefined,
  }));
  assert.match(unknown, /Product Review page 5/u);
  assert.doesNotMatch(unknown, /Product Review page 30/u);
});

test('Product Review workspace uses URL state, bounded page replacement, and no visible Load More dependency', () => {
  assert.match(hub, /URLSearchParams\(window\.location\.search\)/u);
  for (const parameter of ['view', 'page', 'pageSize', 'sort', 'q', 'media']) assert.match(hub, new RegExp(`['"]${parameter}['"]`, 'u'));
  assert.ok(hub.includes('window.history[`${mode}State`]'));
  assert.match(hub, /setReviewQueue\(items\)/u);
  assert.match(hub, /setSupplierReviewPageSize/u);
  assert.doesNotMatch(hub, />Load more products</u);
  assert.doesNotMatch(hub, /\.offset\(/u);
  assert.match(hub, /supplierReviewPageNavigationError/u);
});

test('compact Product Review cards demote supplier evidence and destructive actions', () => {
  assert.match(card, /Supplier evidence/u);
  assert.match(card, /More actions/u);
  assert.match(card, /Review Product/u);
  assert.match(card, /Waiting for media/u);
  assert.match(card, /min-h-11 flex-1 rounded-xl bg-blue-600/u);
  assert.match(card, /hover:border-red-300/u);
  assert.doesNotMatch(card, /onClick=\{openEditor\}/u);
});

test('business and media filters remain separate and approval action remains explicit', () => {
  assert.match(hub, /aria-label="Product review media filters"/u);
  assert.match(hub, /aria-label="Product review filters"/u);
  assert.match(hub, /handleReviewMediaFilterChange/u);
  assert.match(hub, /handleReviewFilterChange/u);
  assert.match(hub, /SupplierReviewEditorModal/u);
  assert.doesNotMatch(hub, /Bulk Approve|Bulk Reject/u);
});
