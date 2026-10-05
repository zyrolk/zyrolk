import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export type SupplierReviewPaginationItem = number | 'ellipsis';

export function buildSupplierReviewPaginationItems(currentPage: number, totalPages: number): SupplierReviewPaginationItem[] {
  if (!Number.isFinite(totalPages) || totalPages < 1) return [Math.max(1, currentPage)];
  const page = Math.min(Math.max(1, Math.floor(currentPage)), Math.floor(totalPages));
  const total = Math.floor(totalPages);
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);

  if (page <= 4) return [1, 2, 3, 4, 5, 'ellipsis', total];
  if (page >= total - 3) return [1, 'ellipsis', total - 4, total - 3, total - 2, total - 1, total];
  return [1, 'ellipsis', page - 1, page, page + 1, 'ellipsis', total];
}

interface SupplierReviewPaginationProps {
  currentPage: number;
  totalPages: number | null;
  hasNext: boolean;
  hasPrevious?: boolean;
  loading?: boolean;
  onPageChange: (page: number) => void;
}

export default function SupplierReviewPagination({
  currentPage,
  totalPages,
  hasNext,
  hasPrevious = currentPage > 1,
  loading = false,
  onPageChange,
}: SupplierReviewPaginationProps) {
  const canGoPrevious = hasPrevious && currentPage > 1 && !loading;
  const canGoNext = hasNext && !loading;
  const items = totalPages === null
    ? [Math.max(1, currentPage)] as SupplierReviewPaginationItem[]
    : buildSupplierReviewPaginationItems(currentPage, totalPages);

  return (
    <nav aria-label="Product Review pagination" className="flex flex-wrap items-center justify-center gap-1.5">
      <button
        type="button"
        onClick={() => onPageChange(currentPage - 1)}
        disabled={!canGoPrevious}
        aria-label="Previous Product Review page"
        className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-xl border border-slate-200 bg-white px-2 text-slate-600 transition-colors hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300 dark:hover:border-blue-700 dark:hover:bg-blue-950/30"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">Previous</span>
      </button>
      {items.map((item, index) => item === 'ellipsis' ? (
        <span key={`ellipsis-${index}`} aria-hidden="true" className="px-1 text-xs font-black text-slate-400">…</span>
      ) : (
        <button
          key={item}
          type="button"
          onClick={() => onPageChange(item)}
          disabled={loading || item === currentPage}
          aria-current={item === currentPage ? 'page' : undefined}
          aria-label={`Product Review page ${item}`}
          className={`inline-flex min-h-10 min-w-10 items-center justify-center rounded-xl px-2 text-xs font-black transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${item === currentPage ? 'bg-blue-600 text-white shadow-sm' : 'border border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:bg-blue-50 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300 dark:hover:border-blue-700 dark:hover:bg-blue-950/30'}`}
        >
          {item}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onPageChange(currentPage + 1)}
        disabled={!canGoNext}
        aria-label="Next Product Review page"
        className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-xl border border-slate-200 bg-white px-2 text-slate-600 transition-colors hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300 dark:hover:border-blue-700 dark:hover:bg-blue-950/30"
      >
        <span className="sr-only">Next</span>
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </nav>
  );
}
