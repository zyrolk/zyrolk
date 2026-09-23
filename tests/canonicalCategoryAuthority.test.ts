import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ProductCard from '../src/components/ProductCard';
import RelatedProductsRail from '../src/features/product-experience/RelatedProductsRail';
import {
  isPublicStorefrontCategory,
  projectStorefrontProduct,
  sanitizeStorefrontCategoryId,
} from '../src/services/storefront/storefrontCatalog';
import { projectCustomerProduct } from '../src/services/product-search/customerProjection';
import { buildStorefrontSeo } from '../src/services/seo/storefrontSeo';
import { projectSupplierReviewCatalogRecords } from '../functions/src/api/suppliers/supplierReviewCatalog';
import {
  isCanonicalActiveCategory,
  suggestSupplierCategory,
  validateSupplierProductForApproval,
} from '../functions/src/api/suppliers/supplierProductMapping';
import { projectSupplierReviewTaxonomy } from '../functions/src/scheduled/supplierReviewQueue';

const canonicalCategory = {
  id: 'electronics',
  name: 'Electronics',
  isActive: true,
  subcategories: [{ id: 'audio', name: 'Audio', isActive: true }],
};

const candidateCategory = {
  id: 'supplier-taxonomy-health-beauty',
  name: 'Health & Beauty',
  isActive: true,
  taxonomyCandidate: true,
  subcategories: [{ id: 'supplier-taxonomy-sub-massage', name: 'Massage', isActive: true }],
};

const validApprovalProduct = {
  name: 'Canonical category probe',
  imageUrl: 'https://cdn.example/probe.webp',
  category: 'electronics',
  subcategory: 'audio',
  brand: '',
  price: 1200,
  costPrice: 800,
  stock: 3,
  visible: true,
  description: 'A valid review product description.',
};

const publicProduct = {
  id: 'candidate-product',
  name: 'Candidate product',
  description: 'Public projection probe',
  price: 100,
  imageUrl: 'https://cdn.example/candidate.webp',
  imageUrls: ['https://cdn.example/candidate.webp'],
  category: candidateCategory.id,
  subcategory: candidateCategory.subcategories[0].id,
  rating: 0,
  reviewsCount: 0,
  stock: 1,
  specs: {},
  isActive: true,
};

test('canonical category authority requires explicit active non-candidate state', () => {
  assert.equal(isCanonicalActiveCategory(canonicalCategory), true);
  assert.equal(isCanonicalActiveCategory({ ...canonicalCategory, isActive: false }), false);
  assert.equal(isCanonicalActiveCategory(candidateCategory), false);
  assert.equal(isCanonicalActiveCategory({ ...canonicalCategory, isActive: undefined }), false);
  const reviewCatalog = projectSupplierReviewCatalogRecords([
    { id: canonicalCategory.id, data: canonicalCategory },
    { id: candidateCategory.id, data: candidateCategory },
  ], []);
  assert.deepEqual(reviewCatalog.categories.map((category) => category.id), [canonicalCategory.id]);

  const mappingToCandidate = [{
    sourceId: 'dropex',
    supplierCategory: 'Health & Beauty',
    normalizedCategory: 'health beauty',
    mappingScope: 'parent' as const,
    targetCategoryId: candidateCategory.id,
    targetSubcategoryId: candidateCategory.subcategories[0].id,
    confidence: 100,
    mappingType: 'learned' as const,
    version: 1,
    updatedBy: 'test',
  }];
  const unresolved = suggestSupplierCategory({
    sourceId: 'dropex',
    supplierCategories: ['Health & Beauty', 'Massage'],
    categories: [canonicalCategory, candidateCategory],
    mappings: mappingToCandidate,
  });
  assert.equal(unresolved.targetCategoryId, '');
  assert.equal(unresolved.targetSubcategoryId, '');
  assert.equal(unresolved.requiresManualSelection, true);

  assert.deepEqual(
    validateSupplierProductForApproval(
      { ...validApprovalProduct, category: candidateCategory.id, subcategory: candidateCategory.subcategories[0].id },
      [candidateCategory],
      [],
      { supplierReview: true },
    ).map((error) => error.field),
    ['category'],
  );
  assert.deepEqual(validateSupplierProductForApproval(validApprovalProduct, [canonicalCategory], [], { supplierReview: true }), []);
});

test('candidate mappings cannot project into pending review items', () => {
  const record = { id: 'review-candidate', productPayload: { category: '', subcategory: '' } };
  const selection = {
    scope: 'source' as const,
    mapping: {
      sourceId: 'dropex',
      supplierCategory: 'Health & Beauty',
      normalizedCategory: 'health beauty',
      mappingScope: 'parent' as const,
      targetCategoryId: candidateCategory.id,
      targetSubcategoryId: candidateCategory.subcategories[0].id,
      confidence: 100,
      mappingType: 'learned' as const,
      version: 1,
      updatedBy: 'test',
    },
  };
  assert.deepEqual(
    projectSupplierReviewTaxonomy(record, selection, candidateCategory, 'Health & Beauty', 'Massage', candidateCategory.id, candidateCategory.subcategories[0].id),
    record,
  );
});

test('public projections and rendered storefront surfaces fail closed for supplier taxonomy IDs', () => {
  assert.equal(sanitizeStorefrontCategoryId(candidateCategory.id), '');
  assert.equal(sanitizeStorefrontCategoryId('electronics'), 'electronics');
  assert.equal(isPublicStorefrontCategory({ id: candidateCategory.id, name: candidateCategory.name, isActive: true, ...(candidateCategory as object) } as never), false);
  assert.equal(isPublicStorefrontCategory({ id: 'electronics', name: 'Electronics', isActive: true } as never), true);

  const projected = projectStorefrontProduct(publicProduct.id, publicProduct);
  assert.equal(projected.category, '');
  assert.equal(projected.subcategory, undefined);
  assert.equal(projectCustomerProduct(publicProduct as never).category, '');

  const seo = buildStorefrontSeo({ currentPage: 'products', product: publicProduct as never, origin: 'https://zyro.lk' });
  const seoText = JSON.stringify(seo.structuredData);
  assert.doesNotMatch(seoText, /supplier-taxonomy/iu);
  assert.doesNotMatch(seoText, /health-beauty/iu);

  const callbacks = {
    onAddToCart: () => undefined,
    onToggleWishlist: () => undefined,
    onViewDetail: () => undefined,
  };
  const cardMarkup = renderToStaticMarkup(createElement(ProductCard, {
    product: publicProduct as never,
    isWishlisted: false,
    ...callbacks,
  }));
  assert.doesNotMatch(cardMarkup, /supplier-taxonomy/iu);

  const relatedMarkup = renderToStaticMarkup(createElement(RelatedProductsRail, {
    products: [publicProduct as never],
    scrollRef: { current: null },
    onScroll: () => undefined,
    onSelect: () => undefined,
    formatPrice: (value: number) => String(value),
  }));
  assert.doesNotMatch(relatedMarkup, /supplier-taxonomy/iu);

});
