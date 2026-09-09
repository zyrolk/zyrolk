import {
  BatteryCharging,
  Cable,
  Car,
  Headphones,
  Home,
  Laptop,
  PackageOpen,
  Smartphone,
  Watch,
} from 'lucide-react';
import { HomepagePreviewProduct } from '../services/storefront/homepagePreviewPresentation';

interface HomepagePreviewProductCardProps {
  product: HomepagePreviewProduct;
}

const ART_ICONS = {
  mobile: Smartphone,
  audio: Headphones,
  watch: Watch,
  electronics: Laptop,
  power: BatteryCharging,
  car: Car,
  home: Home,
  accessories: Cable,
  more: PackageOpen,
} as const;

export function HomepagePreviewProductArt({
  art,
  tone,
}: Pick<HomepagePreviewProduct, 'art' | 'tone'>) {
  const Icon = ART_ICONS[art];
  return (
    <span className={`zy-home-preview-art zy-home-preview-art-${tone}`} aria-hidden="true">
      <span className="zy-home-preview-art-orb" />
      <Icon />
    </span>
  );
}

export default function HomepagePreviewProductCard({ product }: HomepagePreviewProductCardProps) {
  return (
    <article
      className="zy-home-preview-product-card"
      data-preview-product-id={product.id}
      aria-label={`${product.category}: ${product.name}`}
    >
      <div className="zy-home-preview-product-image">
        <HomepagePreviewProductArt art={product.art} tone={product.tone} />
      </div>
      <div className="zy-home-preview-product-copy">
        <small>{product.category}</small>
        <strong>{product.name}</strong>
        <span>Explore category</span>
      </div>
    </article>
  );
}
