import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAdminProductDraft,
  productProjection,
} from '../functions/src/api/products/adminProductManagement';
import { splitProductData } from '../functions/src/api/products/productCommercialData';
import {
  parseSupplierApprovalDraft,
  toPublicProductPayload,
} from '../functions/src/api/suppliers/supplierApproval';
import { ProductParser as DropexProductParser } from '../functions/src/api/suppliers/dropex/ProductParser';
import { validateSupplierProductForApproval } from '../functions/src/api/suppliers/supplierProductMapping';
import {
  buildSupplierOfferPublicProjection,
  buildSupplierProductOffer,
} from '../functions/src/api/suppliers/supplierOfferEngine';
import { buildProductPayload } from '../functions/src/scheduled/supplierSync';
import { SUPPLIER_MEDIA_FAILURE_CODE } from '../functions/src/api/suppliers/supplierMediaReadiness';
import {
  buildProductSavePayload,
  createProductDraft,
} from '../src/services/products/productBlueprint';
import {
  buildSupplierApprovalItem,
  createSupplierReviewDraft,
} from '../src/services/supplierReviewEditor';

const managedImage = 'https://firebasestorage.googleapis.com/v0/b/demo/o/promotion.webp';

const approvalInput = (overrides: Record<string, unknown> = {}) => ({
  productName: 'Promotion Contract Product',
  shortDescription: 'Short description',
  description: 'A valid supplier product description.',
  sellingPrice: 1_146,
  comparePrice: 1_850,
  marketPrice: 1_850,
  costPrice: 900,
  stock: 5,
  category: 'electronics',
  subcategory: '',
  brand: 'brand-1',
  specifications: {},
  isActive: true,
  primaryImageUrl: managedImage,
  galleryImageUrls: [],
  promotionEnabled: false,
  ...overrides,
});

const approvalQueueItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'promotion-review-1',
  supplierId: 'dropex',
  sourceId: 'dropex',
  mediaSourceImageUrls: ['https://supplier.example/promotion.jpg'],
  productPayload: {
    id: 'promotion-product-1',
    name: 'Promotion Contract Product',
    description: 'A valid supplier product description.',
    price: 1_146,
    originalPrice: 1_850,
    discount: 38,
    marketPrice: 1_850,
    stock: 5,
    category: 'electronics',
    brand: 'brand-1',
    imageUrl: managedImage,
    imageUrls: [managedImage],
  },
  managedMedia: [{
    contentHash: 'a'.repeat(64),
    firebaseStorageUrl: managedImage,
    originalSupplierUrl: 'https://supplier.example/promotion.jpg',
    imageStatus: 'ready',
    isPrimary: true,
    sortOrder: 0,
    variants: { large: { firebaseStorageUrl: managedImage } },
  }],
  mediaStatus: 'ready',
  ...overrides,
});

const reviewItem = (comparisonStatus = 'NEW_PRODUCT') => ({
  id: 'review-product-1',
  productName: 'Promotion Contract Product',
  supplierCode: 'DROP-1',
  supplierName: 'Dropex',
  costPrice: 900,
  marketPrice: 1_850,
  stock: 5,
  imageUrl: 'https://supplier.example/promotion.jpg',
  comparison: { comparisonStatus },
  productPayload: {
    id: 'review-product-1',
    name: 'Promotion Contract Product',
    description: 'A valid supplier product description.',
    price: 1_146,
    originalPrice: 1_850,
    marketPrice: 1_850,
    stock: 5,
    category: 'electronics',
    brand: 'brand-1',
    imageUrl: 'https://supplier.example/promotion.jpg',
    imageUrls: ['https://supplier.example/promotion.jpg'],
    specs: {},
    rating: 0,
    reviewsCount: 0,
    isActive: true,
  },
});

test('new supplier products keep market price private when promotion is OFF', () => {
  const item = reviewItem();
  const draft = createSupplierReviewDraft(item);
  assert.equal(draft.promotionEnabled, false);
  assert.equal(draft.comparePrice, 0);

  const approved = buildSupplierApprovalItem(item, draft, ['electronics']);
  assert.equal(Object.hasOwn(approved.productPayload || {}, 'originalPrice'), false);
  assert.equal(Object.hasOwn(approved.productPayload || {}, 'discount'), false);
  assert.equal(approved.productPayload?.marketPrice, 1_850);
});

