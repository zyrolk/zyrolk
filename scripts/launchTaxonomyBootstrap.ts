import { initializeApp as initializeClientApp, deleteApp as deleteClientApp } from 'firebase/app';
import { collection, getDocsFromServer, getFirestore as getClientFirestore } from 'firebase/firestore';
import { pathToFileURL } from 'node:url';
import appletConfig from '../firebase-applet-config.json';

export const LAUNCH_TAXONOMY_PROJECT_ID = 'zyrolk-e0164';
export const LAUNCH_TAXONOMY_CONFIRMATION = 'CREATE_MINIMAL_LAUNCH_TAXONOMY';

export interface LaunchTaxonomySubcategory {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
}

export interface LaunchTaxonomyTemplateField {
  readonly name: string;
  readonly required?: boolean;
}

export interface LaunchTaxonomyCategory {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly isActive: true;
  readonly subcategories: readonly LaunchTaxonomySubcategory[];
  readonly specificationTemplate: readonly LaunchTaxonomyTemplateField[];
}

export interface LaunchTaxonomyBrand {
  readonly id: string;
  readonly name: string;
  readonly isActive: true;
}

export interface LaunchTaxonomyRecordSet {
  readonly categories: readonly LaunchTaxonomyCategory[];
  readonly brands: readonly LaunchTaxonomyBrand[];
}

export interface LaunchTaxonomyExistingRecord {
  readonly id: string;
  readonly data: Record<string, unknown>;
}

export interface LaunchTaxonomyPlan {
  readonly errors: readonly string[];
  readonly createCategories: readonly LaunchTaxonomyCategory[];
  readonly updateCategories: readonly LaunchTaxonomyCategory[];
  readonly createBrands: readonly LaunchTaxonomyBrand[];
  readonly updateBrands: readonly LaunchTaxonomyBrand[];
  readonly productWrites: 0;
}

const category = (
  id: string,
  name: string,
  subcategories: readonly [string, string][],
  specificationTemplate: readonly LaunchTaxonomyTemplateField[],
): LaunchTaxonomyCategory => ({
  id,
  name,
  icon: 'Layers',
  isActive: true,
  subcategories: subcategories.map(([subcategoryId, subcategoryName]) => ({
    id: subcategoryId,
    name: subcategoryName,
    isActive: true,
  })),
  specificationTemplate,
});

const commonTemplate = [
  { name: 'Product Type', required: true },
  { name: 'Material' },
  { name: 'Color' },
  { name: 'Package Quantity' },
] as const;

export const LAUNCH_TAXONOMY: LaunchTaxonomyRecordSet = Object.freeze({
  categories: Object.freeze([
    category('accessories', 'Accessories', [
      ['mobile-accessories', 'Mobile Accessories'],
      ['personal-accessories', 'Personal Accessories'],
      ['fitness-accessories', 'Fitness Accessories'],
      ['watches', 'Watches'],
    ], commonTemplate),
    category('electronics', 'Electronics', [
      ['security-cameras', 'Security Cameras'],
      ['smart-devices', 'Smart Devices'],
      ['audio', 'Audio & Earbuds'],
      ['power-banks', 'Power Banks'],
      ['health-wellness', 'Health & Wellness'],
    ], [
      { name: 'Product Type', required: true },
      { name: 'Model' },
      { name: 'Material' },
      { name: 'Color' },
      { name: 'Connectivity' },
      { name: 'Power Source' },
    ]),
    category('home-kitchen', 'Home & Kitchen', [
      ['kitchen-tools', 'Kitchen Tools'],
      ['small-kitchen-appliances', 'Small Kitchen Appliances'],
      ['home-essentials', 'Home Essentials'],
      ['beauty-personal-care', 'Beauty & Personal Care'],
    ], commonTemplate),
    category('solar-lighting', 'Solar & Lighting', [
      ['solar-lights', 'Solar Lights'],
      ['lighting-accessories', 'Lighting Accessories'],
      ['solar-equipment', 'Solar Equipment'],
    ], [
      { name: 'Product Type', required: true },
      { name: 'Power Source' },
      { name: 'Wattage' },
      { name: 'Battery Capacity' },
      { name: 'Light Color' },
    ]),
    category('home-garden', 'Home & Garden', [
      ['painting-tools', 'Painting Tools'],
    ], commonTemplate),
  ]),
  brands: Object.freeze([
    Object.freeze({ id: 'generic', name: 'Generic', isActive: true }),
    Object.freeze({ id: 'california-beauty', name: 'California Beauty', isActive: true }),
    Object.freeze({ id: 'kinoki', name: 'Kinoki', isActive: true }),
  ]),
});

const text = (value: unknown): string => String(value || '').normalize('NFKC').trim();

const recordMap = (records: readonly LaunchTaxonomyExistingRecord[]): Map<string, Record<string, unknown>> => (
  new Map(records.map((record) => [record.id, record.data]))
);

