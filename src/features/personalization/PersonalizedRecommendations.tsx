import { BarChart3, BrainCircuit, ChevronRight, Layers3, Sparkles } from 'lucide-react';
import ProductCard from '../../components/ProductCard';
import { Product, WebsiteSettings } from '../../types';
import { RecommendationSection } from './personalization';

interface PersonalizedRecommendationsProps {
  sections: RecommendationSection[];
  wishlistIds: Set<string>;
  compareIds: Set<string>;
  settings: WebsiteSettings | null;
  onAddToCart: (product: Product) => void;
  onToggleWishlist: (product: Product) => void;
  onViewProduct: (product: Product) => void;
  onToggleCompare: (product: Product) => void;
  onOpenCompare: () => void;
}

export default function PersonalizedRecommendations({
  sections, wishlistIds, compareIds, settings, onAddToCart, onToggleWishlist, onViewProduct,
  onToggleCompare, onOpenCompare,
}: PersonalizedRecommendationsProps) {
  return (
    <section className="zy-personalized" aria-labelledby="personalized-shopping-title">
      <header className="zy-personalized-heading">
        <span><BrainCircuit aria-hidden="true" /></span>
        <div><p className="zy-section-eyebrow">Rule-based discovery</p><h2 id="personalized-shopping-title">Personalized shopping</h2><p>Recommendations use your saved and recently viewed products with live catalogue signals only.</p></div>
      </header>

      <div className="zy-personalized-sections">
        {sections.map(section => (
          <section key={section.id} className="zy-personalized-shelf" aria-labelledby={`recommendation-${section.id}`}>
            <header><div><span>{section.id === 'trending' ? <BarChart3 /> : section.id === 'frequently-bought-together' ? <Layers3 /> : <Sparkles />}</span><div><h3 id={`recommendation-${section.id}`}>{section.title}</h3><p>{section.description}</p></div></div>{section.products.length > 0 && <small>{section.products.length} live picks</small>}</header>
            {section.products.length > 0 ? (
              <div className="zy-personalized-product-rail">
                {section.products.map(product => (
                  <div className="zy-personalized-product" key={product.id}>
                    <ProductCard product={product} isWishlisted={wishlistIds.has(product.id)} onAddToCart={onAddToCart} onToggleWishlist={onToggleWishlist} onViewDetail={onViewProduct} settings={settings} />
                    <button type="button" className={compareIds.has(product.id) ? 'is-active' : ''} onClick={() => onToggleCompare(product)} aria-pressed={compareIds.has(product.id)}><BarChart3 />{compareIds.has(product.id) ? 'Added to compare' : 'Add to compare'}</button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="zy-personalized-foundation"><Layers3 /><div><strong>{section.foundation ? 'Foundation ready — no aggregate purchase signal yet' : 'More signals needed'}</strong><p>{section.description}</p></div>{section.foundation && <button type="button" onClick={onOpenCompare}>Compare products instead <ChevronRight /></button>}</div>
            )}
          </section>
        ))}
      </div>
    </section>
  );
}
