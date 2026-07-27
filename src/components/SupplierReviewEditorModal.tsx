import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Check, Image, LockKeyhole, Package, Plus, RefreshCw, Sparkles, Trash2, X } from 'lucide-react';
import {
  buildSupplierReviewMetadataSections,
  buildSupplierReviewFieldChanges,
  calculateSupplierProfit,
  setSupplierReviewDraftFieldOwner,
  SupplierReviewDraft,
  SupplierReviewEditableField,
  SupplierReviewSourceItem,
  SUPPLIER_REVIEW_EDITABLE_FIELDS,
  updateSupplierReviewDraftField,
  validateSupplierReviewDraft,
} from '../services/supplierReviewEditor';
import { isValidSupplierImageUrl } from '../services/connectors/a2z-website/productImages';
import {
  SupplierOfferSelectionView,
  SupplierOfferView,
  supplierOfferIsActive,
  supplierOfferIsLocked,
} from '../services/supplierOffers';

interface SupplierReviewEditorModalProps {
  item: SupplierReviewSourceItem;
  initialDraft: SupplierReviewDraft;
  categories: Array<{
    id: string;
    name?: string;
    isActive?: boolean;
    subcategories?: Array<{ id: string; name: string; isActive?: boolean }>;
    specificationTemplate?: Array<{ name: string; required?: boolean }>;
  }>;
  brands: Array<{ id: string; name: string; isActive?: boolean }>;
  validCategoryIds: readonly string[];
  isPublishing: boolean;
  onClose: () => void;
  onPublish: (draft: SupplierReviewDraft) => Promise<void>;
  offers: SupplierOfferView[];
  offerSelection: SupplierOfferSelectionView;
  offersLoading: boolean;
  offerActionId: string | null;
  offerError: string | null;
  onRefreshOffers: () => Promise<void>;
  onConfigureOffer: (offerId: string, patch: { priority?: number; enabled?: boolean }) => Promise<void>;
  onSelectOffer: (offerId: string, options: { locked: boolean; failoverEnabled: boolean }) => Promise<void>;
}

const money = (value: number): string => `LKR ${value.toLocaleString('en-LK', { maximumFractionDigits: 2 })}`;
const MAX_MANAGED_MEDIA_IMAGES = 20;
const OWNERSHIP_LABELS: Record<SupplierReviewEditableField, string> = {
  name: 'Product name', shortDescription: 'Short description', description: 'Description', model: 'Model',
  barcode: 'Barcode', productType: 'Product type', tags: 'Tags', keyFeatures: 'Key features',
  whatsIncluded: "What's included", slug: 'SEO slug', price: 'Selling price', originalPrice: 'Compare price',
  stock: 'Stock', category: 'Category', subcategory: 'Subcategory', brand: 'Brand', specs: 'Specifications',
  isActive: 'Storefront status', isNew: 'New arrival', isFeatured: 'Featured', isBestSeller: 'Best seller',
  imageUrl: 'Primary image', imageUrls: 'Gallery images',
};

const commaList = (value: string): string[] => value.split(',').map((entry) => entry.trim()).filter(Boolean);

