import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Check, Image, Package, Plus, Sparkles, Trash2, X } from 'lucide-react';
import {
  buildSupplierReviewMetadataSections,
  calculateSupplierProfit,
  SupplierReviewDraft,
  SupplierReviewSourceItem,
  validateSupplierReviewDraft,
} from '../services/supplierReviewEditor';
import { isValidSupplierImageUrl } from '../services/connectors/a2z-website/productImages';

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
}

const money = (value: number): string => `LKR ${value.toLocaleString('en-LK', { maximumFractionDigits: 2 })}`;
const MAX_MANAGED_MEDIA_IMAGES = 20;

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
}: SupplierReviewEditorModalProps) {
  const [draft, setDraft] = useState(initialDraft);
  const [submitted, setSubmitted] = useState(false);
  const [galleryInput, setGalleryInput] = useState('');
  const [galleryInputError, setGalleryInputError] = useState('');
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
    setDraft((current) => ({ ...current, [field]: value === '' ? Number.NaN : Number(value) }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (Object.keys(validationErrors).length > 0 || isPublishing) return;
    await onPublish(draft);
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
    setDraft((current) => ({ ...current, galleryImageUrls: [...current.galleryImageUrls, imageUrl] }));
    setGalleryInput('');
    setGalleryInputError('');
  };

  const removeGalleryImage = (index: number) => {
    setDraft((current) => ({
      ...current,
      galleryImageUrls: current.galleryImageUrls.filter((_, imageIndex) => imageIndex !== index),
    }));
  };

  const moveGalleryImage = (index: number, offset: -1 | 1) => {
    setDraft((current) => {
      const destination = index + offset;
      if (destination < 0 || destination >= current.galleryImageUrls.length) return current;
      const galleryImageUrls = [...current.galleryImageUrls];
      [galleryImageUrls[index], galleryImageUrls[destination]] = [galleryImageUrls[destination], galleryImageUrls[index]];
      return { ...current, galleryImageUrls };
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

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs dark:border-slate-800 dark:bg-slate-900/40 sm:grid-cols-3">
            <div><span className="block text-[9px] font-black uppercase tracking-wider text-slate-400">Supplier</span><strong>{item.supplierName || 'Unknown Supplier'}</strong></div>
            <div><span className="block text-[9px] font-black uppercase tracking-wider text-slate-400">Supplier SKU</span><strong className="font-mono">{item.supplierCode}</strong></div>
            <div><span className="block text-[9px] font-black uppercase tracking-wider text-slate-400">Wholesale Price</span><strong>{money(item.costPrice)}</strong></div>
          </div>

          <section className="grid gap-3 rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 text-xs sm:grid-cols-2" aria-labelledby="supplier-mapping-summary-title">
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
            <section className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-4 text-xs" aria-labelledby="supplier-import-warnings-title">
              <h4 id="supplier-import-warnings-title" className="flex items-center gap-2 font-black text-amber-700 dark:text-amber-300"><AlertTriangle className="h-4 w-4" />Import validation warnings</h4>
              <ul className="mt-2 space-y-1 text-[10px] font-semibold text-amber-700/90 dark:text-amber-200/90">
                {importWarnings.map((warning) => <li key={`${warning.field}-${warning.code}`}>{warning.message}</li>)}
              </ul>
            </section>
          )}

          <section aria-labelledby="supplier-imported-data-title" className="space-y-3">
            <div>
              <h4 id="supplier-imported-data-title" className="text-xs font-black uppercase tracking-wider text-slate-700 dark:text-slate-200">Complete imported supplier data</h4>
              <p className="mt-1 text-[10px] text-slate-400">Only fields supplied by the connector are shown. Expand a section to inspect its original values.</p>
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

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs sm:col-span-2">
              <span className="font-bold text-slate-600 dark:text-slate-300">Product Name</span>
              <input ref={firstInputRef} value={draft.productName} onChange={(event) => setDraft((current) => ({ ...current, productName: event.target.value }))} aria-invalid={Boolean(errorFor('productName'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" />
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
              <select value={draft.category} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value, subcategory: '' }))} aria-invalid={Boolean(errorFor('category'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900">
                <option value="">Select category</option>
                {categories.filter((category) => category.isActive !== false).map((category) => <option key={category.id} value={category.id}>{category.name || category.id}</option>)}
              </select>
              {errorFor('category') && <span className="text-[10px] font-semibold text-red-500">{errorFor('category')}</span>}
            </label>

            <label className="space-y-1.5 text-xs">
              <span className="font-bold text-slate-600 dark:text-slate-300">Subcategory</span>
              <select value={draft.subcategory} onChange={(event) => setDraft((current) => ({ ...current, subcategory: event.target.value }))} aria-invalid={Boolean(errorFor('subcategory'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900">
                <option value="">Select subcategory</option>
                {(selectedCategory?.subcategories || []).filter((subcategory) => subcategory.isActive !== false).map((subcategory) => <option key={subcategory.id} value={subcategory.id}>{subcategory.name}</option>)}
              </select>
              {errorFor('subcategory') && <span className="text-[10px] font-semibold text-red-500">{errorFor('subcategory')}</span>}
            </label>

            <label className="space-y-1.5 text-xs">
              <span className="font-bold text-slate-600 dark:text-slate-300">Registered brand</span>
              <select value={draft.brand} onChange={(event) => setDraft((current) => ({ ...current, brand: event.target.value }))} aria-invalid={Boolean(errorFor('brand'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900">
                <option value="">Select brand</option>
                {brands.filter((brand) => brand.isActive !== false).map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
              </select>
              {errorFor('brand') && <span className="text-[10px] font-semibold text-red-500">{errorFor('brand')}</span>}
            </label>

            <label className="flex min-h-11 items-center justify-between rounded-xl border border-slate-200 px-3 text-xs dark:border-slate-700">
              <span className="font-bold text-slate-600 dark:text-slate-300">Storefront status</span>
              <span className="flex items-center gap-2"><input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft((current) => ({ ...current, isActive: event.target.checked }))} />{draft.isActive ? 'Active' : 'Inactive'}</span>
            </label>
          </div>

          {(selectedCategory?.specificationTemplate || []).length > 0 && (
            <fieldset className="grid gap-4 rounded-2xl border border-slate-200 p-4 dark:border-slate-800 sm:grid-cols-2">
              <legend className="px-2 text-xs font-black text-slate-700 dark:text-slate-200">Category specifications</legend>
              {(selectedCategory?.specificationTemplate || []).map((field) => (
                <label key={field.name} className="space-y-1.5 text-xs">
                  <span className="font-bold text-slate-600 dark:text-slate-300">{field.name}{field.required ? ' *' : ''}</span>
                  <input value={(draft.specifications || {})[field.name] || ''} onChange={(event) => setDraft((current) => ({ ...current, specifications: { ...(current.specifications || {}), [field.name]: event.target.value } }))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" />
                </label>
              ))}
              {errorFor('specifications') && <span className="text-[10px] font-semibold text-red-500 sm:col-span-2">{errorFor('specifications')}</span>}
            </fieldset>
          )}

          <section className="space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/40" aria-labelledby="supplier-product-images-title">
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
                  onChange={(event) => setDraft((current) => ({ ...current, primaryImageUrl: event.target.value }))}
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

          <div className="grid gap-3 sm:grid-cols-2" aria-live="polite">
            <div className={`rounded-2xl border p-4 ${profit.profit >= 0 ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600' : 'border-red-500/20 bg-red-500/10 text-red-600'}`}>
              <span className="block text-[9px] font-black uppercase tracking-wider">Profit</span><strong className="text-lg">{money(profit.profit)}</strong>
            </div>
            <div className={`rounded-2xl border p-4 ${profit.marginPercent >= 0 ? 'border-blue-500/20 bg-blue-500/10 text-blue-600' : 'border-red-500/20 bg-red-500/10 text-red-600'}`}>
              <span className="block text-[9px] font-black uppercase tracking-wider">Margin</span><strong className="text-lg">{profit.marginPercent.toFixed(2)}%</strong>
            </div>
          </div>

          <div className={`rounded-2xl border p-4 text-xs ${missingFields.length === 0 ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700' : 'border-amber-500/20 bg-amber-500/10 text-amber-700'}`} aria-live="polite">
            <strong className="flex items-center gap-2">{missingFields.length === 0 ? <Check className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}{missingFields.length === 0 ? 'Ready to publish' : 'Missing required product data'}</strong>
            {missingFields.length > 0 && <p className="mt-1 text-[10px]">Complete: {missingFields.join(', ')}.</p>}
          </div>

          <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
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
