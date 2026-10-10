export type Launch1000Outcome =
  | "SAFE_EXISTING_MAPPING"
  | "SAFE_CLUSTER_PROPOSAL"
  | "ADMIN_CHOICE"
  | "NO_MATCH"
  | "POLICY_HOLD";

export type Launch1000Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface Launch1000Subcategory {
  id: string;
  name: string;
  isActive?: boolean;
}

export interface Launch1000Category {
  id: string;
  name: string;
  isActive?: boolean;
  taxonomyCandidate?: boolean;
  subcategories?: Launch1000Subcategory[];
  specificationTemplate?: Array<{ name: string; required?: boolean }>;
  keywords?: string[];
}

export interface Launch1000TrustedMapping {
  sourceId?: string;
  supplierCategory?: string;
  normalizedCategory?: string;
  targetCategoryId?: string;
  targetSubcategoryId?: string;
  mappingType?: string;
  confidence?: number;
  updatedBy?: string;
  approvedBy?: string;
  approvalStatus?: string;
}

export interface Launch1000Candidate {
  id: string;
  sourceId: string;
  sku: string;
  title: string;
  description?: string;
  productType?: string;
  features?: string[];
  specifications?: Record<string, unknown>;
  brand?: string;
  supplierTaxonomy?: string[];
  stock?: number | null;
  price?: number | null;
  mediaReady: boolean;
  supplierAttributionValid: boolean;
  liveEquivalent?: boolean;
  terminal?: boolean;
  policyHold?: boolean;
  currentCategoryId?: string | null;
  currentSubcategoryId?: string | null;
  otherBlockers?: string[];
}

export interface Launch1000Resolution {
  outcome: Launch1000Outcome;
  confidence: Launch1000Confidence;
  categoryId: string | null;
  subcategoryId: string | null;
  source: "trusted_mapping" | "product_evidence" | "ambiguous" | "unresolved" | "policy";
  evidence: string[];
  supplierClue: string[];
  alternateOptions: Array<{ categoryId: string; subcategoryId: string | null; reason: string }>;
  riskFlags: string[];
  reason: string;
  clusterSignature: string;
}

export interface Launch1000Simulation {
  wouldPassPublication: boolean;
  blockers: string[];
}

export interface Launch1000Cluster {
  clusterId: string;
  normalizedProductType: string;
  candidateCount: number;
  candidateIds: string[];
  representativeProducts: Array<{ sku: string; title: string }>;
  evidenceTerms: string[];
  supplierTaxonomyDistribution: Array<{ value: string; count: number }>;
  proposedCategoryId: string | null;
  proposedSubcategoryId: string | null;
  proposalSource: Launch1000Resolution["source"];
  confidence: Launch1000Confidence;
  outcome: Launch1000Outcome;
  expectedReadyUnlockCount: number;
  expectedPostTaxonomyBlockers: Array<{ blocker: string; count: number }>;
  riskNotes: string[];
}

export interface Launch1000WorkbenchResult {
  candidates: Array<Launch1000Candidate & { resolution: Launch1000Resolution; simulation: Launch1000Simulation }>;
  clusters: Launch1000Cluster[];
}

const POLICY_PATTERNS: Array<[string, RegExp]> = [
  ["WEAPON_OR_BLADE_REVIEW", /\b(knife|knives|blade|sword|machete|weapon|dagger)\b/iu],
  ["REGULATED_HEALTH_REVIEW", /\b(medicine|medication|antibiotic|prescription|drug|pharmaceutical)\b/iu],
  ["HAZARDOUS_CHEMICAL_REVIEW", /\b(pesticide|insecticide|herbicide|solvent|acid|flammable|corrosive)\b/iu],
  ["ADULT_RESTRICTED_REVIEW", /\b(adult|sex|erotic|intimate)\b/iu],
  ["TOBACCO_VAPING_REVIEW", /\b(tobacco|cigarette|vape|vaping|nicotine)\b/iu],
  ["COUNTERFEIT_AUTHENTICITY_REVIEW", /\b(replica|fake|counterfeit|1:1|copy of)\b/iu],
];

