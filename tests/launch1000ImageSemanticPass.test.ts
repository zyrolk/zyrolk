import assert from "node:assert/strict";
import test from "node:test";

import { buildLaunch1000SemanticPass, classifyLaunch1000SemanticCandidate, semanticPassCheckpoint, type Launch1000SemanticCandidate } from "../src/services/launch1000ImageSemanticPass";
import type { Launch1000Category } from "../src/services/launch1000TaxonomyWorkbench";

const catalog: Launch1000Category[] = [
  { id: "fashion", name: "fashion", isActive: true, subcategories: [{ id: "eyewear", name: "Eyewear", isActive: true }, { id: "watches", name: "Watches", isActive: true }, { id: "shapewear", name: "Shapewear", isActive: true }] },
  { id: "electronics", name: "Electronics", isActive: true, subcategories: [{ id: "audio", name: "Audio & Earbuds", isActive: true }, { id: "power-banks", name: "Power Banks", isActive: true }, { id: "computer-accessories", name: "Computer Accessories", isActive: true }], specificationTemplate: [{ name: "Product Type", required: true }] },
  { id: "kids-toys", name: "Kids & Toys", isActive: true, subcategories: [] },
  { id: "home-garden", name: "Home & Garden", isActive: true, subcategories: [{ id: "tools-hardware", name: "Tools & Hardware", isActive: true }], specificationTemplate: [{ name: "Product Type", required: true }] },
  { id: "automotive", name: "Automotive", isActive: true, subcategories: [{ id: "interior-accessories", name: "Interior Accessories", isActive: true }] },
];

function candidate(overrides: Partial<Launch1000SemanticCandidate> = {}): Launch1000SemanticCandidate {
  return { id: "p1", sourceId: "dropex", sku: "SKU1", title: "Wireless Bluetooth Speaker", description: "Portable speaker", features: [], specifications: {}, supplierTaxonomy: ["Electronics"], stock: 10, price: 1000, mediaReady: true, supplierAttributionValid: true, managedImage: { available: true, fetchVerified: true }, ...overrides };
}

test("strong product evidence selects only an active existing taxonomy", () => {
  const result = classifyLaunch1000SemanticCandidate({ candidate: candidate(), catalog });
  assert.equal(result.classification, "HIGH_CONFIDENCE_EXISTING_TAXONOMY");
  assert.equal(result.categoryId, "electronics");
  assert.equal(result.subcategoryId, "audio");
  assert.equal(result.cleanReadyAfterSafeSpec, true);
});

test("supplier taxonomy alone cannot select a category", () => {
  const result = classifyLaunch1000SemanticCandidate({ candidate: candidate({ title: "Generic Item", description: "Useful product", supplierTaxonomy: ["Electronics"] }), catalog });
  assert.equal(result.classification, "NEW_TAXONOMY_NEEDED");
  assert.equal(result.categoryId, null);
});

test("contradictory sunglasses evidence is not forced into vehicle taxonomy", () => {
  const result = classifyLaunch1000SemanticCandidate({ candidate: candidate({ title: "Women's Sunglasses", description: "Polarized eyewear", supplierTaxonomy: ["Vehicle Accessories"] }), catalog });
  assert.equal(result.categoryId, "fashion");
  assert.equal(result.subcategoryId, "eyewear");
  assert.notEqual(result.categoryId, "automotive");
});

test("ASN0047 knife remains a policy hold", () => {
  const result = classifyLaunch1000SemanticCandidate({ candidate: candidate({ id: "asn0047", sku: "ASN0047", title: "Foldable Pocket Knife", description: "Folding blade" }), catalog });
  assert.equal(result.classification, "POLICY_HOLD");
  assert.ok(result.riskFlags.includes("WEAPON_OR_BLADE_REVIEW"));
});

test("explicit product type can safely satisfy only the required Product Type field", () => {
  const result = classifyLaunch1000SemanticCandidate({ candidate: candidate({ title: "Cordless Hammer Drill", description: "Power drill for masonry", supplierTaxonomy: ["Tools"] }), catalog });
  assert.equal(result.categoryId, "home-garden");
  assert.equal(result.specDisposition, "DETERMINISTIC_SPEC_NORMALIZATION");
  assert.equal(result.cleanReadyAfterTaxonomy, false);
  assert.equal(result.cleanReadyAfterSafeSpec, true);
  assert.equal(result.proposedSpec?.field, "Product Type");
});

test("managed image provenance is evidence metadata, not raw URL authority", () => {
  const withImage = classifyLaunch1000SemanticCandidate({ candidate: candidate({ managedImage: { available: true, imageUrl: "https://firebasestorage.googleapis.com/managed" } }), catalog });
  const withoutImage = classifyLaunch1000SemanticCandidate({ candidate: candidate({ mediaReady: false, managedImage: { available: false } }), catalog });
  assert.ok(withImage.imageEvidence.includes("managed media provenance present"));
  assert.equal(withoutImage.cleanReadyAfterTaxonomy, false);
  assert.ok(withoutImage.postTaxonomyBlockers.includes("MEDIA_NOT_READY"));
});

test("batch pass is deterministic and checkpoint is resumable", () => {
  const results = buildLaunch1000SemanticPass({ candidates: [candidate({ id: "b" }), candidate({ id: "a" })], catalog });
  assert.deepEqual(results.map((result) => result.candidateId), ["a", "b"]);
  assert.deepEqual(semanticPassCheckpoint(results.map((result) => result.candidateId), 100), { batchSize: 100, processedIds: ["a", "b"], cursor: "b" });
});
