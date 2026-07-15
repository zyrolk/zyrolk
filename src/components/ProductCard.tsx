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
  const addedTimerRef = useRef<number | null>(null);
  const stockLabel = product.stock <= 0
    ? 'Out of stock'
    : product.stock <= 5
      ? `Only ${product.stock} left`
      : 'In stock';

  useEffect(() => () => {
    if (addedTimerRef.current !== null) window.clearTimeout(addedTimerRef.current);
  }, []);

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
    <article className="zy-product-card group relative flex h-full flex-col overflow-hidden bg-white">
      {/* Badges Overlay */}
      <div className="absolute left-2 top-2 z-10 flex flex-col space-y-1 sm:left-3 sm:top-3">
        {product.discount && product.discount > 0 ? (
          <span className="zy-badge zy-badge-accent zy-product-discount shadow-lg shadow-orange-500/15">
            Save {product.discount}%
          </span>
        ) : null}
        {product.isNew ? (
          <span className="zy-badge zy-badge-primary bg-brand-blue text-white border-brand-blue">
            NEW
          </span>
        ) : null}
        {product.isBestSeller ? (
          <span className="zy-badge bg-amber-500 text-white border-amber-500">
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
          className="zy-wishlist-button absolute right-2 top-2 z-20 flex h-12 w-12 cursor-pointer items-center justify-center rounded-full border border-white/90 bg-white/95 text-slate-500 shadow-md backdrop-blur-sm transition-all hover:bg-white hover:text-red-500 hover:shadow-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25 sm:right-3 sm:top-3"
          title={isWishlisted ? "Remove from Wishlist" : "Add to Wishlist"}
          aria-label={isWishlisted ? `Remove ${product.name} from wishlist` : `Add ${product.name} to wishlist`}
          aria-pressed={isWishlisted}
        >
          <Heart className={`h-4.5 w-4.5 transition-all duration-200 ${isWishlisted ? 'scale-110 fill-red-500 text-red-500' : ''}`} />
        </button>
      )}

      {/* Product Image Stage */}
      <div className="zy-product-image-stage relative m-2 mb-0 flex aspect-square w-[calc(100%-1rem)] items-center justify-center overflow-hidden rounded-[1.15rem] border border-slate-100 bg-gradient-to-br from-slate-50 via-white to-blue-50/80 p-1.5 sm:m-3 sm:mb-0 sm:w-[calc(100%-1.5rem)] sm:rounded-[1.4rem] sm:p-4">
        <button
          type="button"
          onClick={() => onViewDetail(product)}
          className="absolute inset-0 z-[1] cursor-pointer rounded-[1.15rem] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-brand-blue/25 sm:rounded-[1.4rem]"
          aria-label={`View ${product.name}`}
        >
          <span className="sr-only">View product details</span>
        </button>
        <img
          src={product.imageUrl || PRODUCT_IMAGE_FALLBACK}
          alt={product.name}
          referrerPolicy="no-referrer"
          loading="lazy"
          decoding="async"
          width="600"
          height="600"
          className="pointer-events-none w-full h-full object-contain transform group-hover:scale-[1.07] transition-transform duration-500 ease-out drop-shadow-[0_18px_24px_rgba(15,23,42,0.1)]"
          onError={(e) => {
            e.currentTarget.onerror = null;
            e.currentTarget.src = PRODUCT_IMAGE_FALLBACK;
          }}
        />
        {/* Out of Stock overlay */}
        {product.stock <= 0 && (
          <div className="pointer-events-none absolute inset-0 z-[2] bg-white/65 backdrop-blur-[2px] flex items-center justify-center">
            <span className="text-white text-xs font-bold uppercase tracking-wider bg-slate-900 px-4 py-2 rounded-full shadow-lg">
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
          className="absolute inset-x-4 bottom-3 z-10 hidden min-h-12 items-center justify-center gap-2 rounded-xl border border-white/80 bg-brand-blue/95 px-4 py-2.5 text-xs font-black text-white shadow-lg backdrop-blur-md transition-all duration-300 lg:flex lg:translate-y-3 lg:opacity-0 lg:group-hover:translate-y-0 lg:group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
          aria-label={`Quick view ${product.name}`}
        >
          <Eye className="h-4 w-4" aria-hidden="true" />
          Quick View
        </button>
      </div>

      {/* Content & Details */}
      <div className="flex flex-1 flex-col p-3.5 pt-4 sm:p-5 sm:pt-4.5">
        {/* Category Label */}
        <span className="mb-1.5 text-xs font-black uppercase tracking-wide text-slate-500">
          {product.category.replace('-', ' ')}
        </span>

        {/* Product Name */}
        <h3 className="mb-1.5 font-display">
          <button
            type="button"
            onClick={() => onViewDetail(product)}
            className="line-clamp-2 min-h-12 text-left text-[0.95rem] font-extrabold leading-snug text-slate-950 transition-colors hover:text-brand-blue focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
          >
            {product.name}
          </button>
        </h3>

        {/* Rating Stars */}
        <div className="flex items-center space-x-1 mb-3">
          {product.reviewsCount > 0 ? (
            <>
              <div className="flex text-amber-400">
                {[...Array(5)].map((_, i) => (
                  <Star 
                    key={i} 
                    className={`h-3 w-3 ${i < Math.round(product.rating) ? 'fill-amber-400 text-amber-400' : 'text-slate-200'}`} 
                  />
                ))}
              </div>
              <span className="text-xs text-slate-500 font-medium">({product.reviewsCount})</span>
            </>
          ) : (
            <span className="text-xs text-slate-500 font-medium">No reviews yet</span>
          )}
        </div>

        {/* Pricing & Stock Grid */}
        <div className="mt-auto flex flex-col items-start gap-2.5 border-t border-slate-100/80 pt-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex min-h-11 flex-col justify-end">
            <span className="zy-price text-xl leading-none sm:text-2xl">
              {formatPrice(product.price)}
            </span>
            {product.originalPrice && product.originalPrice > product.price && (
              <span className="text-xs text-slate-500 line-through">
                {formatPrice(product.originalPrice)}
              </span>
            )}
          </div>
          <span className={`zy-stock-badge inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-2 text-xs font-extrabold ${product.stock <= 0 ? 'bg-red-50 text-red-700 border-red-100' : product.stock <= 5 ? 'bg-amber-50 text-amber-700 border-amber-100' : 'bg-emerald-50 text-emerald-700 border-emerald-100'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${product.stock <= 0 ? 'bg-red-500' : product.stock <= 5 ? 'bg-amber-500' : 'bg-emerald-500'}`} aria-hidden="true" />
            {stockLabel}
          </span>
        </div>

        {/* Actions button group */}
        <div className="mt-4">
          {product.stock > 0 ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:gap-2.5">
              {/* Add to Cart */}
              <button
                onClick={handleCardAddToCart}
                className={`zy-button zy-button-primary zy-product-primary-action min-h-12 flex-1 cursor-pointer px-3 py-3 text-xs focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25 ${isAdded ? 'zy-product-action-success' : ''}`}
                aria-label={`Add ${product.name} to cart`}
                aria-live="polite"
              >
                {isAdded ? <Check className="h-4 w-4" aria-hidden="true" /> : <ShoppingCart className="h-4 w-4" aria-hidden="true" />}
                <span className="ml-1.5">{isAdded ? 'Added' : 'Add to Cart'}</span>
              </button>

              {/* Quick WhatsApp Order */}
              <button
                onClick={handleWhatsAppQuickBuy}
                className="zy-button zy-product-secondary-action min-h-12 flex-1 rounded-xl border border-emerald-200 bg-white px-2 text-xs text-emerald-700 shadow-sm hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-500/20"
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
              className="zy-button zy-button-outline w-full min-h-12 py-2.5 px-3 text-xs cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
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
