import { User } from 'firebase/auth';
import { Headphones, Home, PackageCheck, ShieldAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';
import './paymentReturn.css';

interface PaymentReturnPageProps {
  user: User | null;
  onContinue: () => void;
  onOrders: () => void;
  onSupport: () => void;
}

export default function PaymentReturnPage({ user, onContinue, onOrders, onSupport }: PaymentReturnPageProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const focusTimer = window.setTimeout(() => headingRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, []);

  return <main className="zy-payment-return" aria-labelledby="payment-return-title">
    <section className="zy-payment-return-card is-unavailable" aria-busy="false">
      <span className="sr-only" role="status" aria-live="polite">Online payment is not currently available</span>
      <span className="zy-payment-return-icon" aria-hidden="true"><ShieldAlert /></span>
      <p className="zy-section-eyebrow">Online payment unavailable</p>
      <h1 id="payment-return-title" ref={headingRef} tabIndex={-1}>Online payment is not currently available</h1>
      <p>Zyro.lk currently accepts Cash on Delivery only. This link did not confirm an online payment or change your order.</p>
      <div className="zy-payment-return-actions">
        {user && <button type="button" onClick={onOrders}><PackageCheck />View My Orders</button>}
        <button type="button" onClick={onSupport}><Headphones />Contact Support</button>
        <button type="button" onClick={onContinue}><Home />Continue shopping</button>
      </div>
    </section>
  </main>;
}
