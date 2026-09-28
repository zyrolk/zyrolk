import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  parseAdminProductDraft,
  productProjection,
} from '../functions/src/api/products/adminProductManagement';
import {
  calculatePromotionDiscountPercent as serverDiscountPercent,
  exceedsPromotionDiscountCap as serverExceedsCap,
  isPromotionDiscountWithinCap,
  MAX_PROMOTION_DISCOUNT_PERCENT as SERVER_MAX,
  PROMOTION_DISCOUNT_CAP_MESSAGE as SERVER_MESSAGE,
} from '../functions/src/api/products/promotionPolicy';
import {
  parseSupplierApprovalDraft,
  toPublicProductPayload,
} from '../functions/src/api/suppliers/supplierApproval';
import {
  buildSupplierOfferPublicProjection,
  buildSupplierProductOffer,
} from '../functions/src/api/suppliers/supplierOfferEngine';
import { buildProductPayload } from '../functions/src/scheduled/supplierSync';
import ProductCard from '../src/components/ProductCard';
import RelatedProductsRail from '../src/features/product-experience/RelatedProductsRail';
import {
  calculatePromotionDiscountPercent as clientDiscountPercent,
  MAX_PROMOTION_DISCOUNT_PERCENT as CLIENT_MAX,
  PROMOTION_DISCOUNT_CAP_MESSAGE as CLIENT_MESSAGE,
  resolveCustomerPromotion,
} from '../src/services/products/promotionPolicy';
import { validateProductForSave } from '../src/services/products/productValidation';
import { validateSupplierReviewDraft, createSupplierReviewDraft } from '../src/services/supplierReviewEditor';

const managedImage = 'https://firebasestorage.googleapis.com/v0/b/demo/o/promotion-cap.webp';

const adminDraft = (overrides: Record<string, unknown> = {}) => ({
  id: 'cap-product-1',
  sku: 'ZY-CAP-1',
  name: 'Promotion cap product',
  description: 'Description',
  shortDescription: '',
  price: 800,
  originalPrice: 1_000,
  promotionEnabled: true,
  imageUrl: managedImage,
  imageUrls: [managedImage],
  category: 'electronics',
  subcategory: '',
  brand: 'brand-1',
  model: '',
  barcode: '',
  productType: '',
  tags: [],
  keyFeatures: [],
  whatsIncluded: [],
  stock: 5,
  specs: {},
  isNew: false,
  isFeatured: false,
  isBestSeller: false,
  isActive: true,
  ...overrides,
});

const approvalInput = (overrides: Record<string, unknown> = {}) => ({
  productName: 'Promotion cap product',
  shortDescription: 'Short description',
  description: 'A valid supplier product description.',
  sellingPrice: 800,
  comparePrice: 1_000,
  marketPrice: 1_000,
  costPrice: 500,
  stock: 5,
  category: 'electronics',
  subcategory: '',
  brand: 'brand-1',
  specifications: {},
  isActive: true,
  primaryImageUrl: managedImage,
  galleryImageUrls: [],
  promotionEnabled: true,
  ...overrides,
});

const approvalQueueItem = (payloadOverrides: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) => ({
  id: 'cap-review-1',
  supplierId: 'dropex',
  sourceId: 'dropex',
  comparisonStatus: 'PRICE_CHANGED',
  mediaSourceImageUrls: ['https://supplier.example/cap.jpg'],
  productPayload: {
    id: 'cap-product-1',
    name: 'Promotion cap product',
    description: 'A valid supplier product description.',
    price: 800,
    originalPrice: 1_000,
    discount: 20,
    marketPrice: 1_000,
    stock: 5,
    category: 'electronics',
    brand: 'brand-1',
    imageUrl: managedImage,
    imageUrls: [managedImage],
    ...payloadOverrides,
  },
  managedMedia: [{
    contentHash: 'b'.repeat(64),
    firebaseStorageUrl: managedImage,
    originalSupplierUrl: 'https://supplier.example/cap.jpg',
    imageStatus: 'ready',
    isPrimary: true,
    sortOrder: 0,
    variants: { large: { firebaseStorageUrl: managedImage } },
  }],
  mediaStatus: 'ready',
  ...overrides,
});

const isDelete = (value: unknown): boolean => (value as { constructor?: { name?: string } })?.constructor?.name === 'DeleteTransform';

