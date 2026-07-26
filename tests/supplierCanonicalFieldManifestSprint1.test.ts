import assert from 'node:assert/strict';
import test from 'node:test';
import { ProductParser } from '../functions/src/api/suppliers/a2z/ProductParser';
import type { RawA2ZProduct } from '../functions/src/api/suppliers/a2z/types';
import {
  CanonicalSupplierFieldId,
  CanonicalSupplierFieldDefinition,
  SUPPLIER_FIELD_MANIFEST,
} from '../functions/src/api/suppliers/supplierFieldManifest';
import {
  buildSupplierProductComparison,
  detectSupplierProductFieldChanges,
  mergeSupplierCatalogDetails,
  mergeSupplierProductMetadata,
  SupplierFieldChange,
} from '../functions/src/api/suppliers/supplierProductImport';
import { buildSupplierAuditEvent } from '../functions/src/api/suppliers/supplierAuditTrail';
import { filterSupplierComparison } from '../functions/src/scheduled/supplierSyncSettings';
import { buildSupplierReviewFieldChanges } from '../src/services/supplierReviewEditor';

const manifest: readonly CanonicalSupplierFieldDefinition[] = SUPPLIER_FIELD_MANIFEST;
type DirectRawSupplierField = Exclude<keyof RawA2ZProduct, 'providedFields' | 'wholesalePrice' | 'recommendedRetailPrice' | 'inventoryLevel'>;
type MissingRawSupplierField = Exclude<DirectRawSupplierField, CanonicalSupplierFieldId>;
const rawSupplierFieldCoverage: [MissingRawSupplierField] extends [never] ? true : false = true;

const sampleValue = (field: CanonicalSupplierFieldDefinition): unknown => {
  switch (field.validation) {
    case 'required_text':
    case 'optional_text': return `${field.id}-value`;
    case 'non_negative_number':
    case 'optional_number': return 7;
    case 'boolean_or_text': return false;
    case 'http_url_list': return [`https://supplier.example/${field.id}.jpg`];
    case 'string_list': return [`${field.id}-one`, `${field.id}-two`];
    case 'record': return { key: `${field.id}-value` };
    case 'array': return [{ id: `${field.id}-entry`, value: 1 }];
    case 'iso_date': return '2026-07-26T10:00:00.000Z';
    case 'any': return { value: `${field.id}-value`, unit: 'unit' };
  }
};

const rawForField = (field: CanonicalSupplierFieldDefinition): Record<string, unknown> => ({
  sku: field.id === 'sku' ? sampleValue(field) : 'MANIFEST-SKU',
  title: field.id === 'title' ? sampleValue(field) : 'Manifest Product',
  [field.sourceFields[0]]: sampleValue(field),
});

const parsedForField = (field: CanonicalSupplierFieldDefinition): RawA2ZProduct => (
  ProductParser.parseJsonPayload(rawForField(field), 'https://supplier.example')
);

const changeForField = (field: CanonicalSupplierFieldDefinition): SupplierFieldChange => {
  const change = detectSupplierProductFieldChanges(parsedForField(field), {})
    .find((candidate) => candidate.field === field.id);
  assert.ok(change, `Expected ${field.id} to produce a canonical field change.`);
  return change;
};

test('Sprint 1 canonical manifest defines every supported supplier field exactly once', () => {
  assert.equal(rawSupplierFieldCoverage, true);
  assert.ok(manifest.length >= 45);
  assert.equal(new Set(manifest.map((field) => field.id)).size, manifest.length);
  assert.equal(new Set(manifest.map((field) => field.audit.key)).size, manifest.length);
  for (const field of manifest) {
    assert.ok(field.sourceFields.length > 0, `${field.id}: source fields`);
    assert.ok(field.normalizedField, `${field.id}: normalized field`);
    assert.ok(field.validation, `${field.id}: validation`);
    assert.ok(field.comparison, `${field.id}: comparison`);
    assert.ok(field.emptyBehavior, `${field.id}: empty behavior`);
    assert.equal(typeof field.adminEditable, 'boolean', `${field.id}: admin editable`);
    assert.ok(field.destinations.length > 0, `${field.id}: destinations`);
    assert.ok(field.destinations.every((destination) => destination.scope && destination.path && destination.ownership && destination.publication));
    assert.ok(field.audit.key && field.audit.label && field.audit.representation, `${field.id}: audit`);
  }
  assert.equal(manifest.some((field) => field.id === 'providedFields'), false, 'providedFields is system normalization metadata, not supplier commerce data');
});

test('Sprint 1 parser normalizes and records presence for every manifest field', () => {
  for (const field of manifest) {
    const parsed = parsedForField(field);
    assert.ok(parsed.providedFields?.includes(field.presenceField || field.id), `${field.id}: presence metadata`);
    const normalized = parsed[field.normalizedField];
    assert.notEqual(normalized, undefined, `${field.id}: normalized value`);
    if (field.id !== 'visibility') assert.notEqual(normalized, null, `${field.id}: normalized null`);
  }
});

