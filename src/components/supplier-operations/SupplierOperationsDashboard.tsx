import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  Download,
  Gauge,
  History,
  Image,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  ShieldAlert,
  Users,
  XCircle,
} from 'lucide-react';

type SupplierApiRequest = (path: string, method: 'GET' | 'POST', body?: Record<string, unknown>) => Promise<Response>;

interface SupplierOperationsDashboardProps {
  requestApi: SupplierApiRequest;
}

interface OperationsSummary {
  totalSuppliers: number;
  activeSuppliers: number;
  disabledSuppliers: number;
  lastSuccessfulSync: string | null;
  nextScheduledSync: string | null;
  productsImportedToday: number;
  productsUpdatedToday: number;
  productsPublishedToday: number;
  failedImports: number;
  failedApprovals: number;
}

interface SupplierHealth {
  id: string;
  name: string;
  enabled: boolean;
  status: string;
  lastSync: string | null;
  lastSuccess: string | null;
  lastFailure: string | null;
  failureReason: string | null;
  stack?: string | null;
  errorDisposition?: string | null;
  syncDurationMs: number;
  productCount: number;
  queueSize: number;
  healthScore: number;
  nextScheduledSync: string | null;
}

interface QueueItem {
  id: string;
  productName: string;
  supplierName: string;
  sourceId: string | null;
  supplierCode: string | null;
  state: string;
  createdAt: string | null;
  updatedAt: string | null;
  retryCount: number;
  failureReason: string | null;
}

interface OperationsAlert {
  id: string;
  severity: string;
  title: string;
  message: string;
  createdAt: string;
}

interface OperationsSnapshot {
  generatedAt: string;
  summary: OperationsSummary;
  suppliers: SupplierHealth[];
  queues: Record<string, number>;
  media: Record<string, number>;
  alerts: OperationsAlert[];
  performance: Record<string, unknown>;
}

interface PageResponse {
  success: boolean;
  items: Array<Record<string, any>>;
  nextCursor: string | null;
  error?: string;
}

const EMPTY_SUMMARY: OperationsSummary = {
  totalSuppliers: 0,
  activeSuppliers: 0,
  disabledSuppliers: 0,
  lastSuccessfulSync: null,
  nextScheduledSync: null,
  productsImportedToday: 0,
  productsUpdatedToday: 0,
  productsPublishedToday: 0,
  failedImports: 0,
  failedApprovals: 0,
};

const dateTime = (value: unknown): string => {
  if (!value) return 'Not available';
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? 'Not available' : parsed.toLocaleString();
};

