import { ChangeEvent, Dispatch, SetStateAction, useMemo } from 'react';
import { ArrowDown, ArrowUp, Copy, Image, Plus, Trash2 } from 'lucide-react';
import { HeroBannerSettings, WebsiteSettings } from '../types';
import HeroBanner from './HeroBanner';
import {
  createHeroSlide,
  duplicateHeroSlide,
  HERO_SLIDE_LIMIT,
  HERO_SLIDE_SPEED_MAX,
  HERO_SLIDE_SPEED_MIN,
  validateHeroSlide,
  validateHeroSlides,
} from '../services/hero-slider/heroSlider';

interface HeroSliderEditorProps {
  settings: WebsiteSettings;
  setSettings: Dispatch<SetStateAction<WebsiteSettings | null>>;
  bannerErrors: Record<string, boolean>;
  setBannerErrors: Dispatch<SetStateAction<Record<string, boolean>>>;
  onImageUpload: (event: ChangeEvent<HTMLInputElement>, bannerId: string) => void;
}

export default function HeroSliderEditor({
  settings,
  setSettings,
  bannerErrors,
  setBannerErrors,
  onImageUpload,
}: HeroSliderEditorProps) {
  const validationErrors = useMemo(() => validateHeroSlides(settings.heroBanners), [settings.heroBanners]);

  const updateSlides = (updater: (slides: HeroBannerSettings[]) => HeroBannerSettings[]) => {
    setSettings((current) => current ? { ...current, heroBanners: updater(current.heroBanners) } : current);
  };

  const updateSlide = (id: string, updates: Partial<HeroBannerSettings>) => {
    updateSlides((slides) => slides.map((slide) => slide.id === id ? { ...slide, ...updates } : slide));
  };

  const moveSlide = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= settings.heroBanners.length) return;
    updateSlides((slides) => {
      const reordered = [...slides];
      [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
      return reordered;
    });
  };

  const addSlide = () => {
    if (settings.heroBanners.length >= HERO_SLIDE_LIMIT) return;
    updateSlides((slides) => [...slides, createHeroSlide()]);
  };

  const duplicateSlide = (slide: HeroBannerSettings) => {
    if (settings.heroBanners.length >= HERO_SLIDE_LIMIT) return;
    updateSlides((slides) => {
      const index = slides.findIndex((item) => item.id === slide.id);
      const copy = duplicateHeroSlide(slide, `hero-${Date.now()}-${index}`);
      return [...slides.slice(0, index + 1), copy, ...slides.slice(index + 1)];
    });
  };

  const deleteSlide = (slide: HeroBannerSettings) => {
    if (!window.confirm(`Delete “${slide.title || 'Untitled slide'}”?`)) return;
    updateSlides((slides) => slides.filter((item) => item.id !== slide.id));
  };

  return (
    <section className="space-y-5 border-t border-slate-100 pt-5 dark:border-slate-800">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <span className="block text-[10px] font-black uppercase tracking-widest text-blue-500">Hero Slider CMS</span>
          <p className="mt-1 text-xs text-slate-500">Manage up to {HERO_SLIDE_LIMIT} promotional slides in storefront order.</p>
        </div>
        <button
          type="button"
          onClick={addSlide}
          disabled={settings.heroBanners.length >= HERO_SLIDE_LIMIT}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-4 w-4" /> Create slide
        </button>
      </div>

      <div className="grid gap-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-900/50 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-3 text-xs font-bold text-slate-600 dark:text-slate-300">
          Enable slider
          <input
            type="checkbox"
            checked={settings.enableSlider !== false}
            onChange={(event) => setSettings((current) => current ? { ...current, enableSlider: event.target.checked } : current)}
            className="h-4 w-4 accent-blue-600"
          />
        </label>
        <label className="space-y-1 text-xs font-bold text-slate-600 dark:text-slate-300">
          <span>Auto slide speed (seconds)</span>
          <input
            type="number"
            min={HERO_SLIDE_SPEED_MIN}
            max={HERO_SLIDE_SPEED_MAX}
            step="1"
            value={settings.autoSlideSpeed ?? 6}
            onChange={(event) => setSettings((current) => current ? { ...current, autoSlideSpeed: Number(event.target.value) } : current)}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
      </div>

      {settings.heroBanners.length === 0 && (
        <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-xs text-slate-500 dark:border-slate-700">
          No CMS slides yet. Create and enable a slide to display the storefront promotional hero.
        </div>
      )}

      {settings.heroBanners.map((banner, index) => (
        <article key={banner.id} className="space-y-4 rounded-2xl border border-slate-200 bg-slate-100/50 p-4 dark:border-slate-800 dark:bg-slate-800/40">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3 dark:border-slate-700">
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-bold uppercase text-slate-500">Slide #{index + 1}</span>
              <label className="flex items-center gap-2 text-[10px] font-bold uppercase text-slate-500">
                <input type="checkbox" checked={banner.enabled !== false} onChange={(event) => updateSlide(banner.id, { enabled: event.target.checked })} className="accent-blue-600" />
                Enabled
              </label>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => moveSlide(index, -1)} disabled={index === 0} aria-label={`Move slide ${index + 1} up`} className="rounded-lg p-2 hover:bg-slate-200 disabled:opacity-30 dark:hover:bg-slate-700"><ArrowUp className="h-4 w-4" /></button>
              <button type="button" onClick={() => moveSlide(index, 1)} disabled={index === settings.heroBanners.length - 1} aria-label={`Move slide ${index + 1} down`} className="rounded-lg p-2 hover:bg-slate-200 disabled:opacity-30 dark:hover:bg-slate-700"><ArrowDown className="h-4 w-4" /></button>
              <button type="button" onClick={() => duplicateSlide(banner)} disabled={settings.heroBanners.length >= HERO_SLIDE_LIMIT} aria-label={`Duplicate slide ${index + 1}`} className="rounded-lg p-2 hover:bg-slate-200 disabled:opacity-30 dark:hover:bg-slate-700"><Copy className="h-4 w-4" /></button>
              <button type="button" onClick={() => deleteSlide(banner)} aria-label={`Delete slide ${index + 1}`} className="rounded-lg p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"><Trash2 className="h-4 w-4" /></button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {([
              ['badge', 'Badge label'],
              ['title', 'Slide title'],
              ['subtitle', 'Subtitle'],
              ['buttonText', 'CTA label'],
              ['buttonUrl', 'CTA URL'],
            ] as const).map(([field, label]) => {
              const fieldError = validateHeroSlide(banner).find((error) => error.field === field);
              const errorId = `hero-${banner.id}-${field}-error`;
              return (
              <label key={field} className="space-y-1 text-xs">
                <span className="text-[10px] font-bold uppercase text-slate-400">{label}</span>
                <input
                  type="text"
                  value={banner[field] ?? ''}
                  onChange={(event) => updateSlide(banner.id, { [field]: event.target.value })}
                  aria-invalid={fieldError ? true : undefined}
                  aria-describedby={fieldError ? errorId : undefined}
                  className={`w-full rounded-lg border bg-white px-3 py-2 text-xs dark:bg-slate-900 ${fieldError ? 'border-red-500 ring-2 ring-red-500/15 dark:border-red-500' : 'border-slate-200 dark:border-slate-700'}`}
                />
                {fieldError && <span id={errorId} className="block text-[10px] font-semibold text-red-500">{fieldError.message}</span>}
              </label>
              );
            })}
            <label className="space-y-1 text-xs">
              <span className="text-[10px] font-bold uppercase text-slate-400">Background gradient</span>
              <select value={banner.bgGradient ?? 'from-black via-zinc-950/90 to-blue-950/20'} onChange={(event) => updateSlide(banner.id, { bgGradient: event.target.value })} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-900">
                <option value="from-black via-zinc-950/90 to-blue-950/20">Royal blue</option>
                <option value="from-black via-neutral-950/90 to-purple-950/30">Premium purple</option>
                <option value="from-black via-slate-950/90 to-emerald-950/30">Emerald</option>
                <option value="from-black via-stone-950/90 to-orange-950/30">Warm orange</option>
                <option value="from-black via-zinc-950/95 to-transparent">Neutral</option>
              </select>
            </label>
          </div>

          <label className="block space-y-1 text-xs">
            <span className="text-[10px] font-bold uppercase text-slate-400">Description</span>
            <textarea rows={3} value={banner.description} onChange={(event) => updateSlide(banner.id, { description: event.target.value })} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-900" />
          </label>

          <div className="grid items-start gap-3 sm:grid-cols-2">
            <div className="space-y-3">
              <label className="block space-y-1 text-xs">
                <span className="text-[10px] font-bold uppercase text-slate-400">Image URL</span>
                <input type="text" value={banner.image} onChange={(event) => updateSlide(banner.id, { image: event.target.value })} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-900" />
              </label>
              <label className="block space-y-1 text-xs">
                <span className="text-[10px] font-bold uppercase text-slate-400">Upload JPG, PNG, WebP or GIF (max 5 MB)</span>
                <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(event) => onImageUpload(event, banner.id)} className="w-full text-[10px] text-slate-500 file:mr-2 file:rounded file:border-0 file:bg-slate-200 file:px-3 file:py-2 file:text-[10px] file:font-semibold dark:file:bg-slate-700 dark:file:text-white" />
              </label>
            </div>
            <div className="aspect-video overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
              {banner.image && !bannerErrors[banner.id] ? (
                <img src={banner.image} alt={`${banner.title || `Slide ${index + 1}`} preview`} onError={() => setBannerErrors((current) => ({ ...current, [banner.id]: true }))} className="h-full w-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-400"><Image className="h-7 w-7" /><span className="text-[10px] font-bold uppercase">No valid image</span></div>
              )}
            </div>
          </div>

          {validateHeroSlides([banner])
            .filter((error) => !['badge', 'title', 'subtitle', 'buttonText', 'buttonUrl'].includes(error.field))
            .map((error, errorIndex) => <p key={`${error.field}-${errorIndex}`} className="text-xs font-semibold text-red-500">{error.message}</p>)}
        </article>
      ))}

      {validationErrors.some((error) => error.field === 'slides') && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-600 dark:border-red-900 dark:bg-red-950/30">
          {validationErrors.filter((error) => error.field === 'slides').map((error) => error.message).join(' ')}
        </div>
      )}

      <div className="space-y-2">
        <span className="block text-[10px] font-black uppercase tracking-widest text-blue-500">Full storefront preview</span>
        <div className="overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800">
          <HeroBanner settings={settings} onExploreProducts={() => undefined} onBrowseCategories={() => undefined} />
        </div>
      </div>
    </section>
  );
}