test('Sprint 1 every declared connector source alias reaches its canonical normalized field', () => {
  for (const field of manifest) {
    for (const sourceField of field.sourceFields) {
      const raw: Record<string, unknown> = { sku: 'ALIAS-SKU', title: 'Alias Product' };
      if (field.id === 'sku') delete raw.sku;
      if (field.id === 'title') delete raw.title;
      raw[sourceField] = sampleValue(field);
      const parsed = ProductParser.parseJsonPayload(raw, 'https://supplier.example');
      assert.ok(parsed.providedFields?.includes(field.presenceField || field.id), `${field.id}/${sourceField}: presence`);
      assert.notEqual(parsed[field.normalizedField], undefined, `${field.id}/${sourceField}: normalized`);
    }
  }
});

test('Sprint 1 every supported field produces a structured before/after review change', () => {
  for (const field of manifest) {
    const change = changeForField(field);
    const comparison = buildSupplierProductComparison(parsedForField(field), {});
    assert.ok(comparison.fieldChanges.some((candidate) => candidate.field === field.id), `${field.id}: review comparison`);
    assert.notEqual(comparison.status, 'UNCHANGED', `${field.id}: queue status`);
    assert.equal(change.field, field.id);
    assert.equal(change.auditKey, field.audit.key);
    assert.equal(change.auditRepresentation, field.audit.representation);
    assert.equal(change.syncGroup, field.syncGroup);
    assert.equal(change.emptyBehavior, field.emptyBehavior);
    assert.equal(change.adminEditable, field.adminEditable);
    assert.deepEqual(change.destinations, field.destinations);
    assert.equal(change.before, null);
    assert.notEqual(change.after, undefined);
    assert.equal(change.changeType, 'added');
  }
});

test('Sprint 1 canonical empty behavior distinguishes sparse preservation from invalid required removal', () => {
  const sparseOptional = ProductParser.parseJsonPayload({ sku: 'SPARSE-1', title: 'Sparse', shortDescription: '' });
  const optionalChanges = detectSupplierProductFieldChanges(sparseOptional, {
    supplierMetadata: { sku: 'SPARSE-1', title: 'Sparse', shortDescription: 'Keep this value' },
  });
  assert.equal(optionalChanges.some((change) => change.field === 'shortDescription'), false);

  const invalidRequired = ProductParser.parseJsonPayload({ sku: 'SPARSE-1', title: '' });
  const requiredChange = detectSupplierProductFieldChanges(invalidRequired, {
    supplierMetadata: { sku: 'SPARSE-1', title: 'Existing product name' },
  }).find((change) => change.field === 'title');
  assert.equal(requiredChange?.changeType, 'invalid_removal');
  assert.equal(requiredChange?.after, null);
});

test('Sprint 1 every field is routed through its explicit sync group without unknown-field fallthrough', () => {
  for (const field of manifest) {
    const change = changeForField(field);
    const comparison = { status: 'DESCRIPTION_CHANGED' as const, changedFields: [change.label], fieldChanges: [change] };
    const enabled = filterSupplierComparison(comparison, {});
    assert.ok(enabled, `${field.id}: enabled comparison`);
    assert.equal(enabled?.fieldChanges?.[0]?.field, field.id);

    const disabledSettings = field.syncGroup === 'pricing'
      ? { syncPriceUpdates: false }
      : field.syncGroup === 'inventory'
        ? { syncStockUpdates: false }
        : field.syncGroup === 'media'
          ? { syncImageUpdates: false }
          : { syncDescriptionUpdates: false };
    assert.equal(filterSupplierComparison(comparison, disabledSettings), null, `${field.id}: explicit group opt-out`);
  }
});

test('Sprint 1 manifest drives public catalog and private supplier metadata projection', () => {
  for (const field of manifest) {
    const parsed = parsedForField(field);
    const accepted = new Set([field.id]);
    if (field.catalogField) {
      const catalog = mergeSupplierCatalogDetails(parsed, {}, accepted);
      assert.equal(Object.hasOwn(catalog, field.catalogField), true, `${field.id}: public catalog projection`);
    }
    if (field.metadataField) {
      const metadata = mergeSupplierProductMetadata(parsed, {}, accepted);
      assert.equal(Object.hasOwn(metadata, field.metadataField), true, `${field.id}: private metadata projection`);
    }
  }
});

test('Sprint 1 audit and Admin Review retain every structured supplier field change', () => {
  const fieldChanges = manifest.map(changeForField);
  const queueItem = {
    id: 'manifest-queue',
    sourceId: 'source-1',
    supplierId: 'supplier-1',
    productPayload: { id: 'product-1' },
    comparison: { comparisonStatus: 'NEW_PRODUCT', changedFields: fieldChanges.map((change) => change.label), fieldChanges },
  };
  const event = buildSupplierAuditEvent({
    queueItemId: 'manifest-queue', queueItem, action: 'queued', previousState: null, newState: 'queued', now: 1_000,
  }, 'manifest-event');
  const audited = event.supplierFieldChanges as SupplierFieldChange[];
  assert.equal(audited.length, manifest.length);
  const auditChanges = event.changedFields as Record<string, { before: unknown; after: unknown }>;
  for (const field of manifest) {
    assert.ok(audited.some((change) => change.field === field.id), `${field.id}: immutable audit detail`);
    assert.ok(Object.hasOwn(auditChanges, field.audit.key), `${field.id}: audit change key`);
  }

  const reviewChanges = buildSupplierReviewFieldChanges({
    id: 'manifest-queue', productName: 'Manifest Product', supplierCode: 'MANIFEST-SKU', costPrice: 1, marketPrice: 2, stock: 3,
    comparison: { fieldChanges },
  });
  assert.equal(reviewChanges.length, manifest.length);
});