test('server and storefront share the same 20% cap and message', () => {
  assert.equal(SERVER_MAX, 20);
  assert.equal(CLIENT_MAX, 20);
  assert.equal(SERVER_MESSAGE, 'Launch promotions cannot exceed 20%.');
  assert.equal(CLIENT_MESSAGE, SERVER_MESSAGE);
});

test('discount percentage is exact, precision-safe, and undefined for invalid prices', () => {
  assert.equal(serverDiscountPercent(1_000, 800), 20);
  assert.equal(clientDiscountPercent(1_000, 800), 20);
  assert.equal(isPromotionDiscountWithinCap(1_234.5, 987.6), true);
  assert.equal(isPromotionDiscountWithinCap(1_000, 799.9), false);
  assert.equal(serverExceedsCap(1_000, 799.9), true);
  for (const [original, price] of [
    [undefined, 800], [null, 800], [1_000, undefined], [1_000, 0], [1_000, -5],
    [800, 800], [700, 800], [Number.NaN, 800], [Number.POSITIVE_INFINITY, 800], ['abc', 800],
  ] as const) {
    assert.equal(serverDiscountPercent(original, price), undefined, `${String(original)} / ${String(price)}`);
    assert.equal(clientDiscountPercent(original, price), undefined, `${String(original)} / ${String(price)}`);
    assert.equal(serverExceedsCap(original, price), false);
  }
});

test('admin product API accepts 5, 10, 15 and exactly 20 percent promotions', () => {
  for (const [price, expected] of [[950, 5], [900, 10], [850, 15], [800, 20]] as const) {
    const draft = parseAdminProductDraft(adminDraft({ price }));
    const projection = productProjection('cap-product-1', 'ZY-CAP-1', draft, 'Brand', '2026-09-27T00:00:00.000Z');
    assert.equal(projection.publicData.originalPrice, 1_000);
    assert.equal(projection.publicData.price, price);
    assert.equal(projection.publicData.discount, expected);
  }
});

test('admin product API rejects promotions above 20 percent without clamping', () => {
  for (const price of [799.9, 790, 750]) {
    assert.throws(() => parseAdminProductDraft(adminDraft({ price })), (error: unknown) => {
      assert.equal((error as { statusCode?: unknown }).statusCode, 400);
      assert.equal((error as { message?: unknown }).message, 'Launch promotions cannot exceed 20%.');
      return true;
    });
  }
});

test('admin product API keeps the existing invalid-promotion failures', () => {
  assert.throws(() => parseAdminProductDraft(adminDraft({ originalPrice: 800 })), /greater than the sale price when promotion is enabled/u);
  assert.throws(() => parseAdminProductDraft(adminDraft({ originalPrice: 700 })), /cannot be lower than the sale price/u);
  assert.throws(() => parseAdminProductDraft(adminDraft({ originalPrice: undefined })), /greater than the sale price when promotion is enabled/u);
});

test('promotion disabled never fails promotion validation or publishes a discount', () => {
  const draft = parseAdminProductDraft(adminDraft({ promotionEnabled: false, price: 500, originalPrice: 1_000 }));
  const projection = productProjection('cap-product-1', 'ZY-CAP-1', draft, 'Brand', '2026-09-27T00:00:00.000Z');
  assert.equal(Object.hasOwn(projection.publicData, 'originalPrice'), false);
  assert.equal(Object.hasOwn(projection.publicData, 'discount'), false);
});

test('an untouched legacy public promotion above 20 percent is dropped on the next admin save', () => {
  const draft = parseAdminProductDraft(adminDraft({ originalPrice: undefined, promotionEnabled: undefined, price: 700 }));
  const projection = productProjection(
    'cap-product-1',
    'ZY-CAP-1',
    draft,
    'Brand',
    '2026-09-27T00:00:00.000Z',
    { price: 700, originalPrice: 1_000, discount: 30 },
  );
  assert.equal(projection.publicData.price, 700);
  assert.equal(Object.hasOwn(projection.publicData, 'originalPrice'), false);
  assert.equal(Object.hasOwn(projection.publicData, 'discount'), false);
});

test('supplier approval accepts exactly 20 percent and rejects anything above it', () => {
  const accepted = toPublicProductPayload(approvalQueueItem(), parseSupplierApprovalDraft(approvalInput()));
  assert.equal(accepted.originalPrice, 1_000);
  assert.equal(accepted.discount, 20);

  assert.throws(() => parseSupplierApprovalDraft(approvalInput({ sellingPrice: 790 })), (error: unknown) => {
    assert.equal((error as { statusCode?: unknown }).statusCode, 400);
    assert.equal((error as { message?: unknown }).message, 'Launch promotions cannot exceed 20%.');
    return true;
  });
  assert.throws(
    () => toPublicProductPayload(approvalQueueItem({ price: 790 }), { ...parseSupplierApprovalDraft(approvalInput())!, sellingPrice: 790 }),
    /Launch promotions cannot exceed 20%\./u,
  );
});