const STOP_WORDS = new Set([
  "and", "the", "for", "with", "from", "new", "best", "sale", "item", "product", "original",
  "small", "large", "set", "pack", "pcs", "piece", "portable", "premium", "quality", "zyro",
]);

export function normalizeLaunch1000Text(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/<[^>]*>/gu, " ")
    .toLowerCase()
    .replace(/[’']/gu, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function tokens(value: unknown): string[] {
  return [...new Set(normalizeLaunch1000Text(value).split(" ").filter((token) => token && !STOP_WORDS.has(token)))];
}

function evidenceText(candidate: Launch1000Candidate): string {
  return [
    candidate.title,
    candidate.description,
    candidate.productType,
    ...(candidate.features || []),
    ...Object.entries(candidate.specifications || {}).flatMap(([key, value]) => [key, String(value ?? "")]),
    candidate.brand,
  ].filter(Boolean).join(" ");
}

function supplierText(candidate: Launch1000Candidate): string {
  return (candidate.supplierTaxonomy || []).join(" ");
}

function activeCategory(catalog: readonly Launch1000Category[], id: string | null | undefined): Launch1000Category | null {
  const category = catalog.find((item) => item.id === id);
  return category && category.isActive === true && category.taxonomyCandidate !== true ? category : null;
}

function validSelection(catalog: readonly Launch1000Category[], categoryId: string, subcategoryId: string | null): boolean {
  const category = activeCategory(catalog, categoryId);
  if (!category) return false;
  const activeSubcategories = (category.subcategories || []).filter((item) => item.isActive !== false);
  if (activeSubcategories.length === 0) return subcategoryId === null || subcategoryId === "";
  return Boolean(subcategoryId && activeSubcategories.some((item) => item.id === subcategoryId));
}

function isTrustedMapping(mapping: Launch1000TrustedMapping, candidate: Launch1000Candidate, catalog: readonly Launch1000Category[]): boolean {
  const supplierValues = (candidate.supplierTaxonomy || []).map(normalizeLaunch1000Text);
  const mappingSupplier = normalizeLaunch1000Text(mapping.normalizedCategory || mapping.supplierCategory);
  const approved = Boolean(mapping.approvedBy || mapping.approvalStatus === "approved");
  const explicitlyMaintained = mapping.mappingType === "manual"
    || (mapping.mappingType === "learned" && approved && Number(mapping.confidence || 0) >= 0.9);
  return (!mapping.sourceId || mapping.sourceId === candidate.sourceId)
    && Boolean(mappingSupplier && supplierValues.includes(mappingSupplier))
    && explicitlyMaintained
    && validSelection(catalog, String(mapping.targetCategoryId || ""), mapping.targetSubcategoryId ? String(mapping.targetSubcategoryId) : null);
}

function findByNames(catalog: readonly Launch1000Category[], categoryNames: RegExp[], subcategoryNames: RegExp[]): { categoryId: string; subcategoryId: string | null; label: string }[] {
  const matches: { categoryId: string; subcategoryId: string | null; label: string }[] = [];
  for (const category of catalog) {
    if (!activeCategory(catalog, category.id)) continue;
    const categoryMatch = categoryNames.some((pattern) => pattern.test(`${category.name} ${(category.keywords || []).join(" ")}`));
    for (const subcategory of (category.subcategories || []).filter((item) => item.isActive !== false)) {
      if (subcategoryNames.some((pattern) => pattern.test(subcategory.name))) {
        matches.push({ categoryId: category.id, subcategoryId: subcategory.id, label: `${category.name} > ${subcategory.name}` });
      }
    }
    if (categoryMatch && (category.subcategories || []).filter((item) => item.isActive !== false).length === 0) {
      matches.push({ categoryId: category.id, subcategoryId: null, label: category.name });
    }
  }
  return matches;
}

function deterministicProductOptions(candidate: Launch1000Candidate, catalog: readonly Launch1000Category[]): Array<{ option: { categoryId: string; subcategoryId: string | null; label: string }; evidence: string[] }> {
  const text = evidenceText(candidate);
  const options: Array<{ option: { categoryId: string; subcategoryId: string | null; label: string }; evidence: string[] }> = [];
  const add = (patterns: RegExp[], categoryNames: RegExp[], subcategoryNames: RegExp[], terms: string[]) => {
    if (!patterns.some((pattern) => pattern.test(text))) return;
    for (const option of findByNames(catalog, categoryNames, subcategoryNames)) options.push({ option, evidence: terms });
  };
  add([/\b(phone case|mobile cover|screen protector|phone charger|mobile charger)\b/iu], [/phone|accessor/iu], [/phone|mobile/iu], ["product type: phone accessory"]);
  add([/\b(earbuds?|headphones?|bluetooth speaker|wireless speaker)\b/iu], [/electronics/iu], [/audio/iu], ["product type: audio"]);
  add([/\b(sunglasses?|eyewear|spectacles?)\b/iu], [/fashion/iu], [/eyewear/iu], ["product type: eyewear"]);
  add([/\b(smart watch|smartwatch)\b/iu], [/electronics|accessor/iu], [/smart.*watch|watch/iu], ["product type: smart watch"]);
  add([/\b(watch|wristwatch)\b/iu], [/accessor/iu], [/^watch|watches/iu], ["product type: watch"]);
  add([/\b(makeup|foundation|lipstick|eyeshadow|mascara|concealer)\b/iu], [/health.*beauty|beauty/iu], [/makeup/iu], ["product type: makeup"]);
  add([/\b(serum|moisturizer|lotion|cleanser|skincare|skin care|eyelash)\b/iu], [/health.*beauty|beauty/iu], [/skin/iu], ["product type: skin care"]);
  add([/\b(perfume|fragrance|cologne|air freshener|vehicle aroma)\b/iu], [/health.*beauty|beauty|automotive/iu], [/fragrance|car.*care|cleaning/iu], ["product type: fragrance or care"]);
  add([/\b(blender|juicer|air fryer|kettle|mixer|toaster|rice cooker)\b/iu], [/home.*kitchen|kitchen/iu], [/small.*kitchen|appliance/iu], ["product type: kitchen appliance"]);
  add([/\b(blender|juicer|air fryer|kettle|mixer|toaster|rice cooker|hotplate|cooking pot|sandwich maker)\b/iu], [/home.*kitchen|kitchen/iu], [/small-kitchen-appliances/iu], ["product type: kitchen appliance"]);
  add([/\b(kitchen|gas stove|stove support|grinder|nonstick|cooking|sink wrench|frying pan|pot|bowl|cutlery|cake|food cover)\b/iu], [/home.*kitchen|kitchen/iu], [/kitchen-tools/iu], ["product type: kitchen tool"]);
  add([/\b(hair dryer|hair straightener|curling iron)\b/iu], [/health.*beauty|beauty/iu], [/hair.*styl/iu], ["product type: hair styling"]);
  add([/\b(shaver|trimmer|epilator)\b/iu], [/health.*beauty|beauty/iu], [/shaver|groom/iu], ["product type: grooming"]);
  add([/\b(toothbrush|oral care|floss|water flosser)\b/iu], [/health.*beauty|beauty/iu], [/oral/iu], ["product type: oral care"]);
  add([/\b(baby|infant|feeding|stroller|dining chair safety belt)\b/iu], [/baby/iu], [/baby/iu], ["product type: baby"]);
  add([/\b(dash ?cam|dashboard camera)\b/iu], [/automotive|vehicle/iu], [/dash/iu], ["product type: dash camera"]);
  add([/\b(fog light|headlight|head light|tail ?light|vehicle body light|number plate|door latch|bike light|angel wing light)\b/iu], [/automotive|vehicle/iu], [/exterior/iu], ["product type: vehicle exterior"]);
  add([/\b(car mat|seat cover|interior)\b/iu], [/automotive|vehicle/iu], [/interior/iu], ["product type: vehicle interior"]);
  add([/\b(motorcycle|motorbike|bike accessory)\b/iu], [/automotive|vehicle/iu], [/motorcycle/iu], ["product type: motorcycle"]);
  add([/\b(solar panel|solar battery)\b/iu], [/solar|lighting/iu], [/solar equipment/iu], ["product type: solar equipment"]);
  add([/\b(solar light|solar lamp|solar fountain|solar fire fly)\b/iu], [/solar|lighting/iu], [/solar light/iu], ["product type: solar light"]);
  add([/\b(led bulb|led light)\b/iu], [/solar|lighting/iu], [/led/iu], ["product type: led light"]);
  add([/\b(torch|flashlight|lantern)\b/iu], [/solar|lighting/iu], [/torch|lantern/iu], ["product type: torch or lantern"]);
  add([/\b(rechargeable light|portable light|emergency light)\b/iu], [/solar|lighting/iu], [/rechargeable|portable|emergency/iu], ["product type: portable light"]);
  add([/\b(garden|pruning|hose|watering|rake|weed|plant|fertilizer|soil)\b/iu], [/home.*garden|garden/iu], [/garden-tools/iu], ["product type: garden"]);
  add([/\b(drill|hammer|screwdriver|wrench|pliers|hand tool|power tool|chisel|soldering|laser distance|grease gun|engraver|clamp|jack support|saw|grinder|welding|crimper|bender|leveler|caliper)\b/iu], [/home.*garden|tools/iu], [/tools-hardware/iu], ["product type: tools"]);
  add([/\b(toilet|cleaning brush|cleaner|mop|clothes rack|fridge cover|drain hose|washing machine cover|chair cover)\b/iu], [/home.*garden|household/iu], [/^household$/iu], ["product type: household"]);
  add([/\b(storage rack|organizer drawer|shoe rack|hanger|storage bag|shelf|cabinet rail)\b/iu], [/home.*garden|household/iu], [/home essentials/iu], ["product type: home storage"]);
  add([/\b(handbag|backpack|wallet|belt|umbrella|shoe|sandal|fashion)\b/iu], [/fashion|accessor/iu], [/accessor|footwear|hat|cap/iu], ["product type: fashion accessory"]);
  add([/\b(toy|puzzle|doll|remote control car|building blocks)\b/iu], [/kids|toy/iu], [/^$/iu], ["product type: toy"]);
  return options;
}

function productFamily(candidate: Launch1000Candidate): string {
  const text = evidenceText(candidate);
  const families: Array<[string, RegExp]> = [
    ["audio", /\b(earbuds?|headphones?|speaker|subwoofer|headset)\b/iu],
    ["phone-accessories", /\b(phone|mobile|screen protector|charger)\b/iu],
    ["vehicle-lighting", /\b(fog light|headlight|head light|tail light|vehicle body light|bike light)\b/iu],
    ["vehicle-interior", /\b(car mat|seat cover|dashboard|interior)\b/iu],
    ["hand-tools", /\b(drill|hammer|screwdriver|wrench|pliers|chisel|saw|soldering)\b/iu],
    ["household", /\b(toilet|cleaner|cleaning|brush|mop|rack|storage|organizer|hose|fridge cover)\b/iu],
    ["skin-care", /\b(serum|skincare|skin care|moisturizer|lotion|cleanser|eyelash)\b/iu],
    ["hair-care", /\b(hair|shaver|trimmer|epilator)\b/iu],
    ["makeup", /\b(makeup|foundation|lipstick|mascara|concealer)\b/iu],
    ["lighting", /\b(solar|led|torch|flashlight|lantern|lamp|light)\b/iu],
    ["fashion-accessories", /\b(handbag|backpack|wallet|belt|umbrella|shoe|sandal)\b/iu],
    ["toys", /\b(toy|puzzle|doll|blocks|scooter)\b/iu],
    ["kitchen", /\b(kitchen|blender|juicer|stove|grinder|kettle|mixer|toaster)\b/iu],
    ["garden", /\b(garden|pruning|watering|plant)\b/iu],
  ];
  return families.find(([, pattern]) => pattern.test(text))?.[0] || tokens(text).slice(0, 3).join("-") || "unclassified";
}

function riskFlags(candidate: Launch1000Candidate): string[] {
  const text = `${evidenceText(candidate)} ${supplierText(candidate)}`;
  return POLICY_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([flag]) => flag);
}

