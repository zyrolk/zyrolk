import { Award, ChevronDown } from 'lucide-react';
import { SpecificationGroup } from './productExperience';

export default function ProductSpecificationsPanel({ groups }: { groups: readonly SpecificationGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <section className="zy-product-specifications space-y-4 text-left" aria-labelledby="product-specifications-title">
      <div className="zy-product-specifications-heading flex items-center space-x-2">
        <span aria-hidden="true"><Award className="h-4.5 w-4.5" /></span>
        <div>
          <span>Technical details</span>
          <h3 id="product-specifications-title">Product specifications</h3>
        </div>
      </div>
      <div className="zy-product-specifications-groups space-y-3">
        {groups.map((group, groupIndex) => (
          <details key={group.title} open={groupIndex === 0} className="group rounded-2xl border border-slate-100 bg-white shadow-xs">
            <summary className="cursor-pointer list-none px-4 py-3 text-xs font-black text-slate-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20">
              <span>{group.title}</span>
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            </summary>
            <dl className="divide-y divide-slate-100 border-t border-slate-100">
              {group.entries.map(({ label, value }) => (
                <div key={label} className="grid grid-cols-1 gap-1 p-4 text-xs sm:grid-cols-3 sm:items-center sm:gap-0">
                  <dt className="font-bold text-slate-600">{label}</dt>
                  <dd className="text-left font-medium text-slate-900 sm:col-span-2 sm:pl-4">{value}</dd>
                </div>
              ))}
            </dl>
          </details>
        ))}
      </div>
    </section>
  );
}
