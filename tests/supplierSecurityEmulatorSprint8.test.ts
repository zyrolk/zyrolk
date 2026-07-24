import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const [host, portValue] = (emulator || '').split(':');
const port = Number(portValue);
const canRun = Boolean(host && Number.isInteger(port) && port > 0);

test('Firestore Emulator denies all Supplier Hub browser writes while trusted server writes remain available', {
  skip: canRun ? undefined : 'Set FIRESTORE_EMULATOR_HOST and start the Firestore Emulator to run rules integration coverage.',
}, async () => {
  const environment = await initializeTestEnvironment({
    projectId: 'zyro-supplier-security-test',
    firestore: { host, port, rules: readFileSync('firestore.rules', 'utf8') },
  });
  try {
    const adminContext = environment.authenticatedContext('supplier-admin', { admin: true });
    const browserDb = adminContext.firestore();
    for (const collection of [
      'supplier_review_queue', 'supplier_import_queue', 'supplier_pending_changes',
      'supplier_sync_locks', 'supplier_sync_history', 'supplierSources',
      'supplier_approval_audit', 'supplier_product_conflicts',
    ]) {
      await assertFails(setDoc(doc(browserDb, collection, 'browser-write'), { queueState: 'approved' }));
    }
    await assertSucceeds(environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'supplier_review_queue', 'function-write'), { queueState: 'review_pending' });
    }));
  } finally {
    await environment.cleanup();
  }
});