export function resolveLaunch1000Taxonomy(input: {
  candidate: Launch1000Candidate;
  catalog: readonly Launch1000Category[];
  trustedMappings?: readonly Launch1000TrustedMapping[];
}): Launch1000Resolution {
  const { candidate, catalog } = input;
  const flags = riskFlags(candidate);
  const supplierClue = (candidate.supplierTaxonomy || []).map(normalizeLaunch1000Text).filter(Boolean);
  if (candidate.policyHold || flags.length > 0) {
    return {
      outcome: "POLICY_HOLD", confidence: "HIGH", categoryId: null, subcategoryId: null, source: "policy",
      evidence: [], supplierClue, alternateOptions: [], riskFlags: flags, reason: "POLICY_REVIEW_REQUIRED",
      clusterSignature: `policy:${flags.join("+") || "external"}`,
    };
  }
  const trusted = (input.trustedMappings || []).find((mapping) => isTrustedMapping(mapping, candidate, catalog));
  if (trusted) {
    const categoryId = String(trusted.targetCategoryId);
    const subcategoryId = trusted.targetSubcategoryId ? String(trusted.targetSubcategoryId) : null;
    return {
      outcome: "SAFE_EXISTING_MAPPING", confidence: "HIGH", categoryId, subcategoryId, source: "trusted_mapping",
      evidence: ["approved trusted mapping"], supplierClue, alternateOptions: [], riskFlags: [], reason: "TRUSTED_MAPPING",
      clusterSignature: `mapping:${categoryId}:${subcategoryId || "none"}`,
    };
  }
  const options = deterministicProductOptions(candidate, catalog);
  const unique = [...new Map(options.map((item) => [`${item.option.categoryId}:${item.option.subcategoryId || ""}`, item])).values()];
  const signature = productFamily(candidate);
  if (unique.length === 1) {
    const selected = unique[0];
    return {
      outcome: "SAFE_CLUSTER_PROPOSAL", confidence: "HIGH", categoryId: selected.option.categoryId, subcategoryId: selected.option.subcategoryId,
      source: "product_evidence", evidence: selected.evidence, supplierClue, alternateOptions: [], riskFlags: [], reason: "PRODUCT_EVIDENCE_MATCH",
      clusterSignature: `evidence:${selected.option.categoryId}:${selected.option.subcategoryId || "none"}:${selected.evidence.join("|")}`,
    };
  }
  if (unique.length > 1) {
    return {
      outcome: "ADMIN_CHOICE", confidence: "MEDIUM", categoryId: null, subcategoryId: null, source: "ambiguous",
      evidence: [...new Set(unique.flatMap((item) => item.evidence))], supplierClue,
      alternateOptions: unique.map((item) => ({ ...item.option, reason: item.evidence.join(", ") })), riskFlags: [], reason: "MULTIPLE_PRODUCT_EVIDENCE_OPTIONS",
      clusterSignature: `choice:${signature}`,
    };
  }
  return {
    outcome: "NO_MATCH", confidence: "LOW", categoryId: null, subcategoryId: null, source: "unresolved",
    evidence: [], supplierClue, alternateOptions: [], riskFlags: [], reason: "NO_SAFE_PRODUCT_EVIDENCE_MATCH",
    clusterSignature: `unresolved:${signature}`,
  };
}

