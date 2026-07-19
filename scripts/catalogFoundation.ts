import { initializeApp as initializeClientApp, deleteApp as deleteClientApp } from 'firebase/app';
import { collection, getDocsFromServer, getFirestore as getClientFirestore } from 'firebase/firestore';
import appletConfig from '../firebase-applet-config.json';
import type { Brand, Category, Product } from '../src/types';
import { validateProductForSave } from '../src/services/products/productValidation';
import {
  auditCatalogFoundationState,
  buildConfiguredCatalogState,
  CATALOG_FOUNDATION_BRANDS,
  CATALOG_FOUNDATION_CATEGORIES,
  CATALOG_FOUNDATION_PRODUCTS,
  CATALOG_FOUNDATION_PROJECT_ID,
} from './catalogFoundationConfig';

const applyRequested = process.argv.includes('--apply');

const readPublicCatalog = async (): Promise<{ categories: Category[]; products: Product[] }> => {
  const app = initializeClientApp(appletConfig, `catalog-foundation-${Date.now()}`);
  try {
    const db = getClientFirestore(app);
    const [categorySnapshot, productSnapshot] = await Promise.all([
      getDocsFromServer(collection(db, 'categories')),
      getDocsFromServer(collection(db, 'products')),
    ]);
    return {
      categories: categorySnapshot.docs.map((document) => ({ id: document.id, ...document.data() } as Category)),
      products: productSnapshot.docs.map((document) => ({ id: document.id, ...document.data() } as Product)),
    };
  } finally {
    await deleteClientApp(app);
  }
};

const validateConfiguredCatalog = (categories: Category[], products: Product[]): readonly string[] => {
  const configured = buildConfiguredCatalogState(categories, products);
  const issues = [...auditCatalogFoundationState(configured)];
  const expectedCategoryIds = new Set(Object.keys(CATALOG_FOUNDATION_CATEGORIES));
  const expectedProductIds = new Set(Object.keys(CATALOG_FOUNDATION_PRODUCTS));

  for (const category of categories) {
    if (!expectedCategoryIds.has(category.id)) issues.push(`Category ${category.id} has no approved foundation configuration.`);
  }
  for (const categoryId of expectedCategoryIds) {
    if (!categories.some((category) => category.id === categoryId)) issues.push(`Configured category ${categoryId} does not exist.`);
  }
  for (const product of products) {
    if (product.isActive !== false && !expectedProductIds.has(product.id)) issues.push(`Active product ${product.id} has no approved foundation mapping.`);
  }
  for (const productId of expectedProductIds) {
    if (!products.some((product) => product.id === productId)) issues.push(`Configured product ${productId} does not exist.`);
  }

  for (const product of configured.products) {
    issues.push(...validateProductForSave({
      product,
      products: configured.products,
      categories: configured.categories,
      brands: configured.brands,
      editingProductId: product.id,
    }).map((issue) => `Product ${product.id}: ${issue}`));
  }
  return issues;
};

