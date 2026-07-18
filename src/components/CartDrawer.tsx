import { User } from 'firebase/auth';
import { CartItem, WebsiteSettings } from '../types';
import PremiumCheckoutDrawer from '../features/checkout/PremiumCheckoutDrawer';

export interface CartDrawerProps {
  isOpen: boolean;
  user: User | null;
  onClose: () => void;
  cartItems: CartItem[];
  onUpdateQuantity: (productId: string, quantity: number) => void;
  onRemoveItem: (productId: string) => void;
  onClearCart: () => void;
  settings?: WebsiteSettings | null;
  setCurrentPage?: (page: string) => void;
}

export default function CartDrawer(props: CartDrawerProps) {
  return <PremiumCheckoutDrawer {...props} />;
}
