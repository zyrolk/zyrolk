import { MapPinned, PackageCheck, ReceiptText, SearchCheck } from 'lucide-react';

const REASONS = [
  {
    icon: PackageCheck,
    title: 'A live marketplace catalogue',
    description: 'Browse published products with current marketplace pricing and availability.',
  },
  {
    icon: SearchCheck,
    title: 'Discovery made simple',
    description: 'Search the catalogue or move through live categories to find the right product faster.',
  },
  {
    icon: ReceiptText,
    title: 'Clear ordering',
    description: 'Review your cart, delivery details and order total before confirming checkout.',
  },
  {
    icon: MapPinned,
    title: 'Built for Sri Lanka',
    description: 'Shop with local contact options, Cash on Delivery and islandwide delivery.',
  },
] as const;

export default function HomepageWhyChoose() {
  return (
    <section className="zy-launch-why" aria-labelledby="homepage-why-title">
      <header className="zy-launch-section-heading">
        <span className="zy-launch-section-eyebrow">The Zyro.lk difference</span>
        <h2 id="homepage-why-title">Why choose Zyro.lk?</h2>
        <p>A focused marketplace experience designed to make everyday product discovery and ordering feel effortless.</p>
      </header>

      <div className="zy-launch-why-grid">
        {REASONS.map(({ icon: Icon, title, description }, index) => (
          <article key={title} className="zy-launch-why-card">
            <span className="zy-launch-why-number" aria-hidden="true">0{index + 1}</span>
            <span className="zy-launch-why-icon" aria-hidden="true"><Icon className="h-6 w-6" /></span>
            <h3>{title}</h3>
            <p>{description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