export function simulateLaunch1000TaxonomyAssignment(candidate: Launch1000Candidate, selection: { categoryId: string | null; subcategoryId: string | null }, catalog: readonly Launch1000Category[]): Launch1000Simulation {
  const blockers = new Set<string>(candidate.otherBlockers || []);
  if (!candidate.title.trim()) blockers.add("TITLE_REQUIRED");
  if (!candidate.description?.trim()) blockers.add("DESCRIPTION_REQUIRED");
  if (!Number.isFinite(candidate.price) || Number(candidate.price) <= 0) blockers.add("INVALID_PRICE");
  if (!Number.isInteger(candidate.stock) || Number(candidate.stock) < 0) blockers.add("INVALID_STOCK");
  if (!candidate.mediaReady) blockers.add("MEDIA_NOT_READY");
  if (!candidate.supplierAttributionValid) blockers.add("INVALID_ATTRIBUTION");
  if ((candidate.stock ?? 0) < 4) blockers.add("LOW_SUPPLIER_STOCK_FOR_PUBLICATION");
  const category = activeCategory(catalog, selection.categoryId);
  if (!category) blockers.add("CATEGORY_INVALID");
  else {
    const activeSubcategories = (category.subcategories || []).filter((item) => item.isActive !== false);
    if (activeSubcategories.length > 0 && !selection.subcategoryId) blockers.add("SUBCATEGORY_REQUIRED");
    else if (!validSelection(catalog, selection.categoryId || "", selection.subcategoryId)) blockers.add("SUBCATEGORY_INVALID");
    const specs = new Map(Object.entries(candidate.specifications || {}).map(([key, value]) => [normalizeLaunch1000Text(key), String(value ?? "").trim()]));
    for (const field of category.specificationTemplate || []) {
      if (field.required && !specs.get(normalizeLaunch1000Text(field.name))) blockers.add(`REQUIRED_SPEC:${field.name}`);
    }
  }
  return { wouldPassPublication: blockers.size === 0, blockers: [...blockers].sort() };
}

