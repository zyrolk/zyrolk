import { ArrowLeft, SearchX, ShoppingBag } from 'lucide-react';

interface StorefrontNotFoundProps {
  onGoHome: () => void;
  onBrowseProducts: () => void;
}

export default function StorefrontNotFound({ onGoHome, onBrowseProducts }: StorefrontNotFoundProps) {
  return (
    <section className="zy-storefront-not-found" aria-labelledby="storefront-not-found-title">
      <div className="zy-storefront-not-found__code" aria-hidden="true">404</div>
      <span className="zy-storefront-not-found__icon" aria-hidden="true"><SearchX className="h-7 w-7" /></span>
      <span className="zy-section-eyebrow">Page not found</span>
      <h1 id="storefront-not-found-title">This marketplace aisle does not exist.</h1>
      <p>The page may have moved, but the live Zyro.lk catalogue is ready when you are.</p>
      <div className="zy-storefront-not-found__actions">
        <button type="button" onClick={onGoHome} className="zy-button zy-button-outline">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to homepage
        </button>
        <button type="button" onClick={onBrowseProducts} className="zy-button zy-button-primary">
          <ShoppingBag className="h-4 w-4" aria-hidden="true" />
          Browse products
        </button>
      </div>
    </section>
  );
}
