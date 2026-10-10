import { Check, ChevronRight, PauseCircle, ShieldAlert } from "lucide-react";
import type { Launch1000Cluster } from "../services/launch1000TaxonomyWorkbench";

export interface Launch1000TaxonomyWorkbenchProps {
  clusters: readonly Launch1000Cluster[];
  selectedClusterId?: string | null;
  readOnly?: boolean;
  onApproveMapping?: (cluster: Launch1000Cluster) => void;
  onChooseDifferent?: (cluster: Launch1000Cluster) => void;
  onHoldCluster?: (cluster: Launch1000Cluster) => void;
}

const outcomeLabel: Record<Launch1000Cluster["outcome"], string> = {
  SAFE_EXISTING_MAPPING: "Safe existing mapping",
  SAFE_CLUSTER_PROPOSAL: "Cluster proposal",
  ADMIN_CHOICE: "Admin choice",
  NO_MATCH: "No safe match",
  POLICY_HOLD: "Policy hold",
};

/**
 * Local/admin-facing presentation contract for the Launch-1000 workbench.
 * This component deliberately owns no Firestore client and performs no
 * mutation; future handlers must call a bounded, server-authoritative apply
 * path after explicit approval.
 */
export function Launch1000TaxonomyWorkbench({
  clusters,
  selectedClusterId,
  readOnly = true,
  onApproveMapping,
  onChooseDifferent,
  onHoldCluster,
}: Launch1000TaxonomyWorkbenchProps) {
  return (
    <section className="space-y-4" aria-label="Launch-1000 taxonomy workbench">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Launch-1000 taxonomy workbench</h2>
          <p className="text-sm text-slate-600">Review deterministic cluster proposals before any bounded apply.</p>
        </div>
        <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800">
          {readOnly ? "Dry run" : "Approval required"}
        </span>
      </div>
      <div className="grid gap-3">
        {clusters.map((cluster) => {
          const selected = cluster.clusterId === selectedClusterId;
          const canApprove = !readOnly && cluster.outcome === "SAFE_CLUSTER_PROPOSAL" && cluster.expectedReadyUnlockCount > 0;
          return (
            <article key={cluster.clusterId} className={`rounded-xl border p-4 ${selected ? "border-indigo-400 bg-indigo-50/40" : "border-slate-200 bg-white"}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    {cluster.outcome === "POLICY_HOLD" ? <ShieldAlert className="h-4 w-4 text-rose-600" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 text-indigo-600" aria-hidden="true" />}
                    <h3 className="font-medium text-slate-900">{cluster.normalizedProductType}</h3>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">{outcomeLabel[cluster.outcome]} · {cluster.candidateCount} candidates · {cluster.expectedReadyUnlockCount} clean unlocks</p>
                </div>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-700">{cluster.confidence} confidence</span>
              </div>
              <p className="mt-3 text-sm text-slate-700">
                Proposed taxonomy: {cluster.proposedCategoryId || "unresolved"}{cluster.proposedSubcategoryId ? ` > ${cluster.proposedSubcategoryId}` : ""}
              </p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
                {cluster.representativeProducts.map((product) => <span key={product.sku} className="rounded bg-slate-100 px-2 py-1">{product.sku}: {product.title}</span>)}
              </div>
              {cluster.expectedPostTaxonomyBlockers.length > 0 && (
                <p className="mt-3 text-xs text-slate-500">Post-taxonomy blockers: {cluster.expectedPostTaxonomyBlockers.slice(0, 4).map((item) => `${item.blocker} (${item.count})`).join(", ")}</p>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" disabled={!canApprove} onClick={() => onApproveMapping?.(cluster)} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300">
                  <Check className="h-3.5 w-3.5" aria-hidden="true" /> Approve mapping
                </button>
                <button type="button" disabled={readOnly} onClick={() => onChooseDifferent?.(cluster)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50">Choose different</button>
                <button type="button" disabled={readOnly} onClick={() => onHoldCluster?.(cluster)} className="inline-flex items-center gap-1 rounded-lg border border-amber-300 px-3 py-2 text-xs font-medium text-amber-800 disabled:cursor-not-allowed disabled:opacity-50">
                  <PauseCircle className="h-3.5 w-3.5" aria-hidden="true" /> Hold cluster
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
