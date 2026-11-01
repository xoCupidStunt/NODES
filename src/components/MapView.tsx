import { useEffect, useMemo, useRef, useState, type PointerEvent as RPE, type WheelEvent as RWE } from 'react';
import { itemColor, itemName, nodes, RAW_ITEMS, WORLD, type ResourceNode } from '../data/game';
import { nodeById, nodeRate } from '../engine/plan';
import { claimedElsewhere, dist, helpfulFactories, nearestNodes, pickNodes, rawDemand, suggestLocation } from '../engine/placement';
import type { Factory } from '../engine/types';
import { useStore } from '../state';
import { foundName, useFoundFactories } from './GameFactoriesCard';
import { idbGet, idbSet } from './idb';
import { fmt, ItemTag } from './ui';

const SIZE = { w: WORLD.maxX - WORLD.minX, h: WORLD.maxY - WORLD.minY };
const RESOURCE_ITEMS = [...new Set(nodes.map((n) => n.item))].filter((i) => RAW_ITEMS.includes(i));
const PURITY_R = { impure: 0.75, normal: 1, pure: 1.35 };

interface ViewBox { x: number; y: number; w: number }

export function MapView({ f }: { f: Factory }) {
  const { state, dispatch, plans } = useStore();
  const plan = plans[f.id];
  const update = (patch: Partial<Factory>) => dispatch({ type: 'update', id: f.id, patch });
  const { found, byFound } = useFoundFactories();
  const [hoverFound, setHoverFound] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [vb, setVb] = useState<ViewBox>(() =>
    f.location ? { x: f.location.x - 100000, y: f.location.y - 100000, w: 200000 } : { x: WORLD.minX, y: WORLD.minY, w: SIZE.w },
  );
  const [aspect, setAspect] = useState(1.6);
  const [placing, setPlacing] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [hoverNode, setHoverNode] = useState<ResourceNode | null>(null);
  const [filter, setFilter] = useState<'needed' | 'all' | Set<string>>('needed');
  const [bg, setBg] = useState<string | null>(null);
  const [bgOpacity, setBgOpacity] = useState(0.7);
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ sx: number; sy: number; vb: ViewBox; moved: boolean } | null>(null);

  useEffect(() => { idbGet<string>('map-bg').then((v) => v && setBg(v)); }, []);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAspect(el.clientWidth / Math.max(1, el.clientHeight)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const u = plan.unlocks;
  const demand = useMemo(() => rawDemand(f, state.progress, plan), [f, state.progress, plan]);
  const taken = useMemo(() => claimedElsewhere(state.factories, f.id), [state.factories, f.id]);
  const mine = useMemo(() => new Set(f.nodes), [f.nodes]);
  // Nodes with a miner already on them in the synced save: skipped by suggestions, still claimable by hand.
  const inGame = useMemo(() => new Set(state.game?.occupied ?? []), [state.game]);
  const avoid = useMemo(() => new Set([...taken, ...inGame]), [taken, inGame]);
  const ownerOf = useMemo(() => {
    const m: Record<string, Factory> = {};
    for (const o of state.factories) for (const n of o.nodes) m[n] = o;
    return m;
  }, [state.factories]);

  const visibleItems = filter === 'all' ? new Set(RESOURCE_ITEMS) : filter === 'needed' ? new Set(Object.keys(demand)) : filter;
  if (filter === 'needed' && visibleItems.size === 0) RESOURCE_ITEMS.forEach((i) => visibleItems.add(i));

  // Nearest free nodes for each needed resource (highlighted).
  const nearest = useMemo(() => {
    const s = new Map<string, number>();
    if (!f.location) return s;
    for (const item of Object.keys(demand)) for (const { node, d } of nearestNodes(item, f.location, new Set([...avoid, ...mine]), 3)) s.set(node.id, d);
    return s;
  }, [f.location, demand, avoid, mine]);

  const chainItems = useMemo(() => {
    const s = new Set<string>(Object.keys(demand));
    for (const g of plan.groups) for (const [i] of g.inputs) s.add(i);
    return s;
  }, [plan, demand]);
  const helpers = useMemo(() => helpfulFactories(f, state.factories, plans, chainItems), [f, state.factories, plans, chainItems]);
  const helperIds = new Set(helpers.map((h) => h.factory.id));

  // Supply status per needed resource
  const supplyRows = Object.entries(demand).map(([item, need]) => {
    const have = f.nodes.map((id) => nodeById[id]).filter((n) => n?.item === item).reduce((a, n) => a + nodeRate(n, u), 0) + (f.extraSupply[item] ?? 0);
    return { item, need, have };
  });

  const h = vb.w / aspect;
  const pxToWorld = vb.w / (svgRef.current?.clientWidth || 1000);
  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: vb.x + ((e.clientX - r.left) / r.width) * vb.w, y: vb.y + ((e.clientY - r.top) / r.height) * h };
  };

  const onWheel = (e: RWE<SVGSVGElement>) => {
    const p = toWorld(e);
    const k = e.deltaY > 0 ? 1.2 : 1 / 1.2;
    const w = Math.min(SIZE.w * 1.5, Math.max(8000, vb.w * k));
    const r = w / vb.w;
    setVb({ x: p.x - (p.x - vb.x) * r, y: p.y - (p.y - vb.y) * r, w });
  };
  const onDown = (e: RPE<SVGSVGElement>) => {
    drag.current = { sx: e.clientX, sy: e.clientY, vb, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: RPE<SVGSVGElement>) => {
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
  };
  const onUp = (e: RPE<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved && placing) {
      const p = toWorld(e);
      update({ location: { x: Math.round(p.x), y: Math.round(p.y) }, placement: 'manual' });
      setPlacing(false);
    }
  };

  const toggleNode = (n: ResourceNode) => {
    if (taken.has(n.id)) return;
    update({ nodes: mine.has(n.id) ? f.nodes.filter((x) => x !== n.id) : [...f.nodes, n.id] });
  };

  const suggest = () => {
    setBusy(true);
    setTimeout(() => {
      const s = suggestLocation(f, state.factories, state.progress, plan, inGame);
      setBusy(false);
      if (!s) return alert('Nothing to place for — this factory needs no mined resources or imports.');
      update({ location: s.location, nodes: s.nodes, placement: 'suggested' });
      setVb({ x: s.location.x - 90000, y: s.location.y - 90000 / aspect, w: 180000 });
      if (s.short > 0.01) alert(`Not enough free nodes anywhere for the full target: ${fmt(s.short)}/min short. Lower the target or unlock better miners.`);
    }, 20);
  };
  const autoClaim = () => {
    if (!f.location) return;
    const p = pickNodes(demand, f.location, avoid, u);
    update({ nodes: [...new Set([...f.nodes.filter((id) => !demand[nodeById[id]?.item] ), ...p.picked.map((n) => n.id)])] });
  };

  const loadBg = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => { setBg(reader.result as string); idbSet('map-bg', reader.result); };
    reader.readAsDataURL(file);
  };

  const nodeR = Math.max(900, 6 * pxToWorld);
  const grid: number[] = [];
  for (let g = Math.ceil(WORLD.minX / 100000) * 100000; g <= WORLD.maxX; g += 100000) grid.push(g);
  const gridY: number[] = [];
  for (let g = Math.ceil(WORLD.minY / 100000) * 100000; g <= WORLD.maxY; g += 100000) gridY.push(g);

  return (
    <div className="map-layout">
      <div className="map-side">
        <section className="card">
          <h3>Placement</h3>
          <div className="col gap">
            <button className="primary" disabled={busy} onClick={suggest}>{busy ? 'Searching…' : '★ Suggest placement'}</button>
            <button className={placing ? 'on' : ''} onClick={() => setPlacing(!placing)}>{placing ? 'Click on the map…' : '✛ Place manually'}</button>
            <button disabled={!f.location} onClick={autoClaim}>Claim nearest nodes</button>
            <button className="ghost" disabled={!f.nodes.length} onClick={() => update({ nodes: [] })}>Release all nodes</button>
          </div>
          <p className="muted small-text">
            {f.location
              ? `${f.placement === 'suggested' ? 'Suggested' : 'Manual'} spot at ${fmt(f.location.x / 100, 0)}, ${fmt(f.location.y / 100, 0)} m. Click nodes to claim or release them.`
              : 'Suggest finds the spot with the shortest belts to enough free nodes (and to factories you import from).'}
          </p>
        </section>

        <section className="card">
          <h3>Resources needed</h3>
          {supplyRows.length === 0 && <p className="muted">None (only water or imports).</p>}
          {supplyRows.map((r) => (
            <div key={r.item} className="supply-row">
              <ItemTag item={r.item} />
              <span className={r.have + 1e-6 < r.need ? 'warn-text' : 'ok-text'}>{fmt(r.have, 1)} / {fmt(r.need, 1)}</span>
            </div>
          ))}
          <p className="muted small-text">Based on the target rate{f.rate === null ? ' (10/min when maximising)' : ''} and your best miner.</p>
        </section>

        {helpers.length > 0 && (
          <section className="card">
            <h3>Factories with parts to spare</h3>
            {helpers.slice(0, 6).map((hh) => (
              <div key={hh.factory.id + hh.item} className="small-text">
                <b>{hh.factory.name}</b>: <ItemTag item={hh.item} rate={hh.rate} />{hh.distance !== null && <span className="muted"> · {fmt(hh.distance, 0)} m</span>}
              </div>
            ))}
          </section>
        )}

        <section className="card">
          <h3>Show</h3>
          <div className="row gap wrap">
            <button className={`small ${filter === 'needed' ? 'on' : ''}`} onClick={() => setFilter('needed')}>Needed</button>
            <button className={`small ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>All</button>
          </div>
          <div className="chips">
            {RESOURCE_ITEMS.map((i) => (
              <button key={i} className={`chip ${visibleItems.has(i) ? 'on' : ''}`} onClick={() => {
                const s = new Set(visibleItems);
                if (s.has(i)) s.delete(i); else s.add(i);
                setFilter(s);
              }}>
                <span className="swatch" style={{ background: itemColor(i) }} />{itemName(i)}
              </button>
            ))}
          </div>
          <div className="legend small-text">
            <div><svg width="14" height="14"><circle cx="7" cy="7" r="4" fill="#aaa" /></svg> impure · <svg width="14" height="14"><circle cx="7" cy="7" r="5.5" fill="#aaa" /></svg> normal · <svg width="16" height="16"><circle cx="8" cy="8" r="7" fill="#aaa" /></svg> pure</div>
            <div><svg width="14" height="14"><rect x="2" y="2" width="10" height="10" transform="rotate(45 7 7)" fill="#aaa" /></svg> resource well satellite</div>
            {found.length > 0 && <div><span className="wmark found" /> built in your game, not added yet</div>}
            <div><span className="ring mine" /> claimed here · <span className="ring near" /> nearest free · <span className="ring other" /> claimed by another factory</div>
            {state.game && <div><span className="ring ingame" /> already mined in your game ({inGame.size} nodes, from “{state.game.saveName}”)</div>}
          </div>
        </section>

        <section className="card">
          <h3>Map image</h3>
          <p className="muted small-text">Optional: load a picture of the world map (e.g. a screenshot of the in-game map, square, north up) to see terrain under the nodes.</p>
          <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && loadBg(e.target.files[0])} />
          {bg && (
            <div className="row gap">
              <label>Opacity <input type="range" min={0.1} max={1} step={0.05} value={bgOpacity} onChange={(e) => setBgOpacity(Number(e.target.value))} /></label>
              <button className="small ghost" onClick={() => { setBg(null); idbSet('map-bg', undefined); }}>Remove</button>
            </div>
          )}
        </section>
      </div>

      <div className="map-wrap">
        <svg
          ref={svgRef}
          className={`map ${placing ? 'placing' : ''}`}
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${h}`}
          onWheel={onWheel}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={() => { setHover(null); drag.current = null; }}
        >
          <rect x={WORLD.minX} y={WORLD.minY} width={SIZE.w} height={SIZE.h} className="map-bg" />
          {bg && <image href={bg} x={WORLD.minX} y={WORLD.minY} width={SIZE.w} height={SIZE.h} opacity={bgOpacity} preserveAspectRatio="none" />}
          {grid.map((g) => <line key={'x' + g} x1={g} x2={g} y1={WORLD.minY} y2={WORLD.maxY} className="map-grid" strokeWidth={pxToWorld} />)}
          {gridY.map((g) => <line key={'y' + g} y1={g} y2={g} x1={WORLD.minX} x2={WORLD.maxX} className="map-grid" strokeWidth={pxToWorld} />)}

          {/* lines from factory to claimed nodes */}
          {f.location && f.nodes.map((id) => {
            const n = nodeById[id];
            return n ? <line key={'l' + id} x1={f.location!.x} y1={f.location!.y} x2={n.x} y2={n.y} stroke={itemColor(n.item)} strokeWidth={2 * pxToWorld} strokeDasharray={`${6 * pxToWorld} ${4 * pxToWorld}`} opacity={0.9} /> : null;
          })}
          {/* imports */}
          {f.location && f.imports.map((imp, k) => {
            const src = state.factories.find((x) => x.id === imp.factoryId);
            return src?.location ? <line key={'i' + k} x1={src.location.x} y1={src.location.y} x2={f.location!.x} y2={f.location!.y} stroke={itemColor(imp.item)} strokeWidth={3 * pxToWorld} opacity={0.8} /> : null;
          })}

          {nodes.map((n) => {
            if (!visibleItems.has(n.item) && !mine.has(n.id)) return null;
            const r = nodeR * PURITY_R[n.purity];
            const isMine = mine.has(n.id);
            const isTaken = taken.has(n.id);
            const isInGame = inGame.has(n.id);
            const near = nearest.has(n.id);
            const fill = itemColor(n.item);
            return (
              <g key={n.id} className="node" opacity={isTaken || (isInGame && !isMine) ? 0.4 : 1} onPointerUp={(e) => { if (!drag.current?.moved && !placing) { e.stopPropagation(); drag.current = null; toggleNode(n); } }} onPointerEnter={() => setHoverNode(n)} onPointerLeave={() => setHoverNode(null)}>
                {(isMine || near || isTaken) && <circle cx={n.x} cy={n.y} r={r + 3 * pxToWorld} fill="none" stroke={isMine ? '#fff' : near ? '#ffd23f' : '#888'} strokeWidth={2 * pxToWorld} strokeDasharray={isTaken ? `${2 * pxToWorld}` : undefined} />}
                {isInGame && <rect className="node-ingame" x={n.x - r - 5.5 * pxToWorld} y={n.y - r - 5.5 * pxToWorld} width={2 * r + 11 * pxToWorld} height={2 * r + 11 * pxToWorld} fill="none" stroke="#38bdf8" strokeWidth={1.6 * pxToWorld} />}
                {n.type === 'well'
                  ? <rect x={n.x - r * 0.8} y={n.y - r * 0.8} width={r * 1.6} height={r * 1.6} transform={`rotate(45 ${n.x} ${n.y})`} fill={fill} stroke="#000" strokeWidth={0.6 * pxToWorld} />
                  : <circle cx={n.x} cy={n.y} r={r} fill={fill} stroke="#000" strokeWidth={0.6 * pxToWorld} />}
              </g>
            );
          })}

          {/* Factories built in the game that aren't in the planner yet */}
          {found.filter((ff) => !byFound.has(ff.key) && ff.machines > 2).map((ff) => {
            const s = 7 * pxToWorld;
            const b = ff.built.bounds;
            const name = foundName(ff, state.foundNames);
            return (
              <g key={ff.key} className="fmark" onPointerEnter={() => setHoverFound(`${name} · ${ff.machines} machines · built in your game, not added (add it from Progress or the World map)`)} onPointerLeave={() => setHoverFound(null)}>
                {b && <rect x={b.minX - 1500} y={b.minY - 1500} width={b.maxX - b.minX + 3000} height={b.maxY - b.minY + 3000} pointerEvents="none" className="footprint found" strokeWidth={1.2 * pxToWorld} strokeDasharray={`${4 * pxToWorld} ${3 * pxToWorld}`} />}
                <rect x={ff.location.x - s} y={ff.location.y - s} width={s * 2} height={s * 2} transform={`rotate(45 ${ff.location.x} ${ff.location.y})`} className="wfound" strokeWidth={1.5 * pxToWorld} />
                {vb.w < 250000 && <text x={ff.location.x} y={ff.location.y - s - 6 * pxToWorld} fontSize={11 * pxToWorld} textAnchor="middle" className="fmark-label found">{name}</text>}
              </g>
            );
          })}

          {state.factories.map((o) => {
            if (!o.location) return null;
            const active = o.id === f.id;
            const s = (active ? 11 : 8) * pxToWorld;
            return (
              <g key={o.id} className="fmark" onPointerUp={(e) => { if (!drag.current?.moved && !placing && !active) { e.stopPropagation(); drag.current = null; dispatch({ type: 'select', id: o.id }); } }}>
                {helperIds.has(o.id) && <circle cx={o.location.x} cy={o.location.y} r={s * 2} fill="none" stroke="#4ade80" strokeWidth={2.5 * pxToWorld} />}
                {o.game?.bounds && <rect x={o.game.bounds.minX - 1500} y={o.game.bounds.minY - 1500} width={o.game.bounds.maxX - o.game.bounds.minX + 3000} height={o.game.bounds.maxY - o.game.bounds.minY + 3000} className="footprint linked" strokeWidth={1.2 * pxToWorld} pointerEvents="none" />}
                <rect x={o.location.x - s} y={o.location.y - s} width={s * 2} height={s * 2} rx={2 * pxToWorld} className={active ? 'fmark-active' : o.game ? 'fmark-linked' : 'fmark-other'} strokeWidth={2 * pxToWorld} />
                <text x={o.location.x} y={o.location.y - s - 5 * pxToWorld} fontSize={12 * pxToWorld} textAnchor="middle" className="fmark-label">{o.name}</text>
              </g>
            );
          })}
        </svg>
        <div className="map-hud">
          {hoverFound ? (
            <span>{hoverFound}</span>
          ) : hoverNode ? (
            <span>
              <b>{hoverNode.purity}</b> {itemName(hoverNode.item)}{hoverNode.type === 'well' ? ' (well satellite)' : ''} · {fmt(nodeRate(hoverNode, u))}/min with your extractor
              {f.location && ` · ${fmt(dist(hoverNode, f.location), 0)} m from ${f.name}`}
              {ownerOf[hoverNode.id] && ` · claimed by ${ownerOf[hoverNode.id].name}`}
              {inGame.has(hoverNode.id) && ' · already mined in your game'}
            </span>
          ) : hover ? (
            <span>x {fmt(hover.x / 100, 0)} m, y {fmt(hover.y / 100, 0)} m · scroll to zoom, drag to pan</span>
          ) : (
            <span>Scroll to zoom, drag to pan. Grid squares are 1 km.</span>
          )}
          <button className="small ghost" onClick={() => setVb({ x: WORLD.minX, y: WORLD.minY, w: SIZE.w })}>Reset view</button>
        </div>
      </div>
    </div>
  );
}
