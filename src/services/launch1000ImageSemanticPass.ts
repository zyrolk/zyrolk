import {
  normalizeLaunch1000Text,
  type Launch1000Candidate,
  type Launch1000Category,
  type Launch1000TrustedMapping,
} from "./launch1000TaxonomyWorkbench";

export type Launch1000SemanticClass =
  | "HIGH_CONFIDENCE_EXISTING_TAXONOMY"
  | "ADMIN_CHOICE"
  | "NEW_TAXONOMY_NEEDED"
  | "INSUFFICIENT_EVIDENCE"
  | "POLICY_HOLD";

export type Launch1000SpecDisposition =
  | "NONE"
  | "DETERMINISTIC_SPEC_NORMALIZATION"
  | "ADMIN_SPEC_CHOICE"
  | "INSUFFICIENT_SPEC_EVIDENCE";

export interface Launch1000ManagedImageEvidence {
  available: boolean;
  fetchVerified?: boolean;
  mimeType?: string;
  width?: number;
  height?: number;
  imageUrl?: string;
  storagePath?: string;
  visualEvidence?: string;
}

export interface Launch1000SemanticCandidate extends Launch1000Candidate {
  managedImage?: Launch1000ManagedImageEvidence;
}

export interface Launch1000SemanticResult {
  candidateId: string;
  sku: string;
  title: string;
  classification: Launch1000SemanticClass;
  categoryId: string | null;
  subcategoryId: string | null;
  categoryLabel: string | null;
  subcategoryLabel: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  evidence: string[];
  supplierClue: string[];
  imageEvidence: string[];
  reason: string;
  riskFlags: string[];
  specDisposition: Launch1000SpecDisposition;
  proposedSpec?: { field: string; value: string; evidence: string };
  postTaxonomyBlockers: string[];
  cleanReadyAfterTaxonomy: boolean;
  cleanReadyAfterSafeSpec: boolean;
  clusterSignature: string;
}

interface TaxonomySelection {
  categoryId: string;
  subcategoryId: string | null;
  categoryLabel: string;
  subcategoryLabel: string | null;
}

interface SemanticRule {
  key: string;
  categoryId: string;
  subcategoryId: string | null;
  title: RegExp;
  supporting?: RegExp[];
  evidence: string;
  productType: string;
}

const POLICY_PATTERNS: Array<[string, RegExp]> = [
  ["WEAPON_OR_BLADE_REVIEW", /\b(knife|knives|blade|sword|machete|weapon|dagger|gun|knuckle)\b/iu],
  ["REGULATED_HEALTH_REVIEW", /\b(medicine|medication|antibiotic|prescription|drug|pharmaceutical|diabetic|supplement)\b/iu],
  ["HAZARDOUS_CHEMICAL_REVIEW", /\b(pesticide|insecticide|herbicide|solvent|acid|flammable|corrosive|paint thinner)\b/iu],
  ["ADULT_RESTRICTED_REVIEW", /\b(adult\s+(?:toy|product)|sex\s+toy|erotic|intimate\s+(?:toy|product))\b/iu],
  ["TOBACCO_VAPING_REVIEW", /\b(tobacco|cigarette|vape|vaping|nicotine)\b/iu],
  ["COUNTERFEIT_AUTHENTICITY_REVIEW", /\b(replica|fake|counterfeit|1:1|copy of|genuine (?:hublot|audemars|casio|caterpillar)|hublot|audemars|rolex|patek philippe)\b/iu],
];

