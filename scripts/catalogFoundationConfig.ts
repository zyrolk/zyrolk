import type { Brand, Category, Product, SpecificationTemplateField, SubCategory } from '../src/types';

export interface CatalogCategoryConfiguration {
  readonly subcategories: readonly SubCategory[];
  readonly specificationTemplate: readonly SpecificationTemplateField[];
}

export interface CatalogProductConfiguration {
  readonly brand: string;
  readonly subcategory: string;
  readonly productType: string;
  readonly model?: string;
  readonly specs: Readonly<Record<string, string>>;
}

export const CATALOG_FOUNDATION_PROJECT_ID = 'zyrolk-e0164';

export const CATALOG_FOUNDATION_BRANDS: readonly Brand[] = Object.freeze([
  Object.freeze({ id: 'generic', name: 'Generic', isActive: true }),
  Object.freeze({ id: 'california-beauty', name: 'California Beauty', isActive: true }),
  Object.freeze({ id: 'kinoki', name: 'Kinoki', isActive: true }),
]);

export const CATALOG_FOUNDATION_CATEGORIES: Readonly<Record<string, CatalogCategoryConfiguration>> = Object.freeze({
  accessories: Object.freeze({
    subcategories: Object.freeze([
      Object.freeze({ id: 'mobile-accessories', name: 'Mobile Accessories', isActive: true }),
      Object.freeze({ id: 'personal-accessories', name: 'Personal Accessories', isActive: true }),
      Object.freeze({ id: 'fitness-accessories', name: 'Fitness Accessories', isActive: true }),
    ]),
    specificationTemplate: Object.freeze([
      Object.freeze({ name: 'Product Type', required: true }),
      Object.freeze({ name: 'Material', required: false }),
      Object.freeze({ name: 'Color', required: false }),
      Object.freeze({ name: 'Compatibility', required: false }),
      Object.freeze({ name: 'Package Quantity', required: false }),
    ]),
  }),
  electronics: Object.freeze({
    subcategories: Object.freeze([
      Object.freeze({ id: 'security-cameras', name: 'Security Cameras', isActive: true }),
      Object.freeze({ id: 'health-wellness', name: 'Health & Wellness', isActive: true }),
      Object.freeze({ id: 'smart-devices', name: 'Smart Devices', isActive: true }),
    ]),
    specificationTemplate: Object.freeze([
      Object.freeze({ name: 'Product Type', required: true }),
      Object.freeze({ name: 'Model', required: false }),
      Object.freeze({ name: 'Material', required: false }),
      Object.freeze({ name: 'Color', required: false }),
      Object.freeze({ name: 'Connectivity', required: false }),
      Object.freeze({ name: 'Power Source', required: false }),
    ]),
  }),
  'home-kitchen': Object.freeze({
    subcategories: Object.freeze([
      Object.freeze({ id: 'beauty-personal-care', name: 'Beauty & Personal Care', isActive: true }),
      Object.freeze({ id: 'kitchen-tools', name: 'Kitchen Tools', isActive: true }),
      Object.freeze({ id: 'home-essentials', name: 'Home Essentials', isActive: true }),
    ]),
    specificationTemplate: Object.freeze([
      Object.freeze({ name: 'Product Type', required: true }),
      Object.freeze({ name: 'Material', required: false }),
      Object.freeze({ name: 'Color', required: false }),
      Object.freeze({ name: 'Package Quantity', required: false }),
    ]),
  }),
  'solar-lighting': Object.freeze({
    subcategories: Object.freeze([
      Object.freeze({ id: 'solar-lights', name: 'Solar Lights', isActive: true }),
      Object.freeze({ id: 'lighting-accessories', name: 'Lighting Accessories', isActive: true }),
      Object.freeze({ id: 'solar-equipment', name: 'Solar Equipment', isActive: true }),
    ]),
    specificationTemplate: Object.freeze([
      Object.freeze({ name: 'Product Type', required: true }),
      Object.freeze({ name: 'Power Source', required: false }),
      Object.freeze({ name: 'Wattage', required: false }),
      Object.freeze({ name: 'Battery Capacity', required: false }),
      Object.freeze({ name: 'Light Color', required: false }),
    ]),
  }),
});

