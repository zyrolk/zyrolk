import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock3, PackageSearch, RefreshCw, Search, Trash2, UserCheck, UserX } from 'lucide-react';
import { supplierBusinessErrorMessage } from '../../services/supplierHubPresentation';

type SupplierApiRequest = (path: string, method: 'GET' | 'POST', body?: Record<string, unknown>) => Promise<Response>;

interface SupplierAccountView {
  uid: string;
  email: string;
  displayName: string;
  authDisabled: boolean;
  userRole: string;
  profileStatus: 'pending' | 'active' | 'disabled' | 'missing';
  companyName: string;
  protectedAccount: boolean;
}

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
  onAccountChanged?: () => void | Promise<void>;
}

const EMPTY_SUMMARY: SupplierManagementSummary = {
  totalProducts: 0,
  pendingReview: 0,
  approvedProducts: 0,
  updatedProducts: 0,
  removedProducts: 0,
  failedImports: 0,
};

export default function SupplierManagementDashboard({ requestApi, refreshKey, onAccountChanged }: SupplierManagementDashboardProps) {
  const [summary, setSummary] = useState<SupplierManagementSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accountQuery, setAccountQuery] = useState('');
  const [account, setAccount] = useState<SupplierAccountView | null>(null);
  const [accountBusy, setAccountBusy] = useState('');
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountNotice, setAccountNotice] = useState<string | null>(null);
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

  const findAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    const query = accountQuery.trim();
    if (!query || accountBusy) return;
    setAccountBusy('lookup');
    setAccountError(null);
    setAccountNotice(null);
    setAccount(null);
    try {
      const response = await requestApi(`/api/supplier-accounts/lookup?query=${encodeURIComponent(query)}`, 'GET');
      const result = await response.json().catch(() => ({})) as { success?: boolean; account?: SupplierAccountView; error?: string };
      if (!response.ok || result.success !== true || !result.account) throw new Error(result.error || 'Firebase Auth user could not be found.');
      setAccount(result.account);
    } catch (lookupError) {
      setAccountError(supplierBusinessErrorMessage(lookupError, 'Firebase Auth user could not be found.'));
    } finally {
      setAccountBusy('');
    }
  };

  const transitionAccount = async (action: 'promote' | 'activate' | 'disable') => {
    if (!account || accountBusy) return;
    setAccountBusy(action);
    setAccountError(null);
    setAccountNotice(null);
    try {
      const response = await requestApi(`/api/supplier-accounts/${encodeURIComponent(account.uid)}/${action}`, 'POST');
      const result = await response.json().catch(() => ({})) as {
        success?: boolean;
        account?: SupplierAccountView;
        changed?: boolean;
        error?: string;
      };
      if (!response.ok || result.success !== true || !result.account) throw new Error(result.error || 'Supplier account could not be updated.');
      setAccount(result.account);
      const labels = { promote: 'promoted to supplier', activate: 'approved and activated', disable: 'disabled' } as const;
      setAccountNotice(result.changed === false ? `Account is already ${labels[action]}.` : `Supplier account ${labels[action]}.`);
      if (onAccountChanged) void Promise.resolve(onAccountChanged()).catch(() => undefined);
    } catch (transitionError) {
      setAccountError(supplierBusinessErrorMessage(transitionError, 'Supplier account could not be updated.'));
    } finally {
      setAccountBusy('');
    }
  };

  if (loading) {
    return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6" aria-label="Loading supplier dashboard">{cards.map(([label]) => <div key={label} className="h-24 animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-800" />)}</div>;
  }

  return (
    <section aria-labelledby="supplier-management-summary-title" className="space-y-4">
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
      <div className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-xs dark:border-slate-800 dark:bg-slate-950 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300"><UserCheck className="h-4 w-4" aria-hidden="true" /></span>
          <div>
            <h5 className="text-sm font-black text-slate-900 dark:text-white">Supplier Portal accounts</h5>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Find an existing Zyro.lk account, promote it, then explicitly approve access.</p>
          </div>
        </div>
        <form onSubmit={findAccount} className="mt-4 flex flex-col gap-2 sm:flex-row">
          <label className="sr-only" htmlFor="supplier-account-query">Firebase Auth email or UID</label>
          <input
            id="supplier-account-query"
            type="text"
            value={accountQuery}
            onChange={(event) => setAccountQuery(event.target.value)}
            placeholder="Firebase Auth email or UID"
            autoComplete="off"
            maxLength={320}
            className="min-h-11 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-hidden focus:border-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
          />
          <button type="submit" disabled={!accountQuery.trim() || Boolean(accountBusy)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-xs font-black text-white disabled:opacity-50 dark:bg-white dark:text-slate-900">
            <Search className={`h-4 w-4 ${accountBusy === 'lookup' ? 'animate-pulse' : ''}`} aria-hidden="true" /> {accountBusy === 'lookup' ? 'Finding account' : 'Find account'}
          </button>
        </form>
        {accountError && <p role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">{accountError}</p>}
        {accountNotice && <p role="status" className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300">{accountNotice}</p>}
        {account && (
          <div className="mt-4 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
            <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
              <div className="min-w-0">
                <p className="truncate text-sm font-black text-slate-900 dark:text-white">{account.displayName || account.email || account.uid}</p>
                <p className="mt-1 break-all text-xs text-slate-500 dark:text-slate-400">{account.email || 'No Auth email'} · UID {account.uid}</p>
                {account.companyName && <p className="mt-1 text-xs font-semibold text-slate-600 dark:text-slate-300">{account.companyName}</p>}
              </div>
              <div className="flex flex-wrap gap-2 text-[10px] font-black uppercase tracking-wider">
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600 dark:bg-slate-800 dark:text-slate-300">Role: {account.userRole}</span>
                <span className={`rounded-full px-2.5 py-1 ${account.profileStatus === 'active' ? 'bg-emerald-100 text-emerald-700' : account.profileStatus === 'disabled' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>Profile: {account.profileStatus}</span>
              </div>
            </div>
            {account.protectedAccount ? (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">This account has protected administrator access and cannot be converted to supplier.</p>
            ) : account.authDisabled ? (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">This Firebase Auth user is disabled. Enable it in Firebase Authentication before promotion.</p>
            ) : (
              <div className="mt-4 flex flex-wrap gap-2">
                {account.userRole !== 'supplier' && <button type="button" onClick={() => void transitionAccount('promote')} disabled={Boolean(accountBusy)} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-4 text-xs font-black text-white disabled:opacity-50"><UserCheck className="h-4 w-4" aria-hidden="true" />{accountBusy === 'promote' ? 'Promoting' : 'Promote to supplier'}</button>}
                {account.userRole === 'supplier' && account.profileStatus !== 'active' && <button type="button" onClick={() => void transitionAccount('activate')} disabled={Boolean(accountBusy)} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-xs font-black text-white disabled:opacity-50"><CheckCircle2 className="h-4 w-4" aria-hidden="true" />{accountBusy === 'activate' ? 'Activating' : 'Approve / Activate'}</button>}
                {account.userRole === 'supplier' && account.profileStatus === 'active' && <button type="button" onClick={() => void transitionAccount('disable')} disabled={Boolean(accountBusy)} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-red-600 px-4 text-xs font-black text-white disabled:opacity-50"><UserX className="h-4 w-4" aria-hidden="true" />{accountBusy === 'disable' ? 'Disabling' : 'Disable supplier'}</button>}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
