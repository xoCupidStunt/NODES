import { useEffect, useRef, useState, type PointerEvent as RPE, type WheelEvent as RWE } from 'react';
import { nodes, RAW_ITEMS, WORLD } from '../data/game';
import { MapImageLayer } from './mapImage';

export const SIZE = { w: WORLD.maxX - WORLD.minX, h: WORLD.maxY - WORLD.minY };
export const RESOURCE_ITEMS = [...new Set(nodes.map((n) => n.item))].filter((i) => RAW_ITEMS.includes(i));
export const PURITY_R = { impure: 0.75, normal: 1, pure: 1.35 };

export interface ViewBox { x: number; y: number; w: number }
export const FULL_VIEW: ViewBox = { x: WORLD.minX, y: WORLD.minY, w: SIZE.w };

/** Pan (drag) and zoom (wheel) for an SVG map in world coordinates (cm). */
export function usePanZoom(initial: ViewBox = FULL_VIEW) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [vb, setVb] = useState<ViewBox>(initial);
  const [aspect, setAspect] = useState(1.6);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ sx: number; sy: number; vb: ViewBox; moved: boolean } | null>(null);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAspect(el.clientWidth / Math.max(1, el.clientHeight)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const h = vb.w / aspect;
  const pxToWorld = vb.w / (svgRef.current?.clientWidth || 1000);
  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: vb.x + ((e.clientX - r.left) / r.width) * vb.w, y: vb.y + ((e.clientY - r.top) / r.height) * h };
  };
  /** Centre the view on a point, `w` cm wide. */
  const focus = (at: { x: number; y: number }, w = 120000) => {
    const el = svgRef.current;
    const a = el && el.clientHeight ? el.clientWidth / el.clientHeight : aspect; // measure now; state may lag a resize
    setVb({ x: at.x - w / 2, y: at.y - w / 2 / a, w });
  };
  /** True if the pointer-up that just happened ends a click that started on the map (not a drag). */
  const wasClick = () => !!drag.current && !drag.current.moved;

  const handlers = {
    onWheel(e: RWE<SVGSVGElement>) {
      const p = toWorld(e);
      const k = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      const w = Math.min(SIZE.w * 1.5, Math.max(8000, vb.w * k));
      const r = w / vb.w;
      setVb({ x: p.x - (p.x - vb.x) * r, y: p.y - (p.y - vb.y) * r, w });
    },
    onPointerDown(e: RPE<SVGSVGElement>) {
      drag.current = { sx: e.clientX, sy: e.clientY, vb, moved: false };
    },
    onPointerMove(e: RPE<SVGSVGElement>) {
      setHover(toWorld(e));
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (d.moved) {
        const s = d.vb.w / svgRef.current!.clientWidth;
        setVb({ ...d.vb, x: d.vb.x - dx * s, y: d.vb.y - dy * s });
      }
    },
    onPointerUp() {
      // Children handle their own clicks first (they run before this bubbles up).
      drag.current = null;
    },
    onPointerLeave() {
      setHover(null);
      drag.current = null;
    },
  };

  return { svgRef, vb, setVb, h, pxToWorld, hover, handlers, focus, wasClick, viewBox: `${vb.x} ${vb.y} ${vb.w} ${h}` };
}

/** World background: dark land, the optional map picture, 1 km grid. */
export function MapBackdrop({ pxToWorld }: { pxToWorld: number }) {
  const gx: number[] = [];
  for (let g = Math.ceil(WORLD.minX / 100000) * 100000; g <= WORLD.maxX; g += 100000) gx.push(g);
  const gy: number[] = [];
  for (let g = Math.ceil(WORLD.minY / 100000) * 100000; g <= WORLD.maxY; g += 100000) gy.push(g);
  return (
    <>
      <rect x={WORLD.minX} y={WORLD.minY} width={SIZE.w} height={SIZE.h} className="map-bg" />
      <MapImageLayer />
      {gx.map((g) => <line key={'x' + g} x1={g} x2={g} y1={WORLD.minY} y2={WORLD.maxY} className="map-grid" strokeWidth={pxToWorld} />)}
      {gy.map((g) => <line key={'y' + g} y1={g} y2={g} x1={WORLD.minX} x2={WORLD.maxX} className="map-grid" strokeWidth={pxToWorld} />)}
    </>
  );
}