test('supplier approval fails closed on a legacy review payload whose preserved promotion exceeds 20 percent', () => {
  const payload = toPublicProductPayload(approvalQueueItem({ price: 750, originalPrice: 1_000, discount: 25 }), undefined);
  assert.equal(payload.price, 750);
  assert.equal(Object.hasOwn(payload, 'originalPrice'), false);
  assert.equal(Object.hasOwn(payload, 'discount'), false);

  const implicitDraft = parseSupplierApprovalDraft(approvalInput({ promotionEnabled: undefined, comparePrice: 1_100 }))!;
  const implicitPayload = toPublicProductPayload(approvalQueueItem(), implicitDraft);
  assert.equal(implicitPayload.price, 800);
  assert.equal(Object.hasOwn(implicitPayload, 'originalPrice'), false);
  assert.equal(Object.hasOwn(implicitPayload, 'discount'), false);
});

const supplierProduct = (price: number) => ({
  sku: 'DROP-CAP-1',
  title: 'Promotion cap product',
  longDescription: 'A valid supplier product description.',
  mediaGallery: ['https://supplier.example/cap.jpg'],
  wholesalePrice: 500,
  recommendedRetailPrice: 2_000,
  price,
  inventoryLevel: 5,
  supplierProductId: 'drop-cap-1',
  categoryHierarchy: ['Electronics'],
  specifications: {},
  providedFields: ['wholesalePrice', 'inventoryLevel'],
});
const categorySuggestion = {
  supplierCategory: 'Electronics', normalizedCategory: 'electronics', targetCategoryId: 'electronics',
  targetSubcategoryId: '', confidence: 1, mappingType: 'exact', mappingSource: 'catalog',
  autoSelected: true, requiresManualSelection: false,
} as const;
const brandSuggestion = {
  supplierBrand: '', normalizedBrand: '', mappedBrandId: 'brand-1', confidence: 1,
  mappingType: 'exact', mappingSource: 'registry', autoSelected: true, requiresManualSelection: false,
} as const;
const syncSettings = { defaultMarkup: 0, defaultProfitMargin: 0, defaultImageLimit: 5 };
const dropexSource = { id: 'dropex', supplierId: 'dropex', priority: 100 };
const existingPromotedProduct = {
  id: 'cap-product-1', price: 850, originalPrice: 1_000, discount: 15,
  marketPrice: 1_000, imageUrl: 'https://supplier.example/old.jpg', imageUrls: [],
  category: 'electronics', brand: 'brand-1', stock: 5,
};
const priceChange = { status: 'PRICE_CHANGED' as const, changedFields: ['price'], fieldChanges: [{ field: 'price' } as never] };

test('supplier sync keeps an existing 15 percent promotion in the review proposal while it stays within 20 percent', () => {
  const payload = buildProductPayload(supplierProduct(820), existingPromotedProduct, categorySuggestion, brandSuggestion, [{ id: 'brand-1', name: 'Brand' }], priceChange, syncSettings, dropexSource);
  assert.equal(payload.price, 820);
  assert.equal(payload.originalPrice, 1_000);
  assert.equal(payload.discount, 18);
});

test('supplier sync drops a preserved promotion from the review proposal when the new price would exceed 20 percent', () => {
  const payload = buildProductPayload(supplierProduct(750), existingPromotedProduct, categorySuggestion, brandSuggestion, [{ id: 'brand-1', name: 'Brand' }], priceChange, syncSettings, dropexSource);
  assert.equal(payload.price, 750);
  assert.equal(Object.hasOwn(payload, 'originalPrice'), false);
  assert.equal(Object.hasOwn(payload, 'discount'), false);
});

