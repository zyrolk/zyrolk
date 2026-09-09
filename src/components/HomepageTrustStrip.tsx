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
    description: 'Your order is securely processed.',
  },
  {
    icon: Headphones,
    title: 'Customer Support',
    description: 'Daily, 8:00 AM - 10:00 PM.',
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
