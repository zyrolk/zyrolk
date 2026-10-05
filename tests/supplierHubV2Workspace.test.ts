import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const hub = readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8');
const card = readFileSync('src/components/SupplierReviewQuickCard.tsx', 'utf8');

test('Supplier Hub V2 exposes five simple primary sections with mobile-safe navigation', () => {
  for (const label of ['Overview', 'Review Queue', 'Suppliers', 'Operations', 'Settings']) {
    assert.match(hub, new RegExp(`label: '${label}'`));
  }
  assert.match(hub, /supplier-hub-section-mobile/u);
  assert.match(hub, /aria-current=\{isSubActive \? 'page' : undefined\}/u);
  assert.match(hub, /writeSupplierHubSectionUrl\(nextSection\)/u);
});

test('Overview keeps sync, inventory and media health as separate concepts', () => {
  assert.match(hub, /aria-label="Supplier system health"/u);
  assert.match(hub, /label: 'Catalog Sync'/u);
  assert.match(hub, /label: 'Inventory Refresh'/u);
  assert.match(hub, /label: 'Media Processing'/u);
  assert.match(hub, /lastSyncJob\.reconciliationStatus === 'VERIFIED'/u);
});

test('Review Queue uses simple views while retaining exact search and bounded pagination', () => {
  for (const label of ['Ready', 'New', 'Updates', 'Issues', 'Waiting', 'History']) {
    assert.match(hub, new RegExp(`\['${label.toLowerCase() === 'ready' ? 'ready' : label.toLowerCase()}', '${label}'\]`));
  }
  assert.match(hub, /Search SKU, supplier ID or item code/u);
  assert.match(hub, /supplierReviewPageSize/u);
  assert.doesNotMatch(hub, />Load more products</u);
  assert.doesNotMatch(hub, /\.offset\(/u);
});

test('Compact review cards keep decisions safe and move diagnostics into secondary actions', () => {
  assert.match(hub, /compact\s*\n?\s*mediaForensics/u);
  assert.match(card, /compact\?: boolean/u);
  assert.match(card, /highLevelStatus/u);
  assert.match(card, />Review</u);
  assert.match(card, /View diagnostics/u);
  assert.match(card, /Remove from Review/u);
});

test('Operations retains pending-review maintenance and advanced diagnostics behind disclosure', () => {
  assert.match(hub, /activeSubTab === 'operations'/u);
  assert.match(hub, /aria-label="Refresh pending reviews"/u);
  assert.match(hub, /Technical operations/u);
  assert.match(hub, /showOperationsDiagnostics/u);
  assert.match(hub, /mode="advanced"/u);
});