export const CATALOG_FOUNDATION_PRODUCTS: Readonly<Record<string, CatalogProductConfiguration>> = Object.freeze({
  '10-pcs-makeup-brush-with-pouch': Object.freeze({
    brand: 'generic',
    subcategory: 'beauty-personal-care',
    productType: 'Makeup Brush Set',
    specs: Object.freeze({ 'Product Type': 'Makeup Brush Set', 'Package Quantity': '10 Pieces' }),
  }),
  '2-pcs-knee-brace-protector': Object.freeze({
    brand: 'generic',
    subcategory: 'health-wellness',
    productType: 'Knee Brace Protector',
    specs: Object.freeze({ 'Product Type': 'Knee Brace Protector', 'Package Quantity': '2 Pieces' }),
  }),
  'a9-mini-wireless-camera': Object.freeze({
    brand: 'generic',
    subcategory: 'security-cameras',
    productType: 'Wireless Security Camera',
    model: 'A9',
    specs: Object.freeze({
      'Product Type': 'Wireless Security Camera',
      Model: 'A9',
      Material: 'ABS',
      Color: 'Black',
      Connectivity: 'Wireless',
    }),
  }),
  'califonia-body-shaper': Object.freeze({
    brand: 'california-beauty',
    subcategory: 'health-wellness',
    productType: 'Body Shaper',
    specs: Object.freeze({ 'Product Type': 'Body Shaper' }),
  }),
  'detox-foot-pad-10-pads': Object.freeze({
    brand: 'kinoki',
    subcategory: 'health-wellness',
    productType: 'Detox Foot Pads',
    specs: Object.freeze({ 'Product Type': 'Detox Foot Pads', 'Package Quantity': '10 Pads' }),
  }),
});

export interface CatalogFoundationState {
  readonly categories: readonly Readonly<Category>[];
  readonly brands: readonly Readonly<Brand>[];
  readonly products: readonly Readonly<Product>[];
}

export const buildConfiguredCatalogState = (
  currentCategories: readonly Readonly<Category>[],
  currentProducts: readonly Readonly<Product>[],
): CatalogFoundationState => {
  const brandNames = new Map(CATALOG_FOUNDATION_BRANDS.map((brand) => [brand.id, brand.name]));
  const categories = currentCategories.map((category) => {
    const configuration = CATALOG_FOUNDATION_CATEGORIES[category.id];
    return configuration ? {
      ...category,
      subcategories: configuration.subcategories.map((subcategory) => ({ ...subcategory })),
      specificationTemplate: configuration.specificationTemplate.map((field) => ({ ...field })),
    } : { ...category };
  });
  const products = currentProducts.map((product) => {
    const configuration = CATALOG_FOUNDATION_PRODUCTS[product.id];
    if (!configuration) return { ...product };
    return {
      ...product,
      brand: configuration.brand,
      subcategory: configuration.subcategory,
      productType: configuration.productType,
      model: configuration.model ?? product.model,
      specs: {
        ...(product.specs ?? {}),
        ...configuration.specs,
        Brand: brandNames.get(configuration.brand) ?? configuration.brand,
        ...(configuration.model ? { Model: configuration.model } : {}),
      },
    };
  });
  return {
    categories,
    brands: CATALOG_FOUNDATION_BRANDS.map((brand) => ({ ...brand })),
    products,
  };
};

export const auditCatalogFoundationState = ({ categories, brands, products }: CatalogFoundationState): readonly string[] => {
  const issues: string[] = [];
  const categoryMap = new Map(categories.map((category) => [category.id, category]));
  const brandMap = new Map(brands.map((brand) => [brand.id, brand]));
  const parentBySubcategory = new Map<string, string>();

  for (const category of categories) {
    if (!category.specificationTemplate?.length) issues.push(`Category ${category.id} has no specification template.`);
    if (!category.subcategories?.length) issues.push(`Category ${category.id} has no subcategories.`);
    for (const subcategory of category.subcategories ?? []) {
      const existingParent = parentBySubcategory.get(subcategory.id);
      if (existingParent && existingParent !== category.id) {
        issues.push(`Subcategory ${subcategory.id} belongs to both ${existingParent} and ${category.id}.`);
      } else {
        parentBySubcategory.set(subcategory.id, category.id);
      }
    }
  }

  for (const product of products.filter((candidate) => candidate.isActive !== false)) {
    const brand = product.brand ? brandMap.get(product.brand) : undefined;
    if (!brand) issues.push(`Product ${product.id} does not reference a registered brand.`);
    else if (brand.isActive === false) issues.push(`Product ${product.id} references disabled brand ${brand.id}.`);
    const category = categoryMap.get(product.category);
    if (!category) {
      issues.push(`Product ${product.id} does not reference an existing category.`);
      continue;
    }
    if (!product.subcategory || !(category.subcategories ?? []).some((subcategory) => (
      subcategory.id === product.subcategory && subcategory.isActive !== false
    ))) {
      issues.push(`Product ${product.id} does not reference an active subcategory in ${category.id}.`);
    }
    for (const field of category.specificationTemplate ?? []) {
      if (field.required && !String(product.specs?.[field.name] ?? '').trim()) {
        issues.push(`Product ${product.id} is missing required specification ${field.name}.`);
      }
    }
  }

  return Object.freeze(issues);
};
