import React from 'react';
import { Star, ShoppingCart, Heart, Phone } from 'lucide-react';
import { Product } from '../types';

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

export default function ProductCard({
  product,
  isWishlisted,
  onAddToCart,
  onToggleWishlist,
  onViewDetail,
  showWishlist = true,
  settings
}: ProductCardProps) {
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
    window.open(`https://wa.me/${waNumber}?text=${message}`, '_blank');
  };

  return (
    <div 
      onClick={() => onViewDetail(product)}
      className="group relative bg-white border border-slate-100 rounded-2xl overflow-hidden shadow-xs hover:shadow-md hover:border-slate-200 transition-all duration-300 flex flex-col h-full cursor-pointer"
    >
      {/* Badges Overlay */}
      <div className="absolute top-3 left-3 z-10 flex flex-col space-y-1">
        {product.discount && product.discount > 0 ? (
          <span className="bg-red-500 text-white text-[11px] font-bold px-2 py-1 rounded-full uppercase tracking-wider">
            {product.discount}% OFF
          </span>
        ) : null}
        {product.isNew ? (
          <span className="bg-brand-blue text-white text-[11px] font-bold px-2 py-1 rounded-full uppercase tracking-wider">
            NEW
          </span>
        ) : null}
        {product.isBestSeller ? (
          <span className="bg-amber-500 text-white text-[11px] font-bold px-2 py-1 rounded-full uppercase tracking-wider">
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
          className="absolute top-3 right-3 z-10 p-2.5 bg-white/85 hover:bg-white text-slate-400 hover:text-red-500 rounded-full shadow-xs hover:shadow-sm backdrop-blur-xs transition-all cursor-pointer"
          title={isWishlisted ? "Remove from Wishlist" : "Add to Wishlist"}
        >
          <Heart className={`h-4.5 w-4.5 transition-colors ${isWishlisted ? 'fill-red-500 text-red-500' : ''}`} />
        </button>
      )}

      {/* Product Image Stage */}
      <div className="relative w-full aspect-square bg-slate-50 flex items-center justify-center overflow-hidden">
        <img
          src={product.imageUrl || 'https://images.unsplash.com/photo-1531403009284-440f080d1e12?auto=format&fit=crop&w=600&q=80'}
          alt={product.name}
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover transform group-hover:scale-105 transition-transform duration-500"
          onError={(e) => {
            e.currentTarget.onerror = null;
            e.currentTarget.src = 'https://images.unsplash.com/photo-1531403009284-440f080d1e12?auto=format&fit=crop&w=600&q=80';
          }}
        />
        {/* Out of Stock overlay */}
        {product.stock <= 0 && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
            <span className="text-white text-xs font-bold uppercase tracking-wider bg-red-600 px-3 py-1.5 rounded-full">
              Out of Stock
            </span>
          </div>
        )}
      </div>

      {/* Content & Details */}
      <div className="p-4 flex flex-col flex-1">
        {/* Category Label */}
        <span className="text-[11px] text-slate-400 font-bold uppercase tracking-widest mb-1">
          {product.category.replace('-', ' ')}
        </span>

        {/* Product Name */}
        <h3 className="text-sm font-semibold text-slate-800 line-clamp-2 mb-1 group-hover:text-brand-blue transition-colors min-h-[40px]">
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
              <span className="text-[11px] text-slate-400 font-medium">({product.reviewsCount})</span>
            </>
          ) : (
            <span className="text-[11px] text-slate-400 italic font-light">No Reviews</span>
          )}
        </div>

        {/* Pricing & Stock Grid */}
        <div className="mt-auto pt-3 border-t border-slate-100 flex items-baseline justify-between flex-wrap gap-1">
          <div className="flex flex-col">
            <span className="text-base font-bold text-slate-900">
              {formatPrice(product.price)}
            </span>
            {product.originalPrice && product.originalPrice > product.price && (
              <span className="text-xs text-slate-400 line-through">
                {formatPrice(product.originalPrice)}
              </span>
            )}
          </div>
          <span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-slate-50 text-slate-500">
            {product.stock > 0 ? `${product.stock} in stock` : 'Out of stock'}
          </span>
        </div>

        {/* Actions button group */}
        <div className="mt-4 grid grid-cols-2 gap-2">
          {/* Add to Cart */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (product.stock > 0) onAddToCart(product);
            }}
            disabled={product.stock <= 0}
            className={`flex items-center justify-center py-2.5 px-2 rounded-xl text-xs font-semibold cursor-pointer transition-all ${
              product.stock > 0 
                ? 'bg-slate-900 text-white hover:bg-slate-800' 
                : 'bg-slate-100 text-slate-400 cursor-not-allowed'
            }`}
          >
            <ShoppingCart className="h-3.5 w-3.5" />
            <span className="hidden sm:inline ml-1.5">Add to Cart</span>
            <span className="inline sm:hidden ml-1 font-medium text-[10px]">Cart</span>
          </button>

          {/* Quick WhatsApp Order */}
          <button
            onClick={handleWhatsAppQuickBuy}
            className="flex items-center justify-center py-2.5 px-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-xs font-semibold cursor-pointer transition-all shadow-xs"
            title="Buy Now via WhatsApp"
          >
            <Phone className="h-3.5 w-3.5 text-white fill-white" />
            <span className="hidden sm:inline ml-1.5">Buy Now</span>
            <span className="inline sm:hidden ml-1 font-medium text-[10px]">Order</span>
          </button>
        </div>

      </div>
    </div>
  );
}
