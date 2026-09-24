import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertNewSupplierPublicationStock,
} from "../functions/src/api/suppliers/supplierApproval";
import {
  isLowStockHoldForNewSupplierProduct,
  LOW_SUPPLIER_STOCK_FOR_PUBLICATION_CODE,
  LOW_SUPPLIER_STOCK_FOR_PUBLICATION_MESSAGE,
  lowSupplierStockValidationError,
} from "../functions/src/api/suppliers/supplierLowStockPolicy";
import { shouldDeferNewSupplierProductForZeroStock } from "../functions/src/scheduled/supplierSync";
import {
  projectSupplierReviewLowStockHold,
  reviewRecordMatchesBusinessFilter,
  supplierReviewRecordIsLowStockHold,
} from "../functions/src/scheduled/supplierReviewQueue";
import { validateSupplierProductForApproval } from "../functions/src/api/suppliers/supplierProductMapping";
import {
  matchesProductReviewFilter,
  supplierReviewIsLowStockHold,
  supplierReviewStatusLabel,
} from "../src/services/supplierHubPresentation";

const category = { id: "electronics", name: "Electronics", isActive: true };

const queueRecord = (stock: unknown, stockKnown = true) => ({
  id: "dropex-shx2196",
  sourceId: "dropex",
  status: "Pending",
  queueState: "review_pending",
  comparisonStatus: "NEW_PRODUCT",
  comparison: { comparisonStatus: "NEW_PRODUCT", matchedProductId: null },
  approvalBaseline: { exists: false },
  stock,
  productPayload: {
    stock,
    supplierMetadata: { supplierStockAvailable: stockKnown },
  },
  supplierSnapshot: { providedFields: stockKnown ? ["stock"] : [] },
  productValidation: { readyToPublish: true, missingFields: [], errors: [] },
});

test("new supplier stock 0 through 3 is a visible low-stock hold", () => {
  for (const stock of [0, 1, 2, 3]) {
    const record = projectSupplierReviewLowStockHold(queueRecord(stock));
    const validation = record.productValidation as Record<string, any>;
    assert.equal(supplierReviewRecordIsLowStockHold(record), true);
    assert.equal(validation.lowStockHold, true);
    assert.equal(validation.readyToPublish, false);
    assert.deepEqual(validation.errors, [lowSupplierStockValidationError()]);
    assert.equal(reviewRecordMatchesBusinessFilter(record, "needs_attention"), true);
    assert.equal(matchesProductReviewFilter(record, "needs_attention"), true);
    assert.equal(supplierReviewIsLowStockHold(record), true);
    assert.equal(supplierReviewStatusLabel(record), "Low Stock Hold");
  }
});

test("new supplier stock 4 clears the hold without changing the queue identity", () => {
  assert.equal(isLowStockHoldForNewSupplierProduct({ isNewUnpublished: true, supplierSourceId: "dropex", stock: 4, stockKnown: true }), false);
  const record = projectSupplierReviewLowStockHold(queueRecord(1));
  const recovered = projectSupplierReviewLowStockHold({
    ...record,
    stock: 8,
    productPayload: { ...record.productPayload, stock: 8 },
    supplierSnapshot: { providedFields: ["stock"] },
    productValidation: {
      ...record.productValidation,
      lowStockHold: true,
      readyToPublish: false,
    },
  });
  const recoveredValidation = recovered.productValidation as Record<string, any>;
  assert.equal(recovered.id, "dropex-shx2196");
  assert.equal(recoveredValidation.lowStockHold, false);
  assert.equal(recoveredValidation.readyToPublish, true);
  assert.deepEqual(recoveredValidation.errors, []);
  assert.equal(reviewRecordMatchesBusinessFilter(recovered, "needs_attention"), false);
});

