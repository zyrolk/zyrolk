import { ArrowRight } from 'lucide-react';
import type { Product } from '../types';

interface HomepageDealStripProps {
  products: Product[];
  hasLiveDeals: boolean;
  title: string;
  subtitle: string;
  onExploreProducts: () => void;
}

export default function HomepageDealStrip({
  products,
  hasLiveDeals,
  title,
  subtitle,
  onExploreProducts,
}: HomepageDealStripProps) {
  const visuals = products.slice(0, 3).filter(product => product.imageUrl);

  return (
    <section className="zy-home-deal-strip" data-zy-reveal aria-labelledby="homepage-deal-strip-title">
      <div className="zy-home-deal-strip-copy">
        <span className="zy-home-deal-strip-eyebrow">{hasLiveDeals ? 'Live savings' : 'Featured picks'}</span>
        <h2 id="homepage-deal-strip-title">{title}</h2>
        <p>{subtitle}</p>
        <button type="button" onClick={onExploreProducts} className="zy-home-deal-strip-cta">
          View picks
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {visuals.length > 0 && (
        <div className="zy-home-deal-strip-visuals" aria-hidden="true">
          {visuals.map((product, index) => (
            <span key={product.id} className={`zy-home-deal-strip-visual is-${index + 1}`}>
              <img src={product.imageUrl} alt="" loading="lazy" decoding="async" />
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