const RULES: SemanticRule[] = [
  { key: "audio", categoryId: "electronics", subcategoryId: "audio", title: /\b(earbuds?|headphones?|subwoofer|bluetooth speaker|wireless speaker|headset)\b/iu, evidence: "explicit audio product type", productType: "audio device" },
  { key: "smart-watch", categoryId: "electronics", subcategoryId: "smart-watches", title: /\b(smart ?watch|smartwatch)\b/iu, evidence: "explicit smart watch product type", productType: "smart watch" },
  { key: "power-bank", categoryId: "electronics", subcategoryId: "power-banks", title: /\b(power ?bank|powerbank|portable charger)\b/iu, evidence: "explicit power bank product type", productType: "power bank" },
  { key: "security-camera", categoryId: "electronics", subcategoryId: "security-cameras", title: /\b(dummy cctv|cctv camera|security camera|surveillance camera)\b/iu, evidence: "explicit security camera product type", productType: "security camera" },
  { key: "action-camera", categoryId: "electronics", subcategoryId: "action-cameras", title: /\b(action camera|gopro|sports camera)\b/iu, evidence: "explicit action camera product type", productType: "action camera" },
  { key: "computer-accessory", categoryId: "electronics", subcategoryId: "computer-accessories", title: /\b(bluetooth keyboard|wireless keyboard|keyboard|computer mouse|laptop stand|laptop cooling)\b/iu, evidence: "explicit computer accessory product type", productType: "computer accessory" },
  { key: "electronic-accessory", categoryId: "electronics", subcategoryId: "electronic-accessories", title: /\b(projector|calculator|door bell|doorbell|gps tracker|battery charger|rechargeable battery|selfie stick|tripod|laser pointer)\b/iu, evidence: "explicit electronic accessory product type", productType: "electronic accessory" },
  { key: "phone-accessory", categoryId: "phone-accessories", subcategoryId: "phone-accessories", title: /\b(phone case|mobile cover|screen protector|phone pouch|phone holder|mobile charger|phone charger)\b/iu, evidence: "explicit phone accessory product type", productType: "phone accessory" },
  { key: "car-dash-camera", categoryId: "automotive", subcategoryId: "dash-cameras", title: /\b(dash ?cam|dashboard camera)\b/iu, evidence: "explicit automotive dash camera product type", productType: "dash camera" },
  { key: "car-care", categoryId: "automotive", subcategoryId: "car-care-cleaning", title: /\b(car duster|scratch wax|car wax|vehicle wax|car polish|vehicle polish|anti[- ]fog.*windshield|windshield.*repair)\b/iu, evidence: "explicit car care product type", productType: "car care product" },
  { key: "vehicle-interior", categoryId: "automotive", subcategoryId: "interior-accessories", title: /\b(car mat|car carpet|seat cover|car arm ?rest|vehicle seat|sun visor organizer|car ashtray|steering wheel|car phone holder|vehicle refrigerator|car fridge)\b/iu, evidence: "explicit vehicle interior product type", productType: "vehicle interior accessory" },
  { key: "vehicle-exterior", categoryId: "automotive", subcategoryId: "exterior-accessories", title: /\b(fog light|headlight|tail ?light|vehicle body light|car door|car window sunshade|windshield|vehicle sealing|number plate|bonnet light|angel eye|devil eye)\b/iu, evidence: "explicit vehicle exterior product type", productType: "vehicle exterior accessory" },
  { key: "motorcycle", categoryId: "automotive", subcategoryId: "motorcycle-accessories", title: /\b(motorcycle|motorbike|biker|bike mask|bike accessory)\b/iu, evidence: "explicit motorcycle accessory product type", productType: "motorcycle accessory" },
  { key: "makeup", categoryId: "health-beauty", subcategoryId: "makeup", title: /\b(makeup|foundation|lipstick|eyeshadow|mascara|concealer|hair mascara)\b/iu, evidence: "explicit makeup product type", productType: "makeup product" },
  { key: "skin-care", categoryId: "health-beauty", subcategoryId: "skin-care", title: /\b(serum|moisturizer|lotion|cleanser|skin ?care|facial|face wash)\b/iu, evidence: "explicit skin care product type", productType: "skin care product" },
  { key: "hair-styling", categoryId: "health-beauty", subcategoryId: "hair-styling", title: /\b(hair dryer|hair straightener|curling iron|automatic curler|hair braider)\b/iu, evidence: "explicit hair styling product type", productType: "hair styling tool" },
  { key: "grooming", categoryId: "health-beauty", subcategoryId: "shavers-trimmers", title: /\b(shaver|trimmer|hair clipper|beard clipper|epilator)\b/iu, evidence: "explicit shaver/trimmer product type", productType: "grooming tool" },
  { key: "hair-care", categoryId: "health-beauty", subcategoryId: "hair-care", title: /\b(wig|hair band|hair growth|henna|hair oil|hair brush)\b/iu, evidence: "explicit hair care product type", productType: "hair care product" },
  { key: "oral-care", categoryId: "health-beauty", subcategoryId: "oral-care", title: /\b(toothbrush|toothpaste|tooth paste|tongue cleaning|oral care|floss|water flosser)\b/iu, evidence: "explicit oral care product type", productType: "oral care product" },
  { key: "massage", categoryId: "health-beauty", subcategoryId: "massage-wellness", title: /\b(massage roller|massager|massage gun|ems.*massage)\b/iu, evidence: "explicit massage/wellness product type", productType: "massage/wellness product" },
  { key: "fragrance", categoryId: "health-beauty", subcategoryId: "fragrances", title: /\b(perfume|fragrance|cologne|vehicle aroma|car perfume)\b/iu, evidence: "explicit fragrance product type", productType: "fragrance" },
  { key: "shapewear", categoryId: "fashion", subcategoryId: "shapewear", title: /\b(hot shaper|shapewear|slimming.*pants|body shaping)\b/iu, evidence: "explicit shapewear product type", productType: "shapewear" },
  { key: "eyewear", categoryId: "fashion", subcategoryId: "eyewear", title: /\b(sunglasses?|eyewear|spectacles?)\b/iu, evidence: "explicit eyewear product type", productType: "eyewear" },
  { key: "fashion-watch", categoryId: "fashion", subcategoryId: "watches", title: /\b(wristwatch|water[- ]resistant.*watch|leather watch|classic.*watch|digital watch)\b/iu, evidence: "explicit watch product type", productType: "watch" },
  { key: "fashion-personal", categoryId: "fashion", subcategoryId: "men-s-accessories", title: /\b(wallet|belt|handbag|crossbody bag|shoulder bag|sling bag|chest bag|waist bag)\b/iu, evidence: "explicit personal accessory product type", productType: "personal accessory" },
  { key: "footwear", categoryId: "fashion", subcategoryId: "footwear-accessories", title: /\b(shoe|shoes|sandal|skating shoes|slippers?)\b/iu, evidence: "explicit footwear product type", productType: "footwear" },
  { key: "hat-cap", categoryId: "fashion", subcategoryId: "hats-caps", title: /\b(cap|hat|hood)\b/iu, evidence: "explicit hat/cap product type", productType: "hat or cap" },
  { key: "baby", categoryId: "baby-kids", subcategoryId: "baby-care", title: /\b(baby|infant|feeding|stroller|dining chair safety belt|children.?s thermos)\b/iu, evidence: "explicit baby-care product type", productType: "baby care product" },
  { key: "toy", categoryId: "kids-toys", subcategoryId: null, title: /\b(toy|doll|puzzle|building blocks|water pistol|magic trick|wacky trick|dinosaur.*(toy|light|sound))\b/iu, evidence: "explicit toy product type", productType: "toy" },
  { key: "kitchen-appliance", categoryId: "home-kitchen", subcategoryId: "small-kitchen-appliances", title: /\b(blender|juicer|air fryer|kettle|mixer|toaster|rice cooker|sandwich maker|deep fryer|single burner|hotplate)\b/iu, evidence: "explicit small kitchen appliance product type", productType: "kitchen appliance" },
  { key: "kitchen-tool", categoryId: "home-kitchen", subcategoryId: "kitchen-tools", title: /\b(gas stove support|frying pan|sauce ?pan|cooking pot|cutlery|food cover|cake decoration|sink wrench|kitchen wall|nonstick|drainer)\b/iu, evidence: "explicit kitchen tool/product type", productType: "kitchen tool" },
  { key: "home-essential", categoryId: "home-kitchen", subcategoryId: "home-essentials", title: /\b(food cover|chair cover|sofa|couch tray|water can|cup|bread container|fruit tray|dish drying mat|storage box|inflatable sofa)\b/iu, evidence: "explicit home essential product type", productType: "home essential" },
  { key: "home-household", categoryId: "home-garden", subcategoryId: "household", title: /\b(toilet|cleaning brush|cleaning cloth|cleaner|mop|chair cover|fridge cover|drain hose|washing machine cover|clothes rack|hanger|shoe rack|storage rack|organizer|storage bag|shopping bag|chair cover|carpet|mat|shoe shine|leather goods dry cleaner)\b/iu, evidence: "explicit household product type", productType: "household product" },
  { key: "home-tools", categoryId: "home-garden", subcategoryId: "tools-hardware", title: /\b(drill|hammer|screwdriver|wrench|pliers|chisel|soldering|laser distance|grease gun|engraver|clamp|jack support|saw|grinder|sander|welding|crimper|bender|leveler|caliper|cutter|paint spray gun|hose clamp|ladder|lock|cabinet rail|glass cutter|rebar)\b/iu, evidence: "explicit tools and hardware product type", productType: "tool or hardware" },
  { key: "garden-tools", categoryId: "home-garden", subcategoryId: "garden-tools", title: /\b(garden|pruning|watering|rake|weed puller|plant stand|soil|hose)\b/iu, evidence: "explicit garden product type", productType: "garden tool" },
  { key: "solar-light", categoryId: "solar-lighting", subcategoryId: "solar-lights", title: /\b(solar light|solar lamp|solar fountain|solar fire ?fly)\b/iu, evidence: "explicit solar light product type", productType: "solar light" },
  { key: "led-light", categoryId: "solar-lighting", subcategoryId: "led-lights", title: /\b(led bulb|led light|led strip)\b/iu, evidence: "explicit LED light product type", productType: "LED light" },
  { key: "torch", categoryId: "solar-lighting", subcategoryId: "torches-lanterns", title: /\b(torch|flashlight|lantern)\b/iu, evidence: "explicit torch/lantern product type", productType: "torch or lantern" },
  { key: "rechargeable-light", categoryId: "solar-lighting", subcategoryId: "rechargeable-lights", title: /\b(rechargeable light|portable light|emergency light)\b/iu, evidence: "explicit rechargeable/emergency light product type", productType: "rechargeable light" },
];

