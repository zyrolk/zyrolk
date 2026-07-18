import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Check, Clock3, Heart, LoaderCircle, LogIn, PackageCheck, RefreshCw, ShoppingCart, Sparkles, Trash2, TrendingDown, TrendingUp, X } from 'lucide-react';
import { User } from 'firebase/auth';
import ProductCard from '../../components/ProductCard';
import { Product, WebsiteSettings } from '../../types';
import PersonalizedRecommendations from './PersonalizedRecommendations';
import { RecommendationSection, WishlistProductView } from './personalization';
import './personalization.css';

interface WishlistExperienceProps {
  mode: 'wishlist' | 'recent';
  user: User | null;
  loading: boolean;
  syncError: string;
  wishlistViews: WishlistProductView[];
  recentlyViewed: Product[];
  compareIds: Set<string>;
  recommendationSections: RecommendationSection[];
  settings: WebsiteSettings | null;
  onNavigate: (page: string) => void;
  onOpenAuth: () => void;
  onAddToCart: (product: Product) => void;
  onToggleWishlist: (product: Product) => void;
  onRemoveWishlistItems: (productIds: string[]) => void;
  onViewProduct: (product: Product) => void;
  onClearHistory: () => void;
  onToggleCompare: (product: Product) => void;
}

const formatPrice = (amount: number) => new Intl.NumberFormat('en-LK', {
  style: 'currency', currency: 'LKR', minimumFractionDigits: 0, maximumFractionDigits: 0,
}).format(Number.isFinite(amount) ? amount : 0);

const ExperienceSkeleton = () => <div className="zy-personalization-skeleton" role="status" aria-label="Loading personalized shopping"><span className="sr-only">Loading personalized shopping</span>{Array.from({ length: 4 }, (_, index) => <i key={index} />)}</div>;

