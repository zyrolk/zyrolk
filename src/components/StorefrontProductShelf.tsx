import { ArrowRight, PackageOpen } from 'lucide-react';
import { Product, WebsiteSettings } from '../types';
import ProductCard from './ProductCard';

export interface StorefrontShelfEmptyState {
  title: string;
  description: string;
}

export interface StorefrontShelfAction {
  label: string;
  onClick: () => void;
  ariaLabel?: string;
}

interface StorefrontProductShelfProps {
  id: string;
  eyebrow: string;
  tone: 'deals' | 'featured' | 'new' | 'best-seller' | 'recommended';
  title: string;
  subtitle: string;
  products: Product[];
  loading: boolean;
  emptyState: StorefrontShelfEmptyState;
  viewAllAction?: StorefrontShelfAction;
  wishlistProductIds: ReadonlySet<string>;
  onAddToCart: (product: Product) => void;
  onToggleWishlist: (product: Product) => void;
  onViewDetail: (product: Product) => void;
  settings?: WebsiteSettings | null;
}

const SHELF_SKELETONS = Array.from({ length: 4 }, (_, index) => index);

export default function StorefrontProductShelf({
  id,
  eyebrow,
  tone,
  title,
  subtitle,
  products,
  loading,
  emptyState,
  viewAllAction,
  wishlistProductIds,
  onAddToCart,
  onToggleWishlist,
  onViewDetail,
  settings,
}: StorefrontProductShelfProps) {
  const titleId = `${id}-title`;
  const showWishlist = settings?.enableWishlist !== false;

  return (
    <section className={`zy-storefront-product-shelf is-${tone}`} aria-labelledby={titleId}>
      <header className="zy-storefront-product-shelf-header">
        <div className="zy-storefront-product-shelf-heading">
          <span className="zy-storefront-product-shelf-eyebrow">
            <span aria-hidden="true" />
            {eyebrow}
          </span>
          <h2 id={titleId}>{title}</h2>
          <p>{subtitle}</p>
        </div>
        {viewAllAction ? (
          <button
            type="button"
            onClick={viewAllAction.onClick}
            className="zy-storefront-product-shelf-action"
            aria-label={viewAllAction.ariaLabel || viewAllAction.label}
          >
            {viewAllAction.label}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </header>

      {loading ? (
        <div
          className="zy-storefront-product-shelf-grid"
          aria-label={`Loading ${title}`}
          aria-busy="true"
        >
          {SHELF_SKELETONS.map(index => (
            <div key={index} className="zy-storefront-product-skeleton" aria-hidden="true">
              <span />
              <div><i /><i /><small /><b /></div>
            </div>
          ))}
        </div>
      ) : products.length > 0 ? (
        <div className="zy-storefront-product-shelf-grid" role="list" aria-label={title}>
          {products.map(product => (
            <div key={product.id} className="zy-storefront-product-shelf-item" role="listitem">
              <ProductCard
                product={product}
                isWishlisted={wishlistProductIds.has(product.id)}
                onAddToCart={onAddToCart}
                onToggleWishlist={onToggleWishlist}
                onViewDetail={onViewDetail}
                showWishlist={showWishlist}
                settings={settings}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="zy-storefront-product-shelf-empty" role="status">
          <span aria-hidden="true"><PackageOpen className="h-6 w-6" /></span>
          <div>
            <h3>{emptyState.title}</h3>
            <p>{emptyState.description}</p>
          </div>
        </div>
      )}
    </section>
  );
}
