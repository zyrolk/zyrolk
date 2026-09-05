import React, { useEffect, useState } from 'react';
import { isValidSupplierImageUrl } from '../services/connectors/a2z-website/productImages';
import {
  formatSupplierCostLabel,
  formatSupplierMarginLabel,
  formatSupplierProfitLabel,
  formatSupplierStockLabel,
} from '../services/supplierCommerceSemantics';
import { reportSupplierImageFailure } from '../services/supplierImageDiagnostics';

export interface SupplierReviewQuickCardProps {
  productName: string;
  supplierItemCode: string;
  managedImageUrl: string;
  statusLabel: string;
  changeLabel: string;
  sellingPrice: number;
  supplierCost: number;
  supplierCostAvailable: boolean;
  profit: number | null;
  marginPercent: number | null;
  profitAvailable: boolean;
  stock: number;
  supplierStockAvailable: boolean;
  brandLabel: string;
  categoryLabel: string;
  subcategoryLabel?: string;
  rawSupplierCategory?: string;
  rawSupplierSubcategory?: string;
  rawSupplierBrand?: string;
  /** Draft preference chip: intended visibility after approval. */
  storefrontVisible: boolean;
  /** Accurate publication state: Not published | Visible | Hidden */
  storefrontStatusLabel: string;
  supplierAttribution: string;
  blockingProblems: string[];
  isPreparing: boolean;
  decisionReady: boolean;
  canQuickApprove: boolean;
  canReject: boolean;
  canRemove?: boolean;
  needsResolution: boolean;
  processing: boolean;
  canRetryMedia?: boolean;
  retryingMedia?: boolean;
  terminalState?: 'Approved' | 'Rejected' | 'Dismissed by admin' | 'Suppressed';
  onApprove: () => void;
  onReject: () => void;
  onRemove?: () => void;
  onViewDetails: () => void;
  onViewHistory: () => void;
  onRetryMedia?: () => void;
}

function ManagedSupplierImage({ src, alt }: { src?: string; alt: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!isValidSupplierImageUrl(src) || failed) {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-center text-[8px] font-bold uppercase leading-tight text-slate-400 dark:bg-slate-800">
        No image
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className="h-10 w-10 rounded-lg border border-slate-200 object-cover dark:border-slate-800"
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={(event) => {
        reportSupplierImageFailure(event.currentTarget);
        setFailed(true);
      }}
    />
  );
}