test('explicit Promotion OFF overrides a legacy public promotion in Supplier Review', () => {
  const item = reviewItem('DESCRIPTION_CHANGED');
  (item.productPayload as unknown as Record<string, unknown>).promotionEnabled = false;
  const draft = createSupplierReviewDraft(item);

  assert.equal(draft.promotionEnabled, false);
  assert.equal(draft.comparePrice, 0);
  const approved = buildSupplierApprovalItem(item, draft, ['electronics']);
  assert.equal(Object.hasOwn(approved.productPayload || {}, 'originalPrice'), false);
  assert.equal(Object.hasOwn(approved.productPayload || {}, 'discount'), false);
});

test('explicit promotion ON serializes regular price and derives 38 percent discount', () => {
  const item = reviewItem();
  const draft = { ...createSupplierReviewDraft(item), promotionEnabled: true, comparePrice: 1_850 };
  const approved = buildSupplierApprovalItem(item, draft, ['electronics']);
  assert.equal(approved.productPayload?.originalPrice, 1_850);
  assert.equal(approved.productPayload?.discount, 38);

  const parsed = parseSupplierApprovalDraft(approvalInput({ promotionEnabled: true, discount: 999 }));
  const publicPayload = toPublicProductPayload(approvalQueueItem(), parsed);
  assert.equal(publicPayload.originalPrice, 1_850);
  assert.equal(publicPayload.discount, 38);
});

test('server approval removes legacy public promotion fields while retaining private market price', () => {
  const parsed = parseSupplierApprovalDraft(approvalInput({ promotionEnabled: false }));
  const payload = toPublicProductPayload(approvalQueueItem(), parsed);
  const split = splitProductData(payload);
  assert.equal(Object.hasOwn(split.publicData, 'originalPrice'), false);
  assert.equal(Object.hasOwn(split.publicData, 'discount'), false);
  assert.equal(Object.hasOwn(split.publicData, 'marketPrice'), false);
  assert.equal(split.commercialData.marketPrice, 1_850);
});

test('Promotion OFF with no compare price leaves a market-price-only item unpromoted', () => {
  const queueItem = approvalQueueItem({
    productPayload: {
      ...approvalQueueItem().productPayload,
      originalPrice: undefined,
      discount: undefined,
      marketPrice: 1_850,
    },
  });
  const parsed = parseSupplierApprovalDraft(approvalInput({
    comparePrice: undefined,
    promotionEnabled: false,
  }));
  const payload = toPublicProductPayload(queueItem, parsed);
  const split = splitProductData(payload);

  assert.equal(Object.hasOwn(split.publicData, 'originalPrice'), false);
  assert.equal(Object.hasOwn(split.publicData, 'discount'), false);
  assert.equal(split.commercialData.marketPrice, 1_850);
});

test('legacy public promotions remain unchanged until explicitly disabled', () => {
  const legacyPayload = toPublicProductPayload(approvalQueueItem(), undefined);
  assert.equal(legacyPayload.originalPrice, 1_850);
  assert.equal(legacyPayload.discount, 38);

  const disabledPayload = toPublicProductPayload(
    approvalQueueItem(),
    parseSupplierApprovalDraft(approvalInput({ promotionEnabled: false }))!,
  );
  assert.equal(Object.hasOwn(disabledPayload, 'originalPrice'), false);
  assert.equal(Object.hasOwn(disabledPayload, 'discount'), false);
});

test('invalid explicit regular prices cannot create a promotion and stored discounts are recalculated', () => {
  assert.throws(
    () => parseSupplierApprovalDraft(approvalInput({ promotionEnabled: true, comparePrice: 1_146 })),
    /greater than the selling price when promotion is enabled/u,
  );
  const payload = toPublicProductPayload(
    approvalQueueItem({ productPayload: { ...approvalQueueItem().productPayload, discount: 999 } }),
    parseSupplierApprovalDraft(approvalInput({ promotionEnabled: true }))!,
  );
  assert.equal(payload.discount, 38);
});

