import { RefObject } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, Star } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { Product } from '../../types';
import { PRODUCT_IMAGE_FALLBACK } from './productExperience';

interface Props {
  products: readonly Product[];
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: (direction: 'left' | 'right') => void;
  onSelect: (product: Product) => void;
  formatPrice: (amount: number) => string;
}

export default function RelatedProductsRail({ products, scrollRef, onScroll, onSelect, formatPrice }: Props) {
  const shouldReduceMotion = useReducedMotion();
  if (products.length === 0) return null;
  return (
    <section className="zy-related-products space-y-6 border-t border-slate-100 pt-14 text-left" aria-labelledby="related-products-title">
      <div className="zy-related-products-header flex items-end justify-between gap-4">
        <div>
          <span className="zy-related-products-eyebrow">More from the live catalogue</span>
          <h3 id="related-products-title" className="text-xl font-black text-slate-900 font-display">You may also like</h3>
          <p className="mt-1 text-xs text-slate-500">Ranked using the existing category, brand, price and rating signals.</p>
        </div>
        {products.length > 4 && <div className="zy-related-products-controls flex space-x-2">
          <button type="button" onClick={() => onScroll('left')} className="rounded-full border border-slate-200 bg-slate-100 p-3 text-slate-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20" aria-label="Scroll related products left"><ChevronLeft className="h-4.5 w-4.5" aria-hidden="true" /></button>
          <button type="button" onClick={() => onScroll('right')} className="rounded-full border border-slate-200 bg-slate-100 p-3 text-slate-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20" aria-label="Scroll related products right"><ChevronRight className="h-4.5 w-4.5" aria-hidden="true" /></button>
        </div>}
      </div>
      <div ref={scrollRef} className="zy-related-products-rail flex snap-x snap-mandatory gap-4 overflow-x-auto py-3 scrollbar-none" aria-label="Related products">
        {products.map((item) => <motion.button
          type="button" key={item.id} whileHover={shouldReduceMotion ? undefined : { y: -4 }} whileTap={shouldReduceMotion ? undefined : { scale: 0.98 }} onClick={() => onSelect(item)}
          className="zy-related-product-card group flex h-full w-[185px] flex-shrink-0 snap-start flex-col rounded-2xl border border-slate-200 bg-white p-4 text-left transition-all hover:border-brand-blue/25 hover:shadow-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20 sm:w-[230px]"
          aria-label={`View related product ${item.name}`}
        >
          <div className="zy-related-product-image relative mb-4 flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl bg-slate-50 p-3">
            <img src={item.imageUrl || PRODUCT_IMAGE_FALLBACK} alt={item.name} loading="lazy" decoding="async" onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = PRODUCT_IMAGE_FALLBACK; }} className="max-h-full max-w-full object-contain transition-transform duration-500 group-hover:scale-105" referrerPolicy="no-referrer" />
            {Boolean(item.discount && item.discount > 0) && <span className="absolute left-2.5 top-2.5 rounded-lg bg-brand-blue px-2.5 py-1 text-[9px] font-black text-white">-{item.discount}%</span>}
            <span className={`zy-related-product-stock ${item.stock > 0 ? 'is-available' : 'is-unavailable'}`}>{item.stock > 0 ? 'In stock' : 'Out of stock'}</span>
          </div>
          <div className="zy-related-product-meta">
            <span>{item.category}</span>
            {item.reviewsCount > 0 && <span aria-label={`${item.rating} out of 5 stars`}><Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-hidden="true" />{item.rating.toFixed(1)}</span>}
          </div>
          <span className="zy-related-product-name line-clamp-2 min-h-10 text-sm font-bold text-slate-800">{item.name}</span>
          <span className="zy-related-product-price mt-3 flex items-end justify-between text-sm font-black text-slate-900">
            <span>
              {formatPrice(item.price)}
              {item.originalPrice && item.originalPrice > item.price && <small>{formatPrice(item.originalPrice)}</small>}
            </span>
            <ArrowRight className="h-3.5 w-3.5 text-brand-blue" aria-hidden="true" />
          </span>
        </motion.button>)}
      </div>
    </section>
  );
}
