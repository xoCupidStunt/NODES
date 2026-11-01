import { useSyncExternalStore } from 'react';
import { WORLD } from '../data/game';
import { idbGet, idbSet } from './idb';

/** How the picture sits on the world: offsets in metres, size and width stretch in %. */
export interface ImageFit { dx: number; dy: number; scale: number; stretch: number }
export interface MapImage { src: string | null; opacity: number; fit: ImageFit }

const DEFAULT_FIT: ImageFit = { dx: 0, dy: 0, scale: 100, stretch: 100 };
let current: MapImage = { src: null, opacity: 0.7, fit: DEFAULT_FIT };
const listeners = new Set<() => void>();
let loaded = false;

function set(patch: Partial<MapImage>) {
  current = { ...current, ...patch };
  listeners.forEach((l) => l());
  if ('src' in patch) idbSet('map-bg', current.src ?? undefined);
  idbSet('map-bg-settings', { opacity: current.opacity, fit: current.fit });
}

function load() {
  if (loaded) return;
  loaded = true;
  Promise.all([idbGet<string>('map-bg'), idbGet<{ opacity: number; fit: ImageFit }>('map-bg-settings')]).then(([src, s]) => {
    current = { src: src ?? null, opacity: s?.opacity ?? 0.7, fit: { ...DEFAULT_FIT, ...s?.fit } };
    listeners.forEach((l) => l());
  });
}

/** The map picture, shared by the world map and every placement map, saved in the browser. */
export function useMapImage() {
  load();
  const img = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);
  return {
    ...img,
    setSrc: (src: string | null) => set({ src }),
    setOpacity: (opacity: number) => set({ opacity }),
    setFit: (patch: Partial<ImageFit>) => set({ fit: { ...current.fit, ...patch } }),
    resetFit: () => set({ fit: DEFAULT_FIT }),
  };
}

/** World-space rectangle (cm) the picture covers. */
export function imageRect(fit: ImageFit) {
  const w = (WORLD.maxX - WORLD.minX) * (fit.scale / 100) * (fit.stretch / 100);
  const h = (WORLD.maxY - WORLD.minY) * (fit.scale / 100);
  const cx = (WORLD.minX + WORLD.maxX) / 2 + fit.dx * 100;
  const cy = (WORLD.minY + WORLD.maxY) / 2 + fit.dy * 100;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** The picture as an SVG <image>, placed by its fit. */
export function MapImageLayer() {
  const { src, opacity, fit } = useMapImage();
  if (!src) return null;
  const r = imageRect(fit);
  return <image href={src} x={r.x} y={r.y} width={r.w} height={r.h} opacity={opacity} preserveAspectRatio="none" pointerEvents="none" />;
}

/** Load / fade / line up / remove the map picture. */
export function MapImageCard() {
  const img = useMapImage();
  const loadFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => img.setSrc(reader.result as string);
    reader.readAsDataURL(file);
  };
  const slider = (label: string, key: keyof ImageFit, min: number, max: number, step: number, unit: string) => (
    <label className="fit-row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={img.fit[key]} onChange={(e) => img.setFit({ [key]: Number(e.target.value) })} />
      <input type="number" step={step} value={img.fit[key]} onChange={(e) => e.target.value !== '' && img.setFit({ [key]: Number(e.target.value) })} />
      <span className="muted">{unit}</span>
    </label>
  );
  return (
    <section className="card">
      <h3>Map image</h3>
      {!img.src && (
        <p className="muted small-text">
          Load a picture of the Satisfactory world map to see terrain under the nodes and factories — for example a screenshot of the in-game map zoomed all the way out, cropped to the map’s edges, north up. It’s saved in this browser and shared by every map here.
        </p>
      )}
      <input type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ''; }} />
      {img.src && (
        <>
          <label className="fit-row">
            <span>Fade</span>
            <input type="range" min={0.1} max={1} step={0.05} value={img.opacity} onChange={(e) => img.setOpacity(Number(e.target.value))} />
            <span className="muted">{Math.round(img.opacity * 100)}%</span>
          </label>
          <details className="fit">
            <summary>Line up with the nodes</summary>
            <p className="muted small-text">Turn on resource nodes and nudge the picture until node clusters sit on the right spots (coasts and big lakes are easy to check).</p>
            {slider('Left / right', 'dx', -1500, 1500, 5, 'm')}
            {slider('Up / down', 'dy', -1500, 1500, 5, 'm')}
            {slider('Size', 'scale', 50, 150, 0.5, '%')}
            {slider('Width', 'stretch', 80, 120, 0.5, '%')}
            <button className="small ghost" onClick={img.resetFit}>Reset position</button>
          </details>
          <button className="small ghost danger" onClick={() => img.setSrc(null)}>Remove image</button>
        </>
      )}
    </section>
  );
}