test('server approval accepts structured optional media warnings but rejects blocking media', () => {
  const optionalWarningItem = approvalQueueItem({
    mediaReadiness: 'publication_safe_with_media_warnings',
    mediaSourceImageUrls: [
      'https://supplier.example/promotion.jpg',
      'https://supplier.example/oversized-gallery.jpg',
    ],
    mediaFailures: [{
      code: SUPPLIER_MEDIA_FAILURE_CODE.IMAGE_TOO_LARGE,
      originalSupplierUrl: 'https://supplier.example/oversized-gallery.jpg',
      retryable: false,
      sourceIndex: 2,
      isPrimary: false,
    }],
  });
  const parsed = parseSupplierApprovalDraft(approvalInput({ promotionEnabled: false }));
  const payload = toPublicProductPayload(optionalWarningItem, parsed);
  assert.deepEqual(payload.imageUrls, [managedImage]);

  assert.throws(() => toPublicProductPayload({
    ...approvalQueueItem(),
    mediaStatus: 'partial',
    mediaFailures: [{ originalSupplierUrl: 'https://supplier.example/unknown.jpg', reason: 'socket hang up' }],
  }, parsed), /blocking image failure/u);
});

test('Dropex reseller cost and supplier selling price stay separate and non-promotional', () => {
  const product = DropexProductParser.parseCatalogItem({
    price: 720,
    reSellingPrice: 999,
    reSellerId: 42,
    reSellerAccount: 'zyro-reseller',
    productDetail: {
      id: 4970,
      name: 'SHX2924 Product',
      sku: 'SHX2924',
      buyingPrice: 410,
      reSellingPrice: 411,
      sellingPrice: 1400,
      onHandInventory: 1,
      categoryName: 'Vehicle Accessories',
      description: 'A valid product description.',
      image: 'shx2924.jpg',
    },
  });
  assert.equal(product.wholesalePrice, 720);
  assert.equal(product.recommendedRetailPrice, 1400);
  assert.equal(product.inventoryLevel, 1);
  assert.deepEqual(product.extraAttributes?.commercialPriceProvenance, {
    authoritativeCost: { source: 'reseller.price', value: 720 },
    supplierSellingPrice: { source: 'productDetail.sellingPrice', value: 1400 },
  });
  assert.equal(product.supplierCategory, 'Vehicle Accessories');

  const categorySuggestion = {
    supplierCategory: 'Vehicle Accessories', normalizedCategory: 'vehicle accessories', targetCategoryId: 'vehicle-accessories',
    targetSubcategoryId: '', confidence: 100, mappingType: 'exact', mappingSource: 'catalog',
    autoSelected: true, requiresManualSelection: false,
  } as const;
  const brandSuggestion = {
    supplierBrand: '', normalizedBrand: '', mappedBrandId: 'brand-1', confidence: 100,
    mappingType: 'exact', mappingSource: 'registry', autoSelected: true, requiresManualSelection: false,
  } as const;
  const payload = buildProductPayload(product, undefined, categorySuggestion, brandSuggestion, [{ id: 'brand-1', name: 'Brand' }], {
    status: 'NEW_PRODUCT', changedFields: [], fieldChanges: [],
  }, { defaultMarkup: 19.9, defaultProfitMargin: 14.9, defaultImageLimit: 5 }, {
    id: 'dropex', supplierId: 'dropex', connectorType: 'dropex', priority: 100,
  });
  assert.equal(payload.price, 1400);
  assert.equal(payload.costPrice, 720);
  assert.equal(payload.marketPrice, 0);
  assert.equal(payload.stock, 1);
  assert.equal(Object.hasOwn(payload, 'originalPrice'), false);
  assert.equal(Object.hasOwn(payload, 'discount'), false);
  assert.deepEqual((payload.supplierMetadata as Record<string, unknown>).extraAttributes, {
    commercialPriceProvenance: {
      authoritativeCost: { source: 'reseller.price', value: 720 },
      supplierSellingPrice: { source: 'productDetail.sellingPrice', value: 1400 },
    },
  });
});