export default function WishlistExperience({
  mode, user, loading, syncError, wishlistViews, recentlyViewed, compareIds, recommendationSections,
  settings, onNavigate, onOpenAuth, onAddToCart, onToggleWishlist, onRemoveWishlistItems,
  onViewProduct, onClearHistory, onToggleCompare,
}: WishlistExperienceProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkSaving, setBulkSaving] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const wishlistIds = useMemo(() => new Set(wishlistViews.map(item => item.id)), [wishlistViews]);
  const selectedAvailable = wishlistViews.filter(item => selectedIds.has(item.id) && item.isAvailable && item.product.stock > 0);

  useEffect(() => {
    setSelectedIds(current => new Set([...current].filter(id => wishlistIds.has(id))));
  }, [wishlistIds]);

  const toggleSelected = (productId: string) => setSelectedIds(current => {
    const next = new Set(current);
    if (next.has(productId)) next.delete(productId); else next.add(productId);
    return next;
  });

  const moveItemsToCart = (items: WishlistProductView[]) => {
    const available = items.filter(item => item.isAvailable && item.product.stock > 0);
    if (available.length === 0) {
      setActionMessage('No selected products are currently available to move to your cart.');
      return;
    }
    setBulkSaving(true);
    available.forEach(item => onAddToCart(item.product));
    onRemoveWishlistItems(available.map(item => item.id));
    setSelectedIds(new Set());
    setActionMessage(`${available.length} ${available.length === 1 ? 'product was' : 'products were'} moved to your cart.`);
    setBulkSaving(false);
  };

  const removeSelected = () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    onRemoveWishlistItems(ids);
    setSelectedIds(new Set());
    setActionMessage(`${ids.length} saved ${ids.length === 1 ? 'product was' : 'products were'} removed.`);
  };

  const clearHistory = () => {
    if (!confirmClearHistory) {
      setConfirmClearHistory(true);
      return;
    }
    onClearHistory();
    setConfirmClearHistory(false);
    setActionMessage(user ? 'Recently viewed history cleared on this device and your signed-in account.' : 'Recently viewed history cleared on this device.');
  };

  return (
    <div className="zy-storefront-page zy-personalization-page">
      <header className="zy-personalization-hero">
        <div><p className="zy-section-eyebrow">Personalized shopping</p><h1>{mode === 'wishlist' ? 'Wishlist 2.0' : 'Recently Viewed'}</h1><p>{mode === 'wishlist' ? 'Keep live favourites organized, spot price changes, and move products to your cart when you are ready.' : 'Continue exploring products you opened recently, with inactive catalogue items cleaned automatically.'}</p></div>
        <div className={`zy-personalization-sync ${user ? 'is-synced' : ''}`}>{user ? <RefreshCw /> : <LogIn />}<span><strong>{user ? 'Account sync active' : 'Saved on this device'}</strong><small>{user ? 'Wishlist and recent history follow your account.' : 'Sign in to synchronize across devices.'}</small></span>{!user && <button type="button" onClick={onOpenAuth}>Sign in</button>}</div>
      </header>

      <nav className="zy-personalization-tabs" aria-label="Personalized shopping sections">
        <button type="button" onClick={() => onNavigate('wishlist')} className={mode === 'wishlist' ? 'is-active' : ''} aria-current={mode === 'wishlist' ? 'page' : undefined}><Heart />Wishlist <span>{wishlistViews.length}</span></button>
        <button type="button" onClick={() => onNavigate('recently-viewed')} className={mode === 'recent' ? 'is-active' : ''} aria-current={mode === 'recent' ? 'page' : undefined}><Clock3 />Recently Viewed <span>{recentlyViewed.length}</span></button>
        <button type="button" onClick={() => onNavigate('compare')}><BarChart3 />Compare <span>{compareIds.size}/4</span></button>
      </nav>

      {syncError && <div className="zy-account-alert is-error" role="alert">{syncError}</div>}
      {actionMessage && <div className="zy-account-alert is-success" role="status"><span>{actionMessage}</span><button type="button" onClick={() => setActionMessage('')} aria-label="Dismiss message"><X /></button></div>}

      {loading ? <ExperienceSkeleton /> : mode === 'wishlist' ? (
        <section className="zy-wishlist-two" aria-labelledby="wishlist-products-title">
          <div className="zy-personalization-section-heading"><div><p className="zy-section-eyebrow">Saved products</p><h2 id="wishlist-products-title">Your live wishlist</h2><p>{wishlistViews.length} {wishlistViews.length === 1 ? 'product' : 'products'} saved</p></div>{wishlistViews.length > 0 && <button type="button" onClick={() => setSelectedIds(selectedIds.size === wishlistViews.length ? new Set() : new Set(wishlistViews.map(item => item.id)))}><Check />{selectedIds.size === wishlistViews.length ? 'Clear selection' : 'Select all'}</button>}</div>

          {selectedIds.size > 0 && <div className="zy-wishlist-bulk" role="region" aria-label="Wishlist bulk actions"><div><strong>{selectedIds.size} selected</strong><span>{selectedAvailable.length} currently in stock</span></div><div><button type="button" onClick={() => moveItemsToCart(wishlistViews.filter(item => selectedIds.has(item.id)))} disabled={bulkSaving || selectedAvailable.length === 0}>{bulkSaving ? <LoaderCircle className="animate-spin" /> : <ShoppingCart />}Move to cart</button><button type="button" onClick={removeSelected}><Trash2 />Remove</button></div></div>}

          {wishlistViews.length === 0 ? <div className="zy-personalization-empty"><Heart /><strong>Your wishlist is ready</strong><p>Use the heart on any live product to save it here and synchronize it when signed in.</p><button type="button" onClick={() => onNavigate('products')}>Explore live products</button></div> : (
            <div className="zy-wishlist-two-grid">
              {wishlistViews.map(item => (
                <article key={item.id} className={`zy-wishlist-two-card ${selectedIds.has(item.id) ? 'is-selected' : ''} ${!item.isAvailable ? 'is-unavailable' : ''}`}>
                  <label className="zy-wishlist-select"><input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelected(item.id)} /><span className="sr-only">Select {item.product.name}</span></label>
                  {item.priceChange !== 'unchanged' && item.isAvailable && <span className={`zy-price-change is-${item.priceChange}`}>{item.priceChange === 'decreased' ? <TrendingDown /> : <TrendingUp />}{item.priceChange === 'decreased' ? 'Price dropped' : 'Price increased'} {item.priceChangePercent.toFixed(0)}%</span>}
                  {item.isAvailable ? <ProductCard product={item.product} isWishlisted onAddToCart={onAddToCart} onToggleWishlist={onToggleWishlist} onViewDetail={onViewProduct} settings={settings} /> : <div className="zy-wishlist-unavailable"><span><img src={item.savedProduct.imageUrl || '/logo.png'} alt="" /></span><small>Unavailable</small><strong>{item.savedProduct.name}</strong><p>This product is no longer active in the live catalogue.</p><button type="button" onClick={() => onRemoveWishlistItems([item.id])}><Trash2 />Remove saved item</button></div>}
                  <div className="zy-wishlist-card-actions">{item.isAvailable && <button type="button" onClick={() => onToggleCompare(item.product)} className={compareIds.has(item.id) ? 'is-active' : ''} aria-pressed={compareIds.has(item.id)}><BarChart3 />{compareIds.has(item.id) ? 'Compared' : 'Compare'}</button>}{item.isAvailable && item.product.stock > 0 && <button type="button" onClick={() => moveItemsToCart([item])}><ShoppingCart />Move to cart</button>}<span className={`is-${item.product.stock <= 0 || !item.isAvailable ? 'out' : item.product.stock <= 5 ? 'low' : 'in'}`}><PackageCheck />{!item.isAvailable || item.product.stock <= 0 ? 'Out of stock' : item.product.stock <= 5 ? `Only ${item.product.stock} left` : 'In stock'}</span></div>
                  {item.priceChange !== 'unchanged' && item.isAvailable && <p className="zy-price-change-detail">Saved at {formatPrice(item.savedProduct.price)} · Now {formatPrice(item.product.price)}</p>}
                </article>
              ))}
            </div>
          )}
        </section>
      ) : (
        <section className="zy-recent-history" aria-labelledby="recent-history-title">
          <div className="zy-personalization-section-heading"><div><p className="zy-section-eyebrow">Browsing history</p><h2 id="recent-history-title">Continue where you left off</h2><p>Newest views appear first. Inactive products are removed automatically.</p></div>{recentlyViewed.length > 0 && <div className="zy-clear-history"><button type="button" onClick={clearHistory}><Trash2 />{confirmClearHistory ? 'Confirm clear history' : 'Clear history'}</button>{confirmClearHistory && <button type="button" onClick={() => setConfirmClearHistory(false)}>Keep history</button>}</div>}</div>
          {recentlyViewed.length === 0 ? <div className="zy-personalization-empty"><Clock3 /><strong>No recently viewed products</strong><p>Products you open will appear here. Signed-in history synchronizes across devices.</p><button type="button" onClick={() => onNavigate('products')}>Browse products</button></div> : <div className="zy-recent-grid">{recentlyViewed.map(product => <article key={product.id}><ProductCard product={product} isWishlisted={wishlistIds.has(product.id)} onAddToCart={onAddToCart} onToggleWishlist={onToggleWishlist} onViewDetail={onViewProduct} settings={settings} /><button type="button" className={compareIds.has(product.id) ? 'is-active' : ''} onClick={() => onToggleCompare(product)} aria-pressed={compareIds.has(product.id)}><BarChart3 />{compareIds.has(product.id) ? 'Added to compare' : 'Add to compare'}</button></article>)}</div>}
        </section>
      )}

      {!loading && <PersonalizedRecommendations sections={recommendationSections} wishlistIds={wishlistIds} compareIds={compareIds} settings={settings} onAddToCart={onAddToCart} onToggleWishlist={onToggleWishlist} onViewProduct={onViewProduct} onToggleCompare={onToggleCompare} onOpenCompare={() => onNavigate('compare')} />}
    </div>
  );
}
