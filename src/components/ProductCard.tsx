import React, { useEffect, useRef, useState } from 'react';
import { Check, Eye, Star, ShoppingCart, Heart, Phone } from 'lucide-react';
import { Product } from '../types';
import { PRODUCT_IMAGE_FALLBACK } from '../features/product-experience/productExperience';

interface ProductCardProps {
  key?: string | number;
  product: Product;
  isWishlisted: boolean;
  onAddToCart: (product: Product) => void;
  onToggleWishlist: (product: Product) => void;
  onViewDetail: (product: Product) => void;
  showWishlist?: boolean;
  settings?: any; // Allow WebsiteSettings to be passed
}

function ProductCard({
  product,
  isWishlisted,
  onAddToCart,
  onToggleWishlist,
  onViewDetail,
  showWishlist = true,
  settings
}: ProductCardProps) {
  const [isAdded, setIsAdded] = useState(false);
  const [isImageLoaded, setIsImageLoaded] = useState(false);
  const addedTimerRef = useRef<number | null>(null);
  const stockLabel = product.stock <= 0
    ? 'Out of stock'
    : product.stock <= 5
      ? `Only ${product.stock} left`
      : 'In stock';

  useEffect(() => () => {
    if (addedTimerRef.current !== null) window.clearTimeout(addedTimerRef.current);
  }, []);

  useEffect(() => {
    setIsImageLoaded(false);
  }, [product.id, product.imageUrl]);

  const handleCardAddToCart = (event: React.MouseEvent) => {
    event.stopPropagation();
    onAddToCart(product);
    setIsAdded(true);
    if (addedTimerRef.current !== null) window.clearTimeout(addedTimerRef.current);
    addedTimerRef.current = window.setTimeout(() => setIsAdded(false), 1600);
  };

  // Format price in Sri Lankan Rupees (LKR)
  const formatPrice = (amount: number) => {
    return new Intl.NumberFormat('en-LK', {
      style: 'currency',
      currency: 'LKR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(amount);
  };

  const handleWhatsAppQuickBuy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const skuText = product.sku ? `\nSKU: *${product.sku}*` : "";
    const message = encodeURIComponent(
      `Hello Zyro.lk, I am interested in ordering:\n` +
      `- *${product.name}* (Qty: 1)${skuText}\n` +
      `Price: *${formatPrice(product.price)}*\n` +
      `Category: ${product.category}\n\n` +
      `Please confirm availability and guide me through delivery details.`
    );
    const waNumber = settings?.whatsappNumber 
      ? settings.whatsappNumber.replace(/[^0-9]/g, "") 
      : "";
    if (!waNumber) {
      alert("WhatsApp checkout is currently being configured by the store administrator. Please try again soon or contact support!");
      return;
    }
    // TODO: Add noopener/noreferrer when WhatsApp window-opening behavior is addressed in a dedicated security change.
    window.open(`https://wa.me/${waNumber}?text=${message}`, '_blank');
  };

  const handleWhatsAppEnquiry = (e: React.MouseEvent) => {
    e.stopPropagation();
    const skuText = product.sku ? `\nSKU: *${product.sku}*` : "";
    const message = encodeURIComponent(
      `Hello Zyro.lk, I am interested in this product but it is currently out of stock:\n` +
      `- *${product.name}*${skuText}\n` +
      `Price: *${formatPrice(product.price)}*\n\n` +
      `Can you please let me know when this will be back in stock or if there is an alternative available?`
    );
    const waNumber = settings?.whatsappNumber 
      ? settings.whatsappNumber.replace(/[^0-9]/g, "") 
      : "";
    if (!waNumber) {
      alert("WhatsApp support is currently being configured by the store administrator. Please try again soon!");
      return;
    }
    window.open(`https://wa.me/${waNumber}?text=${message}`, '_blank');
  };

  return (
    <article
      className={`zy-product-card group ${isAdded ? 'is-added' : ''} ${isWishlisted ? 'is-wishlisted' : ''}`}
      data-zy-reveal
      aria-label={product.name}
    >
      {/* Badges Overlay */}
      <div className="zy-product-card-badges" aria-label="Product highlights">
        {product.discount && product.discount > 0 ? (
          <span className="zy-badge zy-badge-accent zy-product-discount">
            Save {product.discount}%
          </span>
        ) : null}
        {product.isNew ? (
          <span className="zy-badge zy-badge-primary zy-product-card-badge-new">
            NEW
          </span>
        ) : null}
        {product.isBestSeller ? (
          <span className="zy-badge zy-product-card-badge-bestseller">
            BESTSELLER
          </span>
        ) : null}
      </div>

      {/* Wishlist Button Overlay */}
      {showWishlist && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleWishlist(product);
          }}
          className="zy-wishlist-button zy-product-card-wishlist"
          title={isWishlisted ? "Remove from Wishlist" : "Add to Wishlist"}
          aria-label={isWishlisted ? `Remove ${product.name} from wishlist` : `Add ${product.name} to wishlist`}
          aria-pressed={isWishlisted}
        >
          <Heart className={`h-5 w-5 transition-all duration-200 ${isWishlisted ? 'scale-110 fill-red-500 text-red-500' : ''}`} aria-hidden="true" />
        </button>
      )}

      {/* Product Image Stage */}
      <div className="zy-product-image-stage">
        <button
          type="button"
          onClick={() => onViewDetail(product)}
          className="zy-product-image-link"
          aria-label={`View ${product.name}`}
        >
          <span className="sr-only">View product details</span>
        </button>
        <img
          src={product.imageUrl || PRODUCT_IMAGE_FALLBACK}
          alt={product.name}
          referrerPolicy="no-referrer"
          loading="lazy"
          fetchPriority="low"
          decoding="async"
          width="600"
          height="600"
          className={`zy-product-card-image ${isImageLoaded ? 'is-loaded' : 'is-loading'}`}
          onLoad={() => setIsImageLoaded(true)}
          onError={(e) => {
            e.currentTarget.onerror = null;
            e.currentTarget.src = PRODUCT_IMAGE_FALLBACK;
            setIsImageLoaded(true);
          }}
        />
        {/* Out of Stock overlay */}
        {product.stock <= 0 && (
          <div className="zy-product-card-unavailable" aria-hidden="true">
            <span>
              Out of Stock
            </span>
          </div>
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onViewDetail(product);
          }}
          className="zy-product-quick-view"
          aria-label={`Quick view ${product.name}`}
        >
          <Eye className="h-4 w-4" aria-hidden="true" />
          Quick View
        </button>
      </div>

      {/* Content & Details */}
      <div className="zy-product-card-content">
        <div className="zy-product-card-info">
          {/* Category Label */}
          <span className="zy-product-card-category">
            {product.category.replace('-', ' ')}
          </span>

          {/* Product Name */}
          <h3 className="zy-product-card-title">
            <button
              type="button"
              onClick={() => onViewDetail(product)}
              title={product.name}
            >
              {product.name}
            </button>
          </h3>

          {/* Rating Stars */}
          <div className="zy-product-card-rating" aria-label={product.reviewsCount > 0 ? `${product.rating} out of 5 stars from ${product.reviewsCount} reviews` : 'No ratings yet'}>
            {product.reviewsCount > 0 ? (
              <>
                <span className="zy-product-card-rating-value">{product.rating.toFixed(1)}</span>
                <div className="zy-product-card-stars" aria-hidden="true">
                  {[...Array(5)].map((_, i) => (
                    <Star
                      key={i}
                      className={i < Math.round(product.rating) ? 'is-filled' : ''}
                    />
                  ))}
                </div>
                <span className="zy-product-card-review-count">({product.reviewsCount})</span>
              </>
            ) : (
              <span className="zy-product-card-review-count">⭐ No ratings yet</span>
            )}
          </div>
        </div>

        {/* Pricing & Stock Grid */}
        <div className="zy-product-card-commerce">
          <div className="zy-product-card-price-block">
            <span className="zy-price zy-product-card-price">
              {formatPrice(product.price)}
            </span>
            {product.originalPrice && product.originalPrice > product.price && (
              <span className="zy-product-card-original-price">
                {formatPrice(product.originalPrice)}
              </span>
            )}
          </div>
          <span className={`zy-stock-badge zy-product-card-stock ${product.stock <= 0 ? 'is-out' : product.stock <= 5 ? 'is-low' : 'is-available'}`}>
            <span aria-hidden="true" />
            {stockLabel}
          </span>
        </div>

        {/* Actions button group */}
        <div className="zy-product-card-actions">
          {product.stock > 0 ? (
            <div className="zy-product-card-action-grid">
              {/* Add to Cart */}
              <button
                onClick={handleCardAddToCart}
                className={`zy-button zy-button-primary zy-product-primary-action ${isAdded ? 'zy-product-action-success' : ''}`}
                aria-label={`Add ${product.name} to cart`}
                aria-live="polite"
              >
                {isAdded ? <Check className="h-4 w-4" aria-hidden="true" /> : <ShoppingCart className="h-4 w-4" aria-hidden="true" />}
                <span>{isAdded ? 'Added' : 'Add to Cart'}</span>
              </button>

              {/* Quick WhatsApp Order */}
              <button
                onClick={handleWhatsAppQuickBuy}
                className="zy-button zy-product-secondary-action"
                title="Buy Now via WhatsApp"
                aria-label={`Order ${product.name} through WhatsApp`}
              >
                <Phone className="h-4 w-4" aria-hidden="true" />
                <span>Buy Now</span>
              </button>
            </div>
          ) : (
            /* WhatsApp Enquiry Button (out of stock) */
            <button
              onClick={handleWhatsAppEnquiry}
              className="zy-button zy-button-outline zy-product-enquiry-action"
              aria-label={`Ask about availability for ${product.name} on WhatsApp`}
            >
              <Phone className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Enquire on WhatsApp</span>
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

export default React.memo(ProductCard);
