import assert from "node:assert/strict";
import test from "node:test";

import {
  assessProductRisk,
  buildHiddenTaxAiBenchmarkReference,
  hashTaxAiEvidence,
  isSafeManagedImageReference,
  normalizeTaxAiEvidence,
  resolveTaxAiDeterministicTaxonomy,
  validateTaxAiModelOutput,
  validateTaxAiTaxonomySelection,
  type TaxAiProductEvidence,
  type TaxAiTaxonomyCatalog,
} from "../functions/src/api/ai/taxAiFoundation";
import { GeminiTaxAiProvider, UnavailableTaxAiProvider } from "../functions/src/api/ai/taxAiProvider";

const catalog: TaxAiTaxonomyCatalog = {
  categories: [
    { id: "vehicle-accessories", name: "Vehicle Accessories", isActive: true },
    { id: "sunglasses", name: "Sunglasses", isActive: true },
    {
      id: "tools",
      name: "Tools",
      isActive: true,
      subcategories: [{ id: "knives", name: "Knives", isActive: true }],
    },
    { id: "inactive", name: "Inactive", isActive: false },
    { id: "candidate", name: "Candidate", isActive: true, taxonomyCandidate: true },
  ],
};

const sunglasses: TaxAiProductEvidence = {
  sourceId: "dropex",
  supplierSku: "SUN-1",
  title: "Women's Sunglasses",
  description: "Polarized sunglasses for everyday wear.",
  supplierTaxonomy: ["Vehicle Accessories"],
};

test("only active non-candidate taxonomy IDs and valid category/subcategory pairs are accepted", () => {
  assert.equal(validateTaxAiTaxonomySelection({ categoryId: "sunglasses", subcategoryId: null }, catalog).valid, true);
  assert.equal(validateTaxAiTaxonomySelection({ categoryId: "inactive", subcategoryId: null }, catalog).valid, false);
  assert.equal(validateTaxAiTaxonomySelection({ categoryId: "candidate", subcategoryId: null }, catalog).valid, false);
  assert.equal(validateTaxAiTaxonomySelection({ categoryId: "tools", subcategoryId: null }, catalog).reason, "SUBCATEGORY_REQUIRED");
  assert.equal(validateTaxAiTaxonomySelection({ categoryId: "tools", subcategoryId: "unknown" }, catalog).valid, false);
  assert.equal(validateTaxAiTaxonomySelection({ categoryId: "tools", subcategoryId: "knives" }, catalog).valid, true);
});

test("supplier taxonomy is secondary and cannot force Vehicle Accessories over product-owned Sunglasses evidence", () => {
  const resolution = resolveTaxAiDeterministicTaxonomy({ evidence: sunglasses, catalog });
  assert.equal(resolution.source, "product_evidence");
  assert.equal(resolution.taxonomy.categoryId, "sunglasses");
  assert.equal(resolution.taxonomy.categoryId, "sunglasses");
  assert.notEqual(resolution.taxonomy.categoryId, "vehicle-accessories");
});

test("a supplier taxonomy label by itself remains unresolved without product evidence or a trusted mapping", () => {
  const resolution = resolveTaxAiDeterministicTaxonomy({
    evidence: { ...sunglasses, title: "Generic Item", description: "A generic item", supplierTaxonomy: ["Sunglasses"] },
    catalog,
  });
  assert.equal(resolution.source, "unresolved");
  assert.equal(resolution.taxonomy.categoryId, null);
});

test("an approved trusted mapping may resolve a valid active category/subcategory", () => {
  const resolution = resolveTaxAiDeterministicTaxonomy({
    evidence: { ...sunglasses, supplierTaxonomy: ["Cutlery"] },
    catalog,
    trustedMappings: [{
      sourceId: "dropex",
      supplierCategory: "Cutlery",
      normalizedCategory: "cutlery",
      targetCategoryId: "tools",
      targetSubcategoryId: "knives",
      confidence: 1,
      mappingType: "manual",
      version: 1,
      updatedBy: "admin",
    }],
  });
  assert.equal(resolution.source, "trusted_mapping");
  assert.equal(resolution.taxonomy.categoryId, "tools");
  assert.equal(resolution.taxonomy.subcategoryId, "knives");
});

