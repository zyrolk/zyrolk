import { ArrowRight } from 'lucide-react';
import {
  HomepagePreviewProduct,
  HomepagePreviewShelf,
} from '../services/storefront/homepagePreviewPresentation';
import HomepagePreviewProductCard from './HomepagePreviewProductCard';

interface HomepagePreviewProductShelfProps {
  id: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  tone: HomepagePreviewShelf;
  products: readonly HomepagePreviewProduct[];
  onBrowse: () => void;
}

export default function HomepagePreviewProductShelf({
  id,
  eyebrow,
  title,
  subtitle,
  tone,
  products,
  onBrowse,
}: HomepagePreviewProductShelfProps) {
  const titleId = `${id}-title`;

  return (
    <section
      className={`zy-home-preview-shelf is-${tone}`}
      data-preview-shelf={id}
      aria-labelledby={titleId}
    >
      <header className="zy-home-preview-shelf-header">
        <div>
          <span className="zy-home-preview-shelf-eyebrow">{eyebrow}</span>
          <h2 id={titleId}>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <button type="button" onClick={onBrowse} className="zy-home-preview-shelf-action">
          Explore catalogue
          <ArrowRight aria-hidden="true" />
        </button>
      </header>
      <div className="zy-home-preview-shelf-grid" role="list" aria-label={`${title} examples`}>
        {products.map(product => (
          <div key={product.id} role="listitem">
            <HomepagePreviewProductCard product={product} />
          </div>
        ))}
      </div>
    </section>
  );
}
