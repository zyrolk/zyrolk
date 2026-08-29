import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ApiError } from "../functions/src/api/errors";
import {
  resolveSupplierPortalSkuClaim,
  shouldReleaseSupplierPortalSkuClaim,
} from "../functions/src/api/suppliers/supplierPortalSkuClaims";

const supplierId = "supplier-a";
const productId = "zyro-product-a";

test("an approved canonical SKU claim permits only a same-supplier same-product edit", () => {
  const resolution = resolveSupplierPortalSkuClaim({
    claim: {
      supplierId,
      requestId: "original-approved-request",
      canonicalProductId: productId,
    },
    requestId: "later-change-request",
    requestType: "product_change",
    supplierId,
    canonicalProductId: productId,
  });
  assert.deepEqual(resolution, {
    requestId: "original-approved-request",
    canonicalProductId: productId,
  });

  for (const input of [
    { claim: { supplierId: "supplier-b", requestId: "approved", canonicalProductId: productId }, canonicalProductId: productId },
    { claim: { supplierId, requestId: "approved", canonicalProductId: "another-product" }, canonicalProductId: productId },
    { claim: { supplierId, requestId: "pending-request" }, canonicalProductId: productId },
  ]) {
    assert.throws(
      () => resolveSupplierPortalSkuClaim({
        ...input,
        requestId: "later-change-request",
        requestType: "product_change",
        supplierId,
      }),
      (error: unknown) => error instanceof ApiError && error.statusCode === 409,
    );
  }
});

test("a legacy approved request claim is resolved without a migration", () => {
  const resolution = resolveSupplierPortalSkuClaim({
    claim: { supplierId, requestId: "legacy-approved-request" },
    requestId: "later-change-request",
    requestType: "product_change",
    supplierId,
    canonicalProductId: productId,
    owningRequest: {
      id: "legacy-approved-request",
      data: { supplierId, status: "approved", productId },
    },
  });
  assert.deepEqual(resolution, {
    requestId: "legacy-approved-request",
    canonicalProductId: productId,
  });

  for (const data of [
    { supplierId, status: "pending", productId },
    { supplierId, status: "approved", productId: "another-product" },
    { supplierId: "supplier-b", status: "approved", productId },
  ]) {
    assert.throws(
      () => resolveSupplierPortalSkuClaim({
        claim: { supplierId, requestId: "legacy-approved-request" },
        requestId: "later-change-request",
        requestType: "product_change",
        supplierId,
        canonicalProductId: productId,
        owningRequest: { id: "legacy-approved-request", data },
      }),
      /Supplier SKU is already in use/u,
    );
  }
});

test("new-product claims retain their original duplicate protection", () => {
  assert.deepEqual(resolveSupplierPortalSkuClaim({
    claim: null,
    requestId: "new-request",
    requestType: "new_product",
    supplierId,
  }), { requestId: "new-request" });
  assert.deepEqual(resolveSupplierPortalSkuClaim({
    claim: { supplierId, requestId: "new-request" },
    requestId: "new-request",
    requestType: "new_product",
    supplierId,
  }), { requestId: "new-request" });
  assert.throws(() => resolveSupplierPortalSkuClaim({
    claim: { supplierId, requestId: "another-request" },
    requestId: "new-request",
    requestType: "new_product",
    supplierId,
  }), /Supplier SKU is already in use/u);
});

test("rejection releases only new-product claims and preserves durable edit ownership", () => {
  assert.equal(shouldReleaseSupplierPortalSkuClaim({ portalRequestType: "new_product" }, "rejected"), true);
  assert.equal(shouldReleaseSupplierPortalSkuClaim({ portalRequestType: "product_change" }, "rejected"), false);
  assert.equal(shouldReleaseSupplierPortalSkuClaim({ portalRequestType: "product_change" }, "deleted"), false);
  assert.equal(shouldReleaseSupplierPortalSkuClaim({ productFingerprintClaimId: "legacy-new-claim" }, "rejected"), true);
  assert.equal(shouldReleaseSupplierPortalSkuClaim({ comparisonStatus: "DESCRIPTION_CHANGED" }, "rejected"), false);
  assert.equal(shouldReleaseSupplierPortalSkuClaim({ portalRequestType: "new_product" }, "approved"), false);
});

test("Portal submit and approval integrate claim proof, canonical binding, and media lifecycle", () => {
  const portal = readFileSync("functions/src/api/routes/supplierPortal.ts", "utf8");
  const approval = readFileSync("functions/src/api/suppliers/supplierApproval.ts", "utf8");
  const submit = portal.slice(
    portal.indexOf('app.post("/api/supplier-portal/requests/:requestId/submit"'),
    portal.indexOf('app.post("/api/supplier-portal/products/:productId/stock-proposal"'),
  );
  assert.match(submit, /transaction\.get\(dependencies\.db\.collection\("supplier_product_requests"\)\.doc\(claimedRequestId\)\)/u);
  assert.match(submit, /resolveSupplierPortalSkuClaim/u);
  assert.match(submit, /portalRequestType: requestData\.requestType/u);
  assert.match(submit, /managedMediaRequired: true/u);
  assert.match(submit, /buildSupplierQueueLifecycle\(observedAt\)/u);
  assert.match(approval, /canonicalProductId: decidedProductId/u);
  assert.match(approval, /shouldReleaseSupplierPortalSkuClaim\(queueItem, action\)/u);
});
