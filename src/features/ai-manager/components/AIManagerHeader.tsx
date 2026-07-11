import { BrainCircuit, LockKeyhole } from 'lucide-react';
import { ProviderStatus } from './ProviderStatus';

export function AIManagerHeader() {
  return (
    <header className="rounded-3xl border border-blue-500/20 bg-gradient-to-br from-blue-600/15 via-indigo-500/10 to-slate-900/20 p-6 sm:p-8">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-lg shadow-blue-500/20">
            <BrainCircuit className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-emerald-400">
              <LockKeyhole className="h-3 w-3" aria-hidden="true" />
              Read-only foundation
            </div>
            <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">AI Manager</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
              A provider-neutral intelligence workspace showing which operational datasets are ready for future analysis. No AI provider or automated action is connected.
            </p>
          </div>
        </div>
        <ProviderStatus />
      </div>
    </header>
  );
}
