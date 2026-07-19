import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { DeliveryAreaSettings, WebsiteSettings } from '../../types';
import { DEFAULT_HOMEPAGE_SECTIONS } from '../../services/settings/websiteSettings';

interface Props {
  settings: WebsiteSettings;
  setSettings: React.Dispatch<React.SetStateAction<WebsiteSettings | null>>;
}

const inputClass = 'w-full rounded-xl border border-slate-200/60 bg-slate-100/50 px-3 py-2 text-xs focus:outline-hidden dark:border-slate-800 dark:bg-slate-800/60';
const sectionKeys = Object.keys(DEFAULT_HOMEPAGE_SECTIONS) as Array<keyof typeof DEFAULT_HOMEPAGE_SECTIONS>;

export default function BusinessConfigurationEditor({ settings, setSettings }: Props) {
  const [areaDraft, setAreaDraft] = useState({ name: '', districts: '', charge: '', estimatedDelivery: '' });
  const update = (patch: Partial<WebsiteSettings>) => setSettings((current) => current ? ({ ...current, ...patch }) : current);
  const updateHomepage = (key: keyof typeof DEFAULT_HOMEPAGE_SECTIONS, patch: Partial<typeof DEFAULT_HOMEPAGE_SECTIONS[typeof key]>) => {
    setSettings((current) => current ? ({
      ...current,
      homepageSections: {
        ...(current.homepageSections || DEFAULT_HOMEPAGE_SECTIONS),
        [key]: { ...(current.homepageSections?.[key] || DEFAULT_HOMEPAGE_SECTIONS[key]), ...patch },
      },
    }) : current);
  };
  const addArea = () => {
    const districts = areaDraft.districts.split(',').map((value) => value.trim()).filter(Boolean);
    const charge = Number(areaDraft.charge);
    if (!areaDraft.name.trim() || !districts.length || !Number.isFinite(charge) || charge < 0 || !areaDraft.estimatedDelivery.trim()) return;
    const area: DeliveryAreaSettings = {
      id: `area-${Date.now()}`,
      name: areaDraft.name.trim(),
      districts,
      charge,
      estimatedDelivery: areaDraft.estimatedDelivery.trim(),
      isActive: true,
    };
    update({ deliveryAreas: [...(settings.deliveryAreas || []), area] });
    setAreaDraft({ name: '', districts: '', charge: '', estimatedDelivery: '' });
  };

  return <>
    <section className="space-y-4 border-t border-slate-100 pt-4 dark:border-slate-800" aria-labelledby="homepage-config-title">
      <div><h3 id="homepage-config-title" className="text-[10px] font-black uppercase tracking-widest text-blue-500">Homepage merchandising</h3><p className="mt-1 text-[11px] text-slate-400">Hero banners remain managed below. Product membership uses the existing Featured, Best Seller and New Arrival flags.</p></div>
      <div className="space-y-3">
        {sectionKeys.map((key) => {
          const value = settings.homepageSections?.[key] || DEFAULT_HOMEPAGE_SECTIONS[key];
          return <fieldset key={key} className="grid gap-3 rounded-2xl border border-slate-200/60 p-3 sm:grid-cols-[auto_1fr] dark:border-slate-800">
            <label className="flex min-h-11 items-center gap-2 text-xs font-bold"><input type="checkbox" checked={value.enabled} onChange={(event) => updateHomepage(key, { enabled: event.target.checked })} /> Enabled</label>
            <div className="grid gap-2 sm:grid-cols-2"><input className={inputClass} aria-label={`${key} title`} value={value.title} onChange={(event) => updateHomepage(key, { title: event.target.value })} /><input className={inputClass} aria-label={`${key} subtitle`} value={value.subtitle} onChange={(event) => updateHomepage(key, { subtitle: event.target.value })} /></div>
          </fieldset>;
        })}
      </div>
    </section>

    <section className="space-y-4 border-t border-slate-100 pt-4 dark:border-slate-800" aria-labelledby="business-config-title">
      <h3 id="business-config-title" className="text-[10px] font-black uppercase tracking-widest text-blue-500">Business configuration</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-bold text-slate-400">Currency<select className={`${inputClass} mt-1`} value="LKR" disabled><option>LKR</option></select><small className="font-normal">Locked to the current checkout and PayHere contract.</small></label>
        <label className="text-xs font-bold text-slate-400">Store status<select className={`${inputClass} mt-1`} value={settings.storeStatus || 'open'} onChange={(event) => update({ storeStatus: event.target.value as 'open' | 'closed' })}><option value="open">Open</option><option value="closed">Closed</option></select></label>
        <label className="text-xs font-bold text-slate-400 sm:col-span-2">Customer status message<input className={`${inputClass} mt-1`} value={settings.storeStatusMessage || ''} onChange={(event) => update({ storeStatusMessage: event.target.value })} /></label>
        {(['weekdays', 'saturday', 'sunday'] as const).map((day) => <label key={day} className="text-xs font-bold capitalize text-slate-400">{day}<input className={`${inputClass} mt-1`} value={settings.businessHours?.[day] || ''} onChange={(event) => update({ businessHours: { weekdays: settings.businessHours?.weekdays || '', saturday: settings.businessHours?.saturday || '', sunday: settings.businessHours?.sunday || '', [day]: event.target.value } })} /></label>)}
      </div>
    </section>

    <section className="space-y-4 border-t border-slate-100 pt-4 dark:border-slate-800" aria-labelledby="delivery-area-title">
      <div><h3 id="delivery-area-title" className="text-[10px] font-black uppercase tracking-widest text-blue-500">Delivery areas</h3><p className="mt-1 text-[11px] text-slate-400">Districts not assigned here continue to use the flat courier charge.</p></div>
      {(settings.deliveryAreas || []).map((area) => <div key={area.id} className="flex flex-col gap-2 rounded-2xl border border-slate-200/60 p-3 text-xs sm:flex-row sm:items-center dark:border-slate-800"><div className="flex-1"><strong>{area.name}</strong><p className="text-slate-400">{area.districts.join(', ')} · LKR {area.charge.toLocaleString()} · {area.estimatedDelivery}</p></div><label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={area.isActive} onChange={(event) => update({ deliveryAreas: (settings.deliveryAreas || []).map((item) => item.id === area.id ? { ...item, isActive: event.target.checked } : item) })} /> Active</label><button type="button" className="flex min-h-11 items-center gap-1 text-red-500" onClick={() => update({ deliveryAreas: (settings.deliveryAreas || []).filter((item) => item.id !== area.id) })}><Trash2 className="h-4 w-4" /> Remove</button></div>)}
      <div className="grid gap-2 sm:grid-cols-2"><input className={inputClass} placeholder="Area name" aria-label="Delivery area name" value={areaDraft.name} onChange={(event) => setAreaDraft({ ...areaDraft, name: event.target.value })} /><input className={inputClass} placeholder="Districts, comma separated" aria-label="Delivery area districts" value={areaDraft.districts} onChange={(event) => setAreaDraft({ ...areaDraft, districts: event.target.value })} /><input className={inputClass} type="number" min="0" placeholder="Charge (LKR)" aria-label="Delivery area charge" value={areaDraft.charge} onChange={(event) => setAreaDraft({ ...areaDraft, charge: event.target.value })} /><input className={inputClass} placeholder="Estimated delivery, e.g. 2-4 days" aria-label="Estimated delivery time" value={areaDraft.estimatedDelivery} onChange={(event) => setAreaDraft({ ...areaDraft, estimatedDelivery: event.target.value })} /></div>
      <button type="button" onClick={addArea} className="flex min-h-11 items-center gap-2 rounded-xl bg-slate-800 px-4 py-2 text-xs font-bold text-white"><Plus className="h-4 w-4" /> Add delivery area</button>
    </section>

    <section className="space-y-4 border-t border-slate-100 pt-4 dark:border-slate-800" aria-labelledby="system-config-title">
      <h3 id="system-config-title" className="text-[10px] font-black uppercase tracking-widest text-blue-500">System controls</h3>
      <div className="grid gap-2 sm:grid-cols-2">{([
        ['maintenanceMode', 'Maintenance mode'], ['registrationEnabled', 'Customer registration'], ['supplierRegistrationEnabled', 'Supplier registration'], ['emailNotificationsEnabled', 'Email notifications'], ['orderNotificationsEnabled', 'Order notifications'],
      ] as const).map(([key, label]) => <label key={key} className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-200/60 px-3 text-xs font-bold dark:border-slate-800"><input type="checkbox" checked={settings[key] === true} onChange={(event) => update({ [key]: event.target.checked })} /> {label}</label>)}</div>
      <label className="block text-xs font-bold text-slate-400">Maintenance message<textarea className={`${inputClass} mt-1 resize-none`} rows={2} value={settings.maintenanceMessage || ''} onChange={(event) => update({ maintenanceMessage: event.target.value })} /></label>
    </section>
  </>;
}