const duration = (value: unknown): string => {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '—';
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} sec`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
};

const bytes = (value: unknown): string => {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
};

const stateLabel = (value: string): string => value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

const downloadCsv = (name: string, records: Array<Record<string, unknown>>): void => {
  if (!records.length) return;
  const keys = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const csv = [keys.map(quote).join(','), ...records.map((record) => keys.map((key) => quote(
    typeof record[key] === 'object' ? JSON.stringify(record[key]) : record[key],
  )).join(','))].join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
};

export default function SupplierOperationsDashboard({ requestApi }: SupplierOperationsDashboardProps) {
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [historyItems, setHistoryItems] = useState<Array<Record<string, any>>>([]);
  const [auditItems, setAuditItems] = useState<Array<Record<string, any>>>([]);
  const [queueCursor, setQueueCursor] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [queueState, setQueueState] = useState('all');
  const [search, setSearch] = useState('');
  const [auditSearch, setAuditSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readJson = useCallback(async <T,>(response: Response): Promise<T> => {
    const result = await response.json().catch(() => ({})) as T & { success?: boolean; error?: string };
    if (!response.ok || result.success === false) throw new Error(result.error || 'Supplier operations request failed.');
    return result;
  }, []);

  const loadQueue = useCallback(async (append = false, after?: string | null) => {
    const params = new URLSearchParams({ limit: '50' });
    if (queueState !== 'all') params.set('state', queueState);
    if (search.trim()) params.set('search', search.trim());
    if (after) params.set('after', after);
    const result = await readJson<PageResponse>(await requestApi(`/api/supplier-operations/queue?${params}`, 'GET'));
    setQueueItems((current) => append ? [...current, ...(result.items as QueueItem[])] : result.items as QueueItem[]);
    setQueueCursor(result.nextCursor);
  }, [queueState, readJson, requestApi, search]);

  const loadAll = useCallback(async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const [summaryResponse, historyResponse, auditResponse] = await Promise.all([
        requestApi('/api/supplier-operations/summary', 'GET'),
        requestApi('/api/supplier-operations/sync-history?limit=40', 'GET'),
        requestApi('/api/supplier-operations/audit?limit=40', 'GET'),
        loadQueue(false),
      ]);
      const summaryResult = await readJson<OperationsSnapshot & { success: boolean }>(summaryResponse);
      const historyResult = await readJson<PageResponse>(historyResponse);
      const auditResult = await readJson<PageResponse>(auditResponse);
      setSnapshot(summaryResult);
      setHistoryItems(historyResult.items);
      setHistoryCursor(historyResult.nextCursor);
      setAuditItems(auditResult.items);
      setAuditCursor(auditResult.nextCursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Supplier operations could not be loaded.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loadQueue, readJson, requestApi]);

  useEffect(() => {
    void loadAll();
    const interval = window.setInterval(() => void loadAll(true), 30_000);
    return () => window.clearInterval(interval);
  }, [loadAll]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadQueue(false).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : 'Queue could not be loaded.');
    }), 250);
    return () => window.clearTimeout(timeout);
  }, [loadQueue]);

  const runSupplierAction = async (supplierId: string, action: string) => {
    setActionId(`${supplierId}:${action}`);
    setError(null);
    try {
      await readJson(await requestApi(`/api/supplier-operations/suppliers/${encodeURIComponent(supplierId)}/action`, 'POST', { action }));
      await loadAll(true);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Supplier action failed.');
    } finally {
      setActionId(null);
    }
  };

  const runQueueAction = async (action: 'bulk-retry' | 'bulk-reopen' | 'bulk-resolve') => {
    if (!selected.length) return;
    setActionId(action);
    setError(null);
    try {
      await readJson(await requestApi(`/api/supplier-operations/queue/${action}`, 'POST', action === 'bulk-resolve'
        ? { items: selected.map((queueItemId) => ({ queueItemId })) }
        : { queueItemIds: selected }));
      setSelected([]);
      await loadAll(true);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Queue recovery failed.');
    } finally {
      setActionId(null);
    }
  };

  const updateErrorDisposition = async (queueItemId: string, action: 'ignore' | 'resolved') => {
    setActionId(`${queueItemId}:${action}`);
    setError(null);
    try {
      await readJson(await requestApi(`/api/supplier-operations/errors/${encodeURIComponent(queueItemId)}/action`, 'POST', { action }));
      await loadQueue(false);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Error center status could not be updated.');
    } finally {
      setActionId(null);
    }
  };

  const retryError = async (queueItemId: string) => {
    setActionId(`${queueItemId}:retry`);
    setError(null);
    try {
      await readJson(await requestApi('/api/supplier-operations/queue/bulk-retry', 'POST', { queueItemIds: [queueItemId] }));
      await loadAll(true);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Error retry failed.');
    } finally {
      setActionId(null);
    }
  };

  const summary = snapshot?.summary || EMPTY_SUMMARY;
  const queueCounts = snapshot?.queues || {};
  const media = snapshot?.media || {};
  const performance = snapshot?.performance || {};
  const functionMemory = performance.functionMemory && typeof performance.functionMemory === 'object'
    ? performance.functionMemory as Record<string, unknown>
    : {};
  const failedItems = useMemo(() => queueItems.filter((item) => ['retryable_failure', 'dead_letter', 'conflict'].includes(item.state) && !item.errorDisposition), [queueItems]);
  const visibleAuditItems = useMemo(() => {
    const needle = auditSearch.trim().toLowerCase();
    if (!needle) return auditItems;
    return auditItems.filter((item) => [item.action, item.module, item.supplierId, item.sourceId, item.reason]
      .some((value) => String(value || '').toLowerCase().includes(needle)));
  }, [auditItems, auditSearch]);

  const cards = [
    ['Total suppliers', summary.totalSuppliers, Users, 'text-blue-500'],
    ['Active suppliers', summary.activeSuppliers, CheckCircle2, 'text-emerald-500'],
    ['Disabled suppliers', summary.disabledSuppliers, Pause, 'text-slate-500'],
    ['Imported today', summary.productsImportedToday, Database, 'text-violet-500'],
    ['Updated today', summary.productsUpdatedToday, RefreshCw, 'text-cyan-500'],
    ['Published today', summary.productsPublishedToday, Play, 'text-emerald-500'],
    ['Failed imports', summary.failedImports, XCircle, 'text-red-500'],
    ['Approval conflicts', summary.failedApprovals, ShieldAlert, 'text-amber-500'],
  ] as const;

  if (loading) {
    return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Loading Supplier Hub operations"><div className="h-28 animate-pulse rounded-3xl bg-slate-100 dark:bg-slate-800" /><div className="h-28 animate-pulse rounded-3xl bg-slate-100 dark:bg-slate-800" /><div className="h-28 animate-pulse rounded-3xl bg-slate-100 dark:bg-slate-800" /><div className="h-28 animate-pulse rounded-3xl bg-slate-100 dark:bg-slate-800" /></div>;
  }

  return (
    <div className="space-y-8" data-testid="supplier-operations-dashboard">
      <div className="flex flex-col gap-3 rounded-3xl border border-slate-200/70 bg-white p-5 dark:border-slate-800 dark:bg-slate-950 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2"><Activity className="h-5 w-5 text-blue-500" /><h3 className="font-display text-lg font-black text-slate-900 dark:text-white">Operations & Monitoring</h3></div>
          <p className="mt-1 text-xs text-slate-500">Auto-refreshes every 30 seconds · Last snapshot {dateTime(snapshot?.generatedAt)}</p>
        </div>
        <button type="button" onClick={() => void loadAll(true)} disabled={refreshing} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-xs font-black text-white disabled:opacity-60" aria-label="Refresh operations dashboard">
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {error && <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">{error}</div>}

      <section aria-labelledby="operations-summary-title">
        <h4 id="operations-summary-title" className="sr-only">Operations summary</h4>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {cards.map(([label, value, Icon, color]) => <div key={label} className="rounded-3xl border border-slate-200/70 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950"><div className="flex items-center justify-between"><span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</span><Icon className={`h-5 w-5 ${color}`} /></div><p className="mt-4 text-2xl font-black text-slate-900 dark:text-white">{value}</p></div>)}
        </div>
        <div className="mt-3 grid gap-3 text-xs text-slate-500 sm:grid-cols-2"><p>Last successful sync: <strong className="text-slate-700 dark:text-slate-200">{dateTime(summary.lastSuccessfulSync)}</strong></p><p>Next scheduled sync: <strong className="text-slate-700 dark:text-slate-200">{dateTime(summary.nextScheduledSync)}</strong></p></div>
      </section>

      <section aria-labelledby="alerts-title" className="rounded-3xl border border-slate-200/70 bg-white p-5 dark:border-slate-800 dark:bg-slate-950">
        <div className="mb-4 flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-amber-500" /><h4 id="alerts-title" className="font-black text-slate-900 dark:text-white">Active alerts</h4><span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-black text-amber-700">{snapshot?.alerts.length || 0}</span></div>
        {snapshot?.alerts.length ? <div className="grid gap-3 lg:grid-cols-2">{snapshot.alerts.map((alert) => <div key={alert.id} className="rounded-2xl border border-amber-200/70 bg-amber-50/70 p-4 dark:border-amber-900/50 dark:bg-amber-950/20"><div className="flex items-center justify-between gap-2"><strong className="text-sm text-slate-900 dark:text-white">{alert.title}</strong><span className="text-[9px] font-black uppercase text-amber-700">{alert.severity}</span></div><p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{alert.message}</p></div>)}</div> : <p className="text-sm text-slate-500">No active operational alerts.</p>}
      </section>

      <section aria-labelledby="supplier-health-title" className="space-y-4">
        <div className="flex items-center gap-2"><Gauge className="h-5 w-5 text-emerald-500" /><h4 id="supplier-health-title" className="font-black text-slate-900 dark:text-white">Supplier health</h4></div>
        <div className="grid gap-4 lg:grid-cols-2">
          {(snapshot?.suppliers || []).map((supplier) => <article key={supplier.id} className="rounded-3xl border border-slate-200/70 bg-white p-5 dark:border-slate-800 dark:bg-slate-950">
            <div className="flex items-start justify-between gap-3"><div><h5 className="font-black text-slate-900 dark:text-white">{supplier.name}</h5><p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{supplier.status}</p></div><div className={`rounded-full px-3 py-1 text-xs font-black ${supplier.healthScore >= 80 ? 'bg-emerald-100 text-emerald-700' : supplier.healthScore >= 50 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>{supplier.healthScore}%</div></div>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-xs"><div><dt className="text-slate-400">Last success</dt><dd className="font-semibold text-slate-700 dark:text-slate-200">{dateTime(supplier.lastSuccess)}</dd></div><div><dt className="text-slate-400">Average sync</dt><dd className="font-semibold text-slate-700 dark:text-slate-200">{duration(supplier.syncDurationMs)}</dd></div><div><dt className="text-slate-400">Products</dt><dd className="font-semibold text-slate-700 dark:text-slate-200">{supplier.productCount}</dd></div><div><dt className="text-slate-400">Queue</dt><dd className="font-semibold text-slate-700 dark:text-slate-200">{supplier.queueSize}</dd></div></dl>
            {supplier.failureReason && supplier.failureReason !== 'None' && <p className="mt-3 rounded-xl bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">{supplier.failureReason}</p>}
            <div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => void runSupplierAction(supplier.id, 'sync')} disabled={Boolean(actionId)} className="min-h-10 rounded-xl bg-blue-600 px-3 text-[10px] font-black text-white"><RefreshCw className="mr-1 inline h-3.5 w-3.5" />Sync</button>{supplier.enabled ? <><button type="button" onClick={() => void runSupplierAction(supplier.id, 'pause')} disabled={Boolean(actionId)} className="min-h-10 rounded-xl bg-amber-100 px-3 text-[10px] font-black text-amber-700"><Pause className="mr-1 inline h-3.5 w-3.5" />Pause</button><button type="button" onClick={() => void runSupplierAction(supplier.id, 'disable')} disabled={Boolean(actionId)} className="min-h-10 rounded-xl bg-slate-100 px-3 text-[10px] font-black text-slate-700"><XCircle className="mr-1 inline h-3.5 w-3.5" />Disable</button></> : <button type="button" onClick={() => void runSupplierAction(supplier.id, 'resume')} disabled={Boolean(actionId)} className="min-h-10 rounded-xl bg-emerald-100 px-3 text-[10px] font-black text-emerald-700"><Play className="mr-1 inline h-3.5 w-3.5" />Resume</button>}{supplier.lastFailure && <button type="button" onClick={() => void runSupplierAction(supplier.id, 'retry')} disabled={Boolean(actionId)} className="min-h-10 rounded-xl bg-red-100 px-3 text-[10px] font-black text-red-700"><RotateCcw className="mr-1 inline h-3.5 w-3.5" />Retry failed sync</button>}</div>
          </article>)}
        </div>
      </section>

      <section aria-labelledby="queue-monitor-title" className="rounded-3xl border border-slate-200/70 bg-white p-5 dark:border-slate-800 dark:bg-slate-950">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div><div className="flex items-center gap-2"><Server className="h-5 w-5 text-blue-500" /><h4 id="queue-monitor-title" className="font-black text-slate-900 dark:text-white">Queue monitoring</h4></div><p className="mt-1 text-xs text-slate-500">Oldest eligible item: {duration(queueCounts.queueAgeMs)}</p></div><div className="flex flex-wrap gap-2"><div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} className="min-h-10 rounded-xl border border-slate-200 bg-transparent pl-9 pr-3 text-xs dark:border-slate-700" placeholder="Search queue" aria-label="Search queue" /></div><select value={queueState} onChange={(event) => setQueueState(event.target.value)} className="min-h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs dark:border-slate-700 dark:bg-slate-900" aria-label="Filter queue state"><option value="all">All states</option>{['review_pending', 'processing', 'approved', 'rejected', 'conflict', 'retryable_failure', 'dead_letter'].map((state) => <option key={state} value={state}>{stateLabel(state)}</option>)}</select></div></div>
        <div className="mt-4 flex flex-wrap gap-2">{['pending', 'processing', 'approved', 'rejected', 'conflict', 'retry', 'dead_letter'].map((state) => <span key={state} className="rounded-full bg-slate-100 px-3 py-1 text-[10px] font-black text-slate-600 dark:bg-slate-800 dark:text-slate-300">{stateLabel(state)} {Number(queueCounts[state] || 0)}</span>)}</div>
        <div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => void runQueueAction('bulk-retry')} disabled={!selected.length || Boolean(actionId)} className="min-h-10 rounded-xl bg-red-100 px-3 text-[10px] font-black text-red-700 disabled:opacity-40">Bulk retry</button><button type="button" onClick={() => void runQueueAction('bulk-reopen')} disabled={!selected.length || Boolean(actionId)} className="min-h-10 rounded-xl bg-blue-100 px-3 text-[10px] font-black text-blue-700 disabled:opacity-40">Bulk reopen</button><button type="button" onClick={() => void runQueueAction('bulk-resolve')} disabled={!selected.length || Boolean(actionId)} className="min-h-10 rounded-xl bg-amber-100 px-3 text-[10px] font-black text-amber-700 disabled:opacity-40">Bulk resolve conflicts</button></div>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs"><thead><tr className="border-b border-slate-200 text-[9px] uppercase tracking-widest text-slate-400 dark:border-slate-800"><th className="p-3"><span className="sr-only">Select</span></th><th className="p-3">Product</th><th className="p-3">Supplier</th><th className="p-3">State</th><th className="p-3">Age</th><th className="p-3">Retries</th><th className="p-3">Failure</th></tr></thead><tbody>{queueItems.map((item) => <tr key={item.id} className="border-b border-slate-100 dark:border-slate-900"><td className="p-3"><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} aria-label={`Select ${item.productName}`} /></td><td className="p-3 font-bold text-slate-800 dark:text-slate-100">{item.productName}<span className="block font-normal text-slate-400">{item.supplierCode || item.id}</span></td><td className="p-3">{item.supplierName}</td><td className="p-3"><span className="rounded-full bg-slate-100 px-2 py-1 font-bold dark:bg-slate-800">{stateLabel(item.state)}</span></td><td className="p-3">{dateTime(item.createdAt)}</td><td className="p-3">{item.retryCount}</td><td className="max-w-56 truncate p-3 text-red-500" title={item.failureReason || ''}>{item.failureReason || '—'}</td></tr>)}</tbody></table>{!queueItems.length && <p className="py-8 text-center text-sm text-slate-500">No queue items match this view.</p>}</div>
        {queueCursor && <button type="button" onClick={() => void loadQueue(true, queueCursor)} className="mt-4 min-h-10 rounded-xl bg-slate-100 px-4 text-xs font-black dark:bg-slate-800">Load more</button>}
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <section aria-labelledby="sync-history-title" className="rounded-3xl border border-slate-200/70 bg-white p-5 dark:border-slate-800 dark:bg-slate-950">
          <div className="mb-4 flex items-center justify-between"><div className="flex items-center gap-2"><History className="h-5 w-5 text-violet-500" /><h4 id="sync-history-title" className="font-black text-slate-900 dark:text-white">Sync history</h4></div><button type="button" onClick={() => downloadCsv('supplier-sync-history', historyItems)} className="min-h-10 rounded-xl bg-slate-100 px-3 text-[10px] font-black dark:bg-slate-800"><Download className="mr-1 inline h-3.5 w-3.5" />Export</button></div>
          <div className="space-y-3">{historyItems.map((item) => <div key={item.id} className="rounded-2xl border border-slate-100 p-3 text-xs dark:border-slate-800"><div className="flex justify-between gap-3"><strong>{item.supplier || 'Supplier sync'}</strong><span className={item.status === 'Success' ? 'text-emerald-500' : 'text-red-500'}>{item.status}</span></div><p className="mt-1 text-slate-500">{dateTime(item.createdAt)} · {duration(item.durationMs)} · imported {Number(item.productsImported || 0)} · updated {Number(item.productsUpdated || 0)} · deleted {Number(item.productsDeleted || 0)} · failed {Number(item.productsFailed || 0)}</p></div>)}</div>
          {historyCursor && <button type="button" onClick={async () => { const result = await readJson<PageResponse>(await requestApi(`/api/supplier-operations/sync-history?limit=40&after=${encodeURIComponent(historyCursor)}`, 'GET')); setHistoryItems((current) => [...current, ...result.items]); setHistoryCursor(result.nextCursor); }} className="mt-4 min-h-10 rounded-xl bg-slate-100 px-4 text-xs font-black dark:bg-slate-800">Load more</button>}
        </section>

        <section aria-labelledby="error-center-title" className="rounded-3xl border border-slate-200/70 bg-white p-5 dark:border-slate-800 dark:bg-slate-950">
          <div className="mb-4 flex items-center justify-between"><div className="flex items-center gap-2"><ShieldAlert className="h-5 w-5 text-red-500" /><h4 id="error-center-title" className="font-black text-slate-900 dark:text-white">Error center</h4></div><button type="button" onClick={() => downloadCsv('supplier-errors', failedItems as unknown as Array<Record<string, unknown>>)} className="min-h-10 rounded-xl bg-slate-100 px-3 text-[10px] font-black dark:bg-slate-800"><Download className="mr-1 inline h-3.5 w-3.5" />Export</button></div>
          {failedItems.length ? <div className="space-y-3">{failedItems.map((item) => <div key={item.id} className="rounded-2xl border border-red-100 bg-red-50/40 p-3 text-xs dark:border-red-950 dark:bg-red-950/10"><div className="flex justify-between gap-3"><strong>{item.supplierName} · {stateLabel(item.state)}</strong><span>{dateTime(item.updatedAt)}</span></div><p className="mt-1 text-red-700 dark:text-red-300">{item.failureReason || 'Recovery is required.'}</p>{item.stack && <details className="mt-2"><summary className="cursor-pointer font-bold text-slate-600 dark:text-slate-300">Admin stack trace</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-2 text-[10px] text-slate-200">{item.stack}</pre></details>}<div className="mt-3 flex flex-wrap gap-2">{['retryable_failure', 'dead_letter'].includes(item.state) && <button type="button" onClick={() => void retryError(item.id)} className="min-h-9 rounded-lg bg-red-600 px-3 text-[10px] font-black text-white">Retry</button>}<button type="button" onClick={() => void updateErrorDisposition(item.id, 'ignore')} disabled={Boolean(actionId)} className="min-h-9 rounded-lg bg-slate-100 px-3 text-[10px] font-black text-slate-700 disabled:opacity-40">Ignore</button><button type="button" onClick={() => void updateErrorDisposition(item.id, 'resolved')} disabled={Boolean(actionId)} className="min-h-9 rounded-lg bg-emerald-100 px-3 text-[10px] font-black text-emerald-700 disabled:opacity-40">Resolved</button></div></div>)}</div> : <p className="text-sm text-slate-500">No failures on the current queue page.</p>}
        </section>
      </div>

      <section aria-labelledby="media-monitor-title" className="rounded-3xl border border-slate-200/70 bg-white p-5 dark:border-slate-800 dark:bg-slate-950"><div className="mb-4 flex items-center gap-2"><Image className="h-5 w-5 text-cyan-500" /><h4 id="media-monitor-title" className="font-black text-slate-900 dark:text-white">Media monitoring</h4></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">{[['Downloaded', media.downloaded], ['Failed', media.failedDownloads], ['Duplicate reuse', media.duplicateReuse], ['Storage', bytes(media.storageBytes)], ['Broken', media.brokenImages], ['Missing', media.missingImages]].map(([label, value]) => <div key={String(label)} className="rounded-2xl bg-slate-50 p-3 dark:bg-slate-900"><p className="text-[9px] font-black uppercase tracking-widest text-slate-400">{label}</p><p className="mt-2 text-lg font-black">{String(value ?? 0)}</p></div>)}</div></section>

      <section aria-labelledby="performance-title" className="rounded-3xl border border-slate-200/70 bg-white p-5 dark:border-slate-800 dark:bg-slate-950">
        <div className="mb-4 flex items-center gap-2"><Clock3 className="h-5 w-5 text-blue-500" /><h4 id="performance-title" className="font-black text-slate-900 dark:text-white">Performance</h4></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[
          ['Queue throughput', `${String(performance.queueThroughputPerHour ?? 0)}/hour`],
          ['Average sync', duration(performance.averageSyncDurationMs)],
          ['Average approval', duration(performance.averageApprovalDurationMs)],
          ['Average media', duration(performance.averageMediaProcessingDurationMs)],
          ['Function execution', duration(performance.functionExecutionTimeMs)],
          ['Active workers', String(performance.activeWorkers ?? 0)],
          ['Function heap', bytes(functionMemory.heapUsedBytes)],
          ['Firestore reads / writes', performance.cloudMetricsAvailable ? `${String(performance.firestoreReads)} / ${String(performance.firestoreWrites)}` : 'Cloud Monitoring required'],
        ].map(([label, value]) => <div key={label} className="rounded-2xl bg-slate-50 p-3 dark:bg-slate-900"><p className="text-[9px] font-black uppercase text-slate-400">{label}</p><p className="mt-2 font-black">{value}</p></div>)}</div>
        <p className="mt-3 text-[10px] text-slate-400">Firestore billing counters are intentionally not estimated when Cloud Monitoring metrics are unavailable.</p>
      </section>

      <section aria-labelledby="audit-center-title" className="rounded-3xl border border-slate-200/70 bg-white p-5 dark:border-slate-800 dark:bg-slate-950"><div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-2"><Activity className="h-5 w-5 text-emerald-500" /><h4 id="audit-center-title" className="font-black text-slate-900 dark:text-white">Audit center</h4></div><div className="flex gap-2"><label className="relative"><span className="sr-only">Search audit history</span><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" /><input value={auditSearch} onChange={(event) => setAuditSearch(event.target.value)} className="min-h-10 rounded-xl border border-slate-200 bg-transparent pl-9 pr-3 text-xs dark:border-slate-700" placeholder="Search audit" /></label><button type="button" onClick={() => downloadCsv('supplier-audit', visibleAuditItems)} className="min-h-10 rounded-xl bg-slate-100 px-3 text-[10px] font-black dark:bg-slate-800"><Download className="mr-1 inline h-3.5 w-3.5" />Export</button></div></div><div className="space-y-2">{visibleAuditItems.map((item) => <div key={`${item.module}:${item.id}`} className="grid gap-1 rounded-2xl border border-slate-100 p-3 text-xs dark:border-slate-800 sm:grid-cols-[1fr_auto]"><div><strong>{stateLabel(String(item.action || item.event || item.status || 'event'))}</strong><span className="ml-2 text-slate-400">{item.supplierId || item.sourceId || item.supplier || 'system'}</span><p className="mt-1 text-slate-500">{item.reason || item.details || `${item.previousState || 'new'} → ${item.newState || 'recorded'}`}</p></div><time className="text-slate-400">{dateTime(item.timestamp || item.createdAt)}</time></div>)}</div>{auditCursor && <button type="button" onClick={async () => { const result = await readJson<PageResponse>(await requestApi(`/api/supplier-operations/audit?limit=40&after=${encodeURIComponent(auditCursor)}`, 'GET')); setAuditItems((current) => [...current, ...result.items]); setAuditCursor(result.nextCursor); }} className="mt-4 min-h-10 rounded-xl bg-slate-100 px-4 text-xs font-black dark:bg-slate-800">Load more</button>}</section>
    </div>
  );
}
