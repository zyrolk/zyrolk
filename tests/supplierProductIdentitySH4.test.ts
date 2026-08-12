import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildZyroProductId,
  buildZyroSkuCandidates,
  buildZyroSkuClaimId,
  ZYRO_SKU_CLAIMS_COLLECTION,
} from "../functions/src/api/suppliers/supplierProductIdentity";

test("SH-4 creates opaque stable Zyro product IDs without exposing supplier-controlled identifiers", () => {
  const first = buildZyroProductId({
    offerId: "offer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceId: "supplier-a",
    supplierId: "supplier-a",
    supplierProductId: "SUPPLIER/SKU-100",
  });
  const retry = buildZyroProductId({
    offerId: "offer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceId: "supplier-a",
    supplierId: "supplier-a",
    supplierProductId: "SUPPLIER/SKU-100",
  });
  const second = buildZyroProductId({
    offerId: "offer-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sourceId: "supplier-b",
    supplierId: "supplier-b",
    supplierProductId: "SUPPLIER/SKU-100",
  });

  assert.equal(first, retry);
  assert.notEqual(first, second);
  assert.match(first, /^zyro-[a-f0-9]{32}$/u);
  assert.equal(first.includes("supplier"), false);
  assert.equal(first.includes("sku"), false);
});

test("SH-4 produces a bounded deterministic SKU candidate sequence independent of supplier SKU", () => {
  const candidates = buildZyroSkuCandidates("zyro-1234567890abcdef1234567890abcdef");
  assert.equal(candidates.length, 8);
  assert.equal(new Set(candidates).size, candidates.length);
  candidates.forEach((sku) => assert.match(sku, /^ZY-[A-F0-9]{12}$/u));
  assert.deepEqual(candidates, buildZyroSkuCandidates("zyro-1234567890abcdef1234567890abcdef"));
  assert.notEqual(candidates[0], "SUPPLIER-SKU-100");
  assert.match(buildZyroSkuClaimId(candidates[0]), /^[a-f0-9]{64}$/u);
  assert.equal(ZYRO_SKU_CLAIMS_COLLECTION, "zyro_sku_claims");
});

test("SH-4 approval and Rules retain server-authoritative product identity boundaries", () => {
  const approval = readFileSync("functions/src/api/suppliers/supplierApproval.ts", "utf8");
  const sync = readFileSync("functions/src/scheduled/supplierSync.ts", "utf8");
  const rules = readFileSync("firestore.rules", "utf8");

  assert.match(approval, /buildZyroProductId\(/u);
  assert.match(approval, /reserveZyroSku\(/u);
  assert.match(approval, /decisionPendingRevision/u);
  assert.doesNotMatch(approval, /approvedPayload\.sku\s*=\s*(?:queueItem|supplierSnapshot|originalPayload)/u);
  assert.match(sync, /sourceMatches && candidate\.supplierItemCode/u);
  assert.doesNotMatch(sync, /candidate\.sku\?\.trim\(\)\.toLowerCase\(\) === supplierCode/u);
  assert.match(sync, /queueState: "conflict"/u);
  assert.match(rules, /match \/zyro_sku_claims\/\{claimId\}[\s\S]*allow read: if false;[\s\S]*allow create, update, delete: if false;/u);
});
