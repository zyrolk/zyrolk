import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import {
  Bell, BookOpen, Check, ChevronRight, Clock3, Edit3, Heart, Home, KeyRound, LoaderCircle,
  LockKeyhole, MailCheck, MapPin, PackageCheck, Plus, Save, Settings, ShieldCheck, ShoppingBag,
  Trash2, UserRound, X,
} from 'lucide-react';
import {
  EmailAuthProvider, User, reauthenticateWithCredential, sendEmailVerification, updatePassword, updateProfile,
} from 'firebase/auth';
import {
  collection, doc, getDocs, onSnapshot, query, serverTimestamp, setDoc, where, writeBatch,
} from 'firebase/firestore';
import { db } from '../../firebase';
import { Product } from '../../types';
import { getAuthErrorMessage } from '../auth/authErrorMessage';
import { reportClientIssue } from '../../services/observability/clientDiagnostics';
import {
  ACCOUNT_PAGE_TO_SECTION, ACCOUNT_SECTION_TO_PAGE, AccountSection, CustomerAddress, CustomerAddressDraft,
  CustomerNotificationSettings, CustomerOrderSummary, DEFAULT_NOTIFICATION_SETTINGS, EMPTY_ADDRESS_DRAFT,
  formatAccountDate, normalizeAddressDraft, normalizeNotificationSettings, sortCustomerAddresses,
  validateAddressDraft,
} from './accountData';
import './accountCenter.css';

interface AccountCenterProps {
  currentPage: string;
  user: User | null;
  wishlist: Product[];
  recentlyViewed: Product[];
  onNavigate: (page: string) => void;
  onOpenAuth: () => void;
  onViewProduct: (product: Product) => void;
}

interface CustomerProfileDocument {
  displayName?: string;
  phoneNumber?: string;
  customerSettings?: Partial<CustomerNotificationSettings>;
}

const DISTRICTS = [
  'Ampara', 'Anuradhapura', 'Badulla', 'Batticaloa', 'Colombo', 'Galle', 'Gampaha', 'Hambantota',
  'Jaffna', 'Kalutara', 'Kandy', 'Kegalle', 'Kilinochchi', 'Kurunegala', 'Mannar', 'Matale', 'Matara',
  'Monaragala', 'Mullaitivu', 'Nuwara Eliya', 'Polonnaruwa', 'Puttalam', 'Ratnapura', 'Trincomalee', 'Vavuniya',
];

const SECTION_COPY: Record<AccountSection, { eyebrow: string; title: string; description: string }> = {
  overview: { eyebrow: 'Account overview', title: 'Your Zyro.lk dashboard', description: 'Manage the details that make shopping faster and keep an eye on your marketplace activity.' },
  profile: { eyebrow: 'Personal details', title: 'Profile management', description: 'Keep your account identity and preferred contact number current.' },
  addresses: { eyebrow: 'Delivery details', title: 'Address book', description: 'Save multiple delivery addresses and choose one default shipping destination.' },
  security: { eyebrow: 'Account protection', title: 'Security & sign-in', description: 'Review your sign-in foundation, email status, and password security.' },
  settings: { eyebrow: 'Your preferences', title: 'Customer settings', description: 'Choose which useful marketplace updates you would like to receive.' },
};

const formatPrice = (amount: number) => new Intl.NumberFormat('en-LK', {
  style: 'currency', currency: 'LKR', minimumFractionDigits: 0, maximumFractionDigits: 0,
}).format(Number.isFinite(amount) ? amount : 0);

const safeOrder = (id: string, value: Record<string, unknown>): CustomerOrderSummary => ({
  id,
  orderNumber: typeof value.orderNumber === 'string' ? value.orderNumber : undefined,
  totalPrice: Number(value.totalPrice) || 0,
  status: typeof value.status === 'string' ? value.status : 'pending',
  createdAt: typeof value.createdAt === 'string' ? value.createdAt : undefined,
  itemsCount: Array.isArray(value.items)
    ? value.items.reduce((total, item) => total + Math.max(0, Number((item as { quantity?: unknown })?.quantity) || 0), 0)
    : 0,
});

