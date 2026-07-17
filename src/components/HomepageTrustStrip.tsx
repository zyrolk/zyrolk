import { Banknote, Headphones, ShieldCheck, Truck } from 'lucide-react';

const TRUST_ITEMS = [
  {
    icon: Banknote,
    title: 'Cash on Delivery',
    description: 'Pay when your order arrives.',
  },
  {
    icon: Truck,
    title: 'Islandwide Delivery',
    description: 'Convenient delivery across Sri Lanka.',
  },
  {
    icon: ShieldCheck,
    title: 'Secure Checkout',
    description: 'Server-validated order processing.',
  },
  {
    icon: Headphones,
    title: 'Local Support',
    description: 'Help before and after ordering.',
  },
] as const;

export default function HomepageTrustStrip() {
  return (
    <section className="zy-launch-trust" aria-label="Why customers can shop with confidence">
      <div className="zy-launch-trust-grid">
        {TRUST_ITEMS.map(({ icon: Icon, title, description }) => (
          <div key={title} className="zy-launch-trust-item">
            <span className="zy-launch-trust-icon" aria-hidden="true">
              <Icon className="h-5 w-5" />
            </span>
            <div>
              <h2>{title}</h2>
              <p>{description}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
