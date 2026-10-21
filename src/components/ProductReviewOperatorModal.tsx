import React, { useEffect, useMemo, useState } from 'react';
import { Check, ImageOff, ShieldCheck, SkipForward, X } from 'lucide-react';
import type {
  SupplierReviewDraft,
  SupplierReviewSourceItem,
  SupplierReviewTaxonomyCategory,
} from '../services/supplierReviewEditor';
import {
  supplierReviewManagedImageUrls,
  supplierReviewManagedMediaReady,
  type SupplierReviewQuickApprovalItem,
} from '../services/supplierHubPresentation';
import { suggestZyroCategory } from '../services/categorySuggestion/suggestZyroCategory';

interface ProductReviewOperatorModalProps {
  item: SupplierReviewSourceItem;
  initialDraft: SupplierReviewDraft;
  categories: SupplierReviewTaxonomyCategory[];
  decisionReady: boolean;
  blockingProblems: string[];
  isPublishing: boolean;
  isSaving: boolean;
  serverError?: string | null;
  onClose: () => void;
  onSkip: () => void;
  onSaveDraft: (draft: { category: string; subcategory: string }) => Promise<void>;
  onPublish: (draft: SupplierReviewDraft) => Promise<void>;
}

const money = (value: number, available = true): string => (
  available && Number.isFinite(value)
    ? `LKR ${value.toLocaleString('en-LK', { maximumFractionDigits: 2 })}`
    : 'Not supplied'
);

