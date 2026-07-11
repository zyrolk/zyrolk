import { BadgeDollarSign, PackageOpen } from 'lucide-react';
import type { ProductRanking, ProductSalesPerformance } from '../../types/sales';

interface BestSellingProductsCardProps {
  readonly revenueRanking: ProductRanking;
  readonly quantityRanking: ProductRanking;
}

const formatCurrency = (value: number) => `LKR ${Math.round(value).toLocaleString()}`;

function RankingList({
  title,
  items,
  value,
}: {
  readonly title: string;
  readonly items: readonly ProductSalesPerformance[];
  readonly value: (item: ProductSalesPerformance) => string;
}) {
  return (
    <div>
      <h3 className="text-[10px] font-black uppercase tracking-wider text-slate-500">{title}</h3>
      <ol className="mt-2 space-y-2">
        {items.slice(0, 3).map((item, index) => (
          <li key={item.productId} className="flex items-center justify-between gap-3 rounded-xl bg-slate-950/45 px-3 py-2.5 text-xs">
            <span className="min-w-0 truncate text-slate-300"><span className="mr-2 text-slate-600">{index + 1}</span>{item.productName}</span>
            <span className="shrink-0 font-mono text-[10px] font-bold text-slate-400">{value(item)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function BestSellingProductsCard({ revenueRanking, quantityRanking }: BestSellingProductsCardProps) {
  if (revenueRanking.highest.length === 0) {
    return (
      <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5" aria-labelledby="product-sales-ranking-title">
        <h2 id="product-sales-ranking-title" className="text-base font-black text-white">Product sales rankings</h2>
        <p className="mt-3 text-xs leading-relaxed text-slate-500">No non-cancelled order items are available for product rankings.</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5" aria-labelledby="product-sales-ranking-title">
      <h2 id="product-sales-ranking-title" className="text-base font-black text-white">Product sales rankings</h2>
      <p className="mt-1 text-[11px] text-slate-500">Revenue and quantity are ranked independently using observed sales only.</p>
      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="space-y-5 rounded-2xl border border-emerald-500/10 bg-emerald-500/[0.03] p-4">
          <div className="flex items-center gap-2 text-emerald-400"><BadgeDollarSign className="h-4 w-4" aria-hidden="true" /><span className="text-xs font-black">Revenue ranking</span></div>
          <RankingList title="Highest revenue" items={revenueRanking.highest} value={(item) => formatCurrency(item.revenue)} />
          <RankingList title="Lowest observed revenue" items={revenueRanking.lowest} value={(item) => formatCurrency(item.revenue)} />
        </div>
        <div className="space-y-5 rounded-2xl border border-blue-500/10 bg-blue-500/[0.03] p-4">
          <div className="flex items-center gap-2 text-blue-400"><PackageOpen className="h-4 w-4" aria-hidden="true" /><span className="text-xs font-black">Quantity ranking</span></div>
          <RankingList title="Highest quantity" items={quantityRanking.highest} value={(item) => `${item.quantity} units`} />
          <RankingList title="Lowest observed quantity" items={quantityRanking.lowest} value={(item) => `${item.quantity} units`} />
        </div>
      </div>
    </section>
  );
}