test('supplier sync never creates a promotion for a product without an admin promotion', () => {
  const newPayload = buildProductPayload(supplierProduct(820), undefined, categorySuggestion, brandSuggestion, [{ id: 'brand-1', name: 'Brand' }], {
    status: 'NEW_PRODUCT', changedFields: [], fieldChanges: [],
  }, syncSettings, dropexSource);
  assert.equal(Object.hasOwn(newPayload, 'originalPrice'), false);
  assert.equal(Object.hasOwn(newPayload, 'discount'), false);

  const unpromoted = buildProductPayload(
    supplierProduct(820),
    { ...existingPromotedProduct, originalPrice: undefined, discount: undefined },
    categorySuggestion, brandSuggestion, [{ id: 'brand-1', name: 'Brand' }], priceChange, syncSettings, dropexSource,
  );
  assert.equal(Object.hasOwn(unpromoted, 'originalPrice'), false);
  assert.equal(Object.hasOwn(unpromoted, 'discount'), false);
});

const approvedOffer = (price: number) => buildSupplierProductOffer({
  sourceId: 'dropex', supplierId: 'dropex', supplierProductId: 'drop-cap-1', sku: 'DROP-CAP-1',
  barcode: '', productId: 'cap-product-1', price, cost: 500, stock: 5,
  availability: 'in_stock', priority: 100, health: {}, lastSyncAt: '2026-09-27T00:00:00.000Z',
  reviewStatus: 'approved', catalogPayload: { originalPrice: 2_000 }, supplierSnapshot: {},
  timestamp: '2026-09-27T00:00:00.000Z',
});

test('approved offer reprojection keeps an admin promotion within 20 percent and removes one above it', () => {
  const kept = buildSupplierOfferPublicProjection(approvedOffer(820), { price: 850, originalPrice: 1_000, stock: 5 });
  assert.equal(kept.price, 820);
  assert.equal(kept.originalPrice, 1_000);
  assert.equal(kept.discount, 18);

  const removed = buildSupplierOfferPublicProjection(approvedOffer(750), { price: 850, originalPrice: 1_000, stock: 5 });
  assert.equal(removed.price, 750);
  assert.ok(isDelete(removed.originalPrice));
  assert.ok(isDelete(removed.discount));

  const noPromotion = buildSupplierOfferPublicProjection(approvedOffer(750), { price: 850, stock: 5 });
  assert.ok(isDelete(noPromotion.originalPrice));
  assert.ok(isDelete(noPromotion.discount));
});

test('storefront promotion resolver only returns valid promotions up to 20 percent', () => {
  assert.deepEqual(resolveCustomerPromotion({ price: 800, originalPrice: 1_000 }), { originalPrice: 1_000, discountPercent: 20 });
  assert.deepEqual(resolveCustomerPromotion({ price: 850, originalPrice: 1_000, promotionEnabled: true }), { originalPrice: 1_000, discountPercent: 15 });
  assert.equal(resolveCustomerPromotion({ price: 750, originalPrice: 1_000 }), null);
  assert.equal(resolveCustomerPromotion({ price: 800 }), null);
  assert.equal(resolveCustomerPromotion({ price: 800, originalPrice: 800 }), null);
  assert.equal(resolveCustomerPromotion({ price: 800, originalPrice: 700 }), null);
  assert.equal(resolveCustomerPromotion({ price: 0, originalPrice: 1_000 }), null);
  assert.equal(resolveCustomerPromotion({ price: Number.NaN, originalPrice: 1_000 }), null);
  assert.equal(resolveCustomerPromotion({ price: 800, originalPrice: 1_000, promotionEnabled: false }), null);
  assert.equal(resolveCustomerPromotion({ price: 999, originalPrice: 1_000 }), null);
});

const cardProduct = (overrides: Record<string, unknown> = {}) => ({
  id: 'cap-card-1',
  name: 'Promotion cap card',
  description: 'Description',
  price: 800,
  imageUrl: managedImage,
  imageUrls: [],
  category: 'electronics',
  rating: 0,
  reviewsCount: 0,
  stock: 5,
  specs: {},
  ...overrides,
});
const cardCallbacks = { onAddToCart: () => undefined, onToggleWishlist: () => undefined, onViewDetail: () => undefined };
const renderCard = (overrides: Record<string, unknown>) => renderToStaticMarkup(createElement(ProductCard, {
  product: cardProduct(overrides) as never,
  isWishlisted: false,
  ...cardCallbacks,
}));
const renderRail = (overrides: Record<string, unknown>) => renderToStaticMarkup(createElement(RelatedProductsRail, {
  products: [cardProduct(overrides) as never],
  scrollRef: { current: null },
  onScroll: () => undefined,
  onSelect: () => undefined,
  formatPrice: (value: number) => `LKR ${value}`,
}));

