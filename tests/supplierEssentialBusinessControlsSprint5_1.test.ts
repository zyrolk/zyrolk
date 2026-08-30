import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { supplierBusinessErrorMessage } from '../src/services/supplierHubPresentation';

const projectFile = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Sprint 5.1 navigation restores Settings without exposing Advanced as a primary page', () => {
  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
  const navigation = hub.slice(hub.indexOf('{/* Business navigation */}'), hub.indexOf('{/* SUB-TAB CONTENTS */}'));
  for (const label of ['Suppliers', 'Product Review', 'Activity', 'Settings']) {
    assert.match(navigation, new RegExp(`label: '${label}'`));
  }
  assert.doesNotMatch(navigation, /label: 'Advanced'/);
  assert.match(hub, /Supplier Sync Settings/);
  assert.match(hub, /canAccessAdvanced && <section[\s\S]*Advanced Settings/);
});

test('supplier cards retain explicit initial sync and expose essential lifecycle controls', () => {
  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
  for (const control of [
    'Test Connection',
    'Save Supplier',
    'Run Initial Sync',
    'Go to Product Review',
    'Auto Sync',
    'Last Successful Sync',
    'Health',
    'Sync Now',
    'Edit',
    'Delete',
  ]) assert.match(hub, new RegExp(control));
  assert.match(hub, /startInitialSync: false/);
  assert.match(hub, /handleDeleteSupplier/);
  assert.match(hub, /action: 'disable'/);
  assert.match(hub, /historical records will be retained/);
});

test('launch review decisions are individual and have no bulk controls', () => {
  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
  const quickCard = projectFile('src/components/SupplierReviewQuickCard.tsx');
  assert.doesNotMatch(hub, /Bulk Approve/);
  assert.doesNotMatch(hub, /Bulk Reject/);
  assert.match(hub, /supplierReviewCanQuickApprove/);
  assert.match(quickCard, /View Details/);
});

test('Business Settings project only existing synchronization, pricing, and catalogue contracts', () => {
  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
  for (const setting of [
    'Global Auto Sync',
    'Default Auto Sync Behaviour',
    'Default Pricing Rule',
    'Default Markup Rate',
    'Category Mapping',
    'Brand Mapping',
    'Default Category',
    'Product Limits',
    'Image Limits',
    'Review Behaviour',
    'Approval Behaviour',
  ]) assert.match(hub, new RegExp(setting));
  assert.match(hub, /syncInterval: String\(supplierSettings\.syncInterval \|\| '1 Hour'\)/);
  assert.match(hub, /defaultSchedule = String\(supplierSettings\.syncInterval \|\| '1 Hour'\)/);
});

test('Advanced Settings expose existing operations only to owner and super-admin claims', () => {
  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
  for (const setting of [
    'Diagnostics',
    'Recovery',
    'Queue Information',
    'Scheduler Information',
    'Media Diagnostics',
    'System Status',
  ]) assert.match(hub, new RegExp(setting));
  assert.match(hub, /canAccessAdvanced && <section/);
  assert.match(hub, /mode="advanced"/);
});

test('raw security and transport errors are translated for business users', () => {
  assert.equal(
    supplierBusinessErrorMessage('AppCheck: Requests throttled due to previous 403 error'),
    'Your secure session could not be verified. Refresh the page and try again.',
  );
  assert.equal(
    supplierBusinessErrorMessage('Authentication required'),
    'Your admin session has expired. Sign in again and retry.',
  );
  assert.equal(
    supplierBusinessErrorMessage('Failed to fetch'),
    'Supplier Hub could not reach the service. Check your connection and retry.',
  );
  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
  const operations = projectFile('src/components/supplier-operations/SupplierOperationsDashboard.tsx');
  assert.match(hub, /supplierBusinessErrorMessage/);
  assert.match(hub, /reportClientIssue\('supplier-hub'/);
  assert.match(operations, /supplierBusinessErrorMessage/);
  assert.match(operations, /reportClientIssue\('supplier-operations'/);
});

test('Admin sidebar uses the production Suppliers label without legacy stars', () => {
  const dashboard = projectFile('src/components/AdminDashboard.tsx');
  assert.match(dashboard, /id: 'supplierHubFiveStars', label: 'Suppliers'/);
  assert.doesNotMatch(dashboard, /Supplier Hub ⭐/);
});