function activeSelection(catalog: readonly Launch1000Category[], categoryId: string, subcategoryId: string | null): TaxonomySelection | null {
  const category = catalog.find((item) => item.id === categoryId && item.isActive === true && item.taxonomyCandidate !== true);
  if (!category) return null;
  const sub = subcategoryId ? (category.subcategories || []).find((item) => item.id === subcategoryId && item.isActive !== false) : null;
  const activeSubs = (category.subcategories || []).filter((item) => item.isActive !== false);
  if (activeSubs.length > 0 && !sub) return null;
  return { categoryId, subcategoryId: sub?.id || null, categoryLabel: category.name, subcategoryLabel: sub?.name || null };
}

function productEvidence(candidate: Launch1000SemanticCandidate): string {
  return [candidate.title, candidate.description, candidate.productType, ...(candidate.features || []), ...Object.entries(candidate.specifications || {}).flatMap(([key, value]) => [key, String(value ?? "")]), candidate.brand].filter(Boolean).join(" ");
}

function normalizedSupplierClue(candidate: Launch1000SemanticCandidate): string[] {
  return (candidate.supplierTaxonomy || []).map(normalizeLaunch1000Text).filter(Boolean);
}

function policyFlags(candidate: Launch1000SemanticCandidate): string[] {
  const text = productEvidence(candidate);
  return POLICY_PATTERNS.filter(([flag, pattern]) => {
    if (flag === "WEAPON_OR_BLADE_REVIEW" && ( /\b(grease|paint spray|soldering|de[- ]?soldering|welding|caulk|sealant|pressure|revert|glue|heat) .{0,20}\bgun\b/iu.test(text) || /\b(caulk|sealant|soldering|welding|paint spray|pressure|revert|de[- ]?soldering)\b/iu.test(candidate.title) ) && !/^\s*gun\s*$/iu.test(candidate.title)) return false;
    return pattern.test(text);
  }).map(([flag]) => flag);
}