export default function ProductReviewOperatorModal({
  item,
  initialDraft,
  categories,
  decisionReady,
  blockingProblems,
  isPublishing,
  isSaving,
  serverError = null,
  onClose,
  onSkip,
  onSaveDraft,
  onPublish,
}: ProductReviewOperatorModalProps) {
  const [draft, setDraft] = useState(initialDraft);
  const [selectedCategory, setSelectedCategory] = useState(initialDraft.category || '');
  const [selectedSubcategory, setSelectedSubcategory] = useState(initialDraft.subcategory || '');
  const [hasSavedCategory, setHasSavedCategory] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    setDraft(initialDraft);
    setSelectedCategory(initialDraft.category || '');
    setSelectedSubcategory(initialDraft.subcategory || '');
    setHasSavedCategory(false);
    setFeedback(null);
  }, [item.id]);

  const activeCategories = useMemo(() => categories.filter((category) => category.isActive !== false && category.taxonomyCandidate !== true), [categories]);
  const selectedCategoryRecord = activeCategories.find((category) => category.id === selectedCategory);
  const activeSubcategories = useMemo(
    () => (selectedCategoryRecord?.subcategories || []).filter((subcategory) => subcategory.isActive !== false && subcategory.taxonomyCandidate !== true),
    [selectedCategoryRecord],
  );
  const managedImages = useMemo(
    () => supplierReviewManagedImageUrls(item as SupplierReviewQuickApprovalItem),
    [item],
  );
  const managedMediaReady = supplierReviewManagedMediaReady(item as SupplierReviewQuickApprovalItem);
  const categorySuggestion = useMemo(() => suggestZyroCategory({
    productName: initialDraft.productName,
    description: initialDraft.description,
    productType: initialDraft.productType,
    model: initialDraft.model,
    brand: initialDraft.brand,
    keywords: initialDraft.keywords,
    specifications: initialDraft.specifications,
    categories: activeCategories,
    sourceEvidence: [
      initialDraft.productName ? { kind: 'product_title' as const, ref: 'productPayload.name', value: initialDraft.productName } : null,
      initialDraft.description ? { kind: 'product_description' as const, ref: 'productPayload.description', value: initialDraft.description } : null,
    ].filter((evidence): evidence is { kind: 'product_title' | 'product_description'; ref: string; value: string } => evidence !== null),
  }), [activeCategories, initialDraft]);
  const suggestedCategory = categorySuggestion.categoryId
    ? activeCategories.find((category) => category.id === categorySuggestion.categoryId)
    : undefined;
  const suggestedSubcategory = suggestedCategory?.subcategories?.find((subcategory) => subcategory.id === categorySuggestion.subcategoryId);
  const categoryPathReady = Boolean(selectedCategory) && (activeSubcategories.length === 0 || Boolean(selectedSubcategory));
  const canPublish = hasSavedCategory && decisionReady && categoryPathReady && managedMediaReady && !isPublishing && !isSaving;

  const applySuggestion = () => {
    if (categorySuggestion.status !== 'SUGGESTED' || !categorySuggestion.categoryId) return;
    const category = activeCategories.find((candidate) => candidate.id === categorySuggestion.categoryId);
    if (!category) return;
    const subcategory = category.subcategories?.find((candidate) => candidate.id === categorySuggestion.subcategoryId && candidate.isActive !== false);
    setSelectedCategory(category.id);
    setSelectedSubcategory(subcategory?.id || '');
    setFeedback({ kind: 'success', message: 'Suggestion applied locally. Save to record the Admin category decision.' });
  };

  const saveCategory = async () => {
    if (!categoryPathReady) {
      setFeedback({ kind: 'error', message: 'Select an active category and, where required, an active subcategory.' });
      return;
    }
    setFeedback(null);
    try {
      await onSaveDraft({ category: selectedCategory, subcategory: selectedSubcategory });
      setDraft((current) => ({ ...current, category: selectedCategory, subcategory: selectedSubcategory }));
      setHasSavedCategory(true);
      setFeedback({ kind: 'success', message: 'Category saved. The server remains the approval authority.' });
    } catch (error) {
      setFeedback({ kind: 'error', message: error instanceof Error ? error.message : 'Category could not be saved.' });
    }
  };

  const publish = async () => {
    if (!canPublish) {
      setFeedback({ kind: 'error', message: !managedMediaReady ? 'Publishing is blocked because a managed primary image is not ready.' : 'Save the category and resolve all server-reported blockers before publishing.' });
      return;
    }
    setFeedback(null);
    try {
      await onPublish({ ...draft, category: selectedCategory, subcategory: selectedSubcategory });
    } catch (error) {
      setFeedback({ kind: 'error', message: error instanceof Error ? error.message : 'Publication failed closed.' });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-3 backdrop-blur-xs sm:p-5" role="dialog" aria-modal="true" aria-labelledby="product-review-operator-title">
      <div className="flex max-h-[min(92vh,900px)] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-[#111928]">
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4 dark:border-slate-800 sm:px-6">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-blue-600 dark:text-blue-300">Product Review Operator</p>
            <h2 id="product-review-operator-title" className="mt-1 truncate text-lg font-black text-slate-900 dark:text-white">{initialDraft.productName || 'Supplier product'}</h2>
            <p className="mt-1 text-[11px] font-bold text-slate-500">SKU <span className="font-mono">{initialDraft.supplierItemCode || 'Not supplied'}</span> · supplier identity <span className="font-mono">{item.supplierOfferId || item.id}</span></p>
          </div>
          <button type="button" onClick={onClose} disabled={isPublishing || isSaving} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900" aria-label="Close product review"><X className="h-5 w-5" /></button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 sm:p-6">
          <section className="grid gap-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {managedImages.length > 0 ? managedImages.slice(0, 6).map((url) => <img key={url} src={url} alt={initialDraft.productName} referrerPolicy="no-referrer" className="aspect-square w-full rounded-2xl border border-slate-200 object-cover dark:border-slate-700" />) : <div className="col-span-full flex min-h-48 flex-col items-center justify-center rounded-2xl border border-dashed border-amber-400/50 bg-amber-500/5 text-center text-xs font-bold text-amber-700 dark:text-amber-300"><ImageOff className="mb-2 h-8 w-8" />Managed primary image unavailable</div>}
            </div>
            <div className="grid content-start gap-2 sm:grid-cols-2">
              <div className="rounded-2xl border border-slate-100 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/60"><span className="block text-[10px] font-bold uppercase text-slate-400">Selling price</span><strong className="text-sm text-blue-600">{money(initialDraft.sellingPrice)}</strong></div>
              <div className="rounded-2xl border border-slate-100 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/60"><span className="block text-[10px] font-bold uppercase text-slate-400">Supplier cost</span><strong className="text-sm text-slate-900 dark:text-white">{money(initialDraft.costPrice, initialDraft.supplierCostAvailable)}</strong></div>
              <div className="rounded-2xl border border-slate-100 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/60"><span className="block text-[10px] font-bold uppercase text-slate-400">Supplier stock</span><strong className="text-sm text-slate-900 dark:text-white">{initialDraft.supplierStockAvailable ? initialDraft.stock : 'Not supplied'}</strong></div>
              <div className="rounded-2xl border border-slate-100 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/60"><span className="block text-[10px] font-bold uppercase text-slate-400">Managed media</span><strong className={`text-sm ${managedMediaReady ? 'text-emerald-600' : 'text-amber-600'}`}>{managedMediaReady ? 'Ready' : 'Blocked'}</strong></div>
            </div>
          </section>
          <section className="rounded-2xl border border-slate-100 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/60">
            <p className="text-[10px] font-black uppercase tracking-wide text-slate-400">Supplier product details</p>
            <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-slate-700 dark:text-slate-200">{initialDraft.description || initialDraft.shortDescription || 'No supplier description was supplied.'}</p>
          </section>

          <section className="rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h3 className="text-sm font-black text-slate-900 dark:text-white">Confirm canonical category</h3><p className="mt-1 text-[11px] text-slate-500">Use the existing active Zyro taxonomy. The server revalidates the choice on save and approval.</p></div>
              {categorySuggestion.status === 'SUGGESTED' && suggestedCategory && <button type="button" onClick={applySuggestion} disabled={isSaving || isPublishing} className="min-h-10 rounded-xl border border-blue-500/30 bg-blue-500/10 px-3 text-[10px] font-black text-blue-700 disabled:opacity-50 dark:text-blue-300">Apply suggestion</button>}
            </div>
            <div className="mt-3 rounded-xl bg-slate-50 p-3 text-[11px] dark:bg-slate-900/70">
              <span className="font-black text-slate-500">Suggestion:</span>{' '}
              {suggestedCategory ? `${suggestedCategory.name || suggestedCategory.id}${suggestedSubcategory ? ` / ${suggestedSubcategory.name || suggestedSubcategory.id}` : ''}` : 'No confident existing-taxonomy suggestion'}
              <span className="ml-2 font-bold text-slate-400">({categorySuggestion.confidence})</span>
              {categorySuggestion.reasons?.length > 0 && <p className="mt-1 text-slate-500">{categorySuggestion.reasons.join(' · ')}</p>}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-[10px] font-black uppercase tracking-wide text-slate-500">Category<select value={selectedCategory} onChange={(event) => { setSelectedCategory(event.target.value); setSelectedSubcategory(''); setHasSavedCategory(false); }} disabled={isSaving || isPublishing} className="mt-1 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold normal-case text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white"><option value="">Select active category</option>{activeCategories.map((category) => <option key={category.id} value={category.id}>{category.name || category.id}</option>)}</select></label>
              <label className="text-[10px] font-black uppercase tracking-wide text-slate-500">Subcategory<select value={selectedSubcategory} onChange={(event) => { setSelectedSubcategory(event.target.value); setHasSavedCategory(false); }} disabled={isSaving || isPublishing || !selectedCategory} className="mt-1 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold normal-case text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white"><option value={activeSubcategories.length === 0 ? '' : undefined}>{activeSubcategories.length === 0 ? 'No subcategory required' : 'Select active subcategory'}</option>{activeSubcategories.map((subcategory) => <option key={subcategory.id} value={subcategory.id}>{subcategory.name || subcategory.id}</option>)}</select></label>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void saveCategory()} disabled={isSaving || isPublishing} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-4 text-xs font-black text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"><Check className="h-4 w-4" />{isSaving ? 'Saving…' : 'Save category'}</button>
              <span className="text-[10px] font-semibold text-slate-400">{hasSavedCategory ? 'Saved for this review revision.' : 'Save is required before publish.'}</span>
            </div>
          </section>

          {(blockingProblems.length > 0 || !managedMediaReady) && <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-800 dark:text-amber-200"><p className="font-black">Readiness blockers</p><ul className="mt-2 list-disc space-y-1 pl-5">{!managedMediaReady && <li>Managed primary image is not publication-ready.</li>}{blockingProblems.map((problem) => <li key={problem}>{problem}</li>)}</ul></section>}
          {serverError && <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-xs font-bold text-red-700 dark:text-red-300">{serverError}</p>}
          {feedback && <p role={feedback.kind === 'error' ? 'alert' : 'status'} className={`rounded-xl px-3 py-2 text-xs font-bold ${feedback.kind === 'error' ? 'bg-red-500/10 text-red-700 dark:text-red-300' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'}`}>{feedback.message}</p>}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4 dark:border-slate-800 sm:px-6">
          <button type="button" onClick={onSkip} disabled={isSaving || isPublishing} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 px-4 text-xs font-black text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"><SkipForward className="h-4 w-4" />Skip for now</button>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onClose} disabled={isSaving || isPublishing} className="min-h-11 rounded-xl border border-slate-200 px-4 text-xs font-black text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900">Close</button>
            <button type="button" onClick={() => void publish()} disabled={!canPublish} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-5 text-xs font-black text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"><ShieldCheck className="h-4 w-4" />{isPublishing ? 'Publishing…' : 'Approve & Publish'}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
