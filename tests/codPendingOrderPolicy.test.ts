import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_COD_PENDING_ORDER_TTL_MS,
  MIN_COD_PENDING_ORDER_TTL_MS,
  resolveCodPendingOrderTtlMs,
  resolveCodReservationExpiresAt,
} from '../functions/src/api/checkout/codPendingOrderPolicy';
import { expireReservation } from '../functions/src/scheduled/paymentReservations';

const ONE_HOUR_MS = 60 * 60 * 1000;
const originalDateNow = Date.now;

const withFrozenNow = async <T>(now: number, run: () => Promise<T>): Promise<T> => {
  Date.now = () => now;
  try {
    return await run();
  } finally {
    Date.now = originalDateNow;
  }
};

test('A new COD order uses the configured/default TTL and not a one-hour deadline', () => {
  assert.equal(resolveCodPendingOrderTtlMs(null), DEFAULT_COD_PENDING_ORDER_TTL_MS);
  assert.notEqual(resolveCodPendingOrderTtlMs(null), ONE_HOUR_MS);

  const checkout = readFileSync('functions/src/api/routes/checkout.ts', 'utf8');
  assert.match(checkout, /resolveCodReservationExpiresAt\(Date\.now\(\), settings\)/);
  assert.doesNotMatch(checkout, /Date\.now\(\) \+ COD_CONFIRMATION_WINDOW_MS/);

  const configured = resolveCodReservationExpiresAt(Date.UTC(2026, 7, 28, 18, 0), { codPendingOrderTtlHours: 36 });
  assert.equal(configured.getTime() - Date.UTC(2026, 7, 28, 18, 0), 36 * ONE_HOUR_MS);
});

test('B pending COD orders remain pending with reserved stock before expiry', async () => {
  const now = Date.UTC(2026, 7, 28, 20, 0);
  await withFrozenNow(now, async () => {
    const fixture = createExpiryFixture({
      expiresAt: new Date(now + DEFAULT_COD_PENDING_ORDER_TTL_MS),
      productStock: 4,
      quantity: 2,
    });
    assert.equal(await expireReservation(fixture.orderRef as never, fixture.db), false);
    const order = await fixture.orderRef.get();
    const product = await fixture.productRef.get();
    assert.equal(order.data()?.status, 'pending');
    assert.equal(order.data()?.stockReservationStatus, 'reserved');
    assert.equal(product.data()?.stock, 4);
  });
});

test('C overdue pending COD orders cancel once and restore stock exactly once', async () => {
  const now = Date.UTC(2026, 7, 29, 21, 0);
  await withFrozenNow(now, async () => {
    const fixture = createExpiryFixture({
      expiresAt: new Date(now - 5 * 60 * 1000),
      productStock: 4,
      quantity: 2,
    });
    assert.equal(await expireReservation(fixture.orderRef as never, fixture.db), true);
    const order = await fixture.orderRef.get();
    const product = await fixture.productRef.get();
    assert.equal(order.data()?.status, 'cancelled');
    assert.equal(order.data()?.stockReservationStatus, 'released');
    assert.equal(order.data()?.stockRestorationApplied, true);
    assert.equal(product.data()?.stock, 6);
  });
});

test('D confirmed COD orders are not cancelled by the reservation scheduler', async () => {
  const now = Date.UTC(2026, 7, 29, 21, 0);
  await withFrozenNow(now, async () => {
    const fixture = createExpiryFixture({
      expiresAt: new Date(now - 5 * 60 * 1000),
      status: 'confirmed',
      stockReservationStatus: 'committed',
      productStock: 4,
      quantity: 2,
    });
    assert.equal(await expireReservation(fixture.orderRef as never, fixture.db), false);
    const order = await fixture.orderRef.get();
    const product = await fixture.productRef.get();
    assert.equal(order.data()?.status, 'confirmed');
    assert.equal(order.data()?.stockReservationStatus, 'committed');
    assert.equal(product.data()?.stock, 4);
  });
});

test('E repeated scheduler passes remain idempotent after expiry', async () => {
  const now = Date.UTC(2026, 7, 29, 21, 0);
  await withFrozenNow(now, async () => {
    const fixture = createExpiryFixture({
      expiresAt: new Date(now - 5 * 60 * 1000),
      productStock: 3,
      quantity: 1,
    });
    assert.equal(await expireReservation(fixture.orderRef as never, fixture.db), true);
    assert.equal(await expireReservation(fixture.orderRef as never, fixture.db), false);
    const product = await fixture.productRef.get();
    assert.equal(product.data()?.stock, 4);
    assert.equal(await expireReservation(fixture.orderRef as never, fixture.db), false);
    assert.equal(product.data()?.stock, 4);
  });
});