function selectionRules(candidate: Launch1000SemanticCandidate, catalog: readonly Launch1000Category[]): Array<{ rule: SemanticRule; selection: TaxonomySelection }> {
  const text = productEvidence(candidate);
  return RULES.flatMap((rule) => rule.title.test(text) ? [{ rule, selection: activeSelection(catalog, rule.categoryId, rule.subcategoryId) }].filter((item): item is { rule: SemanticRule; selection: TaxonomySelection } => Boolean(item.selection)) : []);
}

function hasExplicitProductType(candidate: Launch1000SemanticCandidate, rule: SemanticRule): boolean {
  const text = productEvidence(candidate);
  return rule.title.test(candidate.title) || rule.title.test(text) || Boolean(candidate.productType?.trim());
}

function semanticProductFamily(candidate: Launch1000SemanticCandidate, ruleKey: string): string {
  const title = normalizeLaunch1000Text(candidate.title);
  const families: Array<[RegExp, string]> = [
    [/\b(earbuds?|headphones?|subwoofer|speaker|headset)\b/iu, "audio"],
    [/\b(drill|wrench|screwdriver|pliers|chisel|grinder|cutter|soldering|welding|clamp|leveler|caliper|rake|mop)\b/iu, "$1"],
    [/\b(rack|hanger|organizer|storage bag|storage box|cleaning brush|cleaning cloth|chair cover|mat|carpet)\b/iu, "$1"],
    [/\b(fog light|headlight|tail light|car door|sun visor|steering wheel|car phone holder)\b/iu, "$1"],
    [/\b(watch|wallet|belt|handbag|backpack|crossbody bag|sling bag|shoe|sandal)\b/iu, "$1"],
    [/\b(toy|doll|puzzle|blocks)\b/iu, "$1"],
    [/\b(frying pan|sauce pan|wok|food cover|cutlery|kitchen)\b/iu, "$1"],
    [/\b(torch|flashlight|lantern|led|solar light|emergency light)\b/iu, "$1"],
    [/\b(hair|shaver|trimmer|mascara|lipstick|makeup|serum|lotion)\b/iu, "$1"],
  ];
  const match = families.find(([pattern]) => pattern.test(title));
  if (!match) return normalizeLaunch1000Text(candidate.title).split(" ").slice(0, 4).join("-") || ruleKey;
  const found = title.match(match[0]);
  return normalizeLaunch1000Text(found?.[1] || match[1] || ruleKey).replace(/\s+/gu, "-");
}