test("unresolved taxonomy produces a proposal-only no-match state without inventing IDs", () => {
  const resolution = resolveTaxAiDeterministicTaxonomy({
    evidence: { ...sunglasses, title: "Unclassifiable Item", description: "Something generic", supplierTaxonomy: ["Unknown Department"] },
    catalog,
  });
  assert.equal(resolution.source, "unresolved");
  assert.equal(resolution.taxonomy.categoryId, null);
  assert.equal(resolution.taxonomy.needsNewTaxonomy, true);
  assert.equal(resolution.taxonomy.proposedTaxonomy?.categoryName, undefined);
});

test("ASN0047-style knife evidence forces policy review even when model returns a valid taxonomy", () => {
  const evidence: TaxAiProductEvidence = {
    sourceId: "dropex",
    supplierSku: "ASN0047",
    title: "Foldable Pocket Knife",
    description: "Compact folding blade.",
  };
  const risk = assessProductRisk(evidence);
  assert.equal(risk.policyReviewRequired, true);
  assert.ok(risk.flags.includes("WEAPON_OR_BLADE_REVIEW"));
  const result = validateTaxAiModelOutput({
    raw: { taxonomy: { categoryId: "tools", subcategoryId: "knives", confidence: 1 }, risk: { flags: [] }, decision: "HIGH_CONFIDENCE" },
    catalog,
    evidence,
    minimumHighConfidence: 0.8,
  });
  assert.equal(result.decision, "POLICY_HOLD");
  assert.equal(result.taxonomy.categoryId, "tools");
});

test("raw supplier URLs are not accepted as managed image references, while a stable managed image is", () => {
  const managedMetadata = { storagePath: "supplier-review/SUN-1/managed.webp", imageStatus: "ready" as const };
  assert.equal(isSafeManagedImageReference({ url: "https://supplier.example/image.webp", provenance: "zyro-managed", publicationSafe: true, ...managedMetadata }), false);
  assert.equal(isSafeManagedImageReference({ url: "https://firebasestorage.googleapis.com/v0/b/demo/o/media.webp?alt=media", provenance: "zyro-managed", publicationSafe: true, ...managedMetadata }), true);
  assert.equal(isSafeManagedImageReference({ url: "https://firebasestorage.googleapis.com/v0/b/demo/o/media.webp?token=short-lived", provenance: "zyro-managed", publicationSafe: true, ...managedMetadata }), false);
  const normalized = normalizeTaxAiEvidence({ ...sunglasses, managedPrimaryImage: { url: "https://supplier.example/image.webp", provenance: "zyro-managed", publicationSafe: true, ...managedMetadata } });
  assert.equal(normalized.managedPrimaryImage, undefined);
});

test("invalid or hallucinated model IDs can never remain HIGH_CONFIDENCE", () => {
  const result = validateTaxAiModelOutput({
    raw: { taxonomy: { categoryId: "made-up-category", subcategoryId: null, confidence: 1 }, decision: "HIGH_CONFIDENCE" },
    catalog,
    evidence: sunglasses,
    minimumHighConfidence: 0.8,
  });
  assert.notEqual(result.decision, "HIGH_CONFIDENCE");
  assert.equal(result.taxonomy.categoryId, null);
  assert.ok(result.reasons.includes("INVALID_OR_INACTIVE_CATEGORY"));
});

test("AI unavailable and malformed output fail closed to review", async () => {
  await assert.rejects(() => new UnavailableTaxAiProvider().classify({ evidence: sunglasses, taxonomy: catalog, promptVersion: "tax-ai-1" }));
  const malformed = validateTaxAiModelOutput({ raw: "not-json", catalog, evidence: sunglasses });
  assert.equal(malformed.decision, "REVIEW");
  assert.equal(malformed.taxonomy.categoryId, null);
});