test("unknown, invalid, and fractional stock preserve existing validation semantics", () => {
  assert.equal(isLowStockHoldForNewSupplierProduct({ isNewUnpublished: true, supplierSourceId: "dropex", stock: 0, stockKnown: false }), false);
  assert.equal(isLowStockHoldForNewSupplierProduct({ isNewUnpublished: true, supplierSourceId: "dropex", stock: -1, stockKnown: true }), false);
  assert.equal(isLowStockHoldForNewSupplierProduct({ isNewUnpublished: true, supplierSourceId: "dropex", stock: 1.5, stockKnown: true }), false);
  const unknown = projectSupplierReviewLowStockHold({
    ...queueRecord(0, false),
    productValidation: {
      readyToPublish: false,
      missingFields: ["stock"],
      errors: [{ field: "stock", code: "missing_stock", message: "Supplier inventory was not provided." }],
    },
  });
  const unknownValidation = unknown.productValidation as Record<string, any>;
  assert.equal(unknownValidation.lowStockHold, false);
  assert.equal(unknownValidation.errors[0].code, "missing_stock");
});

test("live approved products are outside the low-stock publication hold", () => {
  assert.equal(isLowStockHoldForNewSupplierProduct({ isNewUnpublished: false, supplierSourceId: "dropex", stock: 0, stockKnown: true }), false);
  assert.equal(isLowStockHoldForNewSupplierProduct({ isNewUnpublished: true, supplierSourceId: "a2z", stock: 1, stockKnown: true }), false);
  assert.equal(shouldDeferNewSupplierProductForZeroStock({ inventoryLevel: 0, providedFields: ["stock"] }, false, "a2z"), true);
  assert.equal(shouldDeferNewSupplierProductForZeroStock({ inventoryLevel: 0, providedFields: ["stock"] }, false, "dropex"), false);
  const sync = readFileSync("functions/src/scheduled/supplierSync.ts", "utf8");
  assert.match(sync, /applyApprovedSupplierInventoryObservation/u);
});

test("server approval guard rejects current trusted low stock and allows recovery", () => {
  for (const stock of [0, 1, 2, 3]) {
    assert.throws(
      () => assertNewSupplierPublicationStock({ supplierSourceId: "dropex", stock, stockKnown: true }),
      (error: any) => error?.statusCode === 422
        && error?.message === LOW_SUPPLIER_STOCK_FOR_PUBLICATION_MESSAGE
        && error?.details?.validationErrors?.[0]?.code === LOW_SUPPLIER_STOCK_FOR_PUBLICATION_CODE,
    );
  }
  assert.doesNotThrow(() => assertNewSupplierPublicationStock({ supplierSourceId: "dropex", stock: 8, stockKnown: true }));
  assert.doesNotThrow(() => assertNewSupplierPublicationStock({ supplierSourceId: "dropex", stock: 2, stockKnown: false }));
  assert.doesNotThrow(() => assertNewSupplierPublicationStock({ supplierSourceId: "a2z", stock: 2, stockKnown: true }));
});

test("approval guard retains the exact stable low-stock error contract", () => {
  const valid = {
    name: "Gel Seat Cushion",
    imageUrl: "https://storage.example/gel.webp",
    price: 999,
    costPrice: 500,
    description: "A valid description.",
    stock: 1,
    isActive: true,
    category: "electronics",
    specs: {},
  };
  assert.deepEqual(validateSupplierProductForApproval(valid, [category], [], { supplierReview: true }), []);
  assert.equal(LOW_SUPPLIER_STOCK_FOR_PUBLICATION_CODE, "LOW_SUPPLIER_STOCK_FOR_PUBLICATION");
  assert.equal(LOW_SUPPLIER_STOCK_FOR_PUBLICATION_MESSAGE, "Supplier stock must be at least 4 units before publication.");
  const approval = readFileSync("functions/src/api/suppliers/supplierApproval.ts", "utf8");
  assert.match(approval, /trustedStockObservation/u);
  assert.match(approval, /assertNewSupplierPublicationStock/u);
});