function simulate(candidate: Launch1000SemanticCandidate, selection: TaxonomySelection | null, catalog: readonly Launch1000Category[], proposedSpec?: { field: string; value: string; evidence: string }): { blockers: string[]; afterSpecBlockers: string[] } {
  const blockers = new Set(candidate.otherBlockers || []);
  if (!candidate.title.trim()) blockers.add("TITLE_REQUIRED");
  if (!candidate.description?.trim()) blockers.add("DESCRIPTION_REQUIRED");
  if (!Number.isFinite(candidate.price) || Number(candidate.price) <= 0) blockers.add("INVALID_PRICE");
  if (!Number.isInteger(candidate.stock) || Number(candidate.stock) < 0) blockers.add("INVALID_STOCK");
  if (!candidate.mediaReady) blockers.add("MEDIA_NOT_READY");
  if (!candidate.supplierAttributionValid) blockers.add("INVALID_ATTRIBUTION");
  if ((candidate.stock ?? 0) < 4) blockers.add("LOW_SUPPLIER_STOCK_FOR_PUBLICATION");
  if (!selection) blockers.add("CATEGORY_UNRESOLVED");
  else {
    const category = catalog.find((item) => item.id === selection.categoryId);
    const specs = new Map(Object.entries(candidate.specifications || {}).map(([key, value]) => [normalizeLaunch1000Text(key), String(value ?? "").trim()]));
    for (const field of category?.specificationTemplate || []) if (field.required && !specs.get(normalizeLaunch1000Text(field.name))) blockers.add(`REQUIRED_SPEC:${field.name}`);
  }
  const afterSpec = new Set(blockers);
  if (proposedSpec) afterSpec.delete(`REQUIRED_SPEC:${proposedSpec.field}`);
  return { blockers: [...blockers].sort(), afterSpecBlockers: [...afterSpec].sort() };
}

