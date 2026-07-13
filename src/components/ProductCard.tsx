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
    <div 
      onClick={() => onViewDetail(product)}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onViewDetail(product);
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`View details for ${product.name}`}
      className="zy-card zy-card-hover group relative overflow-hidden flex flex-col h-full cursor-pointer border-slate-200/80 bg-white"
    >
      {/* Badges Overlay */}
      <div className="absolute top-3 left-3 z-10 flex flex-col space-y-1">
        {product.discount && product.discount > 0 ? (
          <span className="zy-badge zy-badge-accent shadow-lg shadow-orange-500/15">
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
          className="absolute top-3 right-3 z-20 flex h-11 w-11 items-center justify-center bg-white/95 hover:bg-white text-slate-500 hover:text-red-500 rounded-full shadow-md hover:shadow-lg backdrop-blur-xs transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
          title={isWishlisted ? "Remove from Wishlist" : "Add to Wishlist"}
          aria-label={isWishlisted ? `Remove ${product.name} from wishlist` : `Add ${product.name} to wishlist`}
          aria-pressed={isWishlisted}
        >
          <Heart className={`h-4.5 w-4.5 transition-colors ${isWishlisted ? 'fill-red-500 text-red-500' : ''}`} />
        </button>
      )}

      {/* Product Image Stage */}
      <div className="relative w-full aspect-square bg-gradient-to-br from-slate-50 via-white to-blue-50/50 flex items-center justify-center overflow-hidden p-5 sm:p-7">
        <img
          src={product.imageUrl || PRODUCT_IMAGE_FALLBACK}
          alt={product.name}
          referrerPolicy="no-referrer"
          loading="lazy"
          decoding="async"
          width="600"
          height="600"
          className="w-full h-full object-contain transform group-hover:scale-[1.06] transition-transform duration-500 ease-out drop-shadow-[0_18px_24px_rgba(15,23,42,0.08)]"
          onError={(e) => {
            e.currentTarget.onerror = null;
            e.currentTarget.src = PRODUCT_IMAGE_FALLBACK;
          }}
        />
        {/* Out of Stock overlay */}
        {product.stock <= 0 && (
          <div className="absolute inset-0 bg-white/65 backdrop-blur-[2px] flex items-center justify-center">
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
          className="absolute inset-x-5 bottom-4 z-10 flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/80 bg-slate-950/90 px-4 py-2.5 text-xs font-black text-white shadow-lg backdrop-blur-md transition-all duration-300 sm:translate-y-3 sm:opacity-0 sm:group-hover:translate-y-0 sm:group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
          aria-label={`Quick view ${product.name}`}
        >
          <Eye className="h-4 w-4" aria-hidden="true" />
          Quick View
        </button>
      </div>

      {/* Content & Details */}
      <div className="p-4 sm:p-5 flex flex-col flex-1">
        {/* Category Label */}
        <span className="text-[10px] text-slate-500 font-black uppercase tracking-widest mb-1.5">
          {product.category.replace('-', ' ')}
        </span>

        {/* Product Name */}
        <h3 className="text-[0.95rem] font-extrabold text-slate-950 line-clamp-2 mb-1.5 group-hover:text-brand-blue transition-colors min-h-[42px] leading-snug font-display">
          {product.name}
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
              <span className="text-[11px] text-slate-500 font-medium">({product.reviewsCount})</span>
            </>
          ) : (
            <span className="text-[11px] text-slate-500 font-medium">New arrival</span>
          )}
        </div>

        {/* Pricing & Stock Grid */}
        <div className="mt-auto pt-3.5 border-t border-slate-100/80 flex items-end justify-between flex-wrap gap-2">
          <div className="flex flex-col">
            <span className="zy-price text-xl leading-none">
              {formatPrice(product.price)}
            </span>
            {product.originalPrice && product.originalPrice > product.price && (
              <span className="text-xs text-slate-500 line-through">
                {formatPrice(product.originalPrice)}
              </span>
            )}
          </div>
          <span className={`inline-flex items-center gap-1.5 text-[10px] font-extrabold px-2.5 py-1.5 rounded-full border ${product.stock <= 0 ? 'bg-red-50 text-red-700 border-red-100' : product.stock <= 5 ? 'bg-amber-50 text-amber-700 border-amber-100' : 'bg-emerald-50 text-emerald-700 border-emerald-100'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${product.stock <= 0 ? 'bg-red-500' : product.stock <= 5 ? 'bg-amber-500' : 'bg-emerald-500'}`} aria-hidden="true" />
            {stockLabel}
          </span>
        </div>

        {/* Actions button group */}
        <div className="mt-4">
          {product.stock > 0 ? (
            <div className="flex gap-2.5">
              {/* Add to Cart */}
              <button
                onClick={handleCardAddToCart}
                className="zy-button zy-button-primary min-h-11 flex-1 py-3 px-3 text-xs cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
                aria-label={`Add ${product.name} to cart`}
                aria-live="polite"
              >
                {isAdded ? <Check className="h-4 w-4" aria-hidden="true" /> : <ShoppingCart className="h-4 w-4" aria-hidden="true" />}
                <span className="ml-1.5">{isAdded ? 'Added' : 'Add to Cart'}</span>
              </button>

              {/* Quick WhatsApp Order */}
              <button
                onClick={handleWhatsAppQuickBuy}
                className="zy-button flex h-11 w-11 flex-none items-center justify-center rounded-xl bg-white hover:bg-emerald-50 text-emerald-700 border border-emerald-200 p-0 cursor-pointer shadow-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-500/20"
                title="Buy Now via WhatsApp"
                aria-label={`Order ${product.name} through WhatsApp`}
              >
                <Phone className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          ) : (
            /* WhatsApp Enquiry Button (out of stock) */
            <button
              onClick={handleWhatsAppEnquiry}
              className="zy-button zy-button-outline w-full min-h-11 py-2.5 px-3 text-xs cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
              aria-label={`Ask about availability for ${product.name} on WhatsApp`}
            >
              <Phone className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Enquire on WhatsApp</span>
            </button>
          )}
        </div>

      </div>
    </div>
  );
}

export default React.memo(ProductCard);