function distribution(values: string[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }));
}

export function buildLaunch1000Workbench(input: {
  candidates: readonly Launch1000Candidate[];
  catalog: readonly Launch1000Category[];
  trustedMappings?: readonly Launch1000TrustedMapping[];
}): Launch1000WorkbenchResult {
  const candidates = [...input.candidates].sort((a, b) => a.id.localeCompare(b.id)).map((candidate) => {
    const resolution = resolveLaunch1000Taxonomy({ candidate, catalog: input.catalog, trustedMappings: input.trustedMappings });
    const simulation = simulateLaunch1000TaxonomyAssignment(candidate, resolution, input.catalog);
    return { ...candidate, resolution, simulation };
  });
  const grouped = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const key = `${candidate.resolution.outcome}:${candidate.resolution.clusterSignature}:${candidate.resolution.categoryId || ""}:${candidate.resolution.subcategoryId || ""}`;
    const group = grouped.get(key) || [];
    group.push(candidate);
    grouped.set(key, group);
  }
  const clusters = [...grouped.entries()].map(([key, members]) => {
    const first = members[0];
    const blockerCounts = distribution(members.flatMap((member) => member.simulation.blockers))
      .map((item) => ({ blocker: item.value, count: item.count }));
    const evidenceTerms = distribution(members.flatMap((member) => member.resolution.evidence)).slice(0, 8).map((item) => item.value);
    const normalizedProductType = normalizeLaunch1000Text(first.productType || first.title).split(" ").slice(0, 5).join(" ") || "unclassified";
    return {
      clusterId: `launch1000-${key.replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "")}`,
      normalizedProductType,
      candidateCount: members.length,
      candidateIds: members.map((member) => member.id),
      representativeProducts: members.slice(0, 5).map((member) => ({ sku: member.sku, title: member.title })),
      evidenceTerms,
      supplierTaxonomyDistribution: distribution(members.flatMap((member) => member.supplierTaxonomy || [])),
      proposedCategoryId: first.resolution.categoryId,
      proposedSubcategoryId: first.resolution.subcategoryId,
      proposalSource: first.resolution.source,
      confidence: first.resolution.confidence,
      outcome: first.resolution.outcome,
      expectedReadyUnlockCount: members.filter((member) => member.resolution.outcome !== "POLICY_HOLD" && member.simulation.wouldPassPublication).length,
      expectedPostTaxonomyBlockers: blockerCounts,
      riskNotes: [...new Set(members.flatMap((member) => member.resolution.riskFlags))],
    } satisfies Launch1000Cluster;
  }).sort((a, b) => b.expectedReadyUnlockCount - a.expectedReadyUnlockCount || b.candidateCount - a.candidateCount || a.clusterId.localeCompare(b.clusterId));
  return { candidates, clusters };
}

export interface Launch1000ApplyContract {
  batchSize: 50 | 100;
  idempotencyKey: string;
  checkpoint: string | null;
  writes: "taxonomy_draft_fields_only";
  forbids: readonly string[];
}

export const launch1000FutureApplyContract = (clusterId: string, checkpoint: string | null = null): Launch1000ApplyContract => ({
  batchSize: 100,
  idempotencyKey: `launch1000:${clusterId}`,
  checkpoint,
  writes: "taxonomy_draft_fields_only",
  forbids: ["stock", "localDemand", "media", "supplierSync", "publication", "taxonomy_creation"],
});