export function classifyLaunch1000SemanticCandidate(input: {
  candidate: Launch1000SemanticCandidate;
  catalog: readonly Launch1000Category[];
  trustedMappings?: readonly Launch1000TrustedMapping[];
}): Launch1000SemanticResult {
  const { candidate, catalog } = input;
  const supplierClue = normalizedSupplierClue(candidate);
  const imageEvidence = candidate.managedImage?.available ? [
    "managed media provenance present",
    ...(candidate.managedImage.fetchVerified ? ["managed image fetch verified"] : []),
    ...(candidate.managedImage.visualEvidence ? [candidate.managedImage.visualEvidence] : []),
  ] : ["managed image not available for semantic inspection"];
  const flags = policyFlags(candidate);
  if (candidate.policyHold || flags.length > 0) {
    return {
      candidateId: candidate.id, sku: candidate.sku, title: candidate.title, classification: "POLICY_HOLD",
      categoryId: null, subcategoryId: null, categoryLabel: null, subcategoryLabel: null, confidence: "HIGH",
      evidence: [], supplierClue, imageEvidence, reason: "POLICY_REVIEW_REQUIRED", riskFlags: flags,
      specDisposition: "NONE", postTaxonomyBlockers: ["POLICY_REVIEW_REQUIRED"], cleanReadyAfterTaxonomy: false,
      cleanReadyAfterSafeSpec: false, clusterSignature: `policy:${flags.join("+") || "external"}`,
    };
  }
  const trusted = (input.trustedMappings || []).find((mapping) => {
    const supplier = normalizeLaunch1000Text(mapping.normalizedCategory || mapping.supplierCategory);
    const approved = Boolean(mapping.approvedBy || mapping.approvalStatus === "approved");
    const explicit = mapping.mappingType === "manual" || (mapping.mappingType === "learned" && approved && Number(mapping.confidence || 0) >= 0.9);
    return explicit && supplier && supplierClue.includes(supplier) && (!mapping.sourceId || mapping.sourceId === candidate.sourceId)
      && Boolean(activeSelection(catalog, String(mapping.targetCategoryId || ""), mapping.targetSubcategoryId ? String(mapping.targetSubcategoryId) : null));
  });
  const normalizedTitle = normalizeLaunch1000Text(candidate.title);
  const ambiguousVisualOrUseCase = /\b(sunglass holder|sunglasses holder|welding safety sunglass|photoshoot umbrella|reverse umbrella|kids umbrella|headache migraine relief hat|old man hood|foldable chair.*torch|torch.*chair|pill organizer|led.*slippers?|slippers?.*led|fan.*led|led.*fan|magnifying glass.*led|led.*magnifying glass|shoe shine|shoe container|car armrest)\b/iu.test(normalizedTitle);
  const ruleMatches = ambiguousVisualOrUseCase ? [] : selectionRules(candidate, catalog);
  const options = trusted ? [{ rule: null as SemanticRule | null, selection: activeSelection(catalog, String(trusted.targetCategoryId), trusted.targetSubcategoryId ? String(trusted.targetSubcategoryId) : null) as TaxonomySelection }] : ruleMatches;
  const unique = [...new Map(options.filter((item) => item.selection).map((item) => [`${item.selection.categoryId}:${item.selection.subcategoryId || ""}`, item])).values()];
  let classification: Launch1000SemanticClass;
  let selection: TaxonomySelection | null = null;
  let confidence: "HIGH" | "MEDIUM" | "LOW" = "LOW";
  let reason = "NO_SAFE_EXISTING_TAXONOMY_MATCH";
  let evidence: string[] = [];
  let clusterSignature = `unresolved:${normalizeLaunch1000Text(candidate.title).split(" ").slice(0, 4).join("-") || candidate.id}`;
  if (trusted && unique.length === 1) {
    classification = "HIGH_CONFIDENCE_EXISTING_TAXONOMY";
    selection = unique[0].selection;
    confidence = "HIGH";
    reason = "TRUSTED_MAPPING";
    evidence = ["approved trusted mapping"];
    clusterSignature = `mapping:${selection.categoryId}:${selection.subcategoryId || "none"}`;
  } else if (unique.length === 1) {
    const match = unique[0];
    selection = match.selection;
    const titleMatched = match.rule ? match.rule.title.test(candidate.title) : false;
    const supportingMatches = match.rule?.supporting?.filter((pattern) => pattern.test(productEvidence(candidate))).length || 0;
    if (titleMatched || supportingMatches >= 1) {
      classification = "HIGH_CONFIDENCE_EXISTING_TAXONOMY";
      confidence = "HIGH";
      reason = "PRODUCT_EVIDENCE_MATCH";
    } else {
      classification = "ADMIN_CHOICE";
      confidence = "MEDIUM";
      reason = "EVIDENCE_NOT_TITLE_ANCHORED";
    }
    evidence = [match.rule?.evidence || "product evidence", ...(candidate.productType ? [`product type: ${candidate.productType}`] : [])];
    clusterSignature = `evidence:${selection.categoryId}:${selection.subcategoryId || "none"}:${semanticProductFamily(candidate, match.rule?.key || "unknown")}`;
  } else if (unique.length > 1) {
    classification = "ADMIN_CHOICE";
    confidence = "MEDIUM";
    reason = "MULTIPLE_PRODUCT_EVIDENCE_OPTIONS";
    evidence = unique.map((item) => item.rule?.evidence || "product evidence");
    clusterSignature = `choice:${normalizeLaunch1000Text(candidate.title).split(" ").slice(0, 4).join("-") || candidate.id}`;
  } else {
    const text = productEvidence(candidate).trim();
    classification = ambiguousVisualOrUseCase ? "ADMIN_CHOICE" : text.length < 12 ? "INSUFFICIENT_EVIDENCE" : "NEW_TAXONOMY_NEEDED";
    if (ambiguousVisualOrUseCase) reason = "VISUAL_OR_USE_CASE_AMBIGUITY";
  }
  const proposedSpec = selection && classification === "HIGH_CONFIDENCE_EXISTING_TAXONOMY" && unique[0]?.rule && catalog.find((item) => item.id === selection?.categoryId)?.specificationTemplate?.some((field) => field.required && normalizeLaunch1000Text(field.name) === "product type") && hasExplicitProductType(candidate, unique[0].rule)
    ? { field: "Product Type", value: unique[0].rule.productType, evidence: unique[0].rule.evidence }
    : undefined;
  const simulated = simulate(candidate, selection, catalog, proposedSpec);
  const cleanReadyAfterTaxonomy = classification === "HIGH_CONFIDENCE_EXISTING_TAXONOMY" && simulated.blockers.length === 0;
  const cleanReadyAfterSafeSpec = classification === "HIGH_CONFIDENCE_EXISTING_TAXONOMY" && simulated.afterSpecBlockers.length === 0;
  const specDisposition: Launch1000SpecDisposition = proposedSpec ? "DETERMINISTIC_SPEC_NORMALIZATION"
    : simulated.blockers.some((blocker) => blocker.startsWith("REQUIRED_SPEC:")) ? "INSUFFICIENT_SPEC_EVIDENCE" : "NONE";
  return {
    candidateId: candidate.id, sku: candidate.sku, title: candidate.title, classification,
    categoryId: selection?.categoryId || null, subcategoryId: selection?.subcategoryId || null,
    categoryLabel: selection?.categoryLabel || null, subcategoryLabel: selection?.subcategoryLabel || null,
    confidence, evidence, supplierClue, imageEvidence, reason, riskFlags: flags, specDisposition, proposedSpec,
    postTaxonomyBlockers: simulated.blockers, cleanReadyAfterTaxonomy, cleanReadyAfterSafeSpec,
    clusterSignature,
  };
}

export function buildLaunch1000SemanticPass(input: {
  candidates: readonly Launch1000SemanticCandidate[];
  catalog: readonly Launch1000Category[];
  trustedMappings?: readonly Launch1000TrustedMapping[];
}): Launch1000SemanticResult[] {
  return [...input.candidates].sort((a, b) => a.id.localeCompare(b.id)).map((candidate) => classifyLaunch1000SemanticCandidate({ candidate, catalog: input.catalog, trustedMappings: input.trustedMappings }));
}

export function semanticPassCheckpoint(resultIds: readonly string[], batchSize = 100): { batchSize: number; processedIds: string[]; cursor: string | null } {
  const processedIds = [...new Set(resultIds)].sort();
  return { batchSize, processedIds, cursor: processedIds.at(-1) || null };
}
