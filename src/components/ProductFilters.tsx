import React from 'react';
import { Check, Filter, RotateCcw } from 'lucide-react';
import { Category } from '../types';

interface ProductFiltersProps {
  categories: Category[];
  categoryCounts: Record<string, number>;
  activeProductCount: number;
  selectedCategory: string;
  onSelectCategory: (categoryId: string) => void;
  priceRange: number;
  onPriceRangeChange: (value: number) => void;
  sortBy: string;
  onSortChange: (value: string) => void;
  activeFilterCount: number;
  onClearAll: () => void;
  formatPrice: (value: number) => string;
  idPrefix: string;
}

function ProductFilters({
  categories,
  categoryCounts,
  activeProductCount,
  selectedCategory,
  onSelectCategory,
  priceRange,
  onPriceRangeChange,
  sortBy,
  onSortChange,
  activeFilterCount,
  onClearAll,
  formatPrice,
  idPrefix
}: ProductFiltersProps) {
  const priceInputId = `${idPrefix}-price-range`;
  const sortInputId = `${idPrefix}-sort-products`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b border-slate-100 pb-4">
        <h3 className="flex items-center text-sm font-black font-display text-slate-950">
          <Filter className="mr-2 h-4 w-4 text-brand-blue" aria-hidden="true" />
          Filters
          {activeFilterCount > 0 && (
            <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-blue px-1.5 text-[10px] font-black text-white">
              {activeFilterCount}
            </span>
          )}
        </h3>
        <button
          type="button"
          onClick={onClearAll}
          disabled={activeFilterCount === 0}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-2.5 text-[10px] font-black uppercase tracking-wide text-brand-blue transition-colors hover:bg-blue-50 disabled:cursor-not-allowed disabled:text-slate-300 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Clear All
        </button>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-[11px] font-black uppercase tracking-widest text-slate-500">Categories</legend>
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => onSelectCategory('all')}
            aria-pressed={selectedCategory === 'all'}
            className={`flex min-h-11 w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-xs font-bold transition-all focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20 ${
              selectedCategory === 'all'
                ? 'bg-blue-50 text-brand-blue ring-1 ring-blue-100'
                : 'text-slate-700 hover:bg-slate-50'
            }`}
          >
            <span className="flex items-center gap-2">
              <span className={`flex h-5 w-5 items-center justify-center rounded-full border ${selectedCategory === 'all' ? 'border-brand-blue bg-brand-blue text-white' : 'border-slate-300 bg-white'}`}>
                {selectedCategory === 'all' && <Check className="h-3 w-3" aria-hidden="true" />}
              </span>
              All Categories
            </span>
            <span className="rounded-full bg-white px-2 py-1 text-[10px] text-slate-500 shadow-sm">{activeProductCount}</span>
          </button>

          {categories.map((category) => {
            const isSelected = selectedCategory === category.id;
            return (
              <button
                key={category.id}
                type="button"
                onClick={() => onSelectCategory(category.id)}
                aria-pressed={isSelected}
                className={`flex min-h-11 w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-xs font-bold transition-all focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20 ${
                  isSelected
                    ? 'bg-blue-50 text-brand-blue ring-1 ring-blue-100'
                    : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className={`flex h-5 w-5 flex-none items-center justify-center rounded-full border ${isSelected ? 'border-brand-blue bg-brand-blue text-white' : 'border-slate-300 bg-white'}`}>
                    {isSelected && <Check className="h-3 w-3" aria-hidden="true" />}
                  </span>
                  <span className="truncate">{category.name}</span>
                </span>
                <span className="ml-2 rounded-full bg-white px-2 py-1 text-[10px] text-slate-500 shadow-sm">{categoryCounts[category.id] || 0}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="space-y-3.5 border-t border-slate-100 pt-5">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={priceInputId} className="text-[11px] font-black uppercase tracking-widest text-slate-500">Max Price</label>
          <span className="rounded-lg bg-slate-950 px-2.5 py-1.5 text-[10px] font-black text-white">{formatPrice(priceRange)}</span>
        </div>
        <input
          id={priceInputId}
          type="range"
          min="5000"
          max="1000000"
          step="5000"
          value={priceRange}
          onChange={(event) => onPriceRangeChange(Number(event.target.value))}
          className="h-2 w-full cursor-pointer rounded-lg bg-slate-100 accent-brand-blue focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
        />
        <div className="flex justify-between text-[10px] font-medium text-slate-500">
          <span>LKR 5K</span>
          <span>LKR 1M</span>
        </div>
      </div>

      <div className="space-y-2.5 border-t border-slate-100 pt-5">
        <label htmlFor={sortInputId} className="text-[11px] font-black uppercase tracking-widest text-slate-500">Sort Products</label>
        <select
          id={sortInputId}
          value={sortBy}
          onChange={(event) => onSortChange(event.target.value)}
          className="min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold text-slate-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
        >
          <option value="featured">Featured First</option>
          <option value="price-asc">Price: Low to High</option>
          <option value="price-desc">Price: High to Low</option>
          <option value="rating">Customer Rating</option>
        </select>
      </div>
    </div>
  );
}

export default React.memo(ProductFilters);