test("Gemini adapter is server-injected and returns structured JSON without exposing a browser provider", async () => {
  let requestBody = "";
  let requestUrl = "";
  let requestHeaders: Record<string, string> = {};
  const provider = new GeminiTaxAiProvider({
    apiKey: "test-only-secret",
    model: "test-model",
    endpoint: "https://example.invalid/models",
    fetcher: async (input, init) => {
      requestUrl = String(input);
      requestHeaders = Object.fromEntries(Object.entries(init?.headers || {}).map(([key, value]) => [key, String(value)]));
      requestBody = String(init?.body || "");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ taxonomy: { categoryId: "sunglasses", subcategoryId: null, confidence: 0.9 }, risk: { flags: [] }, decision: "HIGH_CONFIDENCE" }) }] } }] }), { status: 200 });
    },
  });
  const raw = await provider.classify({ evidence: sunglasses, taxonomy: catalog, promptVersion: "tax-ai-1" });
  assert.equal((raw as { taxonomy: { categoryId: string } }).taxonomy.categoryId, "sunglasses");
  assert.equal(requestUrl.includes("test-only-secret"), false);
  assert.equal(requestHeaders["x-goog-api-key"], "test-only-secret");
  assert.equal(requestBody.includes("customer"), false);
  assert.equal(requestBody.includes("order"), false);
});

test("Gemini adapter attaches bounded managed image data and falls back with mediaUnavailable", async () => {
  let generationBody = "";
  const managed = {
    url: "https://firebasestorage.googleapis.com/v0/b/demo/o/media.webp?alt=media",
    provenance: "zyro-managed" as const,
    publicationSafe: true as const,
    storagePath: "supplier-review/SUN-1/managed.webp",
    imageStatus: "ready" as const,
  };
  const provider = new GeminiTaxAiProvider({
    apiKey: "test-only-secret",
    model: "test-model",
    imageFetcher: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/webp", "content-length": "3" } }),
    fetcher: async (_input, init) => {
      generationBody = String(init?.body || "");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ taxonomy: { categoryId: "sunglasses", subcategoryId: null, confidence: 0.9 }, risk: { flags: [] }, decision: "HIGH_CONFIDENCE" }) }] } }] }), { status: 200 });
    },
  });
  const evidence = { ...sunglasses, managedPrimaryImage: managed };
  await provider.classify({ evidence, taxonomy: catalog, promptVersion: "tax-ai-1" });
  assert.equal(provider.lastMediaInputStatus, "present");
  assert.equal((JSON.parse(generationBody) as { contents: Array<{ parts: Array<Record<string, unknown>> }> }).contents[0].parts.some((part) => Boolean(part.inlineData)), true);

  const fallbackProvider = new GeminiTaxAiProvider({
    apiKey: "test-only-secret",
    model: "test-model",
    imageFetcher: async () => { throw new Error("offline"); },
    fetcher: async (_input, init) => {
      generationBody = String(init?.body || "");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ taxonomy: { categoryId: "sunglasses", subcategoryId: null, confidence: 0.9 }, risk: { flags: [] }, decision: "HIGH_CONFIDENCE" }) }] } }] }), { status: 200 });
    },
  });
  await fallbackProvider.classify({ evidence, taxonomy: catalog, promptVersion: "tax-ai-1" });
  assert.equal(fallbackProvider.lastMediaInputStatus, "unavailable");
  assert.equal((JSON.parse(generationBody) as { contents: Array<{ parts: Array<{ text?: string }> }> }).contents[0].parts[0].text?.includes('"mediaUnavailable":true'), true);
});

test("Gemini malformed JSON is rejected rather than converted into a taxonomy decision", async () => {
  const provider = new GeminiTaxAiProvider({
    apiKey: "test-only-secret",
    model: "test-model",
    fetcher: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "not-json" }] } }] }), { status: 200 }),
  });
  await assert.rejects(() => provider.classify({ evidence: sunglasses, taxonomy: catalog, promptVersion: "tax-ai-1" }));
});

test("evidence hashing is deterministic and does not mutate business authority fields", () => {
  const input = { ...sunglasses, specifications: { color: "black" } };
  const before = JSON.stringify(input);
  assert.equal(hashTaxAiEvidence(input), hashTaxAiEvidence({ ...input }));
  assert.equal(JSON.stringify(input), before);
  assert.equal("price" in input, false);
  assert.equal("stock" in input, false);
  assert.equal("localDemand" in input, false);
  assert.equal("order" in input, false);
});

test("hidden benchmark references keep canonical labels out of the model evidence", () => {
  const reference = buildHiddenTaxAiBenchmarkReference({
    id: "product-1",
    evidence: sunglasses,
    canonicalCategoryId: "sunglasses",
    canonicalSubcategoryId: null,
  });
  assert.equal(reference.expectedCategoryId, "sunglasses");
  assert.equal("categoryId" in reference.evidence, false);
  assert.equal("subcategoryId" in reference.evidence, false);
});
