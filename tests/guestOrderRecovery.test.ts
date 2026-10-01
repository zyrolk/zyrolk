import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearGuestOrderRecoveryToken,
  generateGuestOrderRecoveryToken,
  GUEST_ORDER_RECOVERY_STORAGE_KEY,
  isGuestOrderRecoveryToken,
  prepareGuestOrderRecoveryToken,
  promoteGuestOrderRecoveryToken,
  readGuestOrderRecoveryCandidates,
  readGuestOrderRecoveryToken,
} from '../src/features/orders/guestOrderRecovery';
import {
  fetchGuestOrderWithFallback,
  GUEST_ORDER_TRACKING_FAILURE,
} from '../src/features/orders/GuestOrderTrackingPage';
import { NetworkRequestError } from '../src/services/network/fetchJson';
import { buildStorefrontUrl, parseStorefrontRoute } from '../src/services/navigation/storefrontRoutes';
import { buildStorefrontSeo } from '../src/services/seo/storefrontSeo';
import {
  buildOrderPrivateDocument,
  type OrderPrivateAttributionLine,
} from '../functions/src/api/orders/orderPrivateAttribution';
import {
  GUEST_RECOVERY_GENERIC_ERROR,
  GuestOrderRecoveryError,
  hashGuestRecoveryToken,
  lookupGuestOrderByRecoveryToken,
  projectGuestOrderTracking,
} from '../functions/src/api/orders/guestOrderRecovery';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null { return this.values.get(key) || null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const token = (): string => {
  const generated = generateGuestOrderRecoveryToken();
  assert.ok(generated);
  assert.equal(generated.length, 43);
  assert.match(generated, /^[A-Za-z0-9_-]{43}$/u);
  return generated;
};

const privateLine: OrderPrivateAttributionLine = {
  lineId: 'line-internal-1',
  productId: 'product-1',
  zyroSku: 'ZY-1',
  fulfilmentMode: 'internal',
  supplierOfferId: null,
  supplierOfferStateVersion: null,
  supplierSourceId: null,
  supplierId: null,
  supplierAccountId: null,
  supplierProductId: null,
  supplierItemCode: null,
  purchaseSupplierCost: null,
  approvedOfferPrice: null,
  approvedOfferStockEvidence: null,
  capturedAt: '2026-10-01T00:00:00.000Z',
};

const publicOrder = {
  customerUid: 'guest',
  orderNumber: 'ZY100123',
  createdAt: '2026-10-01T00:00:00.000Z',
  status: 'confirmed',
  items: [{ productId: 'product-1', name: 'Safe Product', price: 1_500, quantity: 1, imageUrl: 'https://cdn.example.test/product.jpg' }],
  itemsSubtotal: 1_500,
  discountAmount: 0,
  deliveryFee: 350,
  totalPrice: 1_850,
};

function privateOrderData(recoveryToken: string) {
  return {
    ...buildOrderPrivateDocument('order-1', [privateLine], '2026-10-01T00:00:00.000Z'),
    guestRecovery: { version: 1 as const, tokenHash: hashGuestRecoveryToken(recoveryToken), issuedAt: '2026-10-01T00:00:00.000Z' },
  };
}

test('guest recovery token is cryptographically shaped, pending before retry, and never stores checkout PII', async () => {
  const storage = new MemoryStorage();
  const first = await prepareGuestOrderRecoveryToken('{"customerPhone":"0771234567"}', storage);
  assert.ok(first && isGuestOrderRecoveryToken(first));
  const retry = await prepareGuestOrderRecoveryToken('{"customerPhone":"0771234567"}', storage);
  assert.equal(retry, first);
  const stored = storage.getItem(GUEST_ORDER_RECOVERY_STORAGE_KEY) || '';
  assert.doesNotMatch(stored, /0771234567/u);
  assert.doesNotMatch(stored, /customerPhone/u);
  assert.equal(readGuestOrderRecoveryToken(storage), first);

  promoteGuestOrderRecoveryToken(first!, storage);
  assert.equal(readGuestOrderRecoveryToken(storage), first);
  const next = await prepareGuestOrderRecoveryToken('{"customerPhone":"0777654321"}', storage);
  assert.ok(next && next !== first);
  clearGuestOrderRecoveryToken(storage);
  assert.equal(readGuestOrderRecoveryToken(storage), null);
});

test('storage failure does not block secure token preparation and independent signatures receive new credentials', async () => {
  const failingStorage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  const first = await prepareGuestOrderRecoveryToken('attempt-one', failingStorage);
  const second = await prepareGuestOrderRecoveryToken('attempt-two', failingStorage);
  assert.ok(first && second);
  assert.notEqual(first, second);
});

test('recovery candidates keep pending first, preserve latest, and deduplicate identical tokens', async () => {
  const storage = new MemoryStorage();
  const first = await prepareGuestOrderRecoveryToken('order-a', storage);
  assert.ok(first);
  promoteGuestOrderRecoveryToken(first, storage);
  const pending = await prepareGuestOrderRecoveryToken('order-b', storage);
  assert.ok(pending && pending !== first);
  assert.deepEqual(readGuestOrderRecoveryCandidates(storage), [pending, first]);

  storage.setItem(GUEST_ORDER_RECOVERY_STORAGE_KEY, JSON.stringify({
    version: 1,
    pending: { token: first, fingerprint: 'same' },
    latestToken: first,
  }));
  assert.deepEqual(readGuestOrderRecoveryCandidates(storage), [first]);
});

test('successful pending recovery wins and does not query the latest fallback', async () => {
  const calls: string[] = [];
  const result = await fetchGuestOrderWithFallback(['pending-token', 'latest-token'], async tokenValue => {
    calls.push(tokenValue);
    return { orderNumber: 'B' } as never;
  });
  assert.equal(result.orderNumber, 'B');
  assert.deepEqual(calls, ['pending-token']);
});

test('generic pending credential failure falls back to the previous successful order', async () => {
  const calls: string[] = [];
  const result = await fetchGuestOrderWithFallback(['pending-token', 'latest-token'], async tokenValue => {
    calls.push(tokenValue);
    if (tokenValue === 'pending-token') {
      throw new NetworkRequestError(GUEST_ORDER_TRACKING_FAILURE, 'http', 401, { error: GUEST_ORDER_TRACKING_FAILURE });
    }
    return { orderNumber: 'A' } as never;
  });
  assert.equal(result.orderNumber, 'A');
  assert.deepEqual(calls, ['pending-token', 'latest-token']);
});

test('transient, rate-limit, App Check, and unexpected failures never fall back', async () => {
  const failures: unknown[] = [
    new NetworkRequestError('rate limited', 'http', 429, { error: 'Please wait' }),
    new NetworkRequestError('offline', 'network'),
    new NetworkRequestError('server failed', 'http', 500, { error: 'temporary' }),
    new NetworkRequestError('app check failed', 'http', 401, { error: 'App verification failed' }),
  ];
  for (const failure of failures) {
    const calls: string[] = [];
    await assert.rejects(() => fetchGuestOrderWithFallback(['pending-token', 'latest-token'], async tokenValue => {
      calls.push(tokenValue);
      throw failure;
    }), failure as Error);
    assert.deepEqual(calls, ['pending-token']);
  }
});

test('invalid pending storage is ignored so a valid latest token remains usable', () => {
  const storage = new MemoryStorage();
  storage.setItem(GUEST_ORDER_RECOVERY_STORAGE_KEY, JSON.stringify({
    version: 1,
    pending: { token: 'not-a-token', fingerprint: 'pending' },
    latestToken: token(),
  }));
  assert.equal(readGuestOrderRecoveryCandidates(storage).length, 1);
  assert.equal(readGuestOrderRecoveryCandidates(storage)[0].length, 43);
});

test('track-order route is canonical and intentionally noindex', () => {
  assert.deepEqual(parseStorefrontRoute('/track-order'), { page: 'track-order' });
  assert.equal(buildStorefrontUrl({ page: 'track-order' }), '/track-order');
  const seo = buildStorefrontSeo({ currentPage: 'track-order', origin: 'https://zyro.lk', isAdminMode: false });
  assert.equal(seo.robots, 'noindex, follow');
  assert.doesNotMatch(seo.title, /token|ZY100123/iu);
});

test('server stores only the digest and projects an allowlisted guest order', () => {
  const recoveryToken = token();
  const privateData = privateOrderData(recoveryToken);
  const projection = projectGuestOrderTracking('order-1', publicOrder, privateData);
  assert.deepEqual(Object.keys(projection).sort(), ['deliveryFee', 'discount', 'items', 'itemsSubtotal', 'orderNumber', 'placedAt', 'shipments', 'status', 'totalPrice']);
  assert.equal(projection.orderNumber, 'ZY100123');
  assert.deepEqual(Object.keys(projection.items[0]).sort(), ['imageUrl', 'lineTotal', 'name', 'quantity', 'unitPrice']);
  assert.equal((privateData.guestRecovery as { tokenHash: string }).tokenHash, hashGuestRecoveryToken(recoveryToken));
  assert.doesNotMatch(JSON.stringify(publicOrder), new RegExp(recoveryToken, 'u'));
  assert.doesNotMatch(JSON.stringify(privateData), new RegExp(recoveryToken, 'u'));
  assert.doesNotMatch(JSON.stringify(projection), /supplier|phone|email|address|private|productId|customerUid/iu);
});

test('guest tracking resolves one exact digest, rejects malformed/unknown tokens generically, and fails closed on duplicates', async () => {
  const recoveryToken = token();
  const privateData = privateOrderData(recoveryToken);
  const orderSnapshot = { exists: true, data: () => publicOrder };
  const makeDb = (documents: Array<{ id: string; data: () => Record<string, unknown> }>) => ({
    collection(name: string) {
      if (name === 'order_private') {
        return { where: () => ({ limit: () => ({ get: async () => ({ size: documents.length, docs: documents }) }) }) };
      }
      return { doc: (id: string) => ({ get: async () => id === 'order-1' ? orderSnapshot : { exists: false, data: () => undefined } }) };
    },
  }) as unknown as FirebaseFirestore.Firestore;

  const resolved = await lookupGuestOrderByRecoveryToken(makeDb([{ id: 'order-1', data: () => privateData }]), recoveryToken);
  assert.equal(resolved.orderNumber, 'ZY100123');
  await assert.rejects(() => lookupGuestOrderByRecoveryToken(makeDb([]), recoveryToken), (error: unknown) => {
    assert.ok(error instanceof GuestOrderRecoveryError);
    assert.equal((error as GuestOrderRecoveryError).publicMessage, GUEST_RECOVERY_GENERIC_ERROR);
    return true;
  });
  await assert.rejects(() => lookupGuestOrderByRecoveryToken(makeDb([{ id: 'order-1', data: () => privateData }]), 'bad'), GuestOrderRecoveryError);
  await assert.rejects(() => lookupGuestOrderByRecoveryToken(makeDb([
    { id: 'order-1', data: () => privateData },
    { id: 'order-2', data: () => privateData },
  ]), recoveryToken), GuestOrderRecoveryError);
});

test('non-guest orders cannot be recovered through the guest projection', () => {
  const recoveryToken = token();
  assert.throws(() => projectGuestOrderTracking('order-1', { ...publicOrder, customerUid: 'customer-1' }, privateOrderData(recoveryToken)), GuestOrderRecoveryError);
});