const existingSubcategories = (value: unknown): Array<{ id: string; name: string; isActive: boolean }> => (
  Array.isArray(value)
    ? value
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
      .map((entry) => ({ id: text(entry.id), name: text(entry.name), isActive: entry.isActive === true }))
      .filter((entry) => Boolean(entry.id))
    : []
);

const existingTemplate = (value: unknown): Array<{ name: string; required: boolean }> => (
  Array.isArray(value)
    ? value
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
      .map((entry) => ({ name: text(entry.name), required: entry.required === true }))
      .filter((entry) => Boolean(entry.name))
    : []
);

const mergeCategoryFields = (
  desired: LaunchTaxonomyCategory,
  current: Record<string, unknown>,
): LaunchTaxonomyCategory => {
  const subcategories = existingSubcategories(current.subcategories);
  const subcategoryIds = new Set(subcategories.map((entry) => entry.id));
  const mergedSubcategories = [
    ...subcategories,
    ...desired.subcategories.filter((entry) => !subcategoryIds.has(entry.id)),
  ];
  const template = existingTemplate(current.specificationTemplate);
  const templateNames = new Set(template.map((entry) => entry.name.toLocaleLowerCase()));
  const mergedTemplate = [
    ...template,
    ...desired.specificationTemplate.filter((entry) => !templateNames.has(entry.name.toLocaleLowerCase())),
  ];
  return {
    ...desired,
    subcategories: mergedSubcategories,
    specificationTemplate: mergedTemplate,
  };
};

export function planLaunchTaxonomy(
  existingCategories: readonly LaunchTaxonomyExistingRecord[],
  existingBrands: readonly LaunchTaxonomyExistingRecord[],
): LaunchTaxonomyPlan {
  const errors: string[] = [];
  const categories = recordMap(existingCategories);
  const brands = recordMap(existingBrands);
  const desiredCategoryIds = new Set(LAUNCH_TAXONOMY.categories.map((entry) => entry.id));
  const desiredSubcategoryParents = new Map<string, string>();

  for (const existing of existingCategories) {
    for (const subcategory of existingSubcategories(existing.data.subcategories)) {
      const parent = desiredSubcategoryParents.get(subcategory.id);
      if (parent && parent !== existing.id) {
        errors.push(`Subcategory ${subcategory.id} is claimed by multiple existing parents: ${parent}, ${existing.id}.`);
      } else {
        desiredSubcategoryParents.set(subcategory.id, existing.id);
      }
    }
  }

  const createCategories: LaunchTaxonomyCategory[] = [];
  const updateCategories: LaunchTaxonomyCategory[] = [];
  for (const desired of LAUNCH_TAXONOMY.categories) {
    const current = categories.get(desired.id);
    if (!current) {
      createCategories.push(desired);
      continue;
    }
    if (text(current.name) !== desired.name) {
      errors.push(`Category ${desired.id} exists with conflicting name "${text(current.name)}".`);
      continue;
    }
    if (current.isActive !== true) {
      errors.push(`Category ${desired.id} is inactive or invalid; refusing to reuse it.`);
      continue;
    }
    for (const subcategory of desired.subcategories) {
      const owner = desiredSubcategoryParents.get(subcategory.id);
      if (owner && owner !== desired.id) {
        errors.push(`Subcategory ${subcategory.id} belongs to existing category ${owner}, not ${desired.id}.`);
      }
      const currentSubcategory = existingSubcategories(current.subcategories).find((entry) => entry.id === subcategory.id);
      if (currentSubcategory && currentSubcategory.name !== subcategory.name) {
        errors.push(`Subcategory ${subcategory.id} under ${desired.id} has conflicting name "${currentSubcategory.name}".`);
      }
      if (currentSubcategory?.isActive === false) {
        errors.push(`Subcategory ${subcategory.id} under ${desired.id} is inactive; refusing to reuse it.`);
      }
    }
    const merged = mergeCategoryFields(desired, current);
    if (JSON.stringify(merged.subcategories) !== JSON.stringify(current.subcategories)
      || JSON.stringify(merged.specificationTemplate) !== JSON.stringify(current.specificationTemplate)
      || current.icon === undefined) {
      updateCategories.push(merged);
    }
  }

  for (const existing of existingCategories) {
    if (desiredCategoryIds.has(existing.id)) continue;
    for (const subcategory of existingSubcategories(existing.data.subcategories)) {
      const desiredParent = [...LAUNCH_TAXONOMY.categories].find((candidate) => (
        candidate.subcategories.some((entry) => entry.id === subcategory.id)
      ));
      if (desiredParent) {
        errors.push(`Subcategory ${subcategory.id} is already owned by unrelated category ${existing.id}.`);
      }
    }
  }

  const createBrands: LaunchTaxonomyBrand[] = [];
  const updateBrands: LaunchTaxonomyBrand[] = [];
  for (const desired of LAUNCH_TAXONOMY.brands) {
    const current = brands.get(desired.id);
    if (!current) {
      createBrands.push(desired);
      continue;
    }
    if (text(current.name) !== desired.name) {
      errors.push(`Brand ${desired.id} exists with conflicting name "${text(current.name)}".`);
      continue;
    }
    if (current.isActive !== true) {
      errors.push(`Brand ${desired.id} is inactive or invalid; refusing to reuse it.`);
      continue;
    }
    if (current.isActive === undefined) updateBrands.push(desired);
  }

  return {
    errors: [...new Set(errors)].sort(),
    createCategories,
    updateCategories,
    createBrands,
    updateBrands,
    productWrites: 0,
  };
}