const Skeleton = ({ rows = 3 }: { rows?: number }) => (
  <div className="zy-account-skeleton" role="status" aria-label="Loading account information">
    <span className="sr-only">Loading account information</span>
    {Array.from({ length: rows }, (_, index) => <i key={index} aria-hidden="true" />)}
  </div>
);

const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <label className="zy-account-field">
    <span>{label}</span>
    {children}
    {hint && <small>{hint}</small>}
  </label>
);

export default function AccountCenter({
  currentPage, user, wishlist, recentlyViewed, onNavigate, onOpenAuth, onViewProduct,
}: AccountCenterProps) {
  const section = ACCOUNT_PAGE_TO_SECTION[currentPage] || 'overview';
  const contentHeadingRef = useRef<HTMLHeadingElement>(null);
  const [profile, setProfile] = useState<CustomerProfileDocument>({});
  const [orders, setOrders] = useState<CustomerOrderSummary[]>([]);
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [loadingAddresses, setLoadingAddresses] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [profileForm, setProfileForm] = useState({ displayName: '', phoneNumber: '' });
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMessage, setProfileMessage] = useState('');
  const [profileError, setProfileError] = useState('');

  const [showAddressForm, setShowAddressForm] = useState(false);
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState<CustomerAddressDraft>(EMPTY_ADDRESS_DRAFT);
  const [addressSaving, setAddressSaving] = useState(false);
  const [addressError, setAddressError] = useState('');
  const [addressMessage, setAddressMessage] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const [notificationSettings, setNotificationSettings] = useState<CustomerNotificationSettings>(DEFAULT_NOTIFICATION_SETTINGS);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [settingsError, setSettingsError] = useState('');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [securitySaving, setSecuritySaving] = useState(false);
  const [securityMessage, setSecurityMessage] = useState('');
  const [securityError, setSecurityError] = useState('');
  const [verificationSending, setVerificationSending] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => contentHeadingRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [section]);

  useEffect(() => {
    if (!user) {
      setLoadingProfile(false);
      setLoadingOrders(false);
      setLoadingAddresses(false);
      return;
    }

    setLoadError('');
    setLoadingProfile(true);
    setLoadingOrders(true);
    setLoadingAddresses(true);

    const profileUnsubscribe = onSnapshot(doc(db, 'users', user.uid), snapshot => {
      const nextProfile = snapshot.exists() ? snapshot.data() as CustomerProfileDocument : {};
      setProfile(nextProfile);
      setProfileForm({
        displayName: nextProfile.displayName || user.displayName || '',
        phoneNumber: nextProfile.phoneNumber || '',
      });
      setNotificationSettings(normalizeNotificationSettings(nextProfile.customerSettings));
      setLoadingProfile(false);
    }, error => {
      reportClientIssue('account-profile-listener', error, 'warning');
      setLoadError('Your account details could not be refreshed. Please check your connection and try again.');
      setLoadingProfile(false);
    });

    const ordersUnsubscribe = onSnapshot(
      query(collection(db, 'orders'), where('customerUid', '==', user.uid)),
      snapshot => {
        const nextOrders = snapshot.docs
          .map(orderDoc => safeOrder(orderDoc.id, orderDoc.data()))
          .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());
        setOrders(nextOrders);
        setLoadingOrders(false);
      },
      error => {
        reportClientIssue('account-orders-listener', error, 'warning');
        setLoadError('Your orders could not be refreshed. Please check your connection and try again.');
        setLoadingOrders(false);
      },
    );

    const addressesUnsubscribe = onSnapshot(collection(db, 'users', user.uid, 'addresses'), snapshot => {
      setAddresses(sortCustomerAddresses(snapshot.docs.map(addressDoc => ({
        id: addressDoc.id,
        ...addressDoc.data(),
      } as CustomerAddress))));
      setLoadingAddresses(false);
    }, error => {
      reportClientIssue('account-addresses-listener', error, 'warning');
      setLoadError('Your addresses could not be refreshed. Please check your connection and try again.');
      setLoadingAddresses(false);
    });

    return () => {
      profileUnsubscribe();
      ordersUnsubscribe();
      addressesUnsubscribe();
    };
  }, [user]);

  const navigateSection = (nextSection: AccountSection) => onNavigate(ACCOUNT_SECTION_TO_PAGE[nextSection]);
  const hasPasswordProvider = Boolean(user?.providerData.some(provider => provider.providerId === 'password'));
  const profileComplete = Boolean((profile.displayName || user?.displayName) && profile.phoneNumber);

  const handleProfileSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!user || profileSaving) return;
    const displayName = profileForm.displayName.trim().replace(/\s+/gu, ' ').slice(0, 120);
    const phoneNumber = profileForm.phoneNumber.trim().slice(0, 30);
    const phoneDigits = phoneNumber.replace(/\D/gu, '');
    setProfileError('');
    setProfileMessage('');
    if (!displayName) return setProfileError('Display name is required.');
    if (phoneNumber && (phoneDigits.length < 9 || phoneDigits.length > 15)) return setProfileError('Enter a valid phone number.');

    setProfileSaving(true);
    try {
      await updateProfile(user, { displayName });
      await setDoc(doc(db, 'users', user.uid), { displayName, phoneNumber, updatedAt: serverTimestamp() }, { merge: true });
      setProfile(current => ({ ...current, displayName, phoneNumber }));
      setProfileMessage('Profile details updated successfully.');
    } catch (error) {
      reportClientIssue('account-profile-save', error, 'warning');
      setProfileError('Your profile could not be saved. Please try again.');
    } finally {
      setProfileSaving(false);
    }
  };

  const openNewAddress = () => {
    setEditingAddressId(null);
    setAddressDraft({ ...EMPTY_ADDRESS_DRAFT, fullName: profile.displayName || user?.displayName || '', phone: profile.phoneNumber || '', isDefault: addresses.length === 0 });
    setAddressError('');
    setAddressMessage('');
    setShowAddressForm(true);
  };

  const openAddressEdit = (address: CustomerAddress) => {
    setEditingAddressId(address.id);
    setAddressDraft(normalizeAddressDraft({
      label: address.label,
      fullName: address.fullName,
      phone: address.phone,
      addressLine1: address.addressLine1,
      addressLine2: address.addressLine2,
      city: address.city,
      district: address.district,
      postalCode: address.postalCode,
      isDefault: address.isDefault,
    }));
    setAddressError('');
    setAddressMessage('');
    setShowAddressForm(true);
  };

  const closeAddressForm = () => {
    setShowAddressForm(false);
    setEditingAddressId(null);
    setAddressDraft(EMPTY_ADDRESS_DRAFT);
    setAddressError('');
  };

  const handleAddressSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!user || addressSaving) return;
    const normalized = normalizeAddressDraft(addressDraft);
    const errors = validateAddressDraft(normalized);
    setAddressError('');
    setAddressMessage('');
    if (errors.length > 0) return setAddressError(errors[0]);

    setAddressSaving(true);
    try {
      const wasEditing = Boolean(editingAddressId);
      const addressesRef = collection(db, 'users', user.uid, 'addresses');
      const currentSnapshot = await getDocs(addressesRef);
      const addressRef = editingAddressId ? doc(addressesRef, editingAddressId) : doc(addressesRef);
      const shouldBeDefault = normalized.isDefault || currentSnapshot.empty;
      const batch = writeBatch(db);

      if (shouldBeDefault) {
        currentSnapshot.docs.forEach(existing => {
          if (existing.id !== addressRef.id && existing.data().isDefault === true) {
            batch.update(existing.ref, { isDefault: false, updatedAt: serverTimestamp() });
          }
        });
      }

      batch.set(addressRef, {
        ...normalized,
        isDefault: shouldBeDefault,
        ...(!editingAddressId ? { createdAt: serverTimestamp() } : {}),
        updatedAt: serverTimestamp(),
      }, { merge: Boolean(editingAddressId) });
      await batch.commit();
      closeAddressForm();
      setAddressMessage(wasEditing ? 'Address updated successfully.' : 'Address added successfully.');
    } catch (error) {
      reportClientIssue('account-address-save', error, 'warning');
      setAddressError('This address could not be saved. Please try again.');
    } finally {
      setAddressSaving(false);
    }
  };

  const handleSetDefaultAddress = async (addressId: string) => {
    if (!user) return;
    setAddressError('');
    try {
      const snapshot = await getDocs(collection(db, 'users', user.uid, 'addresses'));
      const batch = writeBatch(db);
      snapshot.docs.forEach(addressDoc => batch.update(addressDoc.ref, {
        isDefault: addressDoc.id === addressId,
        updatedAt: serverTimestamp(),
      }));
      await batch.commit();
      setAddressMessage('Default shipping address updated.');
    } catch (error) {
      reportClientIssue('account-address-default', error, 'warning');
      setAddressError('The default address could not be changed.');
    }
  };

  const handleDeleteAddress = async (address: CustomerAddress) => {
    if (!user || deleteConfirmId !== address.id) {
      setDeleteConfirmId(address.id);
      return;
    }
    setAddressError('');
    try {
      const snapshot = await getDocs(collection(db, 'users', user.uid, 'addresses'));
      const remaining = snapshot.docs.filter(addressDoc => addressDoc.id !== address.id);
      const batch = writeBatch(db);
      batch.delete(doc(db, 'users', user.uid, 'addresses', address.id));
      if (address.isDefault && remaining.length > 0) {
        batch.update(remaining[0].ref, { isDefault: true, updatedAt: serverTimestamp() });
      }
      await batch.commit();
      setDeleteConfirmId(null);
      setAddressMessage('Address deleted.');
    } catch (error) {
      reportClientIssue('account-address-delete', error, 'warning');
      setAddressError('This address could not be deleted.');
    }
  };

  const handleSettingsSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!user || settingsSaving) return;
    setSettingsSaving(true);
    setSettingsError('');
    setSettingsMessage('');
    try {
      await setDoc(doc(db, 'users', user.uid), {
        customerSettings: notificationSettings,
        updatedAt: serverTimestamp(),
      }, { merge: true });
      setSettingsMessage('Your communication preferences have been saved.');
    } catch (error) {
      reportClientIssue('account-settings-save', error, 'warning');
      setSettingsError('Your preferences could not be saved. Please try again.');
    } finally {
      setSettingsSaving(false);
    }
  };

  const handlePasswordChange = async (event: FormEvent) => {
    event.preventDefault();
    if (!user?.email || securitySaving) return;
    setSecurityError('');
    setSecurityMessage('');
    if (newPassword.length < 8) return setSecurityError('Your new password must contain at least 8 characters.');
    if (newPassword !== confirmPassword) return setSecurityError('New password confirmation does not match.');

    setSecuritySaving(true);
    try {
      const credential = EmailAuthProvider.credential(user.email, currentPassword);
      await reauthenticateWithCredential(user, credential);
      await updatePassword(user, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSecurityMessage('Password changed successfully.');
    } catch (error) {
      reportClientIssue('account-password-change', error, 'warning');
      setSecurityError(getAuthErrorMessage(error));
    } finally {
      setSecuritySaving(false);
    }
  };

  const handleVerificationEmail = async () => {
    if (!user || user.emailVerified || verificationSending) return;
    setVerificationSending(true);
    setSecurityError('');
    setSecurityMessage('');
    try {
      await sendEmailVerification(user);
      setSecurityMessage('Verification email sent. Follow the link in your inbox, then sign in again to refresh your status.');
    } catch (error) {
      reportClientIssue('account-email-verification', error, 'warning');
      setSecurityError(getAuthErrorMessage(error));
    } finally {
      setVerificationSending(false);
    }
  };

  if (!user) {
    return (
      <section className="zy-account-signed-out" aria-labelledby="account-sign-in-title">
        <span><LockKeyhole aria-hidden="true" /></span>
        <p className="zy-section-eyebrow">Customer account</p>
        <h1 id="account-sign-in-title">Sign in to open your Account Center.</h1>
        <p>Your wishlist remains on this device. Sign in to manage profile details, addresses, settings, and account security.</p>
        <button type="button" onClick={onOpenAuth}>Sign in or create account</button>
      </section>
    );
  }

  const navigationItems: Array<{ id: AccountSection; label: string; icon: typeof Home }> = [
    { id: 'overview', label: 'Overview', icon: Home },
    { id: 'profile', label: 'Profile', icon: UserRound },
    { id: 'addresses', label: 'Addresses', icon: MapPin },
    { id: 'security', label: 'Security', icon: ShieldCheck },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];
  const copy = SECTION_COPY[section];

  return (
    <div className="zy-account-center">
      <aside className="zy-account-sidebar" aria-label="Account sections">
        <div className="zy-account-identity">
          <div className="zy-account-avatar" aria-hidden="true">
            {user.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" /> : (profile.displayName || user.displayName || user.email || 'Z').slice(0, 1).toUpperCase()}
          </div>
          <div><small>Signed in as</small><strong>{profile.displayName || user.displayName || 'Zyro.lk Customer'}</strong><span>{user.email}</span></div>
        </div>
        <nav>
          {navigationItems.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" onClick={() => navigateSection(id)} className={section === id ? 'is-active' : ''} aria-current={section === id ? 'page' : undefined}>
              <Icon aria-hidden="true" /><span>{label}</span><ChevronRight aria-hidden="true" />
            </button>
          ))}
        </nav>
        <div className="zy-account-sidebar-note"><ShieldCheck aria-hidden="true" /><p><strong>Protected account</strong><span>Firebase Authentication secures your sign-in.</span></p></div>
      </aside>

      <section className="zy-account-content" aria-labelledby="account-content-title">
        <header className="zy-account-page-header">
          <p className="zy-section-eyebrow">{copy.eyebrow}</p>
          <h1 id="account-content-title" ref={contentHeadingRef} tabIndex={-1}>{copy.title}</h1>
          <p>{copy.description}</p>
        </header>

        {loadError && <div className="zy-account-alert is-error" role="alert"><span>{loadError}</span><button type="button" onClick={() => window.location.reload()}>Retry</button></div>}

        {section === 'overview' && (
          <div className="zy-account-overview">
            <div className="zy-account-overview-cards">
              <button type="button" onClick={() => navigateSection('profile')}><span><UserRound /></span><small>Profile</small><strong>{profileComplete ? 'Complete' : 'Needs attention'}</strong><p>{profile.phoneNumber || 'Add your phone number'}</p></button>
              <button type="button" onClick={() => document.getElementById('account-recent-orders')?.scrollIntoView({ behavior: 'smooth' })}><span><PackageCheck /></span><small>Orders</small><strong>{loadingOrders ? '-' : orders.length}</strong><p>{orders.length === 1 ? 'Order placed' : 'Orders placed'}</p></button>
              <button type="button" onClick={() => onNavigate('wishlist')}><span><Heart /></span><small>Wishlist</small><strong>{wishlist.length}</strong><p>{wishlist.length === 1 ? 'Saved product' : 'Saved products'}</p></button>
              <button type="button" onClick={() => document.getElementById('account-recently-viewed')?.scrollIntoView({ behavior: 'smooth' })}><span><Clock3 /></span><small>Recently viewed</small><strong>{recentlyViewed.length}</strong><p>Device-local history</p></button>
            </div>

            <div className="zy-account-panel" id="account-recent-orders">
              <div className="zy-account-panel-heading"><div><small>Order activity</small><h2>Recent orders</h2></div><ShoppingBag aria-hidden="true" /></div>
              {loadingOrders ? <Skeleton rows={3} /> : orders.length === 0 ? (
                <div className="zy-account-empty"><PackageCheck /><strong>No orders yet</strong><p>Your completed Zyro.lk orders will appear here.</p><button type="button" onClick={() => onNavigate('products')}>Browse products</button></div>
              ) : (
                <div className="zy-account-order-list">
                  {orders.slice(0, 4).map(order => <article key={order.id}><div><small>{order.orderNumber || `Order ${order.id.slice(0, 8).toUpperCase()}`}</small><strong>{formatPrice(order.totalPrice)}</strong><span>{formatAccountDate(order.createdAt)}</span></div><div><b className={`status-${order.status.toLowerCase().replace(/[^a-z]/gu, '')}`}>{order.status}</b><span>{order.itemsCount} {order.itemsCount === 1 ? 'item' : 'items'}</span></div></article>)}
                </div>
              )}
            </div>

            <div className="zy-account-panel" id="account-recently-viewed">
              <div className="zy-account-panel-heading"><div><small>Continue browsing</small><h2>Recently viewed</h2></div><Clock3 aria-hidden="true" /></div>
              {recentlyViewed.length === 0 ? <div className="zy-account-empty is-compact"><Clock3 /><strong>No recently viewed products</strong><p>Products you open will appear here on this device.</p></div> : (
                <div className="zy-account-product-strip">
                  {recentlyViewed.map(product => <button type="button" key={product.id} onClick={() => onViewProduct(product)}><span><img src={product.imageUrl || '/logo.png'} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /></span><strong>{product.name}</strong><small>{formatPrice(product.price)}</small></button>)}
                </div>
              )}
            </div>
          </div>
        )}

        {section === 'profile' && (
          loadingProfile ? <Skeleton rows={5} /> : <div className="zy-account-form-card">
            <div className="zy-account-profile-hero"><div className="zy-account-avatar is-large" aria-hidden="true">{user.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" /> : (profileForm.displayName || user.email || 'Z').slice(0, 1).toUpperCase()}</div><div><strong>{profileForm.displayName || 'Zyro.lk Customer'}</strong><span>Avatar upload will be available in a future account phase.</span></div><span className="zy-account-foundation-badge">Avatar placeholder</span></div>
            <form onSubmit={handleProfileSave} className="zy-account-form-grid">
              <Field label="Display name"><input value={profileForm.displayName} onChange={event => setProfileForm(current => ({ ...current, displayName: event.target.value }))} maxLength={120} autoComplete="name" required /></Field>
              <Field label="Phone number" hint="Used as a convenient account contact; checkout details remain unchanged."><input value={profileForm.phoneNumber} onChange={event => setProfileForm(current => ({ ...current, phoneNumber: event.target.value }))} maxLength={30} inputMode="tel" autoComplete="tel" /></Field>
              <Field label="Email address"><input value={user.email || ''} readOnly aria-readonly="true" /></Field>
              <Field label="Member since"><input value={formatAccountDate(user.metadata.creationTime)} readOnly aria-readonly="true" /></Field>
              <div className="zy-account-form-actions">{profileError && <p role="alert" className="is-error">{profileError}</p>}{profileMessage && <p role="status" className="is-success">{profileMessage}</p>}<button type="submit" disabled={profileSaving}>{profileSaving ? <LoaderCircle className="animate-spin" /> : <Save />} {profileSaving ? 'Saving profile' : 'Save profile'}</button></div>
            </form>
          </div>
        )}

        {section === 'addresses' && (
          <div className="zy-account-address-book">
            <div className="zy-account-toolbar"><div><strong>{addresses.length} saved {addresses.length === 1 ? 'address' : 'addresses'}</strong><span>Only your authenticated account can access this address book.</span></div><button type="button" onClick={openNewAddress}><Plus /> Add address</button></div>
            {addressError && <div className="zy-account-alert is-error" role="alert">{addressError}</div>}
            {addressMessage && <div className="zy-account-alert is-success" role="status">{addressMessage}</div>}
            {showAddressForm && (
              <form className="zy-account-form-card zy-address-form" onSubmit={handleAddressSave}>
                <div className="zy-account-panel-heading"><div><small>Shipping destination</small><h2>{editingAddressId ? 'Edit address' : 'Add a new address'}</h2></div><button type="button" onClick={closeAddressForm} aria-label="Close address form"><X /></button></div>
                <div className="zy-account-form-grid">
                  <Field label="Address label"><input value={addressDraft.label} onChange={event => setAddressDraft(current => ({ ...current, label: event.target.value }))} maxLength={40} placeholder="Home, Work, Family" required /></Field>
                  <Field label="Recipient name"><input value={addressDraft.fullName} onChange={event => setAddressDraft(current => ({ ...current, fullName: event.target.value }))} maxLength={120} autoComplete="name" required /></Field>
                  <Field label="Phone number"><input value={addressDraft.phone} onChange={event => setAddressDraft(current => ({ ...current, phone: event.target.value }))} maxLength={30} inputMode="tel" autoComplete="tel" required /></Field>
                  <Field label="Address line 1"><input value={addressDraft.addressLine1} onChange={event => setAddressDraft(current => ({ ...current, addressLine1: event.target.value }))} maxLength={240} autoComplete="address-line1" required /></Field>
                  <Field label="Address line 2"><input value={addressDraft.addressLine2} onChange={event => setAddressDraft(current => ({ ...current, addressLine2: event.target.value }))} maxLength={240} autoComplete="address-line2" /></Field>
                  <Field label="City"><input value={addressDraft.city} onChange={event => setAddressDraft(current => ({ ...current, city: event.target.value }))} maxLength={80} autoComplete="address-level2" required /></Field>
                  <Field label="District"><select value={addressDraft.district} onChange={event => setAddressDraft(current => ({ ...current, district: event.target.value }))} autoComplete="address-level1" required>{DISTRICTS.map(district => <option key={district}>{district}</option>)}</select></Field>
                  <Field label="Postal code"><input value={addressDraft.postalCode} onChange={event => setAddressDraft(current => ({ ...current, postalCode: event.target.value }))} maxLength={20} inputMode="numeric" autoComplete="postal-code" /></Field>
                  <label className="zy-account-check"><input type="checkbox" checked={addressDraft.isDefault} onChange={event => setAddressDraft(current => ({ ...current, isDefault: event.target.checked }))} /><span><strong>Set as default shipping address</strong><small>This is a preference only; checkout continues to use its existing delivery form.</small></span></label>
                  <div className="zy-account-form-actions"><button type="button" className="is-secondary" onClick={closeAddressForm}>Cancel</button><button type="submit" disabled={addressSaving}>{addressSaving ? <LoaderCircle className="animate-spin" /> : <Save />} {addressSaving ? 'Saving address' : 'Save address'}</button></div>
                </div>
              </form>
            )}
            {loadingAddresses ? <Skeleton rows={4} /> : addresses.length === 0 && !showAddressForm ? (
              <div className="zy-account-empty"><BookOpen /><strong>Your address book is empty</strong><p>Add a delivery address for faster reference during future shopping.</p><button type="button" onClick={openNewAddress}>Add your first address</button></div>
            ) : (
              <div className="zy-account-address-grid">
                {addresses.map(address => <article key={address.id} className={address.isDefault ? 'is-default' : ''}><header><span><MapPin /></span><div><small>{address.label}</small><strong>{address.fullName}</strong></div>{address.isDefault && <b><Check /> Default</b>}</header><p>{address.addressLine1}{address.addressLine2 ? `, ${address.addressLine2}` : ''}<br />{address.city}, {address.district}{address.postalCode ? ` ${address.postalCode}` : ''}</p><a href={`tel:${address.phone.replace(/[^0-9+]/gu, '')}`}>{address.phone}</a><footer><button type="button" onClick={() => openAddressEdit(address)}><Edit3 /> Edit</button>{!address.isDefault && <button type="button" onClick={() => handleSetDefaultAddress(address.id)}><Home /> Make default</button>}<button type="button" className="is-danger" onClick={() => handleDeleteAddress(address)}><Trash2 /> {deleteConfirmId === address.id ? 'Confirm delete' : 'Delete'}</button></footer></article>)}
              </div>
            )}
          </div>
        )}

        {section === 'security' && (
          <div className="zy-account-security-grid">
            {(securityError || securityMessage) && <div className={`zy-account-alert ${securityError ? 'is-error' : 'is-success'} zy-account-security-alert`} role={securityError ? 'alert' : 'status'}>{securityError || securityMessage}</div>}
            <section className="zy-account-form-card"><div className="zy-account-panel-heading"><div><small>Email protection</small><h2>Verification status</h2></div><MailCheck /></div><div className={`zy-account-verification ${user.emailVerified ? 'is-verified' : ''}`}><span>{user.emailVerified ? <Check /> : <MailCheck />}</span><div><strong>{user.emailVerified ? 'Email verified' : 'Verification recommended'}</strong><p>{user.email}</p></div></div>{!user.emailVerified && <button type="button" className="zy-account-primary-action" onClick={handleVerificationEmail} disabled={verificationSending}>{verificationSending ? <LoaderCircle className="animate-spin" /> : <MailCheck />} {verificationSending ? 'Sending email' : 'Send verification email'}</button>}</section>
            <section className="zy-account-form-card"><div className="zy-account-panel-heading"><div><small>Recent access</small><h2>Login information</h2></div><Clock3 /></div><dl className="zy-account-login-facts"><div><dt>Last sign-in</dt><dd>{formatAccountDate(user.metadata.lastSignInTime)}</dd></div><div><dt>Account created</dt><dd>{formatAccountDate(user.metadata.creationTime)}</dd></div><div><dt>Sign-in providers</dt><dd>{user.providerData.map(provider => provider.providerId === 'password' ? 'Email & password' : provider.providerId).join(', ') || 'Not available'}</dd></div></dl><p className="zy-account-foundation-note">Phase 1 shows Firebase’s latest account metadata. Device-level session history is not stored yet.</p></section>
            <section className="zy-account-form-card zy-account-password-card"><div className="zy-account-panel-heading"><div><small>Password security</small><h2>Change password</h2></div><KeyRound /></div>{hasPasswordProvider ? <form onSubmit={handlePasswordChange} className="zy-account-form-grid"><Field label="Current password"><input type="password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} autoComplete="current-password" required /></Field><Field label="New password" hint="Use at least 8 characters."><input type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} autoComplete="new-password" minLength={8} required /></Field><Field label="Confirm new password"><input type="password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} required /></Field><div className="zy-account-form-actions"><button type="submit" disabled={securitySaving}>{securitySaving ? <LoaderCircle className="animate-spin" /> : <KeyRound />} {securitySaving ? 'Updating password' : 'Update password'}</button></div></form> : <div className="zy-account-empty is-compact"><ShieldCheck /><strong>Password managed by your sign-in provider</strong><p>This account uses Google or another federated provider. Manage its password with that provider.</p></div>}</section>
          </div>
        )}

        {section === 'settings' && (
          loadingProfile ? <Skeleton rows={4} /> : <form className="zy-account-form-card zy-account-settings" onSubmit={handleSettingsSave}>
            <div className="zy-account-panel-heading"><div><small>Communication controls</small><h2>Notification preferences</h2></div><Bell /></div>
            {([
              ['orderUpdates', 'Order updates', 'Receive important order status and delivery messages.', PackageCheck],
              ['wishlistUpdates', 'Wishlist updates', 'Receive useful changes related to products you saved.', Heart],
              ['promotions', 'Marketplace promotions', 'Receive occasional promotional announcements.', Bell],
              ['marketingEmail', 'Marketing email opt-in', 'Allow Zyro.lk to send marketing emails to your account address.', MailCheck],
            ] as const).map(([key, title, description, Icon]) => <label className="zy-account-setting-row" key={key}><span><Icon /></span><div><strong>{title}</strong><p>{description}</p></div><input type="checkbox" checked={notificationSettings[key]} onChange={event => setNotificationSettings(current => ({ ...current, [key]: event.target.checked }))} aria-label={title} /></label>)}
            <p className="zy-account-foundation-note">These preferences are stored now as a Phase 1 foundation. Automated notification delivery will be connected in a future communications sprint.</p>
            <div className="zy-account-form-actions">{settingsError && <p role="alert" className="is-error">{settingsError}</p>}{settingsMessage && <p role="status" className="is-success">{settingsMessage}</p>}<button type="submit" disabled={settingsSaving}>{settingsSaving ? <LoaderCircle className="animate-spin" /> : <Save />} {settingsSaving ? 'Saving preferences' : 'Save preferences'}</button></div>
          </form>
        )}
      </section>
    </div>
  );
}
