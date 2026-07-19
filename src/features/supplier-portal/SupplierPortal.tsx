import { useCallback, useEffect, useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import { signOut } from 'firebase/auth';
import {
  AlertTriangle, Bell, Boxes, Building2, CheckCircle2, CircleDollarSign, ClipboardList,
  Clock3, Edit3, LayoutDashboard, LogOut, Package, Plus, RefreshCw, Save, Send,
  ShoppingBag, XCircle,
} from 'lucide-react';
import { auth } from '../../firebase';
import {
  loadSupplierPortal, markSupplierNotificationRead, proposeSupplierStock, saveSupplierProductDraft,
  saveSupplierProfile, submitSupplierProductRequest, updateSupplierFulfilment,
} from './supplierPortalApi';
import type {
  SupplierPortalData, SupplierPortalOrder, SupplierPortalProduct, SupplierProductDraft, SupplierProductRequest,
} from './types';

interface SupplierPortalProps {
  user: User;
}

type PortalTab = 'dashboard' | 'profile' | 'products' | 'orders' | 'notifications';

const emptyDraft = (): SupplierProductDraft => ({
  name: '', supplierSku: '', brand: '', model: '', barcode: '', productType: '', category: '', subcategory: '',
  description: '', shortDescription: '', price: 0, stock: 0, imageUrl: '', imageUrls: [], tags: [], keyFeatures: [],
  whatsIncluded: [], specs: {},
});

const formatCurrency = (value: number): string => new Intl.NumberFormat('en-LK', {
  style: 'currency', currency: 'LKR', maximumFractionDigits: 0,
}).format(value || 0);

const formatDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleString('en-LK', { dateStyle: 'medium', timeStyle: 'short' });
};

const listText = (values: string[]): string => values.join(', ');
const parseList = (value: string): string[] => [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];

