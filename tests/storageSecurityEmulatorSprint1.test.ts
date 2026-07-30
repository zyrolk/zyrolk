import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { ref, uploadBytes } from 'firebase/storage';

const emulator = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
const [host, portValue] = (emulator || '').split(':');
const port = Number(portValue);
const canRun = Boolean(host && Number.isInteger(port) && port > 0);
const image = new Blob(['safe-image-test'], { type: 'image/png' });

test('Storage Emulator enforces claims for managed media writes', {
  skip: canRun ? undefined : 'Set FIREBASE_STORAGE_EMULATOR_HOST and start the Storage Emulator to run rules integration coverage.',
}, async () => {
  const environment = await initializeTestEnvironment({
    projectId: 'zyro-storage-security-test',
    storage: { host, port, rules: readFileSync('storage.rules', 'utf8') },
  });
  try {
    const customerStorage = environment.authenticatedContext('customer', { role: 'customer' }).storage();
    const adminStorage = environment.authenticatedContext('admin', { admin: true }).storage();
    await assertFails(uploadBytes(ref(customerStorage, 'banners/customer.png'), image));
    await assertSucceeds(uploadBytes(ref(adminStorage, 'banners/admin.png'), image));
    await assertFails(uploadBytes(ref(adminStorage, 'supplier-media/s1/p1/a1/original/image.png'), image));
  } finally {
    await environment.cleanup();
  }
});