test('Dropex missing reseller price fails closed instead of using nested buyingPrice', () => {
  const product = DropexProductParser.parseCatalogItem({
    productDetail: {
      id: 4970,
      name: 'SHX2924 Product',
      sku: 'SHX2924',
      buyingPrice: 410,
      sellingPrice: 1400,
      onHandInventory: 1,
      categoryName: 'Vehicle Accessories',
      description: 'A valid product description.',
      image: 'shx2924.jpg',
    },
  });
  const categorySuggestion = {
    supplierCategory: 'Vehicle Accessories', normalizedCategory: 'vehicle accessories', targetCategoryId: 'vehicle-accessories',
    targetSubcategoryId: '', confidence: 100, mappingType: 'exact', mappingSource: 'catalog',
    autoSelected: true, requiresManualSelection: false,
  } as const;
  const brandSuggestion = {
    supplierBrand: '', normalizedBrand: '', mappedBrandId: 'brand-1', confidence: 100,
    mappingType: 'exact', mappingSource: 'registry', autoSelected: true, requiresManualSelection: false,
  } as const;
  const payload = buildProductPayload(product, undefined, categorySuggestion, brandSuggestion, [{ id: 'brand-1', name: 'Brand' }], {
    status: 'NEW_PRODUCT', changedFields: [], fieldChanges: [],
  }, { defaultMarkup: 19.9, defaultProfitMargin: 14.9, defaultImageLimit: 5 }, {
    id: 'dropex', supplierId: 'dropex', connectorType: 'dropex', priority: 100,
  });
  assert.equal(payload.price, 0);
  assert.equal(payload.costPrice, undefined);
  assert.ok(validateSupplierProductForApproval(payload, [{ id: 'vehicle-accessories', name: 'Vehicle Accessories' }], [{ id: 'brand-1', name: 'Brand' }])
    .some((error) => error.code === 'invalid' && error.field === 'price'));
});

