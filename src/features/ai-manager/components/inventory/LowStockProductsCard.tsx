import { ListOrdered } from 'lucide-react';
import type { InventoryProductStatus } from '../../types/inventory';

interface LowStockProductsCardProps { readonly products: readonly InventoryProductStatus[] }

export function LowStockProductsCard({ products }: LowStockProductsCardProps) {
  return (
    <article className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5" aria-labelledby="low-stock-products-title">
      <div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400"><ListOrdered className="h-5 w-5" aria-hidden="true" /></div><div><h3 id="low-stock-products-title" className="text-base font-black text-white">Low-stock products</h3><p className="text-[11px] text-slate-500">Lowest quantity first · active products only</p></div></div>
      {products.length === 0 ? <p className="mt-5 rounded-xl border border-dashed border-slate-700 p-4 text-xs text-slate-500">No active products have stock between 1 and 5 units.</p> : <ol className="mt-5 space-y-2">{products.map((product) => <li key={product.id} className="flex items-center justify-between gap-4 rounded-xl border border-slate-800 px-3.5 py-3"><span className="min-w-0 truncate text-xs font-bold text-slate-300">{product.name}</span><span className="shrink-0 text-xs font-black text-amber-300">{product.stock.toLocaleString()} units</span></li>)}</ol>}
    </article>
  );
}
