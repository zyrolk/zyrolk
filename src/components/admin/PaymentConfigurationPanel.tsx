import React, { useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { auth } from '../../firebase';
import { getAppCheckRequestHeaders } from '../../services/security/appCheck';

interface Status { configured: boolean; paymentStatus: string; mode: string; merchantId: string; merchantSecretConfigured: boolean; secretStorage: string; message?: string }

export default function PaymentConfigurationPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true); setError('');
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('Admin authentication is required.');
      const response = await fetch('/api/admin/payment-settings', { headers: { Authorization: `Bearer ${token}`, ...(await getAppCheckRequestHeaders()) } });
      const body = await response.json() as Status & { error?: string };
      if (!response.ok) throw new Error(body.error || 'Payment status could not be loaded.');
      setStatus(body);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Payment status could not be loaded.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  return <section className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800" aria-labelledby="payment-config-title">
    <div className="flex items-start justify-between gap-3"><div><h3 id="payment-config-title" className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-blue-500"><ShieldCheck className="h-4 w-4" /> PayHere payment configuration</h3><p className="mt-1 text-[11px] text-slate-400">Credentials remain in deployment configuration and Firebase Secret Manager; they are never stored in public Firestore settings.</p></div><button type="button" onClick={load} disabled={loading} className="flex min-h-11 items-center gap-1 rounded-xl border px-3 text-xs font-bold"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh</button></div>
    {error && <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-xs text-red-500">{error}</p>}
    {status && <dl className="grid gap-3 rounded-2xl border border-slate-200/60 p-4 text-xs sm:grid-cols-2 dark:border-slate-800"><div><dt className="text-slate-400">Payment status</dt><dd className="font-bold capitalize">{status.paymentStatus}</dd></div><div><dt className="text-slate-400">Mode</dt><dd className="font-bold uppercase">{status.mode}</dd></div><div><dt className="text-slate-400">Merchant ID</dt><dd className="font-mono font-bold">{status.merchantId || 'Not configured'}</dd></div><div><dt className="text-slate-400">Merchant secret</dt><dd className="font-bold">{status.merchantSecretConfigured ? `Configured in ${status.secretStorage}` : 'Not configured'}</dd></div>{status.message && <div className="sm:col-span-2"><dt className="text-slate-400">Readiness note</dt><dd>{status.message}</dd></div>}</dl>}
  </section>;
}