const readCurrentTaxonomy = async (): Promise<{
  categories: LaunchTaxonomyExistingRecord[];
  brands: LaunchTaxonomyExistingRecord[];
}> => {
  const app = initializeClientApp(appletConfig, `launch-taxonomy-preview-${Date.now()}`);
  try {
    const db = getClientFirestore(app);
    const [categorySnapshot, brandSnapshot] = await Promise.all([
      getDocsFromServer(collection(db, 'categories')),
      getDocsFromServer(collection(db, 'brands')),
    ]);
    return {
      categories: categorySnapshot.docs.map((document) => ({ id: document.id, data: document.data() })),
      brands: brandSnapshot.docs.map((document) => ({ id: document.id, data: document.data() })),
    };
  } finally {
    await deleteClientApp(app);
  }
};

export const summarizeLaunchTaxonomyPlan = (plan: LaunchTaxonomyPlan) => ({
  errors: plan.errors,
  createCategories: plan.createCategories.map((entry) => entry.id),
  updateCategories: plan.updateCategories.map((entry) => entry.id),
  createBrands: plan.createBrands.map((entry) => entry.id),
  updateBrands: plan.updateBrands.map((entry) => entry.id),
  productWrites: plan.productWrites,
  valid: plan.errors.length === 0,
});

const applyLaunchTaxonomy = async (plan: LaunchTaxonomyPlan): Promise<void> => {
  if (plan.errors.length > 0) throw new Error(`Launch taxonomy preflight failed:\n${plan.errors.join('\n')}`);
  if (process.env.LAUNCH_TAXONOMY_CONFIRM !== LAUNCH_TAXONOMY_CONFIRMATION) {
    throw new Error(`Set LAUNCH_TAXONOMY_CONFIRM=${LAUNCH_TAXONOMY_CONFIRMATION} to authorize the production batch.`);
  }
  const [{ applicationDefault, getApps, initializeApp }, { getFirestore }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/firestore'),
  ]);
  const app = getApps()[0] ?? initializeApp({
    credential: applicationDefault(),
    projectId: LAUNCH_TAXONOMY_PROJECT_ID,
  });
  const db = getFirestore(app);
  const now = new Date().toISOString();
  const batch = db.batch();
  for (const brand of [...plan.createBrands, ...plan.updateBrands]) {
    const reference = db.collection('brands').doc(brand.id);
    batch.set(reference, { id: brand.id, name: brand.name, isActive: true, updatedAt: now }, { merge: true });
  }
  for (const category of [...plan.createCategories, ...plan.updateCategories]) {
    const reference = db.collection('categories').doc(category.id);
    batch.set(reference, {
      id: category.id,
      name: category.name,
      icon: category.icon,
      isActive: true,
      subcategories: category.subcategories,
      specificationTemplate: category.specificationTemplate,
      updatedAt: now,
    }, { merge: true });
  }
  await batch.commit();
};

const main = async (): Promise<void> => {
  if (appletConfig.projectId !== LAUNCH_TAXONOMY_PROJECT_ID) {
    throw new Error(`Configured Firebase project ${appletConfig.projectId} is not ${LAUNCH_TAXONOMY_PROJECT_ID}.`);
  }
  const current = await readCurrentTaxonomy();
  const plan = planLaunchTaxonomy(current.categories, current.brands);
  console.info(JSON.stringify({
    mode: process.argv.includes('--apply') ? 'apply' : 'dry-run',
    projectId: LAUNCH_TAXONOMY_PROJECT_ID,
    current: { categories: current.categories.length, brands: current.brands.length },
    desired: { categories: LAUNCH_TAXONOMY.categories.length, brands: LAUNCH_TAXONOMY.brands.length },
    plan: summarizeLaunchTaxonomyPlan(plan),
    records: {
      categories: LAUNCH_TAXONOMY.categories,
      brands: LAUNCH_TAXONOMY.brands,
    },
  }, null, 2));
  if (process.argv.includes('--apply')) await applyLaunchTaxonomy(plan);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Launch taxonomy bootstrap failed.');
    process.exitCode = 1;
  });
}