const applyCatalogFoundation = async (categories: Category[], products: Product[]): Promise<void> => {
  if (process.env.CATALOG_FOUNDATION_CONFIRM !== CATALOG_FOUNDATION_PROJECT_ID) {
    throw new Error(`Set CATALOG_FOUNDATION_CONFIRM=${CATALOG_FOUNDATION_PROJECT_ID} to authorize the production batch.`);
  }
  const [{ initializeApp, applicationDefault, getApps }, { getFirestore }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/firestore'),
  ]);
  const adminApp = getApps()[0] ?? initializeApp({
    credential: applicationDefault(),
    projectId: CATALOG_FOUNDATION_PROJECT_ID,
  });
  const db = getFirestore(adminApp);
  const [freshCategorySnapshot, freshProductSnapshot, freshBrandSnapshot] = await Promise.all([
    db.collection('categories').get(),
    db.collection('products').get(),
    db.collection('brands').get(),
  ]);
  const freshCategories = freshCategorySnapshot.docs.map((document) => ({ id: document.id, ...document.data() } as Category));
  const freshProducts = freshProductSnapshot.docs.map((document) => ({ id: document.id, ...document.data() } as Product));
  const preflightIssues = validateConfiguredCatalog(freshCategories, freshProducts);
  if (preflightIssues.length) throw new Error(`Production preflight failed:\n${preflightIssues.join('\n')}`);

  const now = new Date().toISOString();
  const existingBrands = new Map(freshBrandSnapshot.docs.map((document) => [document.id, document.data()]));
  const brandNames = new Map(CATALOG_FOUNDATION_BRANDS.map((brand) => [brand.id, brand.name]));
  const batch = db.batch();

  for (const brand of CATALOG_FOUNDATION_BRANDS) {
    batch.set(db.collection('brands').doc(brand.id), {
      id: brand.id,
      name: brand.name,
      isActive: true,
      createdAt: existingBrands.get(brand.id)?.createdAt ?? now,
      updatedAt: now,
    }, { merge: true });
  }
  for (const [categoryId, configuration] of Object.entries(CATALOG_FOUNDATION_CATEGORIES)) {
    batch.set(db.collection('categories').doc(categoryId), {
      subcategories: configuration.subcategories,
      specificationTemplate: configuration.specificationTemplate,
      updatedAt: now,
    }, { merge: true });
  }
  for (const product of freshProducts) {
    const configuration = CATALOG_FOUNDATION_PRODUCTS[product.id];
    if (!configuration) continue;
    batch.set(db.collection('products').doc(product.id), {
      brand: configuration.brand,
      subcategory: configuration.subcategory,
      productType: configuration.productType,
      ...(configuration.model ? { model: configuration.model } : {}),
      specs: {
        ...(product.specs ?? {}),
        ...configuration.specs,
        Brand: brandNames.get(configuration.brand) ?? configuration.brand,
        ...(configuration.model ? { Model: configuration.model } : {}),
      },
      updatedAt: now,
    }, { merge: true });
  }
  await batch.commit();

  const [verifiedCategorySnapshot, verifiedProductSnapshot, verifiedBrandSnapshot] = await Promise.all([
    db.collection('categories').get(),
    db.collection('products').get(),
    db.collection('brands').get(),
  ]);
  const verificationIssues = auditCatalogFoundationState({
    categories: verifiedCategorySnapshot.docs.map((document) => ({ id: document.id, ...document.data() } as Category)),
    products: verifiedProductSnapshot.docs.map((document) => ({ id: document.id, ...document.data() } as Product)),
    brands: verifiedBrandSnapshot.docs.map((document) => ({ id: document.id, ...document.data() } as Brand)),
  });
  if (verificationIssues.length) throw new Error(`Post-write verification failed:\n${verificationIssues.join('\n')}`);
};

const main = async (): Promise<void> => {
  if (appletConfig.projectId !== CATALOG_FOUNDATION_PROJECT_ID) {
    throw new Error(`Configured Firebase project ${appletConfig.projectId} is not ${CATALOG_FOUNDATION_PROJECT_ID}.`);
  }
  const current = await readPublicCatalog();
  const issues = validateConfiguredCatalog(current.categories, current.products);
  if (issues.length) throw new Error(`Catalog foundation dry run failed:\n${issues.join('\n')}`);
  console.info(JSON.stringify({
    mode: applyRequested ? 'apply' : 'dry-run',
    projectId: CATALOG_FOUNDATION_PROJECT_ID,
    brands: CATALOG_FOUNDATION_BRANDS.length,
    categories: Object.keys(CATALOG_FOUNDATION_CATEGORIES).length,
    products: Object.keys(CATALOG_FOUNDATION_PRODUCTS).length,
    validation: 'passed',
  }));
  if (applyRequested) {
    await applyCatalogFoundation(current.categories, current.products);
    console.info(JSON.stringify({ mode: 'apply', result: 'verified' }));
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Catalog foundation failed.');
  process.exitCode = 1;
});
