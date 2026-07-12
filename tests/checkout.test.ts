import assert from "node:assert/strict";
import test from "node:test";
import {
  CheckoutError,
  calculateCheckoutTotals,
  createCheckoutRateLimiter,
  createCheckoutRequestHash,
  getIdempotencyKeyFromValues,
  resolveCheckoutIdempotency,
  validateCheckoutCartItems,
  validateCheckoutDetails,
} from "../functions/src/api/checkout/checkoutLogic";

test("checkout cart validation accepts normalized valid cart items", () => {
  assert.deepEqual(validateCheckoutCartItems([
    { productId: "  laptop-1 ", quantity: 2 },
  ]), [
    { productId: "laptop-1", quantity: 2 },
  ]);
});

test("checkout cart validation rejects empty carts and invalid quantities", () => {
  assert.throws(() => validateCheckoutCartItems([]), /Cart items are required/);
  assert.throws(() => validateCheckoutCartItems([{ productId: "p1", quantity: 0 }]), /quantity between/);
  assert.throws(() => validateCheckoutCartItems([{ productId: "", quantity: 1 }]), /missing a valid product ID/);
});

test("checkout consolidates duplicate product IDs before stock calculation", () => {
  assert.deepEqual(validateCheckoutCartItems([
    { productId: "p1", quantity: 2 },
    { productId: "p1", quantity: 3 },
    { productId: "p2", quantity: 1 },
  ]), [
    { productId: "p1", quantity: 5 },
    { productId: "p2", quantity: 1 },
  ]);
  assert.throws(() => validateCheckoutCartItems([
    { productId: "p1", quantity: 60 },
    { productId: "p1", quantity: 40 },
  ]), /Combined quantity/);
});

test("checkout totals calculation preserves delivery and free delivery behavior", () => {
  assert.deepEqual(calculateCheckoutTotals(4000, "Colombo", null), {
    itemsSubtotal: 4000,
    deliveryFee: 350,
    grandTotalPrice: 4350,
    freeDeliveryThreshold: 5000,
    baseDeliveryCharge: 350,
  });

  assert.equal(calculateCheckoutTotals(5000, "Colombo", null).deliveryFee, 0);
  assert.equal(calculateCheckoutTotals(2500, "Unknown", { deliveryCharge: 700, freeDeliveryMin: 3000 }).grandTotalPrice, 3200);
});

test("checkout idempotency returns original successful order for repeated matching requests", () => {
  const cartItems = validateCheckoutCartItems([{ productId: "p1", quantity: 1 }]);
  const body = {
    customerUid: "guest",
    customerName: "Test Customer",
    customerPhone: "0771234567",
    customerAddress: "No 1, Main Street",
    district: "Colombo",
    paymentMethod: "cod",
    cartItems,
  };
  const requestHash = createCheckoutRequestHash(body, cartItems);
  const order = { id: "order-1", orderNumber: "ZY100001" };

  assert.equal(getIdempotencyKeyFromValues(" key-1 ", undefined), "key-1");
  assert.deepEqual(resolveCheckoutIdempotency({ requestHash, status: "succeeded", order }, requestHash), {
    action: "return-order",
    order,
  });
});

test("checkout idempotency rejects key reuse with a different request", () => {
  assert.throws(
    () => resolveCheckoutIdempotency({ requestHash: "old", status: "succeeded", order: { id: "o1" } }, "new"),
    (error) => error instanceof CheckoutError && error.statusCode === 409,
  );
});

test("checkout rate limiter blocks rapid abuse and resets after the window", () => {
  const limiter = createCheckoutRateLimiter(new Map(), 1000, 2);

  limiter("customer-ip", 1000);
  limiter("customer-ip", 1100);
  assert.throws(
    () => limiter("customer-ip", 1200),
    (error) => error instanceof CheckoutError && error.statusCode === 429,
  );

  assert.doesNotThrow(() => limiter("customer-ip", 2101));
});

test("checkout request validation returns clear validation errors", () => {
  assert.throws(() => validateCheckoutDetails({
    customerName: "",
    customerPhone: "0771234567",
    customerAddress: "No 1",
    district: "Colombo",
    paymentMethod: "cod",
  }), /Customer name is required/);

  assert.throws(() => validateCheckoutDetails({
    customerName: "Test Customer",
    customerPhone: "123",
    customerAddress: "No 1",
    district: "Colombo",
    paymentMethod: "card",
  }), /Payment method must be cod or whatsapp_confirm/);
});
