import { useSyncExternalStore } from 'react';
import { WORLD } from '../data/game';
import { idbSet } from './idb';

/**
 * The world map picture from the Satisfactory Wiki (fandom), loaded from the wiki itself — not copied
 * into this app. It covers the whole playable world, matching WORLD.
 */
export const MAP_IMAGE_URL = 'https://static.wikia.nocookie.net/satisfactory_gamepedia_en/images/e/ea/Map.jpg/revision/latest?cb=20220921184658';
export const MAP_IMAGE_CREDIT = { text: 'Satisfactory Wiki', href: 'https://satisfactory.fandom.com/wiki/Map' };

interface MapImageSettings { show: boolean; opacity: number }
const KEY = 'nodes-map-image';
const DEFAULTS: MapImageSettings = { show: true, opacity: 0.75 };

let current: MapImageSettings = (() => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
})();
const listeners = new Set<() => void>();
function set(patch: Partial<MapImageSettings>) {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* storage blocked */ }
  listeners.forEach((l) => l());
}

// Images uploaded by older versions are no longer used; free the space.
idbSet('map-bg', undefined);
idbSet('map-bg-settings', undefined);

/** Map picture settings, shared by the world map and every placement map. */
export function useMapImage() {
  const s = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);
  return { ...s, setShow: (show: boolean) => set({ show }), setOpacity: (opacity: number) => set({ opacity }) };
}

/** Whether the picture could be loaded (the wiki may be unreachable). */
let status: 'loading' | 'ok' | 'error' = 'loading';
const statusListeners = new Set<() => void>();
function probe() {
  if (typeof Image === 'undefined') return;
  const img = new Image();
  img.referrerPolicy = 'no-referrer';
  img.onload = () => { status = 'ok'; statusListeners.forEach((l) => l()); };
  img.onerror = () => { status = 'error'; statusListeners.forEach((l) => l()); };
  img.src = MAP_IMAGE_URL;
}
probe();
function useImageStatus() {
  return useSyncExternalStore((l) => { statusListeners.add(l); return () => statusListeners.delete(l); }, () => status);
}

/** The picture as an SVG <image> covering the world. */
export function MapImageLayer() {
  const { show, opacity } = useMapImage();
  const st = useImageStatus();
  if (!show || st === 'error') return null;
  return (
    <image
      href={MAP_IMAGE_URL}
      x={WORLD.minX}
      y={WORLD.minY}
      width={WORLD.maxX - WORLD.minX}
      height={WORLD.maxY - WORLD.minY}
      opacity={opacity}
      preserveAspectRatio="none"
      pointerEvents="none"
    />
  );
}

/** Show / fade the map picture. */
export function MapImageCard() {
  const img = useMapImage();
  const st = useImageStatus();
  return (
    <section className="card">
      <h3>Map image</h3>
      <label className="check"><input type="checkbox" checked={img.show} onChange={(e) => img.setShow(e.target.checked)} /> Show the world map</label>
      {img.show && (
        <label className="fit-row">
          <span>Fade</span>
          <input type="range" min={0.1} max={1} step={0.05} value={img.opacity} onChange={(e) => img.setOpacity(Number(e.target.value))} />
          <span className="muted">{Math.round(img.opacity * 100)}%</span>
        </label>
      )}
      {st === 'error' && <p className="warn small-text">Couldn’t load the map picture from the wiki. Check your connection; the map works without it.</p>}
      <p className="muted small-text">Map picture: <a href={MAP_IMAGE_CREDIT.href} target="_blank" rel="noreferrer">{MAP_IMAGE_CREDIT.text}</a> (game art © Coffee Stain Studios).</p>
    </section>
  );
}
