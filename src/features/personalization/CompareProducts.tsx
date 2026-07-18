import { useMemo, useState } from 'react';
import { BarChart3, Check, Heart, PackageCheck, Plus, Search, ShoppingCart, Sparkles, Trash2, X } from 'lucide-react';
import { Product } from '../../types';
import { PRODUCT_IMAGE_FALLBACK } from '../product-experience/productExperience';
import { buildComparisonRows, resolveComparedProducts } from './personalization';
import './personalization.css';

interface CompareProductsProps {
  products: Product[];
  compareIds: string[];
  wishlistIds: Set<string>;
  loading: boolean;
  message: string;
  onToggleCompare: (product: Product) => void;
  onClearCompare: () => void;
  onAddToCart: (product: Product) => void;
  onToggleWishlist: (product: Product) => void;
  onViewProduct: (product: Product) => void;
  onNavigate: (page: string) => void;
}

const formatPrice = (amount: number) => new Intl.NumberFormat('en-LK', {
  style: 'currency', currency: 'LKR', minimumFractionDigits: 0, maximumFractionDigits: 0,
}).format(Number.isFinite(amount) ? amount : 0);

export default function CompareProducts({
  products, compareIds, wishlistIds, loading, message, onToggleCompare, onClearCompare,
  onAddToCart, onToggleWishlist, onViewProduct, onNavigate,
}: CompareProductsProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const comparedProducts = useMemo(() => resolveComparedProducts(compareIds, products), [compareIds, products]);
  const rows = useMemo(() => buildComparisonRows(comparedProducts), [comparedProducts]);
  const suggestions = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase('en');
    const selected = new Set(compareIds);
    return products.filter(product => product.isActive !== false && !selected.has(product.id) && (
      !query || `${product.name} ${product.category} ${product.specs?.Brand || product.specs?.brand || ''}`.toLocaleLowerCase('en').includes(query)
    )).sort((left, right) => Number(right.isFeatured) - Number(left.isFeatured) || right.reviewsCount - left.reviewsCount || left.name.localeCompare(right.name)).slice(0, 8);
  }, [compareIds, products, searchQuery]);
  const messageIsError = message.startsWith('You can compare up to') || message.includes('could not');

  return (
    <div className="zy-storefront-page zy-compare-page">
      <header className="zy-compare-hero"><div><p className="zy-section-eyebrow">Side-by-side decisions</p><h1>Compare Products</h1><p>Compare up to four live products across pricing, stock, category, brand, and every available specification.</p></div><div><BarChart3 /><strong>{comparedProducts.length}/4</strong><span>products selected</span></div></header>
      <nav className="zy-personalization-tabs" aria-label="Personalized shopping sections"><button type="button" onClick={() => onNavigate('wishlist')}><Heart />Wishlist</button><button type="button" onClick={() => onNavigate('recently-viewed')}><Sparkles />Recently Viewed</button><button type="button" className="is-active" aria-current="page"><BarChart3 />Compare <span>{comparedProducts.length}/4</span></button></nav>
      {message && <div className={`zy-account-alert ${messageIsError ? 'is-error' : 'is-success'}`} role={messageIsError ? 'alert' : 'status'}>{message}</div>}

      {loading ? <div className="zy-personalization-skeleton" role="status" aria-label="Loading product comparison"><span className="sr-only">Loading product comparison</span>{Array.from({ length: 4 }, (_, index) => <i key={index} />)}</div> : (
        <>
          {comparedProducts.length < 4 && <section className="zy-compare-picker" aria-labelledby="compare-picker-title"><header><div><p className="zy-section-eyebrow">Add products</p><h2 id="compare-picker-title">Choose another product</h2></div><span>{4 - comparedProducts.length} slots available</span></header><label><Search /><span className="sr-only">Search products to compare</span><input type="search" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Search name, category, or brand" /></label><div>{suggestions.map(product => <article key={product.id}><span><img src={product.imageUrl || PRODUCT_IMAGE_FALLBACK} alt="" loading="lazy" decoding="async" /></span><div><strong>{product.name}</strong><small>{formatPrice(product.price)} · {product.stock > 0 ? 'In stock' : 'Out of stock'}</small></div><button type="button" onClick={() => onToggleCompare(product)} aria-label={`Add ${product.name} to comparison`}><Plus /></button></article>)}</div>{suggestions.length === 0 && <p className="zy-compare-no-results">No matching live products are available to add.</p>}</section>}

          {comparedProducts.length === 0 ? <div className="zy-personalization-empty zy-compare-empty"><BarChart3 /><strong>Start your comparison</strong><p>Search above to add up to four live products. Differences will be highlighted automatically.</p><button type="button" onClick={() => onNavigate('wishlist')}>Choose from wishlist</button></div> : (
            <section className="zy-compare-workspace" aria-labelledby="compare-table-title"><div className="zy-personalization-section-heading"><div><p className="zy-section-eyebrow">Live comparison</p><h2 id="compare-table-title">Highlighted differences</h2><p>Blue rows contain at least one difference between selected products.</p></div><button type="button" onClick={onClearCompare}><Trash2 />Clear comparison</button></div><div className="zy-compare-table-wrap" tabIndex={0} aria-label="Scrollable product comparison"><table><thead><tr><th scope="col">Product</th>{comparedProducts.map(product => <th scope="col" key={product.id}><button type="button" onClick={() => onToggleCompare(product)} aria-label={`Remove ${product.name} from comparison`}><X /></button><span><img src={product.imageUrl || PRODUCT_IMAGE_FALLBACK} alt="" loading="lazy" decoding="async" /></span><strong>{product.name}</strong><small>{product.category}</small><div><button type="button" onClick={() => onViewProduct(product)}>View product</button></div></th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.key} className={row.different ? 'is-different' : ''}><th scope="row">{row.different && <Sparkles aria-label="Values differ" />}{row.label}</th>{row.values.map((value, index) => <td key={`${row.key}-${comparedProducts[index].id}`}>{value}</td>)}</tr>)}</tbody></table></div><div className="zy-compare-commerce"><span>Commerce actions</span>{comparedProducts.map(product => <article key={product.id}><strong>{product.name}</strong><div><button type="button" disabled={product.stock <= 0} onClick={() => onAddToCart(product)}><ShoppingCart />{product.stock > 0 ? 'Add to cart' : 'Out of stock'}</button><button type="button" className={wishlistIds.has(product.id) ? 'is-active' : ''} onClick={() => onToggleWishlist(product)} aria-pressed={wishlistIds.has(product.id)}>{wishlistIds.has(product.id) ? <Check /> : <Heart />}{wishlistIds.has(product.id) ? 'Saved' : 'Save'}</button></div><small><PackageCheck />{product.stock > 0 ? `${product.stock} available` : 'Currently unavailable'}</small></article>)}</div></section>
          )}
        </>
      )}
    </div>
  );
}
