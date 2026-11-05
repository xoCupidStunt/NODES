import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type SVGProps } from 'react';
import { FOUNDATION as F, isFluid, itemColor, itemName, MACHINE_COLORS } from '../data/game';
import { buildSchematic, facingFor, type BeltPath, type Facing, type Floor, type Schematic, type SchematicContext, type SourceBox } from '../engine/schematic';
import { defaultSchematic, type Factory, type SchematicOptions } from '../engine/types';
import { useStore } from '../state';
import { fmt } from './ui';

const C = {
  yard: '#262c35',
  bg: '#14171c', floor: '#1d2229', grid: '#2b323c', grid5: '#3b4552', bus: '#232a33', row: '#20262e',
  text: '#e8e3d9', muted: '#9aa3ad', wall: '#c9ced6', hole: '#ffcc33', pole: '#ffd23f', machineStroke: '#0b0d10',
};

export function SchematicView({ f }: { f: Factory }) {
  const { state, dispatch, plans } = useStore();
  const plan = plans[f.id];
  const o = f.schematic;
  const set = (patch: Partial<SchematicOptions>) => dispatch({ type: 'update', id: f.id, patch: { schematic: { ...o, ...patch } } });
  const [scale, setScale] = useState(5);
  const [floorSel, setFloorSel] = useState<number | 'all'>('all');
  const svgRef = useRef<SVGSVGElement>(null);
  // Zoom: keep the point in the middle of the view in the middle after the size changes.
  const canvasRef = useRef<HTMLDivElement>(null);
  const keepCentre = useRef<{ rx: number; ry: number } | null>(null);
  const zoomTo = (next: (s: number) => number) => {
    const el = canvasRef.current;
    if (el) keepCentre.current = { rx: (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth, ry: (el.scrollTop + el.clientHeight / 2) / el.scrollHeight };
    setScale((cur) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next(cur) * 10) / 10)));
  };
  useLayoutEffect(() => {
    const el = canvasRef.current;
    const c = keepCentre.current;
    if (!el || !c) return;
    el.scrollLeft = c.rx * el.scrollWidth - el.clientWidth / 2;
    el.scrollTop = c.ry * el.scrollHeight - el.clientHeight / 2;
    keepCentre.current = null;
  }, [scale]);
  // Fit: labels and margins don't scale with zoom, so re-measure and adjust (a few passes) until it fits.
  const fitting = useRef(0);
  const fitWidth = () => { fitting.current = 10; setFitTick((t) => t + 1); };
  const [fitTick, setFitTick] = useState(0);
  useLayoutEffect(() => {
    const el = canvasRef.current;
    const svg = svgRef.current;
    if (!fitting.current || !el || !svg) return;
    fitting.current--;
    const want = el.clientWidth - 24;
    const have = svg.getBoundingClientRect().width;
    if (Math.abs(have - want) < 12) { fitting.current = 0; return; }
    setScale((cur) => {
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.floor(cur * (want / have) * 10) / 10));
      if (next === cur) fitting.current = 0;
      return next;
    });
    el.scrollLeft = 0;
  });
  void fitTick;
  // Ctrl/⌘ + scroll zooms the drawing (plain scroll still scrolls it).
  const zoomRef = useRef(zoomTo);
  zoomRef.current = zoomTo;
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomRef.current((cur) => cur * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });
  // Each floor's real drawn extent (labels included), measured after render; the first render estimates.
  const floorRefs = useRef<Record<number, SVGGElement | null>>({});
  const [measured, setMeasured] = useState<Record<number, Box>>({});
  useLayoutEffect(() => {
    const next: Record<number, Box> = {};
    let changed = false;
    for (const [k, el] of Object.entries(floorRefs.current)) {
      if (!el) continue;
      const b = el.getBBox();
      const box = { x0: b.x - 10, y0: b.y - 10, x1: b.x + b.width + 10, y1: b.y + b.height + 10 };
      const old = measured[Number(k)];
      next[Number(k)] = box;
      if (!old || Math.abs(old.x0 - box.x0) + Math.abs(old.y0 - box.y0) + Math.abs(old.x1 - box.x1) + Math.abs(old.y1 - box.y1) > 2) changed = true;
    }
    if (changed) setMeasured(next);
  });
  // Where it is and who supplies it: gives the extraction yard distances and turns the plan toward its supply.
  const ctx = useMemo<SchematicContext>(() => ({
    location: f.location,
    imports: f.imports.map((i) => {
      const src = state.factories.find((x) => x.id === i.factoryId);
      return { name: src?.name ?? 'another factory', item: i.item, rate: i.rate, at: src?.location ?? null };
    }),
  }), [f.location, f.imports, state.factories]);
  const sch = useMemo(() => (plan.status === 'ok' ? buildSchematic(plan, o, f.target, ctx) : null), [plan, o, f.target, ctx]);
  const autoFacing = useMemo(() => (plan.status === 'ok' ? facingFor(plan, ctx).facing : 'N'), [plan, ctx]);

  if (!sch) {
    return <div className="card"><h2>No schematic</h2><p className="muted">Finish the setup first — the plan has nothing to build yet.</p></div>;
  }
  const floors = floorSel === 'all' ? sch.floors : sch.floors.filter((fl) => fl.index === floorSel);
  const HEADER = 34;
  const GAP = 40;
  const FOOT = 34; // scale bar + north arrow under each floor
  const angle = ANGLE[sch.facing];
  const boxes = floors.map((fl) => turned(measured[fl.index] ?? floorBox(fl, sch, scale, o), angle));
  const totalH = boxes.reduce((a, b) => a + (b.y1 - b.y0) + HEADER + FOOT + GAP, 0);
  const totalW = Math.max(...boxes.map((b) => b.x1 - b.x0)) + 40;

  const download = (kind: 'svg' | 'png') => {
    const el = svgRef.current;
    if (!el) return;
    const xml = new XMLSerializer().serializeToString(el);
    const name = `${f.name.replace(/[^\w-]+/g, '_')}-schematic`;
    if (kind === 'svg') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
      a.download = `${name}.svg`;
      a.click();
      return;
    }
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const k = 2;
      canvas.width = el.width.baseVal.value * k;
      canvas.height = el.height.baseVal.value * k;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(k, k);
      ctx.drawImage(img, 0, 0);
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `${name}.png`;
      a.click();
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  };

  let yOff = 0;
  return (
    <div className="schematic-layout">
      <div className="sch-side">
        <section className="card">
          <h3>Layout</h3>
          <Range label="Space between machines" value={o.machineGap} min={0} max={8} step={1} unit="m" onChange={(v) => set({ machineGap: v })} />
          <Range label="Walkway between rows" value={o.rowGap} min={0} max={4} step={1} unit="fdn" onChange={(v) => set({ rowGap: v })} />
          <Range label="Machines per row (max)" value={o.maxPerRow} min={1} max={30} step={1} onChange={(v) => set({ maxPerRow: v })} />
          <Range label="Floors" value={o.floors} min={1} max={8} step={1} onChange={(v) => set({ floors: v })} />
          <Range label="Outer walkway" value={o.border} min={0} max={3} step={1} unit="fdn" onChange={(v) => set({ border: v })} />
          <label className="field">Input side
            <select value={o.orientation ?? 'auto'} onChange={(e) => set({ orientation: e.target.value as SchematicOptions['orientation'] })}>
              <option value="auto">Toward the supply ({FACING_NAME[autoFacing]})</option>
              {(['N', 'E', 'S', 'W'] as const).map((d) => <option key={d} value={d}>Face {FACING_NAME[d]}</option>)}
            </select>
          </label>
          <label className="field">Snap machines to
            <select value={o.snap} onChange={(e) => set({ snap: e.target.value as SchematicOptions['snap'] })}>
              <option value="none">1 m (tight)</option>
              <option value="half">half foundation (4 m)</option>
              <option value="full">full foundation (8 m)</option>
            </select>
          </label>
        </section>
        <section className="card">
          <h3>Belts &amp; pipes</h3>
          <label className="field">Show logistics
            <select value={o.logistics} onChange={(e) => set({ logistics: e.target.value as SchematicOptions['logistics'] })}>
              <option value="visible">Visible on the floor</option>
              <option value="underfloor">Hidden under the floor</option>
              <option value="walls">Hidden behind walls</option>
            </select>
          </label>
          <label className="field">Feeding machines
            <select value={o.distribution ?? 'balanced'} onChange={(e) => set({ distribution: e.target.value as SchematicOptions['distribution'] })}>
              <option value="balanced">Balanced (splitter trees, even from the start)</option>
              <option value="manifold">Manifold (simpler, backs up to fill)</option>
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={o.perimeterWalls} onChange={(e) => set({ perimeterWalls: e.target.checked })} /> Perimeter walls</label>
          <label className="check"><input type="checkbox" checked={o.showPower} onChange={(e) => set({ showPower: e.target.checked })} /> Power poles</label>
          <label className="check"><input type="checkbox" checked={o.showLabels} onChange={(e) => set({ showLabels: e.target.checked })} /> Machine labels</label>
          <label className="check"><input type="checkbox" checked={o.showRates} onChange={(e) => set({ showRates: e.target.checked })} /> Belt rates &amp; tiers</label>
          <button className="small ghost" onClick={() => set({ ...defaultSchematic })}>Reset options</button>
        </section>
        <section className="card">
          <h3>View</h3>
          <Range label="Zoom" value={scale} min={ZOOM_MIN} max={ZOOM_MAX} step={0.5} unit="px/m" onChange={(v) => zoomTo(() => v)} />
          <label className="field">Floor
            <select value={String(floorSel)} onChange={(e) => setFloorSel(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
              <option value="all">All floors</option>
              {sch.floors.map((fl) => <option key={fl.index} value={fl.index}>Floor {fl.index + 1}</option>)}
            </select>
          </label>
          <div className="row gap wrap">
            <button className="small" onClick={() => download('svg')}>Download SVG</button>
            <button className="small" onClick={() => download('png')}>Download PNG</button>
            <button className="small ghost" onClick={() => window.print()}>Print</button>
          </div>
        </section>
      </div>

      <div className="sch-main">
        {f.game && (
          <div className="sch-disclaimer" role="note">
            <b>For visual reference only.</b> This schematic is generated from the planner’s best layout for this factory’s output. It does not show what is actually built in your game — machine positions, belts and counts in your world will differ.
          </div>
        )}
        <div className="sch-summary">
          <b>{sch.width / F} × {sch.height / F} foundations</b> ({sch.width} × {sch.height} m) · {sch.floors.length} floor{sch.floors.length > 1 ? 's' : ''}
          {sch.floors.length > 1 && <> · storey heights {sch.floors.map((fl) => `${fl.storeyHeight} m`).join(' / ')}</>}
          <span className="muted"> · 1 grid square = 1 foundation (8 m) · input wall faces {FACING_NAME[sch.facing]}</span>
        </div>
        <div className="sch-canvas-wrap">
        <div className="sch-zoom" role="group" aria-label="Zoom">
          <button className="small" onClick={() => zoomTo((c) => c / 1.25)} title="Zoom out" aria-label="Zoom out">−</button>
          <span className="sch-zoom-level" title="Pixels per metre">{fmt(scale, 1)} px/m</span>
          <button className="small" onClick={() => zoomTo((c) => c * 1.25)} title="Zoom in" aria-label="Zoom in">+</button>
          <button className="small ghost" onClick={() => {
            const el = canvasRef.current;
            if (el) fitWidth();
          }} title="Fit the width of the drawing">Fit</button>
        </div>
        <div className="sch-canvas" ref={canvasRef}>
          <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" width={totalW} height={totalH} style={{ background: C.bg }} fontFamily="Segoe UI, Roboto, sans-serif">
            <Defs sch={sch} />
            <rect width={totalW} height={totalH} fill={C.bg} />
            {floors.map((fl, k) => {
              const b = boxes[k];
              const bh = b.y1 - b.y0;
              const g = (
                <g key={fl.index} transform={`translate(20, ${yOff})`}>
                  <text x={0} y={22} fill={C.text} fontSize={16} fontWeight={700}>
                    Floor {fl.index + 1}{fl.index === 0 ? ' (ground)' : ` (+${sch.floors.slice(0, fl.index).reduce((a, x) => a + x.storeyHeight, 0)} m)`}
                    <tspan fill={C.muted} fontSize={12} fontWeight={400}>  · {fl.machines.length} machines · storey {fl.storeyHeight} m</tspan>
                  </text>
                  <RotCtx.Provider value={angle}>
                    <g transform={`translate(${-b.x0}, ${HEADER - b.y0}) rotate(${angle})`}>
                      <g ref={(el) => { floorRefs.current[fl.index] = el; }}>
                        <FloorDrawing fl={fl} s={scale} o={o} sources={fl.index === 0 ? sch.sources : []} />
                      </g>
                    </g>
                  </RotCtx.Provider>
                  <Compass x={0} y={HEADER + bh + 16} s={scale} facing={sch.facing} />
                </g>
              );
              yOff += bh + HEADER + FOOT + GAP;
              return g;
            })}
          </svg>
        </div>
        </div>

        <div className="two-col">
          <section className="card">
            <h3>Legend</h3>
            <div className="legend-grid">
              {[...new Set(sch.floors.flatMap((fl) => fl.machines.map((m) => m.machine.id)))].map((id) => {
                const m = sch.floors.flatMap((fl) => fl.machines).find((x) => x.machine.id === id)!.machine;
                return <div key={id}><span className="mdot" style={{ background: MACHINE_COLORS[id] ?? '#888' }} />{m.name} <span className="muted">{m.w} × {m.l} m</span></div>;
              })}
              {sch.lanes.map((l) => (
                <div key={l.item}><svg width="28" height="10"><line x1="0" y1="5" x2="28" y2="5" stroke={itemColor(l.item)} strokeWidth={l.fluid ? 6 : 3} />{l.fluid && <line x1="0" y1="5" x2="28" y2="5" stroke={C.bg} strokeWidth={2} />}</svg> {itemName(l.item)} {l.fluid ? '(pipe)' : '(belt)'}</div>
              ))}
              <div><svg width="14" height="14"><rect x="2" y="2" width="10" height="10" fill="#fff" stroke="#000" /></svg> Splitter</div>
              <div><svg width="14" height="14"><rect x="2" y="2" width="10" height="10" fill="#333" stroke="#fff" /></svg> Merger</div>
              {sch.balancing.length > 0 && <div><svg width="26" height="14"><rect x="1" y="1" width="24" height="12" rx="3" fill="#fff" stroke="#aaa" strokeWidth="2" /><text x="13" y="10.5" fontSize="8" fontWeight="700" textAnchor="middle" fill="#111">1→N</text></svg> Balanced splitter tree (1→N to a row's machines, ÷N to share the bus)</div>}
              <div><svg width="14" height="14"><circle cx="7" cy="7" r="5" fill="#3fa0e0" stroke="#fff" /></svg> Pipe junction</div>
              <div><svg width="16" height="16"><circle cx="8" cy="8" r="7" fill="none" stroke="#fff" strokeWidth="2" /></svg> Conveyor lift / vertical pipe</div>
              {o.showPower && <div><svg width="14" height="14"><circle cx="7" cy="7" r="5" fill={C.pole} /></svg> Power pole</div>}
              {o.logistics !== 'visible' && <div><svg width="28" height="10"><line x1="0" y1="5" x2="28" y2="5" stroke="#aaa" strokeWidth={3} strokeDasharray="4 3" opacity={0.6} /></svg> Hidden belt / pipe</div>}
              {o.logistics !== 'visible' && <div><svg width="14" height="14"><rect x="3" y="3" width="8" height="8" fill="none" stroke={C.hole} strokeWidth="2" /></svg> {o.logistics === 'walls' ? 'Wall hole' : 'Floor hole'}</div>}
              <div><svg width="20" height="12"><path d="M2,6 L14,6 M10,2 L16,6 L10,10" stroke="#fff" fill="none" strokeWidth="2" /></svg> Flow direction</div>
              {sch.sources.length > 0 && <div><svg width="18" height="14"><rect x="1" y="1" width="16" height="12" rx="2" fill={C.yard} stroke="#aaa" /></svg> Where inputs come from (above the input wall) and where products go (below the output wall)</div>}
              <div><svg width="18" height="14"><rect x="4" y="0" width="10" height="14" fill={C.bus} /></svg> Bus: one lane per item, rows take from it and feed back</div>
            </div>
          </section>
          <section className="card">
            <h3>Bill of materials</h3>
            <table className="table compact">
              <tbody>
                {sch.bom.map((b, k) => <tr key={k}><td>{b.name}</td><td className="num">{fmt(b.count, 0)}{b.unit ? ` ${b.unit}` : ''}</td></tr>)}
              </tbody>
            </table>
            <h3>Notes</h3>
            <ul className="notes">{sch.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </section>
        </div>
        {sch.balancing.length > 0 && <BalancingCard sch={sch} />}
      </div>
    </div>
  );
}

function Range({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span className="row between"><span>{label}</span><b>{value}{unit ? ` ${unit}` : ''}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Defs({ sch }: { sch: Schematic }) {
  const colors = new Set(sch.lanes.map((l) => itemColor(l.item)));
  return (
    <defs>
      {[...colors].map((c) => (
        <marker key={c} id={markerId(c)} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill={c} stroke="#000" strokeWidth="0.8" />
        </marker>
      ))}
    </defs>
  );
}
const markerId = (c: string) => 'arr-' + c.replace(/[^a-z0-9]/gi, '');

function FloorDrawing({ fl, s, o, sources }: { fl: Floor; s: number; o: SchematicOptions; sources: SourceBox[] }) {
  const W = fl.width * s;
  const H = fl.height * s;
  const cols = fl.width / F;
  const rows = fl.height / F;
  const colName = (i: number) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + (i % 26));
  const hidden = fl.belts.filter((b) => b.hidden);
  const shown = fl.belts.filter((b) => !b.hidden);
  return (
    <g>
      <rect width={W} height={H} fill={C.floor} />
      {/* foundation grid */}
      {Array.from({ length: cols + 1 }, (_, i) => <line key={'c' + i} x1={i * F * s} x2={i * F * s} y1={0} y2={H} stroke={i % 5 === 0 ? C.grid5 : C.grid} strokeWidth={1} />)}
      {Array.from({ length: rows + 1 }, (_, i) => <line key={'r' + i} y1={i * F * s} y2={i * F * s} x1={0} x2={W} stroke={i % 5 === 0 ? C.grid5 : C.grid} strokeWidth={1} />)}
      {s >= 4 && Array.from({ length: cols }, (_, i) => <T key={'cn' + i} x={(i + 0.5) * F * s} y={-4} fontSize={9} fill={C.muted} textAnchor="middle">{colName(i)}</T>)}
      {s >= 4 && Array.from({ length: rows }, (_, i) => <T key={'rn' + i} x={-4} y={(i + 0.5) * F * s + 3} fontSize={9} fill={C.muted} textAnchor="end">{i + 1}</T>)}

      {fl.bus && <rect x={fl.bus.x * s} y={0} width={fl.bus.w * s} height={H} fill={C.bus} opacity={0.8} />}

      {/* hidden logistics first, faded */}
      <g opacity={0.45}>{hidden.map((b, k) => <Belt key={k} b={b} s={s} dashed />)}</g>

      {fl.rows.map((r) => (
        <g key={r.id}>
          <rect x={r.x * s} y={r.y * s} width={r.w * s} height={r.h * s} fill={C.row} stroke={C.grid5} strokeDasharray="4 3" />
          {o.showLabels && (
            <T after x={(r.x + r.w) * s + 6} y={(r.y + r.h / 2) * s - 3} fontSize={11} fill={C.text}>
              <tspan x={(r.x + r.w) * s + 6} fontWeight={600}>{r.count} × {r.machine.name}</tspan>
              <tspan x={(r.x + r.w) * s + 6} dy={13} fill={C.muted}>{r.recipe.name} @ {fmt(r.clock, 2)}%</tspan>
            </T>
          )}
        </g>
      ))}

      {fl.machines.map((m) => {
        const color = MACHINE_COLORS[m.machine.id] ?? '#888';
        return (
          <g key={m.id}>
            <rect x={m.x * s} y={m.y * s} width={m.w * s} height={m.l * s} fill={color} stroke={C.machineStroke} strokeWidth={1.5} rx={2}>
              <title>{`${m.machine.name} #${m.index} — ${m.recipe.name} @ ${fmt(m.clock, 4)}% (${m.w} × ${m.l} m)`}</title>
            </rect>
            {m.inPorts.map((p, k) => <path key={'i' + k} d={`M${p.x * s - 4},${p.y * s - 1} L${p.x * s + 4},${p.y * s - 1} L${p.x * s},${p.y * s + 6} z`} fill={itemColor(p.item)} stroke="#000" strokeWidth={0.8} />)}
            {m.outPorts.map((p, k) => <path key={'o' + k} d={`M${p.x * s - 4},${p.y * s - 6} L${p.x * s + 4},${p.y * s - 6} L${p.x * s},${p.y * s + 1} z`} fill={itemColor(p.item)} stroke="#000" strokeWidth={0.8} />)}
            {o.showLabels && s >= 4 && (
              <T x={(m.x + m.w / 2) * s} y={(m.y + m.l / 2) * s + 3} fontSize={Math.min(11, m.w * s / 6)} fill="#0b0d10" textAnchor="middle" fontWeight={700}>
                {short(m.machine.name)} {m.index}
                {s >= 6 && <tspan x={(m.x + m.w / 2) * s} dy={12} fontWeight={400}>{fmt(m.clock, 1)}%</tspan>}
              </T>
            )}
          </g>
        );
      })}

      {shown.map((b, k) => <Belt key={k} b={b} s={s} />)}
      {o.showRates && fl.belts.filter((b) => b.kind !== 'feed').map((b, k) => {
        const [a, c] = [b.points[0], b.points[b.points.length - 1]];
        const vertical = Math.abs(a.x - c.x) < 0.1;
        const label = `${itemName(b.item)} ${fmt(b.rate, 1)}${b.fluid ? 'm³' : ''}/min · ${b.lanes > 1 ? b.lanes + '× ' : ''}${b.tier.replace('Conveyor Belt ', 'Belt ').replace('Pipeline ', 'Pipe ')}`;
        if (vertical) return null;
        // After the row's last machine, level with its belt: clear of splitters, ports and the bus.
        return <T after key={'lbl' + k} x={Math.max(a.x, c.x) * s + 8} y={a.y * s + 3} fontSize={9} fill={C.text} opacity={b.hidden ? 0.7 : 1} paintOrder="stroke" stroke={C.bg} strokeWidth={3}>{label}</T>;
      })}

      {fl.markers.map((m, k) => {
        const x = m.x * s;
        const y = m.y * s;
        const z = Math.max(4, 2 * s);
        switch (m.kind) {
          case 'splitter': return <rect key={k} x={x - z / 2} y={y - z / 2} width={z} height={z} fill="#fff" stroke="#000" opacity={o.logistics === 'visible' ? 1 : 0.5}><title>Splitter</title></rect>;
          case 'merger': return <rect key={k} x={x - z / 2} y={y - z / 2} width={z} height={z} fill="#333" stroke="#fff" opacity={o.logistics === 'visible' ? 1 : 0.5}><title>Merger</title></rect>;
          case 'junction': return <circle key={k} cx={x} cy={y} r={z / 2} fill="#3fa0e0" stroke="#fff" opacity={o.logistics === 'visible' ? 1 : 0.5}><title>Pipeline junction</title></circle>;
          case 'lift': return (
            <g key={k}>
              <circle cx={x} cy={y} r={Math.max(6, 1.6 * s)} fill={C.bg} stroke={itemColor(m.item!)} strokeWidth={2.5} />
              <T x={x} y={y + 3} fontSize={9} fill={C.text} textAnchor="middle">{m.label}</T>
              <title>{`${isFluid(m.item!) ? 'Vertical pipe' : 'Conveyor lift'}: ${itemName(m.item!)}`}</title>
            </g>
          );
          case 'hole': return <rect key={k} x={x - 3} y={y - 3} width={6} height={6} fill="none" stroke={C.hole} strokeWidth={1.5}><title>Conveyor floor hole</title></rect>;
          case 'pole': return <circle key={k} cx={x} cy={y} r={Math.max(3, 0.8 * s)} fill={C.pole} stroke="#000"><title>Power pole</title></circle>;
          case 'balancer': {
            const bw = Math.max(26, 4.5 * s);
            const bh = Math.max(12, 2.2 * s);
            return (
              <g key={k} opacity={o.logistics === 'visible' ? 1 : 0.75}>
                <rect x={x - bw / 2} y={y - bh / 2} width={bw} height={bh} rx={3} fill="#fff" stroke={itemColor(m.item!)} strokeWidth={2} />
                <T x={x} y={y + 3.5} fontSize={Math.max(8, Math.min(11, bh * 0.7))} fontWeight={700} fill="#111" textAnchor="middle">{m.label}</T>
                <title>{m.title ?? 'Balanced splitter tree'}</title>
              </g>
            );
          }
        }
        return null;
      })}

      {fl.walls.map((w, k) => (
        <g key={'w' + k}>
          <line x1={w.a.x * s} y1={w.a.y * s} x2={w.b.x * s} y2={w.b.y * s} stroke={C.wall} strokeWidth={Math.max(3, 0.5 * s)} strokeLinecap="square" />
          {w.holes?.map((hx, j) => {
            const horizontal = Math.abs(w.a.y - w.b.y) < 0.1;
            const px = horizontal ? hx * s : w.a.x * s;
            const py = horizontal ? w.a.y * s : hx * s;
            return <rect key={j} x={px - 4} y={py - 4} width={8} height={8} fill={C.bg} stroke={C.hole} strokeWidth={1.5}><title>Wall opening</title></rect>;
          })}
        </g>
      ))}

      {fl.ports.map((p, k) => {
        const x = p.x * s;
        const y = p.y * s;
        const up = p.dir === 'in';
        return (
          <g key={'p' + k}>
            <path d={up ? `M${x - 7},${y - 8} L${x + 7},${y - 8} L${x},${y + 4} z` : `M${x - 7},${y - 4} L${x + 7},${y - 4} L${x},${y + 8} z`} fill={itemColor(p.item)} stroke="#fff" strokeWidth={1.2} />
            <title>{`${p.label} ${fmt(p.rate, 1)}${isFluid(p.item) ? ' m³' : ''}/min`}</title>
          </g>
        );
      })}

      {sources.map((b, k) => <Yard key={'src' + k} b={b} s={s} />)}
      {fl.outBoxes.map((b, k) => <Yard key={'out' + k} b={b} s={s} />)}
    </g>
  );
}

function Belt({ b, s, dashed }: { b: BeltPath; s: number; dashed?: boolean }) {
  const color = itemColor(b.item);
  // Add a midpoint so straight runs get a direction arrow in the middle.
  const pts = b.points.length === 2 ? [b.points[0], { x: (b.points[0].x + b.points[1].x) / 2, y: (b.points[0].y + b.points[1].y) / 2 }, b.points[1]] : b.points;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x * s},${p.y * s}`).join(' ');
  const w = Math.max(2, (b.kind === 'bus' ? 1.4 : 1.1) * s) * (b.lanes > 1 ? 1.4 : 1);
  return (
    <g>
      <path d={d} fill="none" stroke={color} strokeWidth={b.fluid ? w * 1.3 : w} strokeDasharray={dashed ? `${2 * s} ${1.5 * s}` : undefined}
        markerMid={b.kind === 'feed' ? undefined : `url(#${markerId(color)})`} markerEnd={b.kind === 'bus' ? undefined : `url(#${markerId(color)})`}>
        <title>{`${itemName(b.item)} — ${fmt(b.rate, 2)}${b.fluid ? ' m³' : ''}/min on ${b.lanes > 1 ? b.lanes + '× ' : ''}${b.tier}${b.hidden ? ' (hidden)' : ''}`}</title>
      </path>
      {b.fluid && <path d={d} fill="none" stroke={C.bg} strokeWidth={Math.max(1, w * 0.45)} />}
    </g>
  );
}

const short = (name: string) =>
  ({ 'Particle Accelerator': 'P.Acc', 'Quantum Encoder': 'Q.Enc', Manufacturer: 'Manuf', Constructor: 'Constr', Assembler: 'Assem' } as Record<string, string>)[name] ?? name;

const ANGLE: Record<Facing, number> = { N: 0, E: 90, S: 180, W: 270 };
const FACING_NAME: Record<Facing, string> = { N: 'north', E: 'east', S: 'south', W: 'west' };

/** How far the plan is turned, so text inside it can be turned back upright. */
const RotCtx = createContext(0);
/**
 * Text inside the turned plan, kept upright. `after`: it belongs past the end of a row or belt (the plan's +x side).
 * Turned 180° it's right-aligned so it still runs away from the drawing; turned 90°/270° the rows are columns
 * with no room across them, so it runs along the row instead (read top-down or bottom-up), like on a floor plan.
 */
function T({ x, y, after, ...rest }: SVGProps<SVGTextElement> & { x: number; y: number; after?: boolean }) {
  const a = useContext(RotCtx);
  if (after && (a === 90 || a === 270)) return <text x={x} y={y} {...rest} />;
  return <text x={x} y={y} transform={a ? `rotate(${-a} ${x} ${y})` : undefined} {...rest} {...(after && a === 180 ? { textAnchor: 'end' } : {})} />;
}

interface Box { x0: number; y0: number; x1: number; y1: number }
/** The floor's drawing area in px before turning: plan, yard above it (ground floor), labels around it. */
function floorBox(fl: Floor, sch: Schematic, s: number, o: SchematicOptions): Box {
  const yard = fl.index === 0 ? sch.yardH : 0;
  const yardW = fl.index === 0 && sch.sources.length ? Math.max(...sch.sources.map((b) => b.x + b.w)) : 0;
  const outW = fl.outBoxes.length ? Math.max(...fl.outBoxes.map((b) => b.x + b.w)) : 0;
  const outH = fl.outBoxes.length ? Math.max(...fl.outBoxes.map((b) => b.y + b.h)) : fl.height;
  return { x0: -30, y0: -yard * s - 18, x1: Math.max(fl.width, yardW, outW) * s + (o.showLabels ? 320 : 30), y1: outH * s + 12 };
}
/** The same box after rotate(angle) about the origin. */
function turned(b: Box, a: number): Box {
  if (a === 90) return { x0: -b.y1, y0: b.x0, x1: -b.y0, y1: b.x1 };
  if (a === 180) return { x0: -b.x1, y0: -b.y1, x1: -b.x0, y1: -b.y0 };
  if (a === 270) return { x0: b.y0, y0: -b.x1, x1: b.y1, y1: -b.x0 };
  return b;
}

/** Scale bar and a north arrow (north is always up; the plan is what turns). */
function Compass({ x, y, s, facing }: { x: number; y: number; s: number; facing: Facing }) {
  return (
    <g transform={`translate(${x}, ${y})`}>
      <rect width={5 * F * s} height={4} fill={C.muted} />
      <text x={0} y={-3} fontSize={9} fill={C.muted}>0</text>
      <text x={5 * F * s} y={-3} fontSize={9} fill={C.muted} textAnchor="end">40 m (5 foundations)</text>
      <g transform={`translate(${5 * F * s + 30}, 0)`}>
        <path d="M0,-12 L6,4 L0,0 L-6,4 z" fill={C.text} />
        <text y={14} fontSize={9} fill={C.text} textAnchor="middle">N</text>
      </g>
      <text x={5 * F * s + 52} y={4} fontSize={10} fill={C.muted}>inputs come in from the {FACING_NAME[facing]}</text>
    </g>
  );
}

/** A miner, extractor group or other supply in the yard, wired to its input port. */
function Yard({ b, s }: { b: SourceBox; s: number }) {
  const color = itemColor(b.item);
  const d = b.wire.map((p, i) => `${i ? 'L' : 'M'}${p.x * s},${p.y * s}`).join(' ');
  const lines = [b.title, ...b.lines];
  const cx = (b.x + b.w / 2) * s;
  const cy = (b.y + b.h / 2) * s;
  const dashed = b.kind === 'import' || b.kind === 'outside';
  return (
    <g>
      <path d={d} fill="none" stroke={color} strokeWidth={Math.max(2, 1.1 * s) * (isFluid(b.item) ? 1.3 : 1)} strokeDasharray={dashed ? `${2 * s} ${1.5 * s}` : undefined} markerEnd={`url(#${markerId(color)})`} />
      {isFluid(b.item) && <path d={d} fill="none" stroke={C.bg} strokeWidth={Math.max(1, 0.5 * s)} />}
      <rect x={b.x * s} y={b.y * s} width={b.w * s} height={b.h * s} rx={4} fill={C.yard} stroke={color} strokeWidth={2} strokeDasharray={dashed ? '6 4' : undefined}>
        <title>{lines.join('\n')}</title>
      </rect>
      <T x={cx} y={cy} fontSize={Math.max(8, Math.min(11, s * 1.8))} fill={C.text} textAnchor="middle">
        {lines.map((l, i) => <tspan key={i} x={cx} dy={i === 0 ? -((lines.length - 1) * 12) / 2 + 3 : 12} fontWeight={i === 0 ? 700 : 400} fill={i === 0 ? C.text : C.muted}>{l}</tspan>)}
      </T>
    </g>
  );
}

const ZOOM_MIN = 1;
const ZOOM_MAX = 16;

/** Build steps for every balanced split, by floor. */
function BalancingCard({ sch }: { sch: Schematic }) {
  const [open, setOpen] = useState(true);
  const floors = [...new Set(sch.balancing.map((b) => b.floor))];
  const parts = sch.balancing.reduce((a, b) => ({ s: a.s + b.splitters, m: a.m + b.mergers }), { s: 0, m: 0 });
  return (
    <section className="card balancing-card">
      <div className="row between wrap">
        <h3>Load balancing</h3>
        <button className="small ghost" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide steps' : 'Show steps'}</button>
      </div>
      <p className="muted small-text">
        {sch.balancing.length} balanced split{sch.balancing.length === 1 ? '' : 's'} · {parts.s} splitters and {parts.m} mergers in total (already in the bill of materials).
        Build each tree before connecting the machines, so every one starts at its share.
      </p>
      {open && floors.map((fi) => (
        <div key={fi}>
          {floors.length > 1 && <h4>Floor {fi + 1}</h4>}
          <ol className="balancing-list">
            {sch.balancing.filter((b) => b.floor === fi).sort((a, b) => (a.where === b.where ? 0 : a.where === 'bus' ? -1 : 1)).map((b, k) => (
              <li key={k}>
                <b><span className="mdot" style={{ background: itemColor(b.item) }} />{b.title}</b>
                <ul>{b.steps.map((st) => <li key={st}>{st}</li>)}</ul>
                {b.warn && <p className="warn-text small-text">{b.warn}</p>}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}
