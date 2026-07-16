import { ArrowRight, Grid3X3, Layers3 } from 'lucide-react';
import { Category, Product, WebsiteSettings } from '../types';
import HeroBanner from './HeroBanner';
import StorefrontProductShelf from './StorefrontProductShelf';

export interface HomepageCategoryVisual {
  category: Category;
  image: string;
  itemsCount: number;
}

interface MarketplaceHomePhase1Props {
  settings?: WebsiteSettings | null;
  products: Product[];
  categories: Category[];
  categoryVisuals: HomepageCategoryVisual[];
  discountedProducts: Product[];
  featuredProducts: Product[];
  newArrivalProducts: Product[];
  bestSellerProducts: Product[];
  recommendedProducts: Product[];
  wishlistProductIds: ReadonlySet<string>;
  loading: boolean;
  onExploreProducts: () => void;
  onBrowseCategories: () => void;
  onSelectCategory: (categoryId: string) => void;
  onAddToCart: (product: Product) => void;
  onToggleWishlist: (product: Product) => void;
  onViewDetail: (product: Product) => void;
}

const PLACEHOLDER_TILES = Array.from({ length: 7 }, (_, index) => index);

export default function MarketplaceHomePhase1({
  settings,
  products,
  categories,
  categoryVisuals,
  discountedProducts,
  featuredProducts,
  newArrivalProducts,
  bestSellerProducts,
  recommendedProducts,
  wishlistProductIds,
  loading,
  onExploreProducts,
  onBrowseCategories,
  onSelectCategory,
  onAddToCart,
  onToggleWishlist,
  onViewDetail,
}: MarketplaceHomePhase1Props) {
  const hasCategories = categoryVisuals.length > 0;

  return (
    <main className="zy-foundation-home animate-fadeIn">
      <div className="zy-foundation-hero-wrap">
        <HeroBanner
          settings={settings}
          products={products}
          categories={categories}
          onExploreProducts={onExploreProducts}
          onBrowseCategories={onBrowseCategories}
        />
      </div>

      <section className="zy-foundation-category-dock" aria-labelledby="phase-one-categories-title">
        <header className="zy-foundation-dock-header">
          <div>
            <span className="zy-foundation-eyebrow">Quick shopping</span>
            <h2 id="phase-one-categories-title">Explore categories</h2>
          </div>
          <button type="button" onClick={onBrowseCategories} className="zy-foundation-text-link">
            View all
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        {loading ? (
          <div className="zy-foundation-category-rail" aria-label="Loading categories" aria-busy="true">
            {PLACEHOLDER_TILES.map(index => <div key={index} className="zy-foundation-category-skeleton" aria-hidden="true"><span /><i /><small /></div>)}
          </div>
        ) : hasCategories ? (
          <div className="zy-foundation-category-rail" role="list">
            {categoryVisuals.map(({ category, image, itemsCount }) => (
              <button
                key={category.id}
                type="button"
                onClick={() => onSelectCategory(category.id)}
                className="zy-foundation-category-tile"
                aria-label={`Browse ${category.name}, ${itemsCount} ${itemsCount === 1 ? 'product' : 'products'}`}
                role="listitem"
              >
                <span className="zy-foundation-category-image"><img src={image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /></span>
                <strong>{category.name}</strong>
                <small>{itemsCount} {itemsCount === 1 ? 'product' : 'products'}</small>
              </button>
            ))}
            <button type="button" onClick={onBrowseCategories} className="zy-foundation-category-tile zy-foundation-category-all" role="listitem">
              <span className="zy-foundation-category-image"><Grid3X3 className="h-6 w-6" aria-hidden="true" /></span>
              <strong>All categories</strong>
              <small>Browse collections</small>
            </button>
          </div>
        ) : (
          <div className="zy-foundation-category-empty">
            <div className="zy-foundation-category-rail" aria-hidden="true">
              {PLACEHOLDER_TILES.map(index => <div key={index} className="zy-foundation-category-skeleton is-empty"><span /><i /><small /></div>)}
            </div>
            <div className="zy-foundation-empty-note" role="status">
              <span><Layers3 className="h-5 w-5" aria-hidden="true" /></span>
              <div><strong>Collections are ready for your catalog</strong><p>Active categories with published products will appear here automatically.</p></div>
            </div>
          </div>
        )}
      </section>

      <div className="zy-foundation-container zy-foundation-shelf-stack">
        <StorefrontProductShelf
          id="homepage-flash-deals"
          title="Flash Deals"
          subtitle="Genuine savings from products with a verified regular price and lower selling price."
          products={discountedProducts}
          loading={loading}
          emptyState={{
            title: 'No live deals right now',
            description: 'Products with a genuine active discount will appear here automatically.',
          }}
          viewAllAction={{ label: 'View all', onClick: onExploreProducts, ariaLabel: 'View all products' }}
          wishlistProductIds={wishlistProductIds}
          onAddToCart={onAddToCart}
          onToggleWishlist={onToggleWishlist}
          onViewDetail={onViewDetail}
          settings={settings}
        />

        <StorefrontProductShelf
          id="homepage-featured-products"
          title="Featured Products"
          subtitle="Storefront highlights selected from the currently published marketplace catalog."
          products={featuredProducts}
          loading={loading}
          emptyState={{
            title: 'No featured products right now',
            description: 'Published products selected as featured will appear here automatically.',
          }}
          viewAllAction={{ label: 'View all', onClick: onExploreProducts, ariaLabel: 'View all products' }}
          wishlistProductIds={wishlistProductIds}
          onAddToCart={onAddToCart}
          onToggleWishlist={onToggleWishlist}
          onViewDetail={onViewDetail}
          settings={settings}
        />

        <StorefrontProductShelf
          id="homepage-new-arrivals"
          title="New Arrivals"
          subtitle="Fresh additions available now from the live Zyro.lk catalog."
          products={newArrivalProducts}
          loading={loading}
          emptyState={{
            title: 'No new arrivals right now',
            description: 'Published products marked as new will appear here automatically.',
          }}
          viewAllAction={{ label: 'View all', onClick: onExploreProducts, ariaLabel: 'View all products' }}
          wishlistProductIds={wishlistProductIds}
          onAddToCart={onAddToCart}
          onToggleWishlist={onToggleWishlist}
          onViewDetail={onViewDetail}
          settings={settings}
        />

        <StorefrontProductShelf
          id="homepage-best-sellers"
          title="Best Sellers"
          subtitle="Popular marketplace picks identified from the live product catalog."
          products={bestSellerProducts}
          loading={loading}
          emptyState={{
            title: 'No best sellers right now',
            description: 'Published products marked as best sellers will appear here automatically.',
          }}
          viewAllAction={{ label: 'View all', onClick: onExploreProducts, ariaLabel: 'View all products' }}
          wishlistProductIds={wishlistProductIds}
          onAddToCart={onAddToCart}
          onToggleWishlist={onToggleWishlist}
          onViewDetail={onViewDetail}
          settings={settings}
        />

        <StorefrontProductShelf
          id="homepage-recommended-products"
          title="Recommended Products"
          subtitle="A convenient starting point selected from products currently available in the marketplace."
          products={recommendedProducts}
          loading={loading}
          emptyState={{
            title: 'Recommendations are being refreshed',
            description: 'Available published products will appear here as the live catalog is updated.',
          }}
          viewAllAction={{ label: 'View all', onClick: onExploreProducts, ariaLabel: 'View all products' }}
          wishlistProductIds={wishlistProductIds}
          onAddToCart={onAddToCart}
          onToggleWishlist={onToggleWishlist}
          onViewDetail={onViewDetail}
          settings={settings}
        />
      </div>
    </main>
  );
}
