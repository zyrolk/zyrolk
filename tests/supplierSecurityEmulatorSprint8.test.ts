import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

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
      'supplier_sync_locks', 'supplier_sync_jobs', 'supplier_sync_history', 'supplierSources',
      'supplier_approval_audit', 'supplier_product_conflicts', 'supplier_product_offers',
      'products', 'product_private', 'zyro_sku_claims', 'admin_product_audit',
      'contact_inquiries', 'contact_inquiry_limits',
    ]) {
      await assertFails(setDoc(doc(browserDb, collection, 'browser-write'), { queueState: 'approved' }));
    }
    await assertSucceeds(environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'supplier_review_queue', 'function-write'), { queueState: 'review_pending' });
      await setDoc(doc(context.firestore(), 'products', 'server-product'), { name: 'Public product', isActive: true });
      await setDoc(doc(context.firestore(), 'product_private', 'server-product'), { productId: 'server-product', sku: 'ZY-SERVER001' });
      await setDoc(doc(context.firestore(), 'zyro_sku_claims', 'server-claim'), { productId: 'server-product', sku: 'ZY-SERVER001' });
      await setDoc(doc(context.firestore(), 'admin_product_audit', 'server-audit'), { action: 'create', productId: 'server-product' });
    }));

    const anonymousDb = environment.unauthenticatedContext().firestore();
    const customerDb = environment.authenticatedContext('customer').firestore();
    await assertSucceeds(getDoc(doc(anonymousDb, 'products', 'server-product')));
    await assertSucceeds(getDoc(doc(browserDb, 'product_private', 'server-product')));
    await assertSucceeds(getDoc(doc(browserDb, 'admin_product_audit', 'server-audit')));
    await assertFails(getDoc(doc(customerDb, 'product_private', 'server-product')));
    await assertFails(getDoc(doc(customerDb, 'admin_product_audit', 'server-audit')));
    await assertFails(getDoc(doc(browserDb, 'zyro_sku_claims', 'server-claim')));
    await assertFails(updateDoc(doc(browserDb, 'products', 'server-product'), { name: 'Browser overwrite' }));
    await assertFails(deleteDoc(doc(browserDb, 'products', 'server-product')));
    await assertFails(updateDoc(doc(browserDb, 'product_private', 'server-product'), { sku: 'ZY-TAKEOVER01' }));
    await assertFails(deleteDoc(doc(browserDb, 'product_private', 'server-product')));
    await assertFails(updateDoc(doc(browserDb, 'admin_product_audit', 'server-audit'), { action: 'delete' }));
    await assertFails(deleteDoc(doc(browserDb, 'admin_product_audit', 'server-audit')));
  } finally {
    await environment.cleanup();
  }
});