const StatusPill = ({ status }: { status: string }) => {
  const tone = status === 'approved' || status === 'active' || status === 'shipped'
    ? 'bg-emerald-100 text-emerald-700'
    : status === 'rejected' || status === 'suspended'
      ? 'bg-red-100 text-red-700'
      : 'bg-amber-100 text-amber-700';
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${tone}`}>{status.replaceAll('_', ' ')}</span>;
};

export default function SupplierPortal({ user }: SupplierPortalProps) {
  const [tab, setTab] = useState<PortalTab>('dashboard');
  const [data, setData] = useState<SupplierPortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [showProductEditor, setShowProductEditor] = useState(false);
  const [editingRequestId, setEditingRequestId] = useState('');
  const [editingProductId, setEditingProductId] = useState('');
  const [requestType, setRequestType] = useState<'new_product' | 'product_change'>('new_product');
  const [productDraft, setProductDraft] = useState<SupplierProductDraft>(emptyDraft);
  const [stockDrafts, setStockDrafts] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await loadSupplierPortal(user));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Supplier Hub could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { void refresh(); }, [refresh]);

  const selectedCategory = data?.catalog.categories.find((category) => category.id === productDraft.category);
  const isProfileActive = data?.profile.profileStatus === 'active';

  const runAction = async (key: string, action: () => Promise<void>, successMessage: string) => {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(successMessage);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The action could not be completed.');
    } finally {
      setBusy('');
    }
  };

  const openNewProduct = () => {
    setProductDraft(emptyDraft());
    setEditingRequestId('');
    setEditingProductId('');
    setRequestType('new_product');
    setShowProductEditor(true);
  };

  const draftFromProduct = (product: Partial<SupplierPortalProduct>, supplierSku: string): SupplierProductDraft => ({
    ...emptyDraft(),
    name: product.name || '', supplierSku, brand: product.brand || '', model: product.model || '', barcode: product.barcode || '',
    productType: product.productType || '', category: product.category || '', subcategory: product.subcategory || '',
    description: product.description || '', shortDescription: product.shortDescription || '', price: Number(product.price || 0),
    stock: Number(product.stock || 0), imageUrl: product.imageUrl || '', imageUrls: product.imageUrls || [], tags: product.tags || [],
    keyFeatures: product.keyFeatures || [], whatsIncluded: product.whatsIncluded || [], specs: product.specs || {},
  });

  const openDraftRequest = (request: SupplierProductRequest) => {
    setProductDraft(draftFromProduct(request.productPayload, request.supplierSku));
    setEditingRequestId(request.id);
    setEditingProductId(request.productId);
    setRequestType(request.requestType === 'product_change' ? 'product_change' : 'new_product');
    setShowProductEditor(true);
  };

  const openProductChange = (product: SupplierPortalProduct) => {
    setProductDraft(draftFromProduct(product, product.supplierItemCode || product.sku));
    setEditingRequestId('');
    setEditingProductId(product.id);
    setRequestType('product_change');
    setShowProductEditor(true);
  };

  const saveDraft = async () => {
    await runAction('save-product', async () => {
      const result = await saveSupplierProductDraft(user, {
        ...(editingRequestId ? { requestId: editingRequestId } : {}),
        requestType,
        ...(editingProductId ? { productId: editingProductId } : {}),
        draft: productDraft,
      });
      setEditingRequestId(result.requestId);
      setShowProductEditor(false);
    }, 'Product draft saved. Submit it when the product information is complete.');
  };

  const tabs: Array<{ id: PortalTab; label: string; icon: typeof LayoutDashboard }> = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'profile', label: 'Profile', icon: Building2 },
    { id: 'products', label: 'Products', icon: Package },
    { id: 'orders', label: 'Orders', icon: ClipboardList },
    { id: 'notifications', label: 'Notifications', icon: Bell },
  ];

  const metricCards = data ? [
    ['Total Products', data.summary.totalProducts, Package],
    ['Pending Products', data.summary.pendingProducts, Clock3],
    ['Approved Products', data.summary.approvedProducts, CheckCircle2],
    ['Rejected Products', data.summary.rejectedProducts, XCircle],
    ['Active Orders', data.summary.activeOrders, ShoppingBag],
    ['Monthly Sales', formatCurrency(data.summary.monthlySales), CircleDollarSign],
    ['Low Stock Products', data.summary.lowStockProducts, AlertTriangle],
  ] as const : [];

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <a href="#supplier-main" className="zy-skip-link">Skip to Supplier Hub content</a>
      <header className="border-b border-slate-200 bg-slate-950 text-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-300">Zyro.lk</p>
            <h1 className="text-lg font-black">Supplier Hub</h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block"><p className="text-xs font-bold">{data?.profile.companyName || user.email}</p><p className="text-[10px] text-slate-400">{data?.profile.profileStatus || 'Loading profile'}</p></div>
            <button type="button" onClick={() => void signOut(auth)} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-slate-700 px-3 text-xs font-bold hover:bg-slate-800"><LogOut className="h-4 w-4" aria-hidden="true" /> Sign out</button>
          </div>
        </div>
      </header>

      <nav className="sticky top-0 z-20 overflow-x-auto border-b border-slate-200 bg-white" aria-label="Supplier Hub sections">
        <div className="mx-auto flex max-w-7xl min-w-max gap-1 px-3 py-2 sm:px-6">
          {tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined} className={`inline-flex min-h-10 items-center gap-2 rounded-xl px-3 text-xs font-bold ${tab === id ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}><Icon className="h-4 w-4" aria-hidden="true" />{label}</button>)}
        </div>
      </nav>

      <main id="supplier-main" tabIndex={-1} className="mx-auto max-w-7xl px-4 py-6 outline-none sm:px-6 sm:py-8">
        {error && <div role="alert" className="mb-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">{error}</div>}
        {notice && <div role="status" className="mb-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-700">{notice}</div>}
        {loading && !data ? <div role="status" aria-label="Loading Supplier Hub" className="grid animate-pulse gap-4 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 7 }, (_, index) => <div key={index} className="h-28 rounded-2xl bg-white" />)}</div> : null}

        {data && tab === 'dashboard' && <section aria-labelledby="supplier-dashboard-title">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-wider text-blue-600">Launch operations</p><h2 id="supplier-dashboard-title" className="mt-1 text-2xl font-black">Supplier Dashboard</h2></div><button type="button" onClick={() => void refresh()} disabled={loading} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-xs font-bold disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />Refresh</button></div>
          {!isProfileActive && <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"><strong>Profile status: {data.profile.profileStatus}.</strong> Product submissions and fulfilment updates require an active supplier profile.</div>}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{metricCards.map(([label, value, Icon]) => <article key={label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center justify-between"><p className="text-xs font-bold text-slate-500">{label}</p><Icon className="h-5 w-5 text-blue-600" aria-hidden="true" /></div><p className="mt-4 text-2xl font-black">{value}</p></article>)}</div>
        </section>}

        {data && tab === 'profile' && <section aria-labelledby="supplier-profile-title" className="max-w-4xl">
          <div className="mb-6"><p className="text-xs font-black uppercase tracking-wider text-blue-600">Supplier identity</p><h2 id="supplier-profile-title" className="mt-1 text-2xl font-black">Company Profile</h2></div>
          <form className="grid gap-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:grid-cols-2 sm:p-7" onSubmit={(event) => { event.preventDefault(); void runAction('profile', () => saveSupplierProfile(user, data.profile).then(() => undefined), 'Supplier profile saved.'); }}>
            {([['companyName', 'Company Name'], ['contactPerson', 'Contact Person'], ['phone', 'Phone'], ['email', 'Email'], ['businessRegistrationNumber', 'Business Registration Number (optional)']] as const).map(([field, label]) => <label key={field} className="text-xs font-bold text-slate-600">{label}<input required={field !== 'businessRegistrationNumber'} readOnly={field === 'email'} value={data.profile[field]} onChange={(event) => setData((current) => current ? { ...current, profile: { ...current.profile, [field]: event.target.value } } : current)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm font-medium outline-none focus:border-blue-500 read-only:bg-slate-100" /></label>)}
            <label className="text-xs font-bold text-slate-600 sm:col-span-2">Address<textarea required maxLength={500} value={data.profile.address} onChange={(event) => setData((current) => current ? { ...current, profile: { ...current.profile, address: event.target.value } } : current)} className="mt-2 min-h-24 w-full rounded-xl border border-slate-200 p-3 text-sm font-medium outline-none focus:border-blue-500" /></label>
            <fieldset className="grid gap-4 rounded-2xl border border-slate-200 p-4 sm:col-span-2 sm:grid-cols-2"><legend className="px-2 text-xs font-black text-slate-700">Bank details</legend>{([['accountHolderName', 'Account Holder'], ['bankName', 'Bank Name'], ['branchName', 'Branch'], ['accountNumber', 'Account Number']] as const).map(([field, label]) => <label key={field} className="text-xs font-bold text-slate-600">{label}<input value={data.profile.bankDetails[field] || ''} onChange={(event) => setData((current) => current ? { ...current, profile: { ...current.profile, bankDetails: { ...current.profile.bankDetails, [field]: event.target.value } } } : current)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm font-medium outline-none focus:border-blue-500" /></label>)}</fieldset>
            <div className="flex items-center justify-between gap-3 sm:col-span-2"><div><span className="mr-2 text-xs font-bold text-slate-500">Profile Status</span><StatusPill status={data.profile.profileStatus} /></div><button type="submit" disabled={busy === 'profile'} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-5 text-xs font-black text-white disabled:opacity-50"><Save className="h-4 w-4" aria-hidden="true" />Save Profile</button></div>
          </form>
        </section>}

        {data && tab === 'products' && <section aria-labelledby="supplier-products-title">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-wider text-blue-600">Approval-first catalogue</p><h2 id="supplier-products-title" className="mt-1 text-2xl font-black">Product Management</h2></div><button type="button" onClick={openNewProduct} disabled={!isProfileActive} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-5 text-xs font-black text-white disabled:opacity-50"><Plus className="h-4 w-4" aria-hidden="true" />Add Product</button></div>
          <div className="space-y-6">
            <div><h3 className="mb-3 text-sm font-black">Approval Requests</h3>{data.requests.length ? <div className="grid gap-3">{data.requests.map((request) => <article key={request.id} className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex flex-wrap items-center gap-2"><h4 className="font-black">{request.productName || 'Untitled draft'}</h4><StatusPill status={request.status} /></div><p className="mt-1 text-xs text-slate-500">SKU {request.supplierSku || 'Not set'} · {request.requestType.replaceAll('_', ' ')}</p>{request.rejectionReason && <p className="mt-2 rounded-lg bg-red-50 p-2 text-xs font-semibold text-red-700">{request.rejectionReason}</p>}</div><div className="flex gap-2">{request.status === 'draft' && <><button type="button" onClick={() => openDraftRequest(request)} className="inline-flex min-h-10 items-center gap-1 rounded-xl border border-slate-200 px-3 text-xs font-bold"><Edit3 className="h-3.5 w-3.5" aria-hidden="true" />Edit</button><button type="button" onClick={() => void runAction(`submit-${request.id}`, () => submitSupplierProductRequest(user, request.id).then(() => undefined), 'Product submitted for admin approval.')} disabled={busy === `submit-${request.id}`} className="inline-flex min-h-10 items-center gap-1 rounded-xl bg-emerald-600 px-3 text-xs font-bold text-white disabled:opacity-50"><Send className="h-3.5 w-3.5" aria-hidden="true" />Submit</button></>}</div></article>)}</div> : <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">No product requests yet.</div>}</div>
            <div><h3 className="mb-3 text-sm font-black">Approved Products</h3>{data.products.length ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{data.products.map((product) => <article key={product.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white"><img src={product.imageUrl} alt="" loading="lazy" className="h-40 w-full object-cover" /><div className="p-4"><div className="flex justify-between gap-3"><h4 className="font-black">{product.name}</h4>{product.stock <= product.lowStockLimit && <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" aria-label="Low stock" />}</div><p className="mt-1 text-xs text-slate-500">Stock {product.stock} · {formatCurrency(product.price)}</p><div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => openProductChange(product)} className="min-h-10 rounded-xl border border-slate-200 px-3 text-xs font-bold">Request Changes</button><input aria-label={`Proposed stock for ${product.name}`} inputMode="numeric" value={stockDrafts[product.id] ?? String(product.stock)} onChange={(event) => setStockDrafts((current) => ({ ...current, [product.id]: event.target.value }))} className="w-20 rounded-xl border border-slate-200 px-2 text-xs" /><button type="button" onClick={() => void runAction(`stock-${product.id}`, () => proposeSupplierStock(user, product.id, Number(stockDrafts[product.id] ?? product.stock)).then(() => undefined), 'Stock proposal sent for review.')} disabled={busy === `stock-${product.id}`} className="min-h-10 rounded-xl bg-slate-900 px-3 text-xs font-bold text-white disabled:opacity-50">Propose Stock</button></div></div></article>)}</div> : <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">No approved products are assigned to this supplier account.</div>}</div>
          </div>
        </section>}

        {data && tab === 'orders' && <section aria-labelledby="supplier-orders-title"><div className="mb-6"><p className="text-xs font-black uppercase tracking-wider text-blue-600">Assigned fulfilment</p><h2 id="supplier-orders-title" className="mt-1 text-2xl font-black">Orders</h2></div>{data.orders.length ? <div className="space-y-4">{data.orders.map((order) => <OrderCard key={order.id} order={order} busy={busy} onStatus={(status) => runAction(`order-${order.id}`, () => updateSupplierFulfilment(user, order.id, status).then(() => undefined), `Order ${order.orderNumber} moved to ${status}.`)} />)}</div> : <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">No orders are assigned to your supplier account.</div>}</section>}

        {data && tab === 'notifications' && <section aria-labelledby="supplier-notifications-title"><div className="mb-6"><p className="text-xs font-black uppercase tracking-wider text-blue-600">Operational updates</p><h2 id="supplier-notifications-title" className="mt-1 text-2xl font-black">Notifications</h2></div>{data.notifications.length ? <div className="space-y-3">{data.notifications.map((notification) => <article key={notification.id} className={`rounded-2xl border p-4 ${notification.isRead ? 'border-slate-200 bg-white' : 'border-blue-200 bg-blue-50'}`}><div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2"><Bell className="h-4 w-4 text-blue-600" aria-hidden="true" /><h3 className="text-sm font-black">{notification.title}</h3></div><p className="mt-2 text-sm text-slate-600">{notification.message}</p><p className="mt-2 text-[10px] font-bold text-slate-400">{formatDate(notification.createdAt)}</p></div>{!notification.isRead && !notification.id.startsWith('order-') && !notification.id.startsWith('stock-') && <button type="button" onClick={() => void runAction(`notification-${notification.id}`, () => markSupplierNotificationRead(user, notification.id).then(() => undefined), 'Notification marked as read.')} className="shrink-0 rounded-lg border border-blue-200 px-2 py-1 text-[10px] font-bold text-blue-700">Mark read</button>}</div></article>)}</div> : <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">No supplier notifications yet.</div>}</section>}
      </main>

      {showProductEditor && data && <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/75 p-3 backdrop-blur-sm sm:p-6" role="dialog" aria-modal="true" aria-labelledby="supplier-product-editor-title"><div className="mx-auto max-w-4xl rounded-3xl bg-white p-5 shadow-2xl sm:p-7"><div className="mb-5 flex items-start justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-wider text-blue-600">{requestType === 'new_product' ? 'New product request' : 'Approved product change request'}</p><h2 id="supplier-product-editor-title" className="mt-1 text-xl font-black">Product Editor</h2><p className="mt-1 text-xs text-slate-500">Saving creates a draft only. Publishing always requires administrator approval.</p></div><button type="button" onClick={() => setShowProductEditor(false)} className="rounded-xl border border-slate-200 p-2" aria-label="Close product editor"><XCircle className="h-5 w-5" /></button></div><form className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void saveDraft(); }}>
        {([['name', 'Product Name'], ['supplierSku', 'Supplier SKU'], ['model', 'Model'], ['barcode', 'Barcode'], ['productType', 'Product Type'], ['imageUrl', 'Main Image URL']] as const).map(([field, label]) => <label key={field} className="text-xs font-bold text-slate-600">{label}<input required={['name', 'supplierSku', 'productType', 'imageUrl'].includes(field)} readOnly={requestType === 'product_change' && field === 'supplierSku'} value={String(productDraft[field])} onChange={(event) => setProductDraft((current) => ({ ...current, [field]: event.target.value }))} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-blue-500 read-only:bg-slate-100" /></label>)}
        <label className="text-xs font-bold text-slate-600">Registered Brand<select required value={productDraft.brand} onChange={(event) => setProductDraft((current) => ({ ...current, brand: event.target.value }))} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm"><option value="">Select brand</option>{data.catalog.brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</select></label>
        <label className="text-xs font-bold text-slate-600">Category<select required value={productDraft.category} onChange={(event) => { const category = data.catalog.categories.find((item) => item.id === event.target.value); setProductDraft((current) => ({ ...current, category: event.target.value, subcategory: '', specs: Object.fromEntries((category?.specificationTemplate || []).map((field) => [field.name, current.specs[field.name] || ''])) })); }} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm"><option value="">Select category</option>{data.catalog.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <label className="text-xs font-bold text-slate-600">Subcategory<select required value={productDraft.subcategory} onChange={(event) => setProductDraft((current) => ({ ...current, subcategory: event.target.value }))} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm"><option value="">Select subcategory</option>{selectedCategory?.subcategories.filter((subcategory) => subcategory.isActive !== false).map((subcategory) => <option key={subcategory.id} value={subcategory.id}>{subcategory.name}</option>)}</select></label>
        <label className="text-xs font-bold text-slate-600">Proposed Selling Price<input required min="0.01" step="0.01" type="number" value={productDraft.price} onChange={(event) => setProductDraft((current) => ({ ...current, price: Number(event.target.value) }))} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" /></label><label className="text-xs font-bold text-slate-600">Available Stock<input required min="0" step="1" type="number" value={productDraft.stock} onChange={(event) => setProductDraft((current) => ({ ...current, stock: Number(event.target.value) }))} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" /></label>
        <label className="text-xs font-bold text-slate-600 sm:col-span-2">Short Description<input maxLength={500} value={productDraft.shortDescription} onChange={(event) => setProductDraft((current) => ({ ...current, shortDescription: event.target.value }))} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" /></label><label className="text-xs font-bold text-slate-600 sm:col-span-2">Full Description<textarea required maxLength={10000} value={productDraft.description} onChange={(event) => setProductDraft((current) => ({ ...current, description: event.target.value }))} className="mt-2 min-h-28 w-full rounded-xl border border-slate-200 p-3 text-sm" /></label>
        {([['imageUrls', 'Gallery Image URLs'], ['tags', 'Tags'], ['keyFeatures', 'Key Features'], ['whatsIncluded', "What's Included"]] as const).map(([field, label]) => <label key={field} className="text-xs font-bold text-slate-600">{label} <span className="font-normal text-slate-400">(comma separated)</span><input value={listText(productDraft[field])} onChange={(event) => setProductDraft((current) => ({ ...current, [field]: parseList(event.target.value) }))} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" /></label>)}
        {selectedCategory?.specificationTemplate.length ? <fieldset className="grid gap-4 rounded-2xl border border-slate-200 p-4 sm:col-span-2 sm:grid-cols-2"><legend className="px-2 text-xs font-black">Category Specifications</legend>{selectedCategory.specificationTemplate.map((field) => <label key={field.name} className="text-xs font-bold text-slate-600">{field.name}{field.required ? ' *' : ''}<input required={field.required} value={productDraft.specs[field.name] || ''} onChange={(event) => setProductDraft((current) => ({ ...current, specs: { ...current.specs, [field.name]: event.target.value } }))} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" /></label>)}</fieldset> : null}
        <div className="flex justify-end gap-2 sm:col-span-2"><button type="button" onClick={() => setShowProductEditor(false)} className="min-h-11 rounded-xl border border-slate-200 px-5 text-xs font-bold">Cancel</button><button type="submit" disabled={busy === 'save-product'} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-5 text-xs font-black text-white disabled:opacity-50"><Save className="h-4 w-4" aria-hidden="true" />Save Draft</button></div>
      </form></div></div>}
    </div>
  );
}

function OrderCard({ order, busy, onStatus }: { key?: string; order: SupplierPortalOrder; busy: string; onStatus(status: string): Promise<void> }) {
  const nextStatus: Record<string, string | undefined> = { pending: 'processing', processing: 'packed', packed: 'shipped' };
  const next = nextStatus[order.supplierFulfilmentStatus];
  const locked = ['cancelled', 'delivered'].includes(order.status);
  return <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h3 className="font-black">{order.orderNumber}</h3><StatusPill status={order.supplierFulfilmentStatus} /></div><p className="mt-1 text-xs text-slate-500">Placed {formatDate(order.createdAt)} · {formatCurrency(order.supplierTotal)}</p></div>{next && !locked && <button type="button" onClick={() => void onStatus(next)} disabled={busy === `order-${order.id}`} className="min-h-10 rounded-xl bg-blue-600 px-4 text-xs font-black text-white disabled:opacity-50">Mark {next}</button>}</div><details className="mt-4 rounded-xl bg-slate-50 p-4"><summary className="cursor-pointer text-xs font-black">View order details</summary><div className="mt-4 grid gap-4 text-sm sm:grid-cols-2"><div><h4 className="text-xs font-black uppercase text-slate-500">Delivery</h4><p className="mt-2 font-semibold">{order.customerName}</p><p>{order.customerPhone}</p><p>{order.customerAddress}, {order.city}, {order.district}</p></div><div><h4 className="text-xs font-black uppercase text-slate-500">Payment</h4><p className="mt-2">{order.paymentMethod.replaceAll('_', ' ')}</p><p>{order.paymentStatus.replaceAll('_', ' ')}</p></div><div className="sm:col-span-2"><h4 className="text-xs font-black uppercase text-slate-500">Assigned items</h4><ul className="mt-2 divide-y divide-slate-200">{order.items.map((item) => <li key={`${item.productId}-${item.name}`} className="flex justify-between gap-3 py-2"><span>{item.name} × {item.quantity}</span><strong>{formatCurrency(item.price * item.quantity)}</strong></li>)}</ul></div></div></details></article>;
}