const metadataText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export default function SupplierReviewEditorModal({
  item,
  initialDraft,
  categories,
  brands,
  validCategoryIds,
  isPublishing,
  onClose,
  onPublish,
  offers,
  offerSelection,
  offersLoading,
  offerActionId,
  offerError,
  onRefreshOffers,
  onConfigureOffer,
  onSelectOffer,
}: SupplierReviewEditorModalProps) {
  const [draft, setDraft] = useState(initialDraft);
  const [submitted, setSubmitted] = useState(false);
  const [galleryInput, setGalleryInput] = useState('');
  const [galleryInputError, setGalleryInputError] = useState('');
  const [specificationName, setSpecificationName] = useState('');
  const [specificationValue, setSpecificationValue] = useState('');
  const [failedMediaUrls, setFailedMediaUrls] = useState<Set<string>>(() => new Set());
  const firstInputRef = useRef<HTMLInputElement>(null);
  const validationErrors = useMemo(
    () => validateSupplierReviewDraft(draft, validCategoryIds, categories, brands),
    [brands, categories, draft, validCategoryIds],
  );
  const selectedCategory = useMemo(
    () => categories.find((category) => category.id === draft.category),
    [categories, draft.category],
  );
  const missingFields = useMemo(() => Object.keys(validationErrors), [validationErrors]);
  const profit = useMemo(
    () => calculateSupplierProfit(draft.sellingPrice, item.costPrice),
    [draft.sellingPrice, item.costPrice],
  );
  const metadataSections = useMemo(() => buildSupplierReviewMetadataSections(item), [item]);
  const fieldChanges = useMemo(() => buildSupplierReviewFieldChanges(item), [item]);
  const importWarnings = [
    ...(item.productValidation?.errors || []),
    ...(item.productValidation?.warnings || []),
  ];
  const supplierVideoUrls = useMemo(() => {
    const snapshot = item.supplierSnapshot || {};
    const metadata = snapshot.supplierMetadata && typeof snapshot.supplierMetadata === 'object'
      ? snapshot.supplierMetadata as Record<string, unknown>
      : {};
    const values = snapshot.videoUrls ?? metadata.videoUrls ?? item.productPayload?.videoUrls;
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string' && /^https?:\/\//iu.test(value)) : [];
  }, [item]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    firstInputRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isPublishing) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isPublishing, onClose]);

  const setNumber = (field: 'sellingPrice' | 'comparePrice' | 'stock', value: string) => {
    const ownershipField = field === 'sellingPrice' ? 'price' : field === 'comparePrice' ? 'originalPrice' : 'stock';
    setDraft((current) => updateSupplierReviewDraftField(current, ownershipField, { [field]: value === '' ? Number.NaN : Number(value) }));
  };

  const editDraft = (field: SupplierReviewEditableField, patch: Partial<SupplierReviewDraft>) => {
    setDraft((current) => updateSupplierReviewDraftField(current, field, patch));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (Object.keys(validationErrors).length > 0 || isPublishing) return;
    await onPublish(draft);
  };

  const setSpecification = (name: string, value: string) => {
    setDraft((current) => updateSupplierReviewDraftField(current, 'specs', {
      specifications: { ...(current.specifications || {}), [name]: value },
    }));
  };

  const removeSpecification = (name: string) => {
    setDraft((current) => {
      const specifications = { ...(current.specifications || {}) };
      delete specifications[name];
      return updateSupplierReviewDraftField(current, 'specs', { specifications });
    });
  };

  const addSpecification = () => {
    const name = specificationName.normalize('NFKC').trim();
    if (!name || Object.keys(draft.specifications || {}).some((key) => key.toLocaleLowerCase() === name.toLocaleLowerCase())) return;
    setSpecification(name, specificationValue.trim());
    setSpecificationName('');
    setSpecificationValue('');
  };

  const addGalleryImage = () => {
    const imageUrl = galleryInput.trim();
    if (!isValidSupplierImageUrl(imageUrl)) {
      setGalleryInputError('Enter a valid http or https supplier image URL.');
      return;
    }
    if (new URL(imageUrl).protocol !== 'https:') {
      setGalleryInputError('Managed supplier images must use HTTPS.');
      return;
    }
    if (draft.galleryImageUrls.length >= MAX_MANAGED_MEDIA_IMAGES - 1) {
      setGalleryInputError(`A product can contain at most ${MAX_MANAGED_MEDIA_IMAGES} managed images.`);
      return;
    }
    if (imageUrl === draft.primaryImageUrl.trim() || draft.galleryImageUrls.includes(imageUrl)) {
      setGalleryInputError('This image URL is already in the product gallery.');
      return;
    }
    setDraft((current) => updateSupplierReviewDraftField(current, 'imageUrls', { galleryImageUrls: [...current.galleryImageUrls, imageUrl] }));
    setGalleryInput('');
    setGalleryInputError('');
  };

  const removeGalleryImage = (index: number) => {
    setDraft((current) => updateSupplierReviewDraftField(current, 'imageUrls', {
      galleryImageUrls: current.galleryImageUrls.filter((_, imageIndex) => imageIndex !== index),
    }));
  };

  const moveGalleryImage = (index: number, offset: -1 | 1) => {
    setDraft((current) => {
      const destination = index + offset;
      if (destination < 0 || destination >= current.galleryImageUrls.length) return current;
      const galleryImageUrls = [...current.galleryImageUrls];
      [galleryImageUrls[index], galleryImageUrls[destination]] = [galleryImageUrls[destination], galleryImageUrls[index]];
      return updateSupplierReviewDraftField(current, 'imageUrls', { galleryImageUrls });
    });
  };

  const errorFor = (field: keyof typeof validationErrors) => submitted ? validationErrors[field] : undefined;
  const markMediaFailure = (url: string) => setFailedMediaUrls((current) => {
    if (current.has(url)) return current;
    const next = new Set(current);
    next.add(url);
    return next;
  });

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="supplier-review-editor-title"
        className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-3xl border border-slate-200 bg-white p-6 text-left shadow-2xl dark:border-slate-800 dark:bg-[#111928]"
      >
        <div className="mb-5 flex items-start justify-between gap-4 border-b border-slate-100 pb-4 dark:border-slate-800">
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-blue-500/10 p-2 text-blue-500"><Package className="h-5 w-5" /></span>
            <div>
              <h3 id="supplier-review-editor-title" className="text-base font-black text-slate-900 dark:text-white">Review & Publish Product</h3>
              <p className="text-[11px] text-slate-400">Confirm storefront values while preserving the supplier record.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={isPublishing} aria-label="Close product editor" className="rounded-full bg-slate-100 p-2 text-slate-500 disabled:opacity-50 dark:bg-slate-800">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <details className="order-[80] rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs dark:border-slate-800 dark:bg-slate-900/40">
            <summary className="cursor-pointer font-black text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-200">Supplier information</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div><span className="block text-[9px] font-black uppercase tracking-wider text-slate-400">Supplier</span><strong>{item.supplierName || 'Unknown Supplier'}</strong></div>
            <div><span className="block text-[9px] font-black uppercase tracking-wider text-slate-400">Supplier SKU</span><strong className="font-mono">{item.supplierCode}</strong></div>
            <div><span className="block text-[9px] font-black uppercase tracking-wider text-slate-400">Wholesale Price</span><strong>{money(item.costPrice)}</strong></div>
          </div>
          </details>

          <details className="order-[81] rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 text-xs">
            <summary className="cursor-pointer font-black text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-200">Category and brand suggestions</summary>
          <section className="mt-3 grid gap-3 sm:grid-cols-2" aria-labelledby="supplier-mapping-summary-title">
            <div className="sm:col-span-2">
              <h4 id="supplier-mapping-summary-title" className="flex items-center gap-2 font-black text-slate-800 dark:text-white"><Sparkles className="h-4 w-4 text-blue-500" />Intelligent mapping</h4>
            </div>
            <div className="rounded-xl bg-white/70 p-3 dark:bg-slate-900/60">
              <span className="block text-[9px] font-black uppercase text-slate-400">Supplier category</span>
              <strong>{item.categoryMapping?.supplierCategory || 'Not supplied'}</strong>
              <p className="mt-1 text-[10px] text-slate-500">Suggestion: {item.categoryMapping?.targetCategoryId || 'Manual selection required'} · {Math.round(Number(item.categoryMapping?.confidence || 0))}%</p>
              {item.categoryMapping?.targetCategoryId && !item.categoryMapping.autoSelected ? <button type="button" onClick={() => setDraft((current) => ({ ...current, category: item.categoryMapping?.targetCategoryId || '', subcategory: item.categoryMapping?.targetSubcategoryId || '' }))} className="mt-2 rounded-lg bg-blue-600 px-3 py-2 text-[10px] font-black text-white">Accept category suggestion</button> : null}
            </div>
            <div className="rounded-xl bg-white/70 p-3 dark:bg-slate-900/60">
              <span className="block text-[9px] font-black uppercase text-slate-400">Supplier brand</span>
              <strong>{item.brandMapping?.supplierBrand || 'Not supplied'}</strong>
              <p className="mt-1 text-[10px] text-slate-500">Mapped brand: {item.brandMapping?.mappedBrandId || 'Manual selection required'} · {Math.round(Number(item.brandMapping?.confidence || 0))}%</p>
              {item.brandMapping?.mappedBrandId && !item.brandMapping.autoSelected ? <button type="button" onClick={() => setDraft((current) => ({ ...current, brand: item.brandMapping?.mappedBrandId || '' }))} className="mt-2 rounded-lg bg-blue-600 px-3 py-2 text-[10px] font-black text-white">Accept brand suggestion</button> : null}
            </div>
          </section>

          {importWarnings.length > 0 && (
            <section className="order-0 rounded-2xl border border-amber-500/25 bg-amber-500/10 p-4 text-xs" aria-labelledby="supplier-import-warnings-title">
              <h4 id="supplier-import-warnings-title" className="flex items-center gap-2 font-black text-amber-700 dark:text-amber-300"><AlertTriangle className="h-4 w-4" />Product details needing attention</h4>
              <ul className="mt-2 space-y-1 text-[10px] font-semibold text-amber-700/90 dark:text-amber-200/90">
                {importWarnings.map((warning) => <li key={`${warning.field}-${warning.code}`}>{warning.message}</li>)}
              </ul>
            </section>
          )}

          {fieldChanges.length > 0 && (
            <section className="order-[70] rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4" aria-labelledby="supplier-proposed-changes-title">
              <h4 id="supplier-proposed-changes-title" className="text-xs font-black uppercase tracking-wider text-blue-700 dark:text-blue-300">What changed</h4>
              <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">Review the previous value beside the supplier's latest value.</p>
              <dl className="mt-3 space-y-2">
                {fieldChanges.map((change) => (
                  <div key={`${change.field}-${change.auditKey || change.label}`} className="rounded-xl border border-blue-500/10 bg-white p-3 dark:bg-slate-950/60">
                    <dt className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-black uppercase tracking-wide text-slate-700 dark:text-slate-200">
                      <span>{change.label}</span>
                      <span className="rounded-full bg-blue-500/10 px-2 py-1 text-[8px] font-black uppercase tracking-wider text-blue-600 dark:text-blue-300">{change.changeType || 'changed'}</span>
                    </dt>
                    <dd className="mt-2 grid gap-2 sm:grid-cols-2">
                      <div>
                        <span className="text-[8px] font-black uppercase tracking-wide text-slate-400">Previous</span>
                        <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[10px] font-semibold text-slate-600 dark:text-slate-300">{metadataText(change.before)}</p>
                      </div>
                      <div>
                        <span className="text-[8px] font-black uppercase tracking-wide text-slate-400">Supplier value</span>
                        <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[10px] font-semibold text-blue-700 dark:text-blue-200">{metadataText(change.after)}</p>
                      </div>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          <details className="order-[82] rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
            <summary className="cursor-pointer text-xs font-black uppercase tracking-wider text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-200">Supplier metadata</summary>
          <section aria-labelledby="supplier-imported-data-title" className="mt-3 space-y-3">
            <div>
              <h4 id="supplier-imported-data-title" className="sr-only">Supplier metadata details</h4>
              <p className="mt-1 text-[10px] text-slate-400">Original supplier values are retained here for reference.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {metadataSections.map((section) => (
                <details key={section.id} open={section.open} className="group rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-800 dark:bg-slate-900/40">
                  <summary className="cursor-pointer select-none font-black text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-200">
                    {section.title} <span className="text-[9px] font-bold text-slate-400">({section.fields.length})</span>
                  </summary>
                  {section.fields.length === 0 ? (
                    <p className="mt-3 text-[10px] text-slate-400">Not supplied by this connector.</p>
                  ) : (
                    <dl className="mt-3 space-y-2">
                      {section.fields.map((entry) => (
                        <div key={entry.label} className="rounded-lg bg-white p-2 dark:bg-slate-950/60">
                          <dt className="text-[9px] font-black uppercase tracking-wide text-slate-400">{entry.label}</dt>
                          <dd className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[10px] font-semibold text-slate-700 dark:text-slate-200">{metadataText(entry.value)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </details>
              ))}
            </div>
          </section>
          </details>

          <div className="order-20 grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs sm:col-span-2">
              <span className="font-bold text-slate-600 dark:text-slate-300">Product Name</span>
              <input ref={firstInputRef} value={draft.productName} onChange={(event) => editDraft('name', { productName: event.target.value })} aria-invalid={Boolean(errorFor('productName'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" />
              {errorFor('productName') && <span className="text-[10px] font-semibold text-red-500">{errorFor('productName')}</span>}
            </label>

            <label className="space-y-1.5 text-xs">
              <span className="font-bold text-slate-600 dark:text-slate-300">Selling Price</span>
              <input type="number" min="0.01" step="0.01" value={Number.isFinite(draft.sellingPrice) ? draft.sellingPrice : ''} onChange={(event) => setNumber('sellingPrice', event.target.value)} aria-invalid={Boolean(errorFor('sellingPrice'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" />
              {errorFor('sellingPrice') && <span className="text-[10px] font-semibold text-red-500">{errorFor('sellingPrice')}</span>}
            </label>

            <label className="space-y-1.5 text-xs">
              <span className="font-bold text-slate-600 dark:text-slate-300">Compare Price</span>
              <input type="number" min="0" step="0.01" value={Number.isFinite(draft.comparePrice) ? draft.comparePrice : ''} onChange={(event) => setNumber('comparePrice', event.target.value)} aria-invalid={Boolean(errorFor('comparePrice'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" />
              {errorFor('comparePrice') && <span className="text-[10px] font-semibold text-red-500">{errorFor('comparePrice')}</span>}
            </label>

            <label className="space-y-1.5 text-xs">
              <span className="font-bold text-slate-600 dark:text-slate-300">Stock</span>
              <input type="number" min="0" step="1" value={Number.isFinite(draft.stock) ? draft.stock : ''} onChange={(event) => setNumber('stock', event.target.value)} aria-invalid={Boolean(errorFor('stock'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" />
              {errorFor('stock') && <span className="text-[10px] font-semibold text-red-500">{errorFor('stock')}</span>}
            </label>

            <label className="space-y-1.5 text-xs">
              <span className="font-bold text-slate-600 dark:text-slate-300">Category</span>
              <select value={draft.category} onChange={(event) => setDraft((current) => updateSupplierReviewDraftField(updateSupplierReviewDraftField(current, 'category', { category: event.target.value, subcategory: '' }), 'subcategory', {}))} aria-invalid={Boolean(errorFor('category'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900">
                <option value="">Select category</option>
                {categories.filter((category) => category.isActive !== false).map((category) => <option key={category.id} value={category.id}>{category.name || category.id}</option>)}
              </select>
              {errorFor('category') && <span className="text-[10px] font-semibold text-red-500">{errorFor('category')}</span>}
            </label>

            <label className="space-y-1.5 text-xs">
              <span className="font-bold text-slate-600 dark:text-slate-300">Subcategory</span>
              <select value={draft.subcategory} onChange={(event) => editDraft('subcategory', { subcategory: event.target.value })} aria-invalid={Boolean(errorFor('subcategory'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900">
                <option value="">Select subcategory</option>
                {(selectedCategory?.subcategories || []).filter((subcategory) => subcategory.isActive !== false).map((subcategory) => <option key={subcategory.id} value={subcategory.id}>{subcategory.name}</option>)}
              </select>
              {errorFor('subcategory') && <span className="text-[10px] font-semibold text-red-500">{errorFor('subcategory')}</span>}
            </label>

            <label className="space-y-1.5 text-xs">
              <span className="font-bold text-slate-600 dark:text-slate-300">Registered brand</span>
              <select value={draft.brand} onChange={(event) => editDraft('brand', { brand: event.target.value })} aria-invalid={Boolean(errorFor('brand'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900">
                <option value="">Select brand</option>
                {brands.filter((brand) => brand.isActive !== false).map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
              </select>
              {errorFor('brand') && <span className="text-[10px] font-semibold text-red-500">{errorFor('brand')}</span>}
            </label>

            <label className="flex min-h-11 items-center justify-between rounded-xl border border-slate-200 px-3 text-xs dark:border-slate-700">
              <span className="font-bold text-slate-600 dark:text-slate-300">Storefront status</span>
              <span className="flex items-center gap-2"><input type="checkbox" checked={draft.isActive} onChange={(event) => editDraft('isActive', { isActive: event.target.checked })} />{draft.isActive ? 'Active' : 'Inactive'}</span>
            </label>
          </div>

          <section className="order-[60] space-y-3 rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4" aria-labelledby="supplier-offers-title">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 id="supplier-offers-title" className="text-xs font-black uppercase tracking-wider text-blue-700 dark:text-blue-200">Supplier offers</h4>
                <p className="mt-1 text-[10px] text-slate-500">Compare independent supplier terms. Changing the active supplier does not bypass product review.</p>
              </div>
              <button type="button" onClick={() => void onRefreshOffers()} disabled={offersLoading} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-blue-500/20 bg-white px-3 text-[10px] font-black text-blue-700 disabled:opacity-50 dark:bg-slate-900 dark:text-blue-200">
                <RefreshCw className={`h-3.5 w-3.5 ${offersLoading ? 'animate-spin' : ''}`} aria-hidden="true" />Refresh
              </button>
            </div>
            {offerError && <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-[10px] font-semibold text-red-600">{offerError}</p>}
            {offersLoading ? (
              <div className="h-24 animate-pulse rounded-xl bg-slate-200/70 dark:bg-slate-800" aria-label="Loading supplier offers" />
            ) : offers.length === 0 ? (
              <p className="rounded-xl border border-dashed border-blue-500/20 px-4 py-5 text-center text-[10px] font-semibold text-slate-500">This legacy product has no materialized supplier offers yet. Its first approved supplier sync will create one automatically.</p>
            ) : (
              <div className="grid gap-3">
                {offers.map((offer) => {
                  const active = supplierOfferIsActive(offer, offerSelection);
                  const locked = supplierOfferIsLocked(offer, offerSelection);
                  const busy = offerActionId === offer.id;
                  return (
                    <article key={offer.id} className={`rounded-xl border bg-white p-3 dark:bg-slate-900 ${active ? 'border-emerald-500/40 ring-1 ring-emerald-500/20' : 'border-slate-200 dark:border-slate-700'}`}>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <strong className="text-xs text-slate-900 dark:text-white">{offer.supplierId || offer.sourceId}</strong>
                            {active && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[9px] font-black text-emerald-600">Active</span>}
                            {locked && <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[9px] font-black text-amber-600"><LockKeyhole className="h-3 w-3" />Locked</span>}
                            {!offer.enabled && <span className="rounded-full bg-slate-500/10 px-2 py-0.5 text-[9px] font-black text-slate-500">Disabled</span>}
                          </div>
                          <p className="mt-1 text-[9px] text-slate-400">{offer.sourceId} · SKU {offer.sku || '—'} · {offer.reviewStatus.replaceAll('_', ' ')}</p>
                        </div>
                        <span className={`rounded-full px-2 py-1 text-[9px] font-black ${offer.availability === 'in_stock' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600'}`}>{offer.availability.replaceAll('_', ' ')}</span>
                      </div>
                      <dl className="mt-3 grid grid-cols-2 gap-2 text-[10px] sm:grid-cols-4">
                        <div><dt className="text-slate-400">Price</dt><dd className="font-black">{money(offer.price)}</dd></div>
                        <div><dt className="text-slate-400">Cost</dt><dd className="font-black">{money(offer.cost)}</dd></div>
                        <div><dt className="text-slate-400">Stock</dt><dd className="font-black">{offer.stock}</dd></div>
                        <div><dt className="text-slate-400">Last sync</dt><dd className="truncate font-bold" title={offer.lastSyncAt}>{offer.lastSyncAt ? new Date(offer.lastSyncAt).toLocaleString() : '—'}</dd></div>
                      </dl>
                      <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                        <label className="text-[9px] font-bold text-slate-500">Priority<input type="number" min="0" max="10000" defaultValue={offer.priority} disabled={busy} onBlur={(event) => { const priority = Number(event.target.value); if (Number.isInteger(priority) && priority !== offer.priority) void onConfigureOffer(offer.id, { priority }); }} className="mt-1 block h-9 w-24 rounded-lg border border-slate-200 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-950" /></label>
                        <label className="flex min-h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-[10px] font-bold dark:border-slate-700"><input type="checkbox" checked={offer.enabled} disabled={busy} onChange={(event) => void onConfigureOffer(offer.id, { enabled: event.target.checked })} />Enabled</label>
                        <button type="button" disabled={busy || !offer.enabled || active} onClick={() => void onSelectOffer(offer.id, { locked: false, failoverEnabled: offerSelection.failoverEnabled })} className="min-h-9 rounded-lg bg-blue-600 px-3 text-[10px] font-black text-white disabled:opacity-40">Use supplier</button>
                        <button type="button" disabled={busy || !offer.enabled} onClick={() => void onSelectOffer(offer.id, { locked: !locked, failoverEnabled: offerSelection.failoverEnabled })} className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-amber-500/20 px-3 text-[10px] font-black text-amber-600 disabled:opacity-40"><LockKeyhole className="h-3.5 w-3.5" />{locked ? 'Unlock' : 'Lock'}</button>
                      </div>
                    </article>
                  );
                })}
                <label className="flex min-h-11 items-center justify-between rounded-xl border border-blue-500/15 bg-white px-3 text-xs font-bold dark:bg-slate-900">
                  Automatic failover
                  <input type="checkbox" checked={offerSelection.failoverEnabled} disabled={!offerSelection.activeOfferId || Boolean(offerActionId)} onChange={(event) => { if (offerSelection.activeOfferId) void onSelectOffer(offerSelection.activeOfferId, { locked: Boolean(offerSelection.lockedOfferId), failoverEnabled: event.target.checked }); }} />
                </label>
              </div>
            )}
          </section>
          </details>

          <section className="order-30 space-y-4 rounded-2xl border border-slate-200 p-4 dark:border-slate-800" aria-labelledby="supplier-review-content-title">
            <div>
              <h4 id="supplier-review-content-title" className="text-xs font-black uppercase tracking-wider text-slate-700 dark:text-slate-200">Content, identity & merchandising</h4>
              <p className="mt-1 text-[10px] text-slate-400">These are the same customer-facing controls available for manually managed products.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-xs sm:col-span-2"><span className="font-bold text-slate-600 dark:text-slate-300">Short description</span><textarea rows={2} value={draft.shortDescription} onChange={(event) => editDraft('shortDescription', { shortDescription: event.target.value })} aria-invalid={Boolean(errorFor('shortDescription'))} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />{errorFor('shortDescription') && <span className="text-[10px] font-semibold text-red-500">{errorFor('shortDescription')}</span>}</label>
              <label className="space-y-1.5 text-xs sm:col-span-2"><span className="font-bold text-slate-600 dark:text-slate-300">Full description</span><textarea rows={5} value={draft.description} onChange={(event) => editDraft('description', { description: event.target.value })} aria-invalid={Boolean(errorFor('description'))} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />{errorFor('description') && <span className="text-[10px] font-semibold text-red-500">{errorFor('description')}</span>}</label>
              <label className="space-y-1.5 text-xs"><span className="font-bold text-slate-600 dark:text-slate-300">Model</span><input value={draft.model} onChange={(event) => editDraft('model', { model: event.target.value })} aria-invalid={Boolean(errorFor('model'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" /></label>
              <label className="space-y-1.5 text-xs"><span className="font-bold text-slate-600 dark:text-slate-300">Barcode</span><input value={draft.barcode} onChange={(event) => editDraft('barcode', { barcode: event.target.value })} aria-invalid={Boolean(errorFor('barcode'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" /></label>
              <label className="space-y-1.5 text-xs"><span className="font-bold text-slate-600 dark:text-slate-300">Product type</span><input value={draft.productType} onChange={(event) => editDraft('productType', { productType: event.target.value })} aria-invalid={Boolean(errorFor('productType'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" /></label>
              <label className="space-y-1.5 text-xs"><span className="font-bold text-slate-600 dark:text-slate-300">SEO slug</span><input value={draft.slug} onChange={(event) => editDraft('slug', { slug: event.target.value })} aria-invalid={Boolean(errorFor('slug'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" /></label>
              <label className="space-y-1.5 text-xs sm:col-span-2"><span className="font-bold text-slate-600 dark:text-slate-300">Tags</span><input value={draft.tags.join(', ')} onChange={(event) => editDraft('tags', { tags: commaList(event.target.value) })} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" /></label>
              <label className="space-y-1.5 text-xs"><span className="font-bold text-slate-600 dark:text-slate-300">Key features</span><textarea rows={3} value={draft.keyFeatures.join(', ')} onChange={(event) => editDraft('keyFeatures', { keyFeatures: commaList(event.target.value) })} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900" /></label>
              <label className="space-y-1.5 text-xs"><span className="font-bold text-slate-600 dark:text-slate-300">What's included</span><textarea rows={3} value={draft.whatsIncluded.join(', ')} onChange={(event) => editDraft('whatsIncluded', { whatsIncluded: commaList(event.target.value) })} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900" /></label>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {([['isNew', 'New arrival'], ['isFeatured', 'Featured'], ['isBestSeller', 'Best seller']] as const).map(([field, label]) => (
                <label key={field} className="flex min-h-11 items-center justify-between rounded-xl border border-slate-200 px-3 text-xs dark:border-slate-700"><span className="font-bold">{label}</span><input type="checkbox" checked={draft[field]} onChange={(event) => editDraft(field, { [field]: event.target.checked })} /></label>
              ))}
            </div>
          </section>

          <fieldset className="order-40 grid gap-4 rounded-2xl border border-slate-200 p-4 dark:border-slate-800 sm:grid-cols-2">
              <legend className="px-2 text-xs font-black text-slate-700 dark:text-slate-200">Category specifications</legend>
              {(selectedCategory?.specificationTemplate || []).map((field) => (
                <label key={field.name} className="space-y-1.5 text-xs">
                  <span className="font-bold text-slate-600 dark:text-slate-300">{field.name}{field.required ? ' *' : ''}</span>
                  <input value={(draft.specifications || {})[field.name] || ''} onChange={(event) => setSpecification(field.name, event.target.value)} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" />
                </label>
              ))}
              {Object.entries(draft.specifications || {}).filter(([name]) => !(selectedCategory?.specificationTemplate || []).some((field) => field.name === name)).map(([name, value]) => (
                <label key={name} className="space-y-1.5 text-xs">
                  <span className="flex items-center justify-between gap-2 font-bold text-slate-600 dark:text-slate-300">{name}<button type="button" onClick={() => removeSpecification(name)} aria-label={`Remove ${name} specification`} className="rounded-md p-1 text-red-500"><Trash2 className="h-3.5 w-3.5" /></button></span>
                  <input value={value} onChange={(event) => setSpecification(name, event.target.value)} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" />
                </label>
              ))}
              <div className="grid gap-2 sm:col-span-2 sm:grid-cols-[1fr_1fr_auto]">
                <input value={specificationName} onChange={(event) => setSpecificationName(event.target.value)} placeholder="Specification name" aria-label="New specification name" className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 text-xs dark:border-slate-700 dark:bg-slate-900" />
                <input value={specificationValue} onChange={(event) => setSpecificationValue(event.target.value)} placeholder="Value" aria-label="New specification value" className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 text-xs dark:border-slate-700 dark:bg-slate-900" />
                <button type="button" onClick={addSpecification} disabled={!specificationName.trim()} className="inline-flex min-h-11 items-center justify-center gap-1 rounded-xl bg-slate-900 px-4 text-xs font-black text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"><Plus className="h-4 w-4" />Add</button>
              </div>
              {errorFor('specifications') && <span className="text-[10px] font-semibold text-red-500 sm:col-span-2">{errorFor('specifications')}</span>}
          </fieldset>

          <details className="order-[90] rounded-2xl border border-violet-500/20 bg-violet-500/5 p-4">
            <summary className="cursor-pointer text-xs font-black text-violet-700 outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:text-violet-200">Advanced field protection</summary>
          <section className="mt-3 space-y-3" aria-labelledby="supplier-field-ownership-title">
            <div>
              <h4 id="supplier-field-ownership-title" className="text-xs font-black uppercase tracking-wider text-violet-700 dark:text-violet-200">Field ownership</h4>
              <p className="mt-1 text-[10px] text-slate-500">Admin-owned values remain protected during later supplier approvals. Supplier-owned values may follow approved supplier updates.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {SUPPLIER_REVIEW_EDITABLE_FIELDS.map((field) => (
                <label key={field} className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-violet-500/15 bg-white px-3 text-xs dark:bg-slate-900">
                  <span className="font-bold text-slate-700 dark:text-slate-200">{OWNERSHIP_LABELS[field]}</span>
                  <select value={draft.fieldOwnership[field]} onChange={(event) => setDraft((current) => setSupplierReviewDraftFieldOwner(current, field, event.target.value as 'admin' | 'supplier'))} aria-label={`${OWNERSHIP_LABELS[field]} ownership`} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[10px] font-black dark:border-slate-700 dark:bg-slate-950">
                    <option value="admin">Admin</option>
                    <option value="supplier">Supplier</option>
                  </select>
                </label>
              ))}
            </div>
          </section>
          </details>

          <section className="order-10 space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/40" aria-labelledby="supplier-product-images-title">
            <div>
              <h4 id="supplier-product-images-title" className="text-xs font-black uppercase tracking-wider text-slate-700 dark:text-slate-200">Product Images</h4>
              <p className="mt-1 text-[10px] text-slate-400">Edit the storefront primary image and gallery order before publishing.</p>
              <p className="mt-1 text-[10px] font-bold text-slate-500">Image count: {draft.primaryImageUrl.trim() ? draft.galleryImageUrls.length + 1 : draft.galleryImageUrls.length}{failedMediaUrls.size > 0 ? ` · Broken images: ${failedMediaUrls.size}` : ''}</p>
            </div>

            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem]">
              <label className="space-y-1.5 text-xs">
                <span className="font-bold text-slate-600 dark:text-slate-300">Primary image URL</span>
                <input
                  type="url"
                  value={draft.primaryImageUrl}
                  onChange={(event) => editDraft('imageUrl', { primaryImageUrl: event.target.value })}
                  aria-invalid={Boolean(errorFor('primaryImageUrl'))}
                  placeholder="https://supplier.example/product.jpg"
                  className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900"
                />
                {errorFor('primaryImageUrl') && <span className="block text-[10px] font-semibold text-red-500">{errorFor('primaryImageUrl')}</span>}
              </label>
              <div className="flex aspect-square items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
                {isValidSupplierImageUrl(draft.primaryImageUrl) ? (
                  <img src={draft.primaryImageUrl.trim()} alt="Primary product preview" onError={() => markMediaFailure(draft.primaryImageUrl.trim())} className="h-full w-full object-contain" referrerPolicy="no-referrer" />
                ) : (
                  <div className="text-center text-slate-400"><Image className="mx-auto h-6 w-6" /><span className="mt-1 block text-[9px] font-bold">No valid preview</span></div>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <span className="text-xs font-bold text-slate-600 dark:text-slate-300">Gallery images</span>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="url"
                  value={galleryInput}
                  onChange={(event) => { setGalleryInput(event.target.value); setGalleryInputError(''); }}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addGalleryImage(); } }}
                  placeholder="Add gallery image URL"
                  aria-invalid={Boolean(galleryInputError)}
                  className="min-h-11 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-xs dark:border-slate-700 dark:bg-slate-900"
                />
                <button type="button" onClick={addGalleryImage} disabled={draft.galleryImageUrls.length >= MAX_MANAGED_MEDIA_IMAGES - 1} className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-50"><Plus className="h-4 w-4" />Add image</button>
              </div>
              {galleryInputError && <span className="block text-[10px] font-semibold text-red-500">{galleryInputError}</span>}
              {errorFor('galleryImageUrls') && <span className="block text-[10px] font-semibold text-red-500">{errorFor('galleryImageUrls')}</span>}
            </div>

            {draft.galleryImageUrls.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-[10px] font-semibold text-slate-400 dark:border-slate-700">No additional gallery images.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {draft.galleryImageUrls.map((imageUrl, index) => (
                  <article key={`${imageUrl}-${index}`} className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
                    <div className="mb-2 flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-950">
                      {isValidSupplierImageUrl(imageUrl) ? <img src={imageUrl} alt={`Gallery preview ${index + 1}`} onError={() => markMediaFailure(imageUrl)} className="h-full w-full object-contain" referrerPolicy="no-referrer" /> : <Image className="h-6 w-6 text-red-400" />}
                    </div>
                    <p className="truncate text-[9px] text-slate-400" title={imageUrl}>{imageUrl}</p>
                    <div className="mt-2 flex justify-end gap-1">
                      <button type="button" onClick={() => moveGalleryImage(index, -1)} disabled={index === 0} aria-label={`Move gallery image ${index + 1} up`} className="rounded-lg border border-slate-200 p-2 text-slate-500 disabled:opacity-30 dark:border-slate-700"><ArrowUp className="h-3.5 w-3.5" /></button>
                      <button type="button" onClick={() => moveGalleryImage(index, 1)} disabled={index === draft.galleryImageUrls.length - 1} aria-label={`Move gallery image ${index + 1} down`} className="rounded-lg border border-slate-200 p-2 text-slate-500 disabled:opacity-30 dark:border-slate-700"><ArrowDown className="h-3.5 w-3.5" /></button>
                      <button type="button" onClick={() => removeGalleryImage(index)} aria-label={`Remove gallery image ${index + 1}`} className="rounded-lg border border-red-500/20 p-2 text-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  </article>
                ))}
              </div>
            )}

            {supplierVideoUrls.length > 0 && (
              <div className="space-y-2">
                <span className="text-xs font-bold text-slate-600 dark:text-slate-300">Supplier video URLs</span>
                <ul className="space-y-1">
                  {supplierVideoUrls.map((url) => <li key={url}><a href={url} target="_blank" rel="noreferrer" className="block truncate text-[10px] font-semibold text-blue-600 underline" title={url}>{url}</a></li>)}
                </ul>
              </div>
            )}
          </section>

          <div className="order-50 grid gap-3 sm:grid-cols-2" aria-live="polite">
            <div className={`rounded-2xl border p-4 ${profit.profit >= 0 ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600' : 'border-red-500/20 bg-red-500/10 text-red-600'}`}>
              <span className="block text-[9px] font-black uppercase tracking-wider">Profit</span><strong className="text-lg">{money(profit.profit)}</strong>
            </div>
            <div className={`rounded-2xl border p-4 ${profit.marginPercent >= 0 ? 'border-blue-500/20 bg-blue-500/10 text-blue-600' : 'border-red-500/20 bg-red-500/10 text-red-600'}`}>
              <span className="block text-[9px] font-black uppercase tracking-wider">Margin</span><strong className="text-lg">{profit.marginPercent.toFixed(2)}%</strong>
            </div>
          </div>

          <div className={`order-[55] rounded-2xl border p-4 text-xs ${missingFields.length === 0 ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700' : 'border-amber-500/20 bg-amber-500/10 text-amber-700'}`} aria-live="polite">
            <strong className="flex items-center gap-2">{missingFields.length === 0 ? <Check className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}{missingFields.length === 0 ? 'Ready to publish' : 'Missing required product data'}</strong>
            {missingFields.length > 0 && <p className="mt-1 text-[10px]">Complete: {missingFields.join(', ')}.</p>}
          </div>

          <div className="order-[100] flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
            <button type="button" onClick={onClose} disabled={isPublishing} className="min-h-11 rounded-xl border border-slate-200 px-4 text-xs font-bold text-slate-500 disabled:opacity-50 dark:border-slate-700">Cancel</button>
            <button type="submit" disabled={isPublishing || missingFields.length > 0} className="flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-5 text-xs font-black text-white disabled:bg-slate-600">
              <Check className="h-4 w-4" />{isPublishing ? 'Publishing...' : 'Approve & Publish'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
