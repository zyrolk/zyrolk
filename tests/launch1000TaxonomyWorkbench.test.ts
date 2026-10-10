import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLaunch1000Workbench,
  launch1000FutureApplyContract,
  resolveLaunch1000Taxonomy,
  simulateLaunch1000TaxonomyAssignment,
  type Launch1000Candidate,
  type Launch1000Category,
} from "../src/services/launch1000TaxonomyWorkbench";

const catalog: Launch1000Category[] = [
  {
    id: "fashion",
    name: "Fashion",
    isActive: true,
    subcategories: [{ id: "eyewear", name: "Eyewear", isActive: true }],
  },
  {
    id: "home-kitchen",
    name: "Home & Kitchen",
    isActive: true,
    subcategories: [{ id: "small-kitchen-appliances", name: "Small Kitchen Appliances", isActive: true, }],
    specificationTemplate: [{ name: "Capacity", required: true }],
  },
  { id: "kids-toys", name: "Kids & Toys", isActive: true, subcategories: [] },
  { id: "inactive", name: "Inactive", isActive: false, subcategories: [] },
  { id: "candidate", name: "Candidate", isActive: true, taxonomyCandidate: true, subcategories: [] },
];

function candidate(overrides: Partial<Launch1000Candidate> = {}): Launch1000Candidate {
  return {
    id: "p-1",
    sourceId: "dropex",
    sku: "SKU-1",
    title: "Women's Sunglasses",
    description: "Polarized eyewear for everyday wear.",
    features: ["polarized"],
    specifications: {},
    supplierTaxonomy: ["Vehicle Accessories"],
    stock: 12,
    price: 2500,
    mediaReady: true,
    supplierAttributionValid: true,
    ...overrides,
  };
}

test("product evidence wins over a contradictory supplier taxonomy clue", () => {
  const result = resolveLaunch1000Taxonomy({ candidate: candidate(), catalog });
  assert.equal(result.outcome, "SAFE_CLUSTER_PROPOSAL");
  assert.equal(result.categoryId, "fashion");
  assert.equal(result.subcategoryId, "eyewear");
  assert.deepEqual(result.supplierClue, ["vehicle accessories"]);
});

test("supplier taxonomy alone cannot create a canonical selection", () => {
  const result = resolveLaunch1000Taxonomy({
    candidate: candidate({ title: "Generic Item", description: "A useful item.", features: [], supplierTaxonomy: ["Fashion"] }),
    catalog,
  });
  assert.equal(result.outcome, "NO_MATCH");
  assert.equal(result.categoryId, null);
});

test("explicit trusted mapping has priority and inactive targets are rejected", () => {
  const trusted = resolveLaunch1000Taxonomy({
    candidate: candidate({ supplierTaxonomy: ["Kitchen Appliances"], title: "Countertop Unit", description: "A kitchen appliance." }),
    catalog,
    trustedMappings: [{ sourceId: "dropex", supplierCategory: "Kitchen Appliances", targetCategoryId: "home-kitchen", targetSubcategoryId: "small-kitchen-appliances", mappingType: "manual", updatedBy: "admin" }],
  });
  assert.equal(trusted.outcome, "SAFE_EXISTING_MAPPING");
  assert.equal(trusted.subcategoryId, "small-kitchen-appliances");

  const invalid = resolveLaunch1000Taxonomy({
    candidate: candidate({ supplierTaxonomy: ["Kitchen Appliances"], title: "Countertop Unit", description: "A kitchen appliance." }),
    catalog,
    trustedMappings: [{ sourceId: "dropex", supplierCategory: "Kitchen Appliances", targetCategoryId: "inactive", mappingType: "manual", updatedBy: "admin" }],
  });
  assert.notEqual(invalid.outcome, "SAFE_EXISTING_MAPPING");
});

test("policy-sensitive knife evidence is held outside the rapid launch path", () => {
  const result = resolveLaunch1000Taxonomy({
    candidate: candidate({ sku: "ASN0047", title: "Foldable Pocket Knife", description: "Compact folding blade." }),
    catalog,
  });
  assert.equal(result.outcome, "POLICY_HOLD");
  assert.ok(result.riskFlags.includes("WEAPON_OR_BLADE_REVIEW"));
});

test("taxonomy simulation exposes required specifications and subcategory blockers", () => {
  const missingSpec = simulateLaunch1000TaxonomyAssignment(candidate({ title: "Countertop Blender" }), { categoryId: "home-kitchen", subcategoryId: "small-kitchen-appliances" }, catalog);
  assert.equal(missingSpec.wouldPassPublication, false);
  assert.ok(missingSpec.blockers.includes("REQUIRED_SPEC:Capacity"));

  const missingSubcategory = simulateLaunch1000TaxonomyAssignment(candidate(), { categoryId: "fashion", subcategoryId: null }, catalog);
  assert.ok(missingSubcategory.blockers.includes("SUBCATEGORY_REQUIRED"));
});

test("workbench is deterministic, clusters semantic equivalents, and does not mutate candidates", () => {
  const products = [
    candidate({ id: "b", sku: "B", title: "Wireless Earbuds", description: "Bluetooth earbuds.", supplierTaxonomy: ["Electronics"] }),
    candidate({ id: "a", sku: "A", title: "Women's Sunglasses" }),
  ];
  const before = JSON.stringify(products);
  const result = buildLaunch1000Workbench({ candidates: products, catalog });
  assert.equal(JSON.stringify(products), before);
  assert.deepEqual(result.candidates.map((item) => item.id), ["a", "b"]);
  assert.ok(result.clusters.length >= 1);
  assert.equal(result.candidates.some((item) => item.simulation.wouldPassPublication), true);
});

test("future apply contract is bounded and forbids business authority writes", () => {
  const contract = launch1000FutureApplyContract("cluster-1");
  assert.equal(contract.batchSize, 100);
  assert.equal(contract.writes, "taxonomy_draft_fields_only");
  assert.ok(contract.forbids.includes("stock"));
  assert.ok(contract.forbids.includes("publication"));
  assert.ok(contract.idempotencyKey.startsWith("launch1000:"));
});
