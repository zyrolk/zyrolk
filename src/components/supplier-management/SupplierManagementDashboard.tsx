import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock3, PackageSearch, RefreshCw, Trash2 } from 'lucide-react';
import { supplierBusinessErrorMessage } from '../../services/supplierHubPresentation';

type SupplierApiRequest = (path: string, method: 'GET') => Promise<Response>;

interface SupplierManagementSummary {
  totalProducts: number;
  pendingReview: number;
  approvedProducts: number;
  updatedProducts: number;
  removedProducts: number;
  failedImports: number;
}

interface SupplierManagementDashboardProps {
  requestApi: SupplierApiRequest;
  refreshKey: number;
}

const EMPTY_SUMMARY: SupplierManagementSummary = {
  totalProducts: 0,
  pendingReview: 0,
  approvedProducts: 0,
  updatedProducts: 0,
  removedProducts: 0,
  failedImports: 0,
};

export default function SupplierManagementDashboard({ requestApi, refreshKey }: SupplierManagementDashboardProps) {
  const [summary, setSummary] = useState<SupplierManagementSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const loadSummary = useCallback(async (quiet = false) => {
    const requestId = ++requestIdRef.current;
    if (!quiet) setLoading(true);
    try {
      const response = await requestApi('/api/supplier-operations/summary', 'GET');
      const result = await response.json().catch(() => ({})) as {
        success?: boolean;
        summary?: Partial<SupplierManagementSummary>;
        error?: string;
      };
      if (!response.ok || result.success === false || !result.summary) {
        throw new Error(result.error || 'Supplier dashboard could not be loaded.');
      }
      if (requestId !== requestIdRef.current) return;
      setSummary({
        totalProducts: Number(result.summary.totalProducts || 0),
        pendingReview: Number(result.summary.pendingReview || 0),
        approvedProducts: Number(result.summary.approvedProducts || 0),
        updatedProducts: Number(result.summary.updatedProducts || 0),
        removedProducts: Number(result.summary.removedProducts || 0),
        failedImports: Number(result.summary.failedImports || 0),
      });
      setError(null);
    } catch (loadError) {
      if (requestId === requestIdRef.current) {
        setError(supplierBusinessErrorMessage(loadError, 'Supplier dashboard could not be loaded.'));
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [requestApi]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const poll = async () => {
      await loadSummary(true);
      if (!cancelled) timer = window.setTimeout(() => void poll(), 30_000);
    };
    void loadSummary(false);
    timer = window.setTimeout(() => void poll(), 30_000);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [loadSummary, refreshKey]);

  const cards = [
    ['Total Products', summary.totalProducts, PackageSearch, 'text-blue-500'],
    ['Pending Review', summary.pendingReview, Clock3, 'text-amber-500'],
    ['Approved Products', summary.approvedProducts, CheckCircle2, 'text-emerald-500'],
    ['Updated Products', summary.updatedProducts, RefreshCw, 'text-cyan-500'],
    ['Removed Products', summary.removedProducts, Trash2, 'text-slate-500'],
    ['Failed Imports', summary.failedImports, AlertCircle, 'text-rose-500'],
  ] as const;

  if (loading) {
    return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6" aria-label="Loading supplier dashboard">{cards.map(([label]) => <div key={label} className="h-24 animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-800" />)}</div>;
  }

  return (
    <section aria-labelledby="supplier-management-summary-title" className="space-y-3">
      <h4 id="supplier-management-summary-title" className="sr-only">Supplier dashboard</h4>
      {error && <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {cards.map(([label, value, Icon, color]) => (
          <div key={label} className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-xs dark:border-slate-800 dark:bg-slate-950">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[9px] font-black uppercase tracking-wider text-slate-400">{label}</span>
              <Icon className={`h-4 w-4 shrink-0 ${color}`} aria-hidden="true" />
            </div>
            <p className="mt-3 text-xl font-black text-slate-900 dark:text-white">{value}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