test('Dropex missing or invalid supplier selling price fails closed without a cost-derived proposal', () => {
  const categorySuggestion = {
    supplierCategory: 'Vehicle Accessories', normalizedCategory: 'vehicle accessories', targetCategoryId: 'vehicle-accessories',
    targetSubcategoryId: '', confidence: 100, mappingType: 'exact', mappingSource: 'catalog',
    autoSelected: true, requiresManualSelection: false,
  } as const;
  const brandSuggestion = {
    supplierBrand: '', normalizedBrand: '', mappedBrandId: 'brand-1', confidence: 100,
    mappingType: 'exact', mappingSource: 'registry', autoSelected: true, requiresManualSelection: false,
  } as const;
  for (const sellingPrice of [undefined, null, '', 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const product = DropexProductParser.parseCatalogItem({
      price: 870,
      productDetail: {
        id: 4990,
        name: 'AZK1690 Product',
        sku: 'AZK1690',
        sellingPrice,
        onHandInventory: 8,
      },
    });
    const payload = buildProductPayload(product, undefined, categorySuggestion, brandSuggestion, [], {
      status: 'NEW_PRODUCT', changedFields: [], fieldChanges: [],
    }, { defaultMarkup: 34.8, defaultProfitMargin: 0, defaultImageLimit: 5 }, {
      id: 'dropex', supplierId: 'dropex', connectorType: 'dropex', priority: 100,
    });
    assert.equal(payload.price, 0);
    assert.equal(payload.marketPrice, 0);
    assert.equal(product.price, undefined);
  }
});

test('server publication rejects a customer price below its authoritative cost', () => {
  const queue = approvalQueueItem({
    productPayload: { ...approvalQueueItem().productPayload, price: 553, costPrice: 720 },
  });
  assert.throws(() => toPublicProductPayload(queue, undefined), (error: unknown) => {
    assert.ok(error && typeof error === 'object');
    assert.equal((error as { statusCode?: unknown }).statusCode, 422);
    assert.equal((error as { message?: unknown }).message, 'Selling price must be at least the supplier cost.');
    return true;
  });
  assert.throws(() => parseSupplierApprovalDraft(approvalInput({ sellingPrice: 553, costPrice: 720 })), (error: unknown) => {
    assert.ok(error && typeof error === 'object');
    assert.equal((error as { statusCode?: unknown }).statusCode, 400);
    assert.equal((error as { message?: unknown }).message, 'Selling price must be at least the supplier cost.');
    return true;
  });
});

test('Dropex accepts only a finite positive reseller-row price for fulfilment cost', () => {
  const categorySuggestion = {
    supplierCategory: 'Vehicle Accessories', normalizedCategory: 'vehicle accessories', targetCategoryId: 'vehicle-accessories',
    targetSubcategoryId: '', confidence: 100, mappingType: 'exact', mappingSource: 'catalog',
    autoSelected: true, requiresManualSelection: false,
  } as const;
  const brandSuggestion = {
    supplierBrand: '', normalizedBrand: '', mappedBrandId: 'brand-1', confidence: 100,
    mappingType: 'exact', mappingSource: 'registry', autoSelected: true, requiresManualSelection: false,
  } as const;
  const baseDetail = {
    id: 4970,
    name: 'SHX2924 Product',
    sku: 'SHX2924',
    buyingPrice: 410,
    sellingPrice: 1400,
    onHandInventory: 1,
    categoryName: 'Vehicle Accessories',
    description: 'A valid product description.',
    image: 'shx2924.jpg',
  };
  const aliasValues = {
    reSellingPrice: 500,
    resellingPrice: 501,
    reSellerPrice: 502,
  };
  const missingOrAmbiguousInputs: Array<Record<string, unknown>> = [
    { productDetail: { ...baseDetail }, ...aliasValues },
    { productDetail: { ...baseDetail, reSellingPrice: 500 } },
    { productDetail: { ...baseDetail, resellingPrice: 500 } },
    { productDetail: { ...baseDetail, reSellerPrice: 500 } },
    ...[undefined, null, '', 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'not-a-number'].map((price) => ({
      price,
      productDetail: { ...baseDetail, ...aliasValues },
      reSellingPrice: 503,
      resellingPrice: 504,
      reSellerPrice: 505,
    })),
  ];

  for (const rawItem of missingOrAmbiguousInputs) {
    const product = DropexProductParser.parseCatalogItem(rawItem);
    assert.equal(product.wholesalePrice, 0);
    assert.equal((product.extraAttributes?.commercialPriceProvenance as Record<string, unknown> | undefined)?.authoritativeCost, undefined);
    assert.equal((product.extraAttributes?.commercialPriceProvenance as Record<string, unknown> | undefined)?.supplierSellingPrice &&
      ((product.extraAttributes?.commercialPriceProvenance as Record<string, unknown>).supplierSellingPrice as Record<string, unknown>).value, 1400);
    assert.equal(
      buildProductPayload(product, undefined, categorySuggestion, brandSuggestion, [{ id: 'brand-1', name: 'Brand' }], {
        status: 'NEW_PRODUCT', changedFields: [], fieldChanges: [],
      }, { defaultMarkup: 19.9, defaultProfitMargin: 14.9, defaultImageLimit: 5 }, {
        id: 'dropex', supplierId: 'dropex', connectorType: 'dropex', priority: 100,
      }).price,
      0,
    );
  }

  const valid = DropexProductParser.parseCatalogItem({
    price: '720',
    ...aliasValues,
    productDetail: { ...baseDetail, ...aliasValues },
  });
  assert.equal(valid.wholesalePrice, 720);
  assert.deepEqual((valid.extraAttributes?.commercialPriceProvenance as Record<string, unknown>).authoritativeCost, {
    source: 'reseller.price', value: 720,
  });
});

test('admin product saves apply the same explicit promotion contract', () => {
  const off = buildProductSavePayload({
    draft: {
      ...createProductDraft('electronics', 'ZY-1'),
      name: 'No promotion',
      price: 1_146,
      originalPrice: 1_850,
      promotionEnabled: false,
      imageUrl: managedImage,
      stock: 5,
    },
    now: '2026-09-07T00:00:00.000Z',
  });
  assert.equal(off.originalPrice, undefined);
  assert.equal(off.discount, undefined);

  const on = buildProductSavePayload({
    draft: { ...off, promotionEnabled: true, originalPrice: 1_850 },
    now: '2026-09-07T00:00:00.000Z',
  });
  assert.equal(on.originalPrice, 1_850);
  assert.equal(on.discount, 38);

  const serverOff = parseAdminProductDraft({
    id: 'admin-product-1',
    sku: 'ZY-1',
    name: 'No promotion',
    description: 'Description',
    shortDescription: '',
    price: 1_146,
    originalPrice: 1_850,
    promotionEnabled: false,
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
    marketPrice: 1_850,
  });
  const serverOffProjection = productProjection(
    'admin-product-1',
    'ZY-1',
    serverOff,
    'Brand',
    '2026-09-07T00:00:00.000Z',
    { price: 1_146, originalPrice: 1_850, discount: 38 },
  );
  assert.equal(Object.hasOwn(serverOffProjection.publicData, 'originalPrice'), false);
  assert.equal(Object.hasOwn(serverOffProjection.publicData, 'discount'), false);
  assert.equal(serverOffProjection.commercialData.marketPrice, 1_850);

  const serverOn = parseAdminProductDraft({
    ...Object.fromEntries(
      Object.entries(serverOff).filter(([field]) => field !== 'requestedId' && field !== 'requestedSku'),
    ),
    promotionEnabled: true,
  });
  const serverOnProjection = productProjection(
    'admin-product-1',
    'ZY-1',
    serverOn,
    'Brand',
    '2026-09-07T00:00:00.000Z',
  );
  assert.equal(serverOnProjection.publicData.originalPrice, 1_850);
  assert.equal(serverOnProjection.publicData.discount, 38);
});

test('normal admin edits preserve an untouched legacy promotion', () => {
  const legacyDraft = {
    ...createProductDraft('electronics', 'ZY-LEGACY'),
    id: 'legacy-product',
    name: 'Legacy promotion',
    description: 'Description',
    price: 1_146,
    originalPrice: 1_850,
    imageUrl: managedImage,
    stock: 5,
    brand: 'brand-1',
  };
  delete legacyDraft.promotionEnabled;
  const legacy = buildProductSavePayload({
    draft: legacyDraft,
    storedProduct: {
      id: 'legacy-product',
      name: 'Legacy promotion',
      description: 'Description',
      price: 1_146,
      originalPrice: 1_850,
      imageUrl: managedImage,
      imageUrls: [],
      category: 'electronics',
      brand: 'brand-1',
      rating: 0,
      reviewsCount: 0,
      stock: 5,
      specs: {},
    },
    now: '2026-09-07T00:00:00.000Z',
  });

  assert.equal(legacy.promotionEnabled, true);
  assert.equal(legacy.originalPrice, 1_850);
  assert.equal(legacy.discount, 38);
});

test('supplier sync does not create a new public promotion but preserves an existing one', () => {
  const product = {
    sku: 'DROP-1',
    title: 'Promotion Contract Product',
    longDescription: 'A valid supplier product description.',
    mediaGallery: ['https://supplier.example/promotion.jpg'],
    wholesalePrice: 900,
    recommendedRetailPrice: 2_200,
    price: 1_146,
    inventoryLevel: 5,
    supplierProductId: 'drop-product-1',
    categoryHierarchy: ['Electronics'],
    specifications: {},
    providedFields: ['wholesalePrice', 'inventoryLevel'],
  };
  const categorySuggestion = {
    supplierCategory: 'Electronics', normalizedCategory: 'electronics', targetCategoryId: 'electronics',
    targetSubcategoryId: '', confidence: 1, mappingType: 'exact', mappingSource: 'catalog',
    autoSelected: true, requiresManualSelection: false,
  } as const;
  const brandSuggestion = {
    supplierBrand: '', normalizedBrand: '', mappedBrandId: 'brand-1', confidence: 1,
    mappingType: 'exact', mappingSource: 'registry', autoSelected: true, requiresManualSelection: false,
  } as const;
  const settings = { defaultMarkup: 0, defaultProfitMargin: 0, defaultImageLimit: 5 };
  const source = { id: 'dropex', supplierId: 'dropex', priority: 100 };

  const newPayload = buildProductPayload(product, undefined, categorySuggestion, brandSuggestion, [{ id: 'brand-1', name: 'Brand' }], {
    status: 'NEW_PRODUCT', changedFields: [], fieldChanges: [],
  }, settings, source);
  assert.equal(Object.hasOwn(newPayload, 'originalPrice'), false);
  assert.equal(Object.hasOwn(newPayload, 'discount'), false);
  assert.equal(newPayload.marketPrice, 0);

  const existingPayload = buildProductPayload(product, {
    id: 'existing-product', price: 1_146, originalPrice: 1_850, discount: 38,
    marketPrice: 1_850, imageUrl: 'https://supplier.example/old.jpg', imageUrls: [],
    category: 'electronics', brand: 'brand-1', stock: 5,
  }, categorySuggestion, brandSuggestion, [{ id: 'brand-1', name: 'Brand' }], {
    status: 'PRICE_CHANGED', changedFields: ['price'], fieldChanges: [{ field: 'price' } as never],
  }, settings, source);
  assert.equal(existingPayload.originalPrice, 1_850);
  assert.equal(existingPayload.discount, 38);

  const unapprovedPricePayload = buildProductPayload(
    { ...product, recommendedRetailPrice: 500 },
    {
      id: 'existing-product', price: 1_146, originalPrice: 1_850, discount: 38,
      marketPrice: 1_850, imageUrl: 'https://supplier.example/old.jpg', imageUrls: [],
      category: 'electronics', brand: 'brand-1', stock: 5,
    },
    categorySuggestion,
    brandSuggestion,
    [{ id: 'brand-1', name: 'Brand' }],
    { status: 'DESCRIPTION_CHANGED', changedFields: ['longDescription'], fieldChanges: [{ field: 'longDescription' } as never] },
    settings,
    source,
  );
  assert.equal(unapprovedPricePayload.price, 1_146);
  assert.equal(unapprovedPricePayload.originalPrice, 1_850);
  assert.equal(unapprovedPricePayload.discount, 38);
});

test('approved offer reprojection cannot turn OFF-product reference pricing into a promotion', () => {
  const offer = buildSupplierProductOffer({
    sourceId: 'dropex', supplierId: 'dropex', supplierProductId: 'drop-product-1', sku: 'DROP-1',
    barcode: '', productId: 'product-1', price: 1_146, cost: 900, stock: 5,
    availability: 'in_stock', priority: 100, health: {}, lastSyncAt: '2026-09-07T00:00:00.000Z',
    reviewStatus: 'approved', catalogPayload: { originalPrice: 1_850 }, supplierSnapshot: {},
    timestamp: '2026-09-07T00:00:00.000Z',
  });
  const projection = buildSupplierOfferPublicProjection(offer, { price: 1_146, stock: 5 });
  assert.equal(projection.price, 1_146);
  assert.equal((projection.originalPrice as { constructor?: { name?: string } })?.constructor?.name, 'DeleteTransform');
  assert.equal((projection.discount as { constructor?: { name?: string } })?.constructor?.name, 'DeleteTransform');
});

test('approved offer reprojection preserves the admin regular price over supplier reference pricing', () => {
  const offer = buildSupplierProductOffer({
    sourceId: 'dropex', supplierId: 'dropex', supplierProductId: 'drop-product-1', sku: 'DROP-1',
    barcode: '', productId: 'product-1', price: 1_146, cost: 900, stock: 5,
    availability: 'in_stock', priority: 100, health: {}, lastSyncAt: '2026-09-07T00:00:00.000Z',
    reviewStatus: 'approved', catalogPayload: { originalPrice: 2_200 }, supplierSnapshot: {},
    timestamp: '2026-09-07T00:00:00.000Z',
  });
  const projection = buildSupplierOfferPublicProjection(offer, {
    price: 1_146,
    originalPrice: 1_850,
    stock: 5,
  });

  assert.equal(projection.price, 1_146);
  assert.equal(projection.originalPrice, 1_850);
  assert.equal(projection.discount, 38);
});

test('approved offer reprojection removes an invalidated promotion instead of restoring supplier reference pricing', () => {
  const offer = buildSupplierProductOffer({
    sourceId: 'dropex', supplierId: 'dropex', supplierProductId: 'drop-product-1', sku: 'DROP-1',
    barcode: '', productId: 'product-1', price: 2_000, cost: 900, stock: 5,
    availability: 'in_stock', priority: 100, health: {}, lastSyncAt: '2026-09-07T00:00:00.000Z',
    reviewStatus: 'approved', catalogPayload: { originalPrice: 2_200 }, supplierSnapshot: {},
    timestamp: '2026-09-07T00:00:00.000Z',
  });
  const projection = buildSupplierOfferPublicProjection(offer, {
    price: 1_146,
    originalPrice: 1_850,
    stock: 5,
  });

  assert.equal((projection.originalPrice as { constructor?: { name?: string } })?.constructor?.name, 'DeleteTransform');
  assert.equal((projection.discount as { constructor?: { name?: string } })?.constructor?.name, 'DeleteTransform');
});