test('product card and related rail render a valid 20 percent promotion', () => {
  const card = renderCard({ originalPrice: 1_000, discount: 20 });
  assert.match(card, /Save 20%/);
  assert.match(card, /zy-product-card-original-price/);
  const rail = renderRail({ originalPrice: 1_000, discount: 20 });
  assert.match(rail, /-20%/);
  assert.match(rail, /LKR 1000/);
});

test('invalid promotions render the normal selling price only', () => {
  for (const overrides of [
    { originalPrice: 1_000, discount: 25, price: 750 },
    { discount: 15 },
    { originalPrice: 800, discount: 10 },
    { originalPrice: 700, discount: 10 },
    { originalPrice: 1_000, discount: undefined, price: Number.NaN },
    { originalPrice: 1_000, promotionEnabled: false, discount: 20 },
  ]) {
    const card = renderCard(overrides);
    assert.doesNotMatch(card, /Save -?\d+%|zy-product-discount|zy-product-card-original-price/u, JSON.stringify(overrides));
    assert.doesNotMatch(card, /undefined%|NaN%/u);
    const rail = renderRail(overrides);
    assert.doesNotMatch(rail, /-\d+%|undefined%|NaN%/u, JSON.stringify(overrides));
    assert.doesNotMatch(rail, /<small>/u);
  }
  assert.match(renderCard({ originalPrice: 1_000, price: 750 }), /750/);
});

test('product detail modal derives every discount display from the capped resolver', () => {
  const modal = readFileSync('src/components/ProductDetailModal.tsx', 'utf8');
  assert.match(modal, /const promotion = resolveCustomerPromotion\(product\)/);
  assert.match(modal, /\{promotion && \(/);
  assert.match(modal, /-\{promotion\.discountPercent\}% INTRODUCTORY OFFER/);
  assert.match(modal, /\(\{promotion\.discountPercent\}% OFF\)/);
  assert.match(modal, /formatPrice\(promotion\.originalPrice\)/);
  assert.match(modal, /const itemPromotion = resolveCustomerPromotion\(item\)/);
  assert.match(modal, /formatPrice\(product\.price\)/);
  assert.doesNotMatch(modal, /product\.discount\b|item\.discount\b|product\.originalPrice\b/u);
});

test('admin editors surface the 20 percent cap without new promotion workflow', () => {
  const base = {
    product: { name: 'Cap', id: 'cap', sku: 'CAP-1', price: 750, originalPrice: 1_000, promotionEnabled: true, stock: 1, imageUrl: managedImage, category: 'electronics' },
    products: [],
    categories: [{ id: 'electronics', name: 'Electronics', isActive: true }] as never,
  };
  assert.ok(validateProductForSave(base).includes('Launch promotions cannot exceed 20%.'));
  assert.ok(!validateProductForSave({ ...base, product: { ...base.product, price: 800 } }).includes('Launch promotions cannot exceed 20%.'));
  assert.ok(!validateProductForSave({ ...base, product: { ...base.product, promotionEnabled: false, originalPrice: undefined } }).includes('Launch promotions cannot exceed 20%.'));

  const reviewDraft = {
    ...createSupplierReviewDraft({
      id: 'cap-review', productName: 'Cap', supplierCode: 'CAP', costPrice: 500, marketPrice: 1_000, stock: 5,
      imageUrl: 'https://supplier.example/cap.jpg', comparison: { comparisonStatus: 'NEW_PRODUCT' },
      productPayload: { id: 'cap', name: 'Cap', description: 'Description', price: 750, stock: 5, category: 'electronics', imageUrl: 'https://supplier.example/cap.jpg', imageUrls: [], specs: {}, rating: 0, reviewsCount: 0, isActive: true },
    } as never),
    promotionEnabled: true,
    sellingPrice: 750,
    comparePrice: 1_000,
  };
  assert.equal(validateSupplierReviewDraft(reviewDraft as never).comparePrice, 'Launch promotions cannot exceed 20%.');
  assert.notEqual(validateSupplierReviewDraft({ ...reviewDraft, sellingPrice: 800 } as never).comparePrice, 'Launch promotions cannot exceed 20%.');

  const dashboard = readFileSync('src/components/AdminDashboard.tsx', 'utf8');
  assert.match(dashboard, /exceedsPromotionDiscountCap\(newProduct\.originalPrice, newProduct\.price\)/);
  assert.match(dashboard, /\{PROMOTION_DISCOUNT_CAP_MESSAGE\}/);
});
