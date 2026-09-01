import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Check, Image, LockKeyhole, Package, Pencil, Plus, RefreshCw, Sparkles, Trash2, X } from 'lucide-react';
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
import { formatSupplierTimestamp, supplierReviewSpecificationCount } from '../services/supplierHubPresentation';
import {
  formatSupplierCostLabel,
  formatSupplierMarginLabel,
  formatSupplierProfitLabel,
  formatSupplierStockLabel,
} from '../services/supplierCommerceSemantics';

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

const money = (value: number | null | undefined): string => (
  Number.isFinite(value) ? `LKR ${value.toLocaleString('en-LK', { maximumFractionDigits: 2 })}` : 'Not supplied'
);
const MAX_MANAGED_MEDIA_IMAGES = 20;
const OWNERSHIP_LABELS: Record<SupplierReviewEditableField, string> = {
  name: 'Product name', shortDescription: 'Short description', description: 'Description', model: 'Model',
  barcode: 'Barcode', productType: 'Product type', tags: 'Tags', keyFeatures: 'Key features',
  whatsIncluded: "What's included", slug: 'SEO slug', metaDescription: 'Meta description', keywords: 'SEO keywords',
  price: 'Selling price', originalPrice: 'Compare price',
  costPrice: 'Cost price', marketPrice: 'Market price',
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
  const [isEditing, setIsEditing] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [galleryInput, setGalleryInput] = useState('');
  const [galleryInputError, setGalleryInputError] = useState('');
  const [specificationName, setSpecificationName] = useState('');
  const [specificationValue, setSpecificationValue] = useState('');
  const [failedMediaUrls, setFailedMediaUrls] = useState<Set<string>>(() => new Set());
  const firstInputRef = useRef<HTMLInputElement>(null);
  const detailsActionRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const isPublishingRef = useRef(isPublishing);
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
    () => calculateSupplierProfit(draft.sellingPrice, draft.costPrice, draft.supplierCostAvailable),
    [draft.costPrice, draft.sellingPrice, draft.supplierCostAvailable],
  );
  const metadataSections = useMemo(() => buildSupplierReviewMetadataSections(item), [item]);
  const fieldChanges = useMemo(() => buildSupplierReviewFieldChanges(item), [item]);
  const specificationCount = useMemo(() => supplierReviewSpecificationCount(item), [item]);
  const suggestedCategory = useMemo(
    () => categories.find((category) => category.id === item.categoryMapping?.targetCategoryId),
    [categories, item.categoryMapping?.targetCategoryId],
  );
  const suggestedBrand = useMemo(
    () => brands.find((brand) => brand.id === item.brandMapping?.mappedBrandId),
    [brands, item.brandMapping?.mappedBrandId],
  );
  const validationChecklist = useMemo(() => {
    const checks: Array<{ label: string; fields: Array<keyof typeof validationErrors> }> = [
      { label: 'Images', fields: ['primaryImageUrl', 'galleryImageUrls'] },
      { label: 'Price', fields: ['sellingPrice', 'comparePrice', 'costPrice', 'marketPrice'] },
      { label: 'Description', fields: ['shortDescription', 'description'] },
      { label: 'Brand', fields: ['brand'] },
      { label: 'Category', fields: ['category', 'subcategory'] },
      { label: 'Specifications', fields: ['specifications'] },
      { label: 'Stock', fields: ['stock'] },
    ];
    return checks.map((check) => {
      const error = check.fields.map((field) => validationErrors[field]).find(Boolean);
      return { label: check.label, valid: !error, error };
    });
  }, [validationErrors]);
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

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { isPublishingRef.current = isPublishing; }, [isPublishing]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusFrame = window.requestAnimationFrame(() => detailsActionRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isPublishingRef.current) onCloseRef.current();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href]')) as HTMLElement[];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, []);

  const setNumber = (field: 'sellingPrice' | 'comparePrice' | 'costPrice' | 'marketPrice' | 'stock', value: string) => {
    const ownershipField = field === 'sellingPrice'
      ? 'price'
      : field === 'comparePrice'
        ? 'originalPrice'
        : field;
    setDraft((current) => updateSupplierReviewDraftField(current, ownershipField, { [field]: value === '' ? Number.NaN : Number(value) }));
  };

  const editDraft = (field: SupplierReviewEditableField, patch: Partial<SupplierReviewDraft>) => {
    setDraft((current) => updateSupplierReviewDraftField(current, field, patch));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isEditing) return;
    setSubmitted(true);
    if (Object.keys(validationErrors).length > 0 || isPublishing) return;
    await onPublish(draft);
  };

  const beginEditing = () => {
    setIsEditing(true);
    window.requestAnimationFrame(() => firstInputRef.current?.focus());
  };

  const cancelEditing = () => {
    setDraft(initialDraft);
    setSubmitted(false);
    setIsEditing(false);
    window.requestAnimationFrame(() => detailsActionRef.current?.focus());
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
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-2 backdrop-blur-sm sm:p-4" role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="supplier-review-editor-title"
        className="max-h-[calc(100dvh-1rem)] w-full max-w-3xl overflow-y-auto overscroll-contain rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-2xl dark:border-slate-800 dark:bg-[#111928] sm:max-h-[92vh] sm:rounded-3xl sm:p-6"
      >
        <div className="sticky top-0 z-30 mb-5 flex items-start justify-between gap-4 border-b border-slate-100 bg-white/95 pb-4 backdrop-blur dark:border-slate-800 dark:bg-[#111928]/95">
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-blue-500/10 p-2 text-blue-500"><Package className="h-5 w-5" /></span>
            <div>
              <h3 id="supplier-review-editor-title" className="text-base font-black text-slate-900 dark:text-white">{isEditing ? 'Edit product data' : 'Product details'}</h3>
              <p className="text-[11px] text-slate-400">{isEditing ? 'Update storefront values while preserving the supplier record.' : `Read-only supplier review · ${specificationCount} specifications`}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={isPublishing} aria-label="Close product editor" className="rounded-full bg-slate-100 p-2 text-slate-500 disabled:opacity-50 dark:bg-slate-800">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5" aria-readonly={!isEditing}>
          {!isEditing && (
            <p id="supplier-review-read-only-note" className="order-[-1] rounded-xl border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-[10px] font-semibold text-blue-700 dark:text-blue-200">
              Details are read-only. Choose Edit product data before changing storefront values.
            </p>
          )}
          <fieldset disabled={!isEditing || isPublishing} className="contents">
          <details className="order-[80] rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs dark:border-slate-800 dark:bg-slate-900/40">
            <summary className="cursor-pointer font-black text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-200">Supplier information</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div><span className="block text-[9px] font-black uppercase tracking-wider text-slate-400">Supplier</span><strong>{item.supplierName || 'Unknown Supplier'}</strong></div>
            <div><span className="block text-[9px] font-black uppercase tracking-wider text-slate-400">Supplier SKU</span><strong className="font-mono">{item.supplierCode}</strong></div>
            <div><span className="block text-[9px] font-black uppercase tracking-wider text-slate-400">Wholesale Price</span><strong>{formatSupplierCostLabel(draft.costPrice, draft.supplierCostAvailable)}</strong></div>
          </div>
          </details>

          <details open className="order-[5] rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 text-xs">
            <summary className="cursor-pointer font-black text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-200">Category and brand suggestions</summary>
          <section className="mt-3 grid gap-3 sm:grid-cols-2" aria-labelledby="supplier-mapping-summary-title">
            <div className="sm:col-span-2">
              <h4 id="supplier-mapping-summary-title" className="flex items-center gap-2 font-black text-slate-800 dark:text-white"><Sparkles className="h-4 w-4 text-blue-500" />Intelligent mapping</h4>
            </div>
            <div className="rounded-xl bg-white/70 p-3 dark:bg-slate-900/60">
              <span className="block text-[9px] font-black uppercase text-slate-400">Supplier category</span>
              <strong>{item.categoryMapping?.supplierCategory || 'Not supplied'}</strong>
              {item.categoryMapping?.targetCategoryId ? <><div className="mt-2 flex flex-wrap items-center gap-2"><span className="text-[10px] text-slate-500">Suggested Category</span><strong className="text-xs text-blue-700 dark:text-blue-300">{suggestedCategory?.name || item.categoryMapping.targetCategoryId}</strong><span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[9px] font-black text-blue-600">{Math.round(Number(item.categoryMapping.confidence || 0))}% confidence</span></div><button type="button" onClick={() => setDraft((current) => ({ ...current, category: item.categoryMapping?.targetCategoryId || '', subcategory: item.categoryMapping?.targetSubcategoryId || '' }))} disabled={draft.category === item.categoryMapping.targetCategoryId && draft.subcategory === (item.categoryMapping.targetSubcategoryId || '')} className="mt-2 rounded-lg bg-blue-600 px-3 py-2 text-[10px] font-black text-white disabled:cursor-not-allowed disabled:opacity-40">Apply</button></> : <p className="mt-2 rounded-lg border border-dashed border-blue-500/20 p-3 text-[10px] text-slate-500">No category suggestion is available. Select a category manually.</p>}
            </div>
            <div className="rounded-xl bg-white/70 p-3 dark:bg-slate-900/60">
              <span className="block text-[9px] font-black uppercase text-slate-400">Supplier brand</span>
              <strong>{item.brandMapping?.supplierBrand || 'Not supplied'}</strong>
              {item.brandMapping?.mappedBrandId ? <><div className="mt-2 flex flex-wrap items-center gap-2"><span className="text-[10px] text-slate-500">Suggested Brand</span><strong className="text-xs text-blue-700 dark:text-blue-300">{suggestedBrand?.name || item.brandMapping.mappedBrandId}</strong><span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[9px] font-black text-blue-600">{Math.round(Number(item.brandMapping.confidence || 0))}% confidence</span></div><button type="button" onClick={() => setDraft((current) => ({ ...current, brand: item.brandMapping?.mappedBrandId || '' }))} disabled={draft.brand === item.brandMapping.mappedBrandId} className="mt-2 rounded-lg bg-blue-600 px-3 py-2 text-[10px] font-black text-white disabled:cursor-not-allowed disabled:opacity-40">Apply</button></> : <p className="mt-2 rounded-lg border border-dashed border-blue-500/20 p-3 text-[10px] text-slate-500">No brand suggestion is available. Select a brand manually.</p>}
            </div>
          </section>
          </details>

          {importWarnings.length > 0 && (
            <section className="order-0 rounded-2xl border border-amber-500/25 bg-amber-500/10 p-4 text-xs" aria-labelledby="supplier-import-warnings-title">
              <h4 id="supplier-import-warnings-title" className="flex items-center gap-2 font-black text-amber-700 dark:text-amber-300"><AlertTriangle className="h-4 w-4" />Product details needing attention</h4>
              <ul className="mt-2 space-y-1 text-[10px] font-semibold text-amber-700/90 dark:text-amber-200/90">
                {importWarnings.map((warning) => <li key={`${warning.field}-${warning.code}`}>{warning.message}</li>)}
              </ul>
            </section>
          )}

          {item.approvalConflict && (
            <section className="order-0 rounded-2xl border border-red-500/25 bg-red-500/10 p-4 text-xs" aria-labelledby="supplier-conflict-context-title">
              <h4 id="supplier-conflict-context-title" className="flex items-center gap-2 font-black text-red-700 dark:text-red-300"><AlertTriangle className="h-4 w-4" />Conflict requires an explicit administrator decision</h4>
              <dl className="mt-3 grid gap-2 sm:grid-cols-2">
                <div className="rounded-xl bg-white/70 p-3 dark:bg-slate-950/40"><dt className="text-[9px] font-black uppercase tracking-wide text-slate-400">Reason</dt><dd className="mt-1 font-semibold text-slate-700 dark:text-slate-200">{String(item.approvalConflict.reason || 'Supplier product conflict').replaceAll('_', ' ')}</dd></div>
                <div className="rounded-xl bg-white/70 p-3 dark:bg-slate-950/40"><dt className="text-[9px] font-black uppercase tracking-wide text-slate-400">Canonical Zyro product</dt><dd className="mt-1 break-all font-mono font-semibold text-slate-700 dark:text-slate-200">{item.matchedProductId || item.productPayload?.id || 'Not resolved'}</dd></div>
                {item.approvalConflict.changedFields?.length ? <div className="rounded-xl bg-white/70 p-3 sm:col-span-2 dark:bg-slate-950/40"><dt className="text-[9px] font-black uppercase tracking-wide text-slate-400">Detected signals</dt><dd className="mt-1 font-semibold text-slate-700 dark:text-slate-200">{item.approvalConflict.changedFields.join(', ')}</dd></div> : null}
              </dl>
              <p className="mt-3 text-[10px] font-semibold text-red-700/90 dark:text-red-200/90">Review the supplier identity and canonical product before publishing. Product Review never merges or publishes this conflict automatically.</p>
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

          <details open className="order-20 rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
            <summary className="cursor-pointer text-xs font-black uppercase tracking-wider text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-200">Product, pricing & catalogue</summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs sm:col-span-2">
              <span className="font-bold text-slate-600 dark:text-slate-300">Product Name</span>
              <input ref={firstInputRef} value={draft.productName} onChange={(event) => editDraft('name', { productName: event.target.value })} aria-invalid={Boolean(errorFor('productName'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" />
              {errorFor('productName') && <span className="text-[10px] font-semibold text-red-500">{errorFor('productName')}</span>}
            </label>

            <div className="space-y-1.5 text-xs">
              <span className="font-bold text-slate-600 dark:text-slate-300">Zyro SKU <span className="font-normal text-slate-400">(Admin only)</span></span>
              <div className="flex min-h-11 items-center rounded-xl border border-slate-200 bg-slate-100 px-3 font-mono text-slate-500 dark:border-slate-700 dark:bg-slate-900/60">
                {draft.productSku || 'Auto-assigned on approval'}
              </div>
            </div>

            <div className="space-y-1.5 text-xs">
              <span className="font-bold text-slate-600 dark:text-slate-300">Supplier Product Code <span className="font-normal text-slate-400">(Admin only · Read-only)</span></span>
              <div className="flex min-h-11 items-center rounded-xl border border-slate-200 bg-slate-100 px-3 font-mono text-slate-500 dark:border-slate-700 dark:bg-slate-900/60">
                {draft.supplierItemCode || 'Not supplied'}
              </div>
              <p className="text-[9px] text-slate-400">Retained as the supplier matching identity for future updates.</p>
            </div>

            <label className="space-y-1.5 text-xs">
              <span className="font-bold text-slate-600 dark:text-slate-300">Selling Price <span className="font-normal text-slate-400">(Customer visible)</span></span>
              <input type="number" min="0.01" step="0.01" value={Number.isFinite(draft.sellingPrice) ? draft.sellingPrice : ''} onChange={(event) => setNumber('sellingPrice', event.target.value)} aria-invalid={Boolean(errorFor('sellingPrice'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" />
              {errorFor('sellingPrice') && <span className="text-[10px] font-semibold text-red-500">{errorFor('sellingPrice')}</span>}
            </label>

            <label className="space-y-1.5 text-xs">
              <span className="font-bold text-slate-600 dark:text-slate-300">Compare Price <span className="font-normal text-slate-400">(Customer visible)</span></span>
              <input type="number" min="0" step="0.01" value={Number.isFinite(draft.comparePrice) ? draft.comparePrice : ''} onChange={(event) => setNumber('comparePrice', event.target.value)} aria-invalid={Boolean(errorFor('comparePrice'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" />
              {errorFor('comparePrice') && <span className="text-[10px] font-semibold text-red-500">{errorFor('comparePrice')}</span>}
            </label>

            <label className="space-y-1.5 text-xs">
              <span className="font-bold text-slate-600 dark:text-slate-300">Cost Price <span className="font-normal text-slate-400">(Admin only)</span></span>
              {!draft.supplierCostAvailable && (
                <p className="text-[10px] font-semibold text-amber-700 dark:text-amber-300">Supplier cost not supplied. Enter a valid cost before approval.</p>
              )}
              <input type="number" min="0" step="0.01" value={Number.isFinite(draft.costPrice) ? draft.costPrice : ''} onChange={(event) => setNumber('costPrice', event.target.value)} aria-invalid={Boolean(errorFor('costPrice'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" />
              {errorFor('costPrice') && <span className="text-[10px] font-semibold text-red-500">{errorFor('costPrice')}</span>}
            </label>

            <label className="space-y-1.5 text-xs">
              <span className="font-bold text-slate-600 dark:text-slate-300">Market Price <span className="font-normal text-slate-400">(Admin only)</span></span>
              <input type="number" min="0" step="0.01" value={Number.isFinite(draft.marketPrice) ? draft.marketPrice : ''} onChange={(event) => setNumber('marketPrice', event.target.value)} aria-invalid={Boolean(errorFor('marketPrice'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" />
              {errorFor('marketPrice') && <span className="text-[10px] font-semibold text-red-500">{errorFor('marketPrice')}</span>}
            </label>

            <label className="space-y-1.5 text-xs">
              <span className="font-bold text-slate-600 dark:text-slate-300">Stock</span>
              {!draft.supplierStockAvailable && (
                <p className="text-[10px] font-semibold text-amber-700 dark:text-amber-300">Supplier inventory not supplied.</p>
              )}
              {draft.supplierStockAvailable && draft.stock <= 0 && (
                <p className="text-[10px] font-semibold text-amber-700 dark:text-amber-300">0 / Out of stock</p>
              )}
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

            <label className="space-y-1.5 text-xs sm:col-span-2">
              <span className="font-bold text-slate-600 dark:text-slate-300">Full description</span>
              <textarea rows={5} value={draft.description} onChange={(event) => editDraft('description', { description: event.target.value })} aria-invalid={Boolean(errorFor('description'))} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
              {errorFor('description') && <span className="text-[10px] font-semibold text-red-500">{errorFor('description')}</span>}
            </label>

            <label className="flex min-h-11 items-center justify-between rounded-xl border border-slate-200 px-3 text-xs dark:border-slate-700 sm:col-span-2">
              <span className="font-bold text-slate-600 dark:text-slate-300">Storefront status</span>
              <span className="flex items-center gap-2"><input type="checkbox" checked={draft.isActive} onChange={(event) => editDraft('isActive', { isActive: event.target.checked })} />{draft.isActive ? 'Active' : 'Inactive'}</span>
            </label>
          </div>
          </details>

          <details className="order-[60] rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4">
            <summary className="cursor-pointer text-xs font-black uppercase tracking-wider text-blue-700 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-200">Supplier offers</summary>
          <section className="mt-4 space-y-3" aria-labelledby="supplier-offers-title">
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
                        <div><dt className="text-slate-400">Last sync</dt><dd className="truncate font-bold" title={offer.lastSyncAt}>{formatSupplierTimestamp(offer.lastSyncAt, 'Not updated yet')}</dd></div>
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

          <details className="order-30 rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
            <summary className="cursor-pointer text-xs font-black uppercase tracking-wider text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-200">Content, SEO & merchandising</summary>
          <section className="mt-4 space-y-4" aria-labelledby="supplier-review-content-title">
            <div>
              <h4 id="supplier-review-content-title" className="text-xs font-black uppercase tracking-wider text-slate-700 dark:text-slate-200">Content, identity & merchandising</h4>
              <p className="mt-1 text-[10px] text-slate-400">These are the same customer-facing controls available for manually managed products.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-xs sm:col-span-2"><span className="font-bold text-slate-600 dark:text-slate-300">Short description</span><textarea rows={2} value={draft.shortDescription} onChange={(event) => editDraft('shortDescription', { shortDescription: event.target.value })} aria-invalid={Boolean(errorFor('shortDescription'))} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />{errorFor('shortDescription') && <span className="text-[10px] font-semibold text-red-500">{errorFor('shortDescription')}</span>}</label>
              <label className="space-y-1.5 text-xs sm:col-span-2 text-slate-400"><span className="font-bold text-slate-600 dark:text-slate-300">Full description</span><p className="text-[10px]">Edit the full description in the essential product section above.</p></label>
              <label className="space-y-1.5 text-xs"><span className="font-bold text-slate-600 dark:text-slate-300">Model</span><input value={draft.model} onChange={(event) => editDraft('model', { model: event.target.value })} aria-invalid={Boolean(errorFor('model'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" /></label>
              <label className="space-y-1.5 text-xs"><span className="font-bold text-slate-600 dark:text-slate-300">Barcode</span><input value={draft.barcode} onChange={(event) => editDraft('barcode', { barcode: event.target.value })} aria-invalid={Boolean(errorFor('barcode'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" /></label>
              <label className="space-y-1.5 text-xs"><span className="font-bold text-slate-600 dark:text-slate-300">Product type</span><input value={draft.productType} onChange={(event) => editDraft('productType', { productType: event.target.value })} aria-invalid={Boolean(errorFor('productType'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" /></label>
              <label className="space-y-1.5 text-xs"><span className="font-bold text-slate-600 dark:text-slate-300">SEO slug</span><input value={draft.slug} onChange={(event) => editDraft('slug', { slug: event.target.value })} aria-invalid={Boolean(errorFor('slug'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" /></label>
              <label className="space-y-1.5 text-xs sm:col-span-2"><span className="font-bold text-slate-600 dark:text-slate-300">Meta description</span><textarea rows={3} value={draft.metaDescription} onChange={(event) => editDraft('metaDescription', { metaDescription: event.target.value })} aria-invalid={Boolean(errorFor('metaDescription'))} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />{errorFor('metaDescription') && <span className="text-[10px] font-semibold text-red-500">{errorFor('metaDescription')}</span>}</label>
              <label className="space-y-1.5 text-xs sm:col-span-2"><span className="font-bold text-slate-600 dark:text-slate-300">SEO keywords</span><input value={draft.keywords.join(', ')} onChange={(event) => editDraft('keywords', { keywords: commaList(event.target.value) })} aria-invalid={Boolean(errorFor('keywords'))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900" />{errorFor('keywords') && <span className="text-[10px] font-semibold text-red-500">{errorFor('keywords')}</span>}</label>
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
          </details>

          <details className="order-40 rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
            <summary className="cursor-pointer text-xs font-black uppercase tracking-wider text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-200">Specifications</summary>
          <fieldset className="mt-4 grid gap-4 sm:grid-cols-2">
              <legend className="sr-only">Category specifications</legend>
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
          </details>

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

          <details open className="order-10 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/40">
            <summary className="cursor-pointer text-xs font-black uppercase tracking-wider text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-200">Images & gallery</summary>
          <section className="mt-4 space-y-4" aria-labelledby="supplier-product-images-title">
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
              <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
                <span className="absolute left-2 top-2 z-10 rounded-full bg-emerald-600 px-2 py-1 text-[8px] font-black uppercase text-white shadow">Primary image</span>
                {isValidSupplierImageUrl(draft.primaryImageUrl) ? (
                  <img src={draft.primaryImageUrl.trim()} alt="Primary product preview" onError={() => markMediaFailure(draft.primaryImageUrl.trim())} className="h-full w-full object-contain" referrerPolicy="no-referrer" />
                ) : (
                  <div className="text-center text-slate-400"><Image className="mx-auto h-6 w-6" /><span className="mt-1 block text-[9px] font-bold">No valid preview</span></div>
                )}
                {draft.primaryImageUrl.trim() && <button type="button" onClick={() => editDraft('imageUrl', { primaryImageUrl: '' })} className="absolute bottom-2 right-2 z-10 rounded-lg bg-white/90 p-2 text-red-600 shadow backdrop-blur dark:bg-slate-900/90" aria-label="Remove primary image"><Trash2 className="h-3.5 w-3.5" /></button>}
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
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {draft.galleryImageUrls.map((imageUrl, index) => (
                  <article key={`${imageUrl}-${index}`} className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
                    <div className="relative mb-2 flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-950">
                      <span className="absolute left-1.5 top-1.5 z-10 rounded-md bg-black/60 px-1.5 py-0.5 text-[8px] font-black text-white">{index + 2}</span>
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
          </details>

          <div className="order-50 grid gap-3 sm:grid-cols-2" aria-live="polite">
            <div className={`rounded-2xl border p-4 ${!profit.available ? 'border-slate-300 bg-slate-50 text-slate-500' : profit.profit !== null && profit.profit >= 0 ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600' : 'border-red-500/20 bg-red-500/10 text-red-600'}`}>
              <span className="block text-[9px] font-black uppercase tracking-wider">Profit</span><strong className="text-lg">{formatSupplierProfitLabel(profit.profit, profit.available)}</strong>
            </div>
            <div className={`rounded-2xl border p-4 ${!profit.available ? 'border-slate-300 bg-slate-50 text-slate-500' : profit.marginPercent !== null && profit.marginPercent >= 0 ? 'border-blue-500/20 bg-blue-500/10 text-blue-600' : 'border-red-500/20 bg-red-500/10 text-red-600'}`}>
              <span className="block text-[9px] font-black uppercase tracking-wider">Margin</span><strong className="text-lg">{formatSupplierMarginLabel(profit.marginPercent, profit.available)}</strong>
            </div>
          </div>

          <section id="supplier-publish-readiness" className={`order-[55] rounded-2xl border p-4 text-xs ${missingFields.length === 0 ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700' : 'border-amber-500/20 bg-amber-500/10 text-amber-700'}`} aria-live="polite" aria-labelledby="supplier-publish-readiness-title">
            <h4 id="supplier-publish-readiness-title" className="flex items-center gap-2 font-black">{missingFields.length === 0 ? <Check className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}{missingFields.length === 0 ? 'Ready to publish' : 'Complete required product details'}</h4>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {validationChecklist.map((check) => (
                <li key={check.label} className="flex items-start gap-2 rounded-xl bg-white/60 px-3 py-2 dark:bg-slate-950/30">
                  <span className={`mt-0.5 font-black ${check.valid ? 'text-emerald-600' : 'text-red-600'}`} aria-hidden="true">{check.valid ? '✓' : '✕'}</span>
                  <span><strong className="block">{check.label}</strong>{check.error && <span className="mt-0.5 block text-[9px] font-semibold text-red-600 dark:text-red-300">{check.error}</span>}</span>
                </li>
              ))}
            </ul>
            {missingFields.length > 0 && <p id="supplier-publish-blocked-reason" className="mt-3 text-[10px] font-bold">Approve & Publish is unavailable until every failed checklist item is completed.</p>}
          </section>
          </fieldset>

          <div className="sticky bottom-0 z-30 order-[100] -mx-4 -mb-4 flex flex-col-reverse gap-2 border-t border-slate-100 bg-white/95 p-4 backdrop-blur dark:border-slate-800 dark:bg-[#111928]/95 sm:mx-0 sm:mb-0 sm:flex-row sm:justify-end sm:px-0 sm:pb-0">
            <button type="button" onClick={onClose} disabled={isPublishing} className="min-h-11 w-full rounded-xl border border-slate-200 px-4 text-xs font-bold text-slate-500 disabled:opacity-50 dark:border-slate-700 sm:w-auto">Close</button>
            {!isEditing ? (
              <button ref={detailsActionRef} type="button" onClick={beginEditing} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 text-xs font-black text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 sm:w-auto" aria-describedby="supplier-review-read-only-note">
                <Pencil className="h-4 w-4" aria-hidden="true" />Edit product data
              </button>
            ) : (
              <>
                <button type="button" onClick={cancelEditing} disabled={isPublishing} className="min-h-11 w-full rounded-xl border border-slate-200 px-4 text-xs font-bold text-slate-600 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 sm:w-auto">Cancel editing</button>
                <button type="submit" disabled={isPublishing || missingFields.length > 0} aria-describedby={missingFields.length > 0 ? 'supplier-publish-blocked-reason' : undefined} title={missingFields.length > 0 ? `Publishing blocked: ${Object.values(validationErrors).join(' ')}` : 'Approve and publish this product'} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 text-xs font-black text-white disabled:cursor-not-allowed disabled:bg-slate-600 sm:w-auto">
                  <Check className="h-4 w-4" />{isPublishing ? 'Publishing...' : 'Approve & Publish'}
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
