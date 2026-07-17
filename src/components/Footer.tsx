import {
  ArrowRight,
  Facebook,
  Headphones,
  Instagram,
  Mail,
  MapPin,
  Music2,
  Phone,
  ShoppingBag,
  Youtube,
} from 'lucide-react';
import { Category, WebsiteSettings } from '../types';

interface FooterProps {
  setCurrentPage: (page: string) => void;
  onSelectCategory: (category: string) => void;
  settings?: WebsiteSettings | null;
  categories: readonly Category[];
  categoryCounts: Readonly<Record<string, number>>;
}

export default function Footer({ setCurrentPage, onSelectCategory, settings, categories, categoryCounts }: FooterProps) {
  const handleCategoryClick = (categoryId: string) => {
    onSelectCategory(categoryId);
    setCurrentPage('products');
  };

  const handleBrowseProducts = () => handleCategoryClick('all');
  const footerLogo = settings?.footerLogoUrl || settings?.logoUrl;
  const storeName = settings?.storeName?.trim() || 'Zyro.lk';
  const topCategories = categories.filter(category => (categoryCounts[category.id] ?? 0) > 0).slice(0, 5);
  const hasContactDetails = Boolean(settings?.contactAddress || settings?.contactPhone || settings?.contactEmail);
  const hasSocialLinks = Boolean(settings?.facebookUrl || settings?.instagramUrl || settings?.tiktokUrl || settings?.youtubeUrl);

  return (
    <footer className="zy-market-footer zy-launch-footer">
      <div className="zy-launch-footer-container">
        <section className="zy-launch-footer-cta" aria-labelledby="footer-marketplace-title">
          <div className="zy-launch-footer-cta-icon" aria-hidden="true"><ShoppingBag className="h-7 w-7" /></div>
          <div className="zy-launch-footer-cta-copy">
            <span>Continue exploring</span>
            <h2 id="footer-marketplace-title">Your next marketplace find is waiting.</h2>
            <p>Browse the live catalogue or contact the Zyro.lk team when you need help.</p>
          </div>
          <div className="zy-launch-footer-cta-actions">
            <button type="button" onClick={handleBrowseProducts} className="zy-launch-footer-primary">
              Shop marketplace
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
            <button type="button" onClick={() => setCurrentPage('contact')} className="zy-launch-footer-secondary">
              <Headphones className="h-4 w-4" aria-hidden="true" />
              Get support
            </button>
          </div>
        </section>

        <div className="zy-launch-footer-grid">
          <section className="zy-launch-footer-brand" aria-label={`${storeName} overview`}>
            {footerLogo ? (
              <img
                src={footerLogo}
                alt={storeName}
                className="zy-launch-footer-logo"
                referrerPolicy="no-referrer"
                loading="lazy"
                decoding="async"
              />
            ) : (
              <span className="zy-launch-footer-wordmark">{storeName}</span>
            )}
            <p>{settings?.aboutText || 'A growing Sri Lankan marketplace for product discovery, convenient ordering and local customer support.'}</p>

            {hasSocialLinks && (
              <div className="zy-launch-footer-socials" aria-label="Social media links">
                {settings?.facebookUrl && (
                  <a href={settings.facebookUrl} target="_blank" rel="noopener noreferrer" aria-label={`Visit ${storeName} on Facebook`}>
                    <Facebook className="h-4 w-4" aria-hidden="true" />
                  </a>
                )}
                {settings?.instagramUrl && (
                  <a href={settings.instagramUrl} target="_blank" rel="noopener noreferrer" aria-label={`Visit ${storeName} on Instagram`}>
                    <Instagram className="h-4 w-4" aria-hidden="true" />
                  </a>
                )}
                {settings?.tiktokUrl && (
                  <a href={settings.tiktokUrl} target="_blank" rel="noopener noreferrer" aria-label={`Visit ${storeName} on TikTok`}>
                    <Music2 className="h-4 w-4" aria-hidden="true" />
                  </a>
                )}
                {settings?.youtubeUrl && (
                  <a href={settings.youtubeUrl} target="_blank" rel="noopener noreferrer" aria-label={`Visit ${storeName} on YouTube`}>
                    <Youtube className="h-4 w-4" aria-hidden="true" />
                  </a>
                )}
              </div>
            )}
          </section>

          <nav className="zy-launch-footer-links" aria-labelledby="footer-shop-title">
            <h2 id="footer-shop-title">Shop</h2>
            <ul>
              <li><button type="button" onClick={() => setCurrentPage('home')}>Homepage</button></li>
              <li><button type="button" onClick={handleBrowseProducts}>All products</button></li>
              <li><button type="button" onClick={() => setCurrentPage('categories')}>Categories</button></li>
              <li><button type="button" onClick={() => setCurrentPage('wishlist')}>Wishlist</button></li>
            </ul>
          </nav>

          <nav className="zy-launch-footer-links" aria-labelledby="footer-categories-title">
            <h2 id="footer-categories-title">Popular categories</h2>
            {topCategories.length > 0 ? (
              <ul>
                {topCategories.map(category => (
                  <li key={category.id}>
                    <button type="button" onClick={() => handleCategoryClick(category.id)}>{category.name}</button>
                  </li>
                ))}
              </ul>
            ) : (
              <button type="button" onClick={handleBrowseProducts} className="zy-launch-footer-empty-link">Browse all products</button>
            )}
          </nav>

          <nav className="zy-launch-footer-links" aria-labelledby="footer-help-title">
            <h2 id="footer-help-title">Help & company</h2>
            <ul>
              <li><button type="button" onClick={() => setCurrentPage('contact')}>Contact & support</button></li>
              <li><button type="button" onClick={() => setCurrentPage('about-us')}>About us</button></li>
              <li><button type="button" onClick={() => setCurrentPage('faq')}>FAQs & guides</button></li>
              <li><button type="button" onClick={() => setCurrentPage('return-policy')}>Purchase support policy</button></li>
              <li><button type="button" onClick={() => setCurrentPage('terms-conditions')}>Terms & conditions</button></li>
              <li><button type="button" onClick={() => setCurrentPage('privacy-policy')}>Privacy policy</button></li>
            </ul>
          </nav>
        </div>

        {hasContactDetails && (
          <div className="zy-launch-footer-contact" aria-label="Store contact details">
            {settings?.contactAddress && (
              <span><MapPin className="h-4 w-4" aria-hidden="true" />{settings.contactAddress}</span>
            )}
            {settings?.contactPhone && (
              <a href={`tel:${settings.contactPhone}`}>
                <Phone className="h-4 w-4" aria-hidden="true" />
                {settings.contactPhone}{settings.contactPhone2 ? ` / ${settings.contactPhone2}` : ''}
              </a>
            )}
            {settings?.contactEmail && (
              <a href={`mailto:${settings.contactEmail}`}>
                <Mail className="h-4 w-4" aria-hidden="true" />
                {settings.contactEmail}
              </a>
            )}
          </div>
        )}

        <div className="zy-launch-footer-bottom">
          <p>{settings?.copyrightText || `© ${new Date().getFullYear()} ${storeName}. All rights reserved.`}</p>
          <p>Made for convenient shopping across Sri Lanka.</p>
        </div>
      </div>
    </footer>
  );
}
