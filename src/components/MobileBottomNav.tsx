import React from 'react';
import { Home, Heart, ShoppingCart, Grid3X3, UserRound } from 'lucide-react';

interface MobileBottomNavProps {
  currentPage: string;
  setCurrentPage: (page: string) => void;
  cartCount: number;
  wishlistCount: number;
  onOpenCart: () => void;
  isCartOpen?: boolean;
  isAdminMode: boolean;
  setIsAdminMode: (val: boolean) => void;
}

export default function MobileBottomNav({
  currentPage,
  setCurrentPage,
  cartCount,
  wishlistCount,
  onOpenCart,
  isCartOpen = false,
  isAdminMode,
  setIsAdminMode,
}: MobileBottomNavProps) {
  const handleTabClick = (pageId: string) => {
    setIsAdminMode(false);
    setCurrentPage(pageId);
  };

  const activeTabClass = "text-brand-blue scale-110";
  const inactiveTabClass = "text-slate-500 hover:text-slate-700";
  const isAccountPage = currentPage === 'account' || currentPage.startsWith('account-');
  const isHomeActive = currentPage === 'home' && !isAdminMode && !isCartOpen;
  const isCategoriesActive = currentPage === 'categories' && !isAdminMode && !isCartOpen;
  const isWishlistActive = currentPage === 'wishlist' && !isAdminMode && !isCartOpen;
  const isCartActive = isCartOpen && !isAccountPage;
  const isAccountActive = isAccountPage && !isAdminMode;

  return (
    <nav className="zy-bottom-dock fixed left-3 right-3 z-40 md:hidden" aria-label="Mobile storefront navigation">
      <div className="zy-mobile-dock bg-white/95 backdrop-blur-xl border border-slate-200/80 rounded-2xl px-1.5 py-1.5 flex justify-around items-stretch">

        {/* Tab 1: Home */}
        <button
          onClick={() => handleTabClick('home')}
          className={`zy-mobile-tab flex min-h-12 flex-col items-center justify-center flex-1 transition-all relative py-1 cursor-pointer rounded-xl active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20 ${
            isHomeActive ? activeTabClass : inactiveTabClass
          }`}
          aria-label="Go to home"
          aria-current={isHomeActive ? 'page' : undefined}
        >
          <Home className="h-5 w-5" />
          <span className="text-[9px] font-bold mt-1 tracking-tight">Home</span>
          {isHomeActive && (
            <span className="absolute bottom-0 w-1 h-1 bg-brand-blue rounded-full"></span>
          )}
        </button>

        {/* Tab 2: Categories */}
        <button
          onClick={() => handleTabClick('categories')}
          className={`zy-mobile-tab flex min-h-12 flex-col items-center justify-center flex-1 transition-all relative py-1 cursor-pointer rounded-xl active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20 ${
            isCategoriesActive ? activeTabClass : inactiveTabClass
          }`}
          aria-label="Browse categories"
          aria-current={isCategoriesActive ? 'page' : undefined}
        >
          <Grid3X3 className="h-5 w-5" />
          <span className="text-[9px] font-bold mt-1 tracking-tight">Categories</span>
          {isCategoriesActive && (
            <span className="absolute bottom-0 w-1 h-1 bg-brand-blue rounded-full"></span>
          )}
        </button>

        {/* Tab 3: Wishlist */}
        <button
          onClick={() => handleTabClick('wishlist')}
          className={`zy-mobile-tab flex min-h-12 flex-col items-center justify-center flex-1 transition-all relative py-1 cursor-pointer rounded-xl active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20 ${
            isWishlistActive ? activeTabClass : inactiveTabClass
          }`}
          aria-label={`Open wishlist with ${wishlistCount} saved ${wishlistCount === 1 ? 'product' : 'products'}`}
          aria-current={isWishlistActive ? 'page' : undefined}
        >
          <div className="relative">
            <Heart className="h-5 w-5" />
            {wishlistCount > 0 && (
              <span className="absolute -top-1.5 -right-2 inline-flex items-center justify-center px-1.5 py-0.5 text-[8px] font-black leading-none text-white bg-red-500 rounded-full">
                {wishlistCount}
              </span>
            )}
          </div>
          <span className="text-[9px] font-bold mt-1 tracking-tight">Wishlist</span>
          {isWishlistActive && (
            <span className="absolute bottom-0 w-1 h-1 bg-brand-blue rounded-full"></span>
          )}
        </button>

        {/* Tab 4: Cart */}
        <button
          onClick={onOpenCart}
          className={`zy-mobile-tab zy-mobile-tab-cart flex min-h-12 flex-col items-center justify-center flex-1 transition-all relative py-1 cursor-pointer rounded-xl active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20 ${
            isCartActive ? activeTabClass : inactiveTabClass
          }`}
          aria-label={`Open cart with ${cartCount} ${cartCount === 1 ? 'item' : 'items'}`}
          aria-current={isCartActive ? 'page' : undefined}
        >
          <div className="relative">
            <ShoppingCart className="h-5 w-5" />
            {cartCount > 0 && (
              <span className="absolute -top-1.5 -right-2 inline-flex items-center justify-center px-1.5 py-0.5 text-[8px] font-black leading-none text-white bg-brand-blue rounded-full">
                {cartCount}
              </span>
            )}
          </div>
          <span className="text-[9px] font-bold mt-1 tracking-tight">Cart</span>
          {isCartActive && (
            <span className="absolute bottom-0 w-1 h-1 bg-brand-blue rounded-full"></span>
          )}
        </button>

        {/* Tab 5: Account */}
        <button
          onClick={() => handleTabClick('account')}
          className={`zy-mobile-tab flex min-h-12 flex-col items-center justify-center flex-1 transition-all relative py-1 cursor-pointer rounded-xl active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20 ${
            isAccountActive ? activeTabClass : inactiveTabClass
          }`}
          aria-label="Go to account"
          aria-current={isAccountActive ? 'page' : undefined}
        >
          <UserRound className="h-5 w-5" />
          <span className="text-[9px] font-bold mt-1 tracking-tight">Account</span>
          {isAccountActive && (
            <span className="absolute bottom-0 w-1 h-1 bg-brand-blue rounded-full"></span>
          )}
        </button>

      </div>
    </nav>
  );
}