export function SupplierReviewQuickCard({
  productName,
  supplierItemCode,
  managedImageUrl,
  statusLabel,
  changeLabel,
  sellingPrice,
  supplierCost,
  supplierCostAvailable,
  profit,
  marginPercent,
  profitAvailable,
  stock,
  supplierStockAvailable,
  brandLabel,
  categoryLabel,
  subcategoryLabel,
  rawSupplierCategory,
  rawSupplierSubcategory,
  rawSupplierBrand,
  storefrontVisible,
  storefrontStatusLabel,
  supplierAttribution,
  blockingProblems,
  isPreparing,
  decisionReady,
  canQuickApprove,
  canReject,
  canRemove = false,
  needsResolution,
  processing,
  canRetryMedia = false,
  retryingMedia = false,
  terminalState,
  onApprove,
  onReject,
  onRemove,
  onViewDetails,
  onViewHistory,
  onRetryMedia,
}: SupplierReviewQuickCardProps) {
  const openEditor = () => {
    if (!decisionReady || terminalState || processing) return;
    onViewDetails();
  };

  return (
    <article
      className={`flex overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950 ${decisionReady && !terminalState ? 'cursor-pointer focus-within:ring-2 focus-within:ring-emerald-500/40' : ''}`}
      onClick={openEditor}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openEditor();
        }
      }}
      role={decisionReady && !terminalState ? 'button' : undefined}
      tabIndex={decisionReady && !terminalState ? 0 : undefined}
      aria-label={decisionReady && !terminalState ? `Review product ${productName}` : undefined}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start gap-3 p-4">
          <ManagedSupplierImage src={managedImageUrl} alt={`Managed product image for ${productName}`} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h4 className="break-words text-sm font-black text-slate-900 dark:text-white">{productName}</h4>
                <p className="mt-1 text-[9px] font-bold uppercase tracking-wide text-slate-400">Supplier SKU <span className="font-mono normal-case">{supplierItemCode || 'Not supplied'}</span></p>
              </div>
              <span className="rounded-lg bg-slate-100 px-2 py-1 text-[9px] font-black text-slate-600 dark:bg-slate-800 dark:text-slate-300">{terminalState || statusLabel}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[9px] font-black text-blue-600">{terminalState === 'Dismissed by admin' ? 'Removed from Review' : changeLabel}</span>
              {(!terminalState || terminalState === 'Approved') && (
                <span className={`rounded-full px-2 py-0.5 text-[9px] font-black ${storefrontVisible ? 'bg-emerald-500/10 text-emerald-600' : 'bg-slate-500/10 text-slate-600 dark:text-slate-300'}`}>{storefrontVisible ? 'Visible after approval' : 'Approved but hidden'}</span>
              )}
            </div>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-y border-slate-100 bg-slate-50/70 p-4 text-[10px] dark:border-slate-800 dark:bg-slate-900/40 sm:grid-cols-3">
          <div><dt className="text-slate-400">Selling price</dt><dd className="font-black text-blue-600">LKR {sellingPrice.toLocaleString()}</dd></div>
          <div><dt className="text-slate-400">Supplier cost</dt><dd className="font-black">{formatSupplierCostLabel(supplierCost, supplierCostAvailable)}</dd></div>
          <div><dt className="text-slate-400">Profit</dt><dd className={`font-black ${profitAvailable && profit !== null && profit < 0 ? 'text-red-600' : profitAvailable ? 'text-emerald-600' : 'text-slate-500'}`}>{formatSupplierProfitLabel(profit, profitAvailable)}</dd></div>
          <div><dt className="text-slate-400">Margin</dt><dd className={`font-black ${profitAvailable && marginPercent !== null && marginPercent < 0 ? 'text-red-600' : profitAvailable ? 'text-slate-800 dark:text-slate-100' : 'text-slate-500'}`}>{formatSupplierMarginLabel(marginPercent, profitAvailable)}</dd></div>
          <div><dt className="text-slate-400">Stock</dt><dd className="font-black">{formatSupplierStockLabel(stock, supplierStockAvailable)}</dd></div>
          <div><dt className="text-slate-400">Zyro brand</dt><dd className="font-bold">{brandLabel}</dd></div>
          <div><dt className="text-slate-400">Zyro category</dt><dd className="font-bold">{categoryLabel}</dd></div>
          {subcategoryLabel && <div><dt className="text-slate-400">Zyro subcategory</dt><dd className="font-bold">{subcategoryLabel}</dd></div>}
          <div><dt className="text-slate-400">Storefront</dt><dd className="font-bold">{storefrontStatusLabel}</dd></div>
        </dl>

        {(rawSupplierBrand || rawSupplierCategory || rawSupplierSubcategory) && (
          <div className="border-b border-slate-100 px-4 py-3 text-[10px] dark:border-slate-800">
            <span className="font-black uppercase tracking-wide text-slate-400">Supplier raw metadata</span>
            <dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div><dt className="text-slate-400">Supplier brand</dt><dd className="font-semibold text-slate-700 dark:text-slate-200">{rawSupplierBrand || 'Not supplied'}</dd></div>
              <div><dt className="text-slate-400">Supplier category</dt><dd className="font-semibold text-slate-700 dark:text-slate-200">{rawSupplierCategory || 'Not supplied'}</dd></div>
              <div><dt className="text-slate-400">Supplier subcategory</dt><dd className="font-semibold text-slate-700 dark:text-slate-200">{rawSupplierSubcategory || 'Not supplied'}</dd></div>
            </dl>
          </div>
        )}

        <div className="px-4 pt-3 text-[10px] text-slate-500 dark:text-slate-400">
          <span className="font-black uppercase tracking-wide text-slate-400">Supplier/source</span>
          <p className="mt-1 font-semibold text-slate-700 dark:text-slate-200">{supplierAttribution}</p>
        </div>

        {isPreparing && !terminalState && (
          <div className="mx-4 mt-3 rounded-xl bg-blue-500/10 p-3 text-[10px] font-bold text-blue-700 dark:text-blue-300" role="status">
            <p className="font-black">Media is processing</p>
            <p className="mt-1 font-semibold leading-relaxed">
              Approval stays disabled until managed images finish and this item reaches Ready for Review. This list refreshes automatically.
            </p>
          </div>
        )}

        {blockingProblems.length > 0 && !isPreparing && !terminalState && (
          <div className="mx-4 mt-3 rounded-xl bg-amber-500/10 p-3 text-[10px] font-bold text-amber-700 dark:text-amber-300" role="status">
            <p className="font-black">Review required</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">{blockingProblems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
            {canRetryMedia && onRetryMedia && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onRetryMedia();
                }}
                disabled={processing || retryingMedia}
                className="mt-3 min-h-10 rounded-xl bg-amber-600 px-3 text-[10px] font-black text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {retryingMedia ? 'Retrying media…' : 'Retry media'}
              </button>
            )}
          </div>
        )}

        {decisionReady && !terminalState && (
          <div
            className="mt-auto grid grid-cols-2 gap-2 border-t border-slate-100 bg-white/95 p-3 dark:border-slate-800 dark:bg-slate-950/95 sm:grid-cols-4"
            onClick={(event) => event.stopPropagation()}
          >
            {canQuickApprove && (
              <button type="button" onClick={onApprove} disabled={processing} aria-label={`Approve ${productName}`} className="min-h-11 rounded-xl bg-blue-600 px-3 text-[10px] font-black text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50">
                {processing ? 'Approving…' : 'Approve'}
              </button>
            )}
            {canReject && (
              <button type="button" onClick={onReject} disabled={processing} aria-label={`Reject ${productName}`} className="min-h-11 rounded-xl bg-red-600 px-3 text-[10px] font-black text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50">Reject</button>
            )}
            {canRemove && onRemove && (
              <button type="button" onClick={onRemove} disabled={processing} aria-label={`Remove ${productName} from Product Review`} className="min-h-11 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 text-[10px] font-black text-amber-700 hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50">Remove from Review</button>
            )}
            <button type="button" onClick={onViewDetails} disabled={processing} aria-label={`Review product ${productName}`} className={`min-h-11 rounded-xl px-3 text-[10px] font-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-50 ${needsResolution ? 'col-span-2 border border-amber-500/30 bg-amber-500/10 text-amber-700 sm:col-span-1 dark:text-amber-300' : 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'}`}>Review Product</button>
          </div>
        )}

        {isPreparing && !terminalState && (
          <div className="mt-auto border-t border-slate-100 p-3 dark:border-slate-800" onClick={(event) => event.stopPropagation()}>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {canReject && (
                <button type="button" onClick={onReject} disabled={processing} aria-label={`Reject ${productName}`} className="min-h-11 rounded-xl bg-red-600 px-3 text-[10px] font-black text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50">
                  Reject
                </button>
              )}
              {canRemove && onRemove && (
                <button type="button" onClick={onRemove} disabled={processing} aria-label={`Remove ${productName} from Product Review`} className="min-h-11 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 text-[10px] font-black text-amber-700 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50">Remove from Review</button>
              )}
              <button type="button" disabled className={`min-h-11 rounded-xl border border-slate-200 bg-slate-50 px-4 text-[10px] font-black text-slate-400 dark:border-slate-800 dark:bg-slate-900/40 ${canReject ? '' : 'w-full'}`} aria-disabled="true">
                Approval unavailable while media is processing
              </button>
            </div>
          </div>
        )}

        {terminalState && (
          <div className="p-3" onClick={(event) => event.stopPropagation()}>
            <p className="mb-2 text-center text-[10px] font-black text-emerald-700 dark:text-emerald-300" role="status">{terminalState === 'Dismissed by admin' ? 'Removed from Review' : `Decision recorded: ${terminalState}`}</p>
            <button type="button" onClick={onViewHistory} className="min-h-11 w-full rounded-xl border border-blue-500/20 bg-blue-500/10 px-4 text-[10px] font-black text-blue-700 dark:text-blue-300">View decision history</button>
          </div>
        )}
      </div>
    </article>
  );
}

export default React.memo(SupplierReviewQuickCard);
