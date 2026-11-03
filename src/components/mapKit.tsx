import { useEffect, useRef, useState, type PointerEvent as RPE, type WheelEvent as RWE } from 'react';
import { isFluid, itemColor, itemName, nodeKind, nodes, RAW_ITEMS, wellOf, wells, WORLD, type ResourceNode, type ResourceWell } from '../data/game';
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
  // End a drag on any release, even one a marker's click handler kept from reaching the map.
  useEffect(() => {
    const end = () => { drag.current = null; };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => { window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); };
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
      if (e.buttons === 0) { drag.current = null; return; } // button already up: not a drag
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

/**
 * One resource node. Shape says the type (circle = miner or oil node, diamond = resource well satellite,
 * triangle = geyser); size and outline say the purity (impure: small, dashed · normal · pure: large, double ring).
 */
export function NodeShape({ n, r, px, fill }: { n: ResourceNode; r: number; px: number; fill: string }) {
  const stroke = 0.6 * px;
  const body = n.type === 'well'
    ? <rect x={n.x - r * 0.8} y={n.y - r * 0.8} width={r * 1.6} height={r * 1.6} transform={`rotate(45 ${n.x} ${n.y})`} fill={fill} stroke="#000" strokeWidth={stroke} />
    : n.type === 'geyser'
      ? <path d={`M${n.x},${n.y - r * 1.1} L${n.x + r},${n.y + r * 0.8} L${n.x - r},${n.y + r * 0.8} z`} fill={fill} stroke="#000" strokeWidth={stroke} />
      : <circle cx={n.x} cy={n.y} r={r} fill={fill} stroke="#000" strokeWidth={stroke} />;
  return (
    <>
      {body}
      {n.purity === 'pure' && <circle cx={n.x} cy={n.y} r={r + 1.8 * px} fill="none" stroke="#fff" strokeWidth={1.1 * px} opacity={0.85} />}
      {n.purity === 'impure' && <circle cx={n.x} cy={n.y} r={r + 1.4 * px} fill="none" stroke="#fff" strokeWidth={0.9 * px} strokeDasharray={`${1.5 * px} ${1.5 * px}`} opacity={0.6} />}
    </>
  );
}

/** Resource wells: a dashed ring around each well's satellites and a hexagon where its Pressurizer goes. */
export function WellLayer({ px, show, onHover }: { px: number; show: (item: string) => boolean; onHover?: (w: ResourceWell | null, e?: { clientX: number; clientY: number }) => void }) {
  return (
    <>
      {wells.filter((w) => show(w.item)).map((w) => {
        const hex = Math.max(900, 6 * px);
        const pts = Array.from({ length: 6 }, (_, k) => `${w.x + hex * Math.cos((Math.PI / 3) * k)},${w.y + hex * Math.sin((Math.PI / 3) * k)}`).join(' ');
        return (
          <g key={w.id} className="well" onPointerEnter={(e) => onHover?.(w, e)} onPointerMove={(e) => onHover?.(w, e)} onPointerLeave={() => onHover?.(null)}>
            <circle cx={w.x} cy={w.y} r={w.radius + 2500} fill={itemColor(w.item)} fillOpacity={0.08} stroke={itemColor(w.item)} strokeWidth={1.4 * px} strokeDasharray={`${5 * px} ${3 * px}`} />
            <polygon points={pts} fill="#0b0e12" stroke={itemColor(w.item)} strokeWidth={2 * px} />
            <circle cx={w.x} cy={w.y} r={hex * 0.35} fill={itemColor(w.item)} />
          </g>
        );
      })}
    </>
  );
}

/** Text for hovering a node: what it is, its purity, and what it gives with your best extractor. */
export function nodeTip(n: ResourceNode, rate?: number) {
  const w = wellOf[n.id];
  return {
    title: `${itemName(n.item)} — ${n.purity}`,
    lines: [
      nodeKind(n) + (w ? ` (well with ${w.satellites.length} satellites)` : ''),
      rate !== undefined ? (rate > 0 ? `${fmtRate(rate)}${isFluid(n.item) ? ' m³' : ''}/min at 100% with your best extractor` : 'No extractor unlocked for it yet') : '',
    ].filter(Boolean),
  };
}

/** Text for hovering a resource well. */
export function wellTip(w: ResourceWell, rateOf?: (n: ResourceNode) => number) {
  const by = (p: ResourceNode['purity']) => w.satellites.filter((n) => n.purity === p).length;
  const total = rateOf ? w.satellites.reduce((a, n) => a + rateOf(n), 0) : 0;
  return {
    title: `${itemName(w.item)} resource well`,
    lines: [
      `${w.satellites.length} satellites: ${[['pure', by('pure')], ['normal', by('normal')], ['impure', by('impure')]].filter(([, c]) => c).map(([p, c]) => `${c} ${p}`).join(', ')}`,
      ...(total > 0 ? [`Up to ${fmtRate(total)} m³/min with every satellite tapped at 100%`] : []),
      'Needs a Resource Well Pressurizer at the centre (hexagon)',
    ],
  };
}

const fmtRate = (v: number) => (Math.round(v * 10) / 10).toLocaleString();

/** A small card that follows the cursor. */
export function MapTip({ at, title, lines }: { at: { x: number; y: number }; title: string; lines: string[] }) {
  return (
    // Flip to the other side of the cursor near the window's right or bottom edge.
    <div className="map-tip" style={at.x > window.innerWidth - 320 ? { right: window.innerWidth - at.x + 14, top: Math.min(at.y + 14, window.innerHeight - 110) } : { left: at.x + 14, top: Math.min(at.y + 14, window.innerHeight - 110) }}>
      <b>{title}</b>
      {lines.map((l) => <div key={l}>{l}</div>)}
    </div>
  );
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

/** Legend for node shapes, purity and wells. */
export function NodeLegend() {
  const dot = (p: ResourceNode['purity'], type: ResourceNode['type'] = 'node') => (
    <svg width="18" height="18" viewBox="-9 -9 18 18"><NodeShape n={{ id: '', item: '', purity: p, type, x: 0, y: 0, z: 0 }} r={5 * PURITY_R[p]} px={1} fill="#aaa" /></svg>
  );
  return (
    <>
      <div>{dot('impure')} impure · {dot('normal')} normal · {dot('pure')} pure</div>
      <div>{dot('normal')} miner / oil node · {dot('normal', 'well')} well satellite · {dot('normal', 'geyser')} geyser</div>
      <div><svg width="18" height="18" viewBox="-9 -9 18 18"><circle r="8" fill="#aaa" fillOpacity="0.15" stroke="#aaa" strokeDasharray="3 2" /><polygon points="4,0 2,3.5 -2,3.5 -4,0 -2,-3.5 2,-3.5" fill="#0b0e12" stroke="#aaa" /></svg> resource well (hexagon = Pressurizer spot)</div>
    </>
  );
}
