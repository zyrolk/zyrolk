import { Clock, LogIn, Mail, Phone } from 'lucide-react';
import type { WebsiteSettings } from '../types';

export default function StorefrontMaintenance({ settings, onSignIn }: { settings: WebsiteSettings; onSignIn: () => void }) {
  return <main className="flex min-h-screen items-center justify-center bg-slate-950 px-5 py-12 text-white">
    <section className="w-full max-w-2xl rounded-3xl border border-white/10 bg-white/5 p-7 text-center shadow-2xl sm:p-12" aria-labelledby="maintenance-title">
      {settings.logoUrl && <img src={settings.logoUrl} alt={settings.storeName} className="mx-auto mb-6 h-16 max-w-56 object-contain" />}
      <span className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500/15 text-blue-300"><Clock aria-hidden="true" /></span>
      <h1 id="maintenance-title" className="text-3xl font-black sm:text-4xl">We’ll be back shortly</h1>
      <p className="mx-auto mt-4 max-w-xl text-sm leading-7 text-slate-300">{settings.maintenanceMessage || `${settings.storeName} is temporarily unavailable while scheduled maintenance is completed.`}</p>
      <div className="mt-7 flex flex-wrap justify-center gap-3 text-xs text-slate-300">{settings.contactEmail && <a className="flex min-h-11 items-center gap-2 rounded-xl border border-white/10 px-4" href={`mailto:${settings.contactEmail}`}><Mail className="h-4 w-4" /> {settings.contactEmail}</a>}{settings.contactPhone && <a className="flex min-h-11 items-center gap-2 rounded-xl border border-white/10 px-4" href={`tel:${settings.contactPhone}`}><Phone className="h-4 w-4" /> {settings.contactPhone}</a>}</div>
      <button type="button" onClick={onSignIn} className="mt-8 inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-bold"><LogIn className="h-4 w-4" /> Staff sign in</button>
    </section>
  </main>;
}