test('F closed-hours COD orders remain valid into the next business period', () => {
  const closedAt = Date.UTC(2026, 7, 28, 19, 30);
  const expiresAt = resolveCodReservationExpiresAt(closedAt, null);
  const nextBusinessMorning = Date.UTC(2026, 7, 29, 3, 30);
  assert.ok(expiresAt.getTime() > nextBusinessMorning);
  assert.equal(expiresAt.getTime() - closedAt, DEFAULT_COD_PENDING_ORDER_TTL_MS);
});

test('G invalid or missing configuration falls back to the safe 24-hour default', () => {
  for (const settings of [null, undefined, {}, { codPendingOrderTtlHours: null }, { codPendingOrderTtlHours: '' }, { codPendingOrderTtlHours: 0 }, { codPendingOrderTtlHours: -4 }, { codPendingOrderTtlHours: 'bad' }, { codPendingOrderTtlHours: 1 }]) {
    assert.equal(resolveCodPendingOrderTtlMs(settings as Record<string, unknown> | null | undefined), DEFAULT_COD_PENDING_ORDER_TTL_MS);
  }
  assert.equal(resolveCodPendingOrderTtlMs({ codPendingOrderTtlHours: 48 }), 48 * ONE_HOUR_MS);
  assert.ok(MIN_COD_PENDING_ORDER_TTL_MS > ONE_HOUR_MS);
});

test('H legacy orders keep their persisted expiry timestamp for scheduler eligibility', async () => {
  const legacyExpiry = new Date(Date.UTC(2026, 7, 27, 10, 0));
  const now = Date.UTC(2026, 7, 27, 11, 0);
  await withFrozenNow(now, async () => {
    const fixture = createExpiryFixture({
      expiresAt: legacyExpiry,
      productStock: 5,
      quantity: 1,
    });
    assert.equal(await expireReservation(fixture.orderRef as never, fixture.db), true);
    const order = await fixture.orderRef.get();
    assert.equal(order.data()?.reservationExpiredReason, 'cod_confirmation_expired');
  });
});

test('storefront closed-hours copy remains consistent with next-business-period handling', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  assert.match(app, /Orders remain available and will be processed during the next business period\./);
  assert.equal(DEFAULT_COD_PENDING_ORDER_TTL_MS, 24 * ONE_HOUR_MS);
});

type ExpiryFixtureOptions = {
  expiresAt: Date;
  productStock: number;
  quantity: number;
  status?: string;
  stockReservationStatus?: string;
};

type MockReference = {
  key: string;
  collectionName: string;
  id: string;
  get: () => Promise<MockSnapshot>;
};

type MockSnapshot = {
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
};

function createExpiryFixture(options: ExpiryFixtureOptions) {
  const documents = new Map<string, Record<string, unknown>>();
  const productId = 'cod-policy-product';
  const orderId = 'cod-policy-order';
  const productRef = mockReference('products', productId, documents);
  const orderRef = mockReference('orders', orderId, documents);

  documents.set(productRef.key, {
    id: productId,
    name: 'COD policy product',
    price: 1_000,
    stock: options.productStock,
    isActive: true,
  });
  documents.set(orderRef.key, {
    orderNumber: 'ZY900001',
    status: options.status || 'pending',
    paymentMethod: 'cod',
    paymentStatus: 'not_required',
    stockDeducted: true,
    stockReservationStatus: options.stockReservationStatus || 'reserved',
    stockReservationExpiresAt: options.expiresAt,
    stockRestorationApplied: false,
    items: [{ productId, name: 'COD policy product', price: 1_000, quantity: options.quantity }],
  });

  const db = {
    collection: (name: string) => ({
      doc: (id: string) => mockReference(name, id, documents),
    }),
    runTransaction: async <T>(callback: (transaction: {
      get: (reference: MockReference) => Promise<MockSnapshot>;
      update: (reference: MockReference, patch: Record<string, unknown>) => void;
      set: (reference: MockReference, data: Record<string, unknown>, options?: { merge?: boolean }) => void;
    }) => Promise<T>): Promise<T> => {
      const transaction = {
        get: async (reference: MockReference) => mockSnapshot(reference.key, documents.get(reference.key)),
        update: (reference: MockReference, patch: Record<string, unknown>) => {
          documents.set(reference.key, { ...(documents.get(reference.key) || {}), ...patch });
        },
        set: (reference: MockReference, data: Record<string, unknown>, options?: { merge?: boolean }) => {
          documents.set(reference.key, options?.merge ? { ...(documents.get(reference.key) || {}), ...data } : data);
        },
      };
      return callback(transaction);
    },
  };

  return { db: db as never, orderRef, productRef };
}

function mockReference(
  collectionName: string,
  id: string,
  documents: Map<string, Record<string, unknown>>,
): MockReference {
  const key = `${collectionName}/${id}`;
  return {
    key,
    collectionName,
    id,
    get: async () => mockSnapshot(key, documents.get(key)),
  };
}

function mockSnapshot(key: string, data: Record<string, unknown> | undefined): MockSnapshot {
  void key;
  return {
    exists: data !== undefined,
    data: () => data,
  };
}
