import { useMemo, useRef, useState } from 'react';
import { FOUNDATION as F, isFluid, itemColor, itemName, MACHINE_COLORS } from '../data/game';
import { buildSchematic, type BeltPath, type Floor, type Schematic } from '../engine/schematic';
import { defaultSchematic, type Factory, type SchematicOptions } from '../engine/types';
import { useStore } from '../state';
import { fmt } from './ui';

const C = {
  bg: '#14171c', floor: '#1d2229', grid: '#2b323c', grid5: '#3b4552', bus: '#232a33', row: '#20262e',
  text: '#e8e3d9', muted: '#9aa3ad', wall: '#c9ced6', hole: '#ffcc33', pole: '#ffd23f', machineStroke: '#0b0d10',
};

export function SchematicView({ f }: { f: Factory }) {
  const { dispatch, plans } = useStore();
  const plan = plans[f.id];
  const o = f.schematic;
  const set = (patch: Partial<SchematicOptions>) => dispatch({ type: 'update', id: f.id, patch: { schematic: { ...o, ...patch } } });
  const [scale, setScale] = useState(5);
  const [floorSel, setFloorSel] = useState<number | 'all'>('all');
  const svgRef = useRef<SVGSVGElement>(null);
  const sch = useMemo(() => (plan.status === 'ok' ? buildSchematic(plan, o, f.target) : null), [plan, o, f.target]);

  if (!sch) {
    return <div className="card"><h2>No schematic</h2><p className="muted">Finish the setup first — the plan has nothing to build yet.</p></div>;
  }
  const floors = floorSel === 'all' ? sch.floors : sch.floors.filter((fl) => fl.index === floorSel);
  const HEADER = 34;
  const GAP = 40;
  const totalH = floors.reduce((a, fl) => a + fl.height * scale + HEADER + GAP, 0);
  const totalW = sch.width * scale + 40;

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
          <label className="check"><input type="checkbox" checked={o.perimeterWalls} onChange={(e) => set({ perimeterWalls: e.target.checked })} /> Perimeter walls</label>
          <label className="check"><input type="checkbox" checked={o.showPower} onChange={(e) => set({ showPower: e.target.checked })} /> Power poles</label>
          <label className="check"><input type="checkbox" checked={o.showLabels} onChange={(e) => set({ showLabels: e.target.checked })} /> Machine labels</label>
          <label className="check"><input type="checkbox" checked={o.showRates} onChange={(e) => set({ showRates: e.target.checked })} /> Belt rates &amp; tiers</label>
          <button className="small ghost" onClick={() => set({ ...defaultSchematic })}>Reset options</button>
        </section>
        <section className="card">
          <h3>View</h3>
          <Range label="Zoom" value={scale} min={2} max={14} step={1} unit="px/m" onChange={setScale} />
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
          <span className="muted"> · 1 grid square = 1 foundation (8 m)</span>
        </div>
        <div className="sch-canvas">
          <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" width={totalW} height={totalH} style={{ background: C.bg }} fontFamily="Segoe UI, Roboto, sans-serif">
            <Defs sch={sch} />
            <rect width={totalW} height={totalH} fill={C.bg} />
            {floors.map((fl) => {
              const g = (
                <g key={fl.index} transform={`translate(20, ${yOff})`}>
                  <text x={0} y={22} fill={C.text} fontSize={16} fontWeight={700}>
                    Floor {fl.index + 1}{fl.index === 0 ? ' (ground)' : ` (+${sch.floors.slice(0, fl.index).reduce((a, x) => a + x.storeyHeight, 0)} m)`}
                    <tspan fill={C.muted} fontSize={12} fontWeight={400}>  · {fl.machines.length} machines · storey {fl.storeyHeight} m</tspan>
                  </text>
                  <g transform={`translate(0, ${HEADER})`}>
                    <FloorDrawing fl={fl} s={scale} o={o} />
                  </g>
                </g>
              );
              yOff += fl.height * scale + HEADER + GAP;
              return g;
            })}
          </svg>
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
              <div><svg width="14" height="14"><circle cx="7" cy="7" r="5" fill="#3fa0e0" stroke="#fff" /></svg> Pipe junction</div>
              <div><svg width="16" height="16"><circle cx="8" cy="8" r="7" fill="none" stroke="#fff" strokeWidth="2" /></svg> Conveyor lift / vertical pipe</div>
              {o.showPower && <div><svg width="14" height="14"><circle cx="7" cy="7" r="5" fill={C.pole} /></svg> Power pole</div>}
              {o.logistics !== 'visible' && <div><svg width="28" height="10"><line x1="0" y1="5" x2="28" y2="5" stroke="#aaa" strokeWidth={3} strokeDasharray="4 3" opacity={0.6} /></svg> Hidden belt / pipe</div>}
              {o.logistics !== 'visible' && <div><svg width="14" height="14"><rect x="3" y="3" width="8" height="8" fill="none" stroke={C.hole} strokeWidth="2" /></svg> {o.logistics === 'walls' ? 'Wall hole' : 'Floor hole'}</div>}
              <div><svg width="20" height="12"><path d="M2,6 L14,6 M10,2 L16,6 L10,10" stroke="#fff" fill="none" strokeWidth="2" /></svg> Flow direction</div>
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

function FloorDrawing({ fl, s, o }: { fl: Floor; s: number; o: SchematicOptions }) {
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
      {s >= 4 && Array.from({ length: cols }, (_, i) => <text key={'cn' + i} x={(i + 0.5) * F * s} y={-4} fontSize={9} fill={C.muted} textAnchor="middle">{colName(i)}</text>)}
      {s >= 4 && Array.from({ length: rows }, (_, i) => <text key={'rn' + i} x={-4} y={(i + 0.5) * F * s + 3} fontSize={9} fill={C.muted} textAnchor="end">{i + 1}</text>)}

      {fl.bus && <rect x={fl.bus.x * s} y={0} width={fl.bus.w * s} height={H} fill={C.bus} opacity={0.8} />}
      {fl.bus && <text x={(fl.bus.x + fl.bus.w / 2) * s} y={H - 6} fontSize={10} fill={C.muted} textAnchor="middle">BUS</text>}

      {/* hidden logistics first, faded */}
      <g opacity={0.45}>{hidden.map((b, k) => <Belt key={k} b={b} s={s} dashed />)}</g>

      {fl.rows.map((r) => (
        <g key={r.id}>
          <rect x={r.x * s} y={r.y * s} width={r.w * s} height={r.h * s} fill={C.row} stroke={C.grid5} strokeDasharray="4 3" />
          {o.showLabels && (
            <text x={(r.x + r.w) * s + 6} y={(r.y + r.h / 2) * s + 4} fontSize={11} fill={C.text}>
              {r.count} × {r.machine.name} · {r.recipe.name} @ {fmt(r.clock, 2)}%
            </text>
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
              <text x={(m.x + m.w / 2) * s} y={(m.y + m.l / 2) * s + 3} fontSize={Math.min(11, m.w * s / 6)} fill="#0b0d10" textAnchor="middle" fontWeight={700}>
                {short(m.machine.name)} {m.index}
                {s >= 6 && <tspan x={(m.x + m.w / 2) * s} dy={12} fontWeight={400}>{fmt(m.clock, 1)}%</tspan>}
              </text>
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
        return <text key={'lbl' + k} x={(Math.min(a.x, c.x) + 2) * s + (b.kind === 'manifold' ? 40 : 0)} y={a.y * s - 3} fontSize={9} fill={C.text} opacity={b.hidden ? 0.7 : 1} paintOrder="stroke" stroke={C.bg} strokeWidth={3}>{label}</text>;
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
              <text x={x} y={y + 3} fontSize={9} fill={C.text} textAnchor="middle">{m.label}</text>
              <title>{`${isFluid(m.item!) ? 'Vertical pipe' : 'Conveyor lift'}: ${itemName(m.item!)}`}</title>
            </g>
          );
          case 'hole': return <rect key={k} x={x - 3} y={y - 3} width={6} height={6} fill="none" stroke={C.hole} strokeWidth={1.5}><title>Conveyor floor hole</title></rect>;
          case 'pole': return <circle key={k} cx={x} cy={y} r={Math.max(3, 0.8 * s)} fill={C.pole} stroke="#000"><title>Power pole</title></circle>;
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
            <text x={x + 10} y={y + 4 + (fl.ports.filter((q) => q.dir === p.dir).indexOf(p)) * 12 * (up ? 1 : -1)} fontSize={10} fill={C.text} fontWeight={600} paintOrder="stroke" stroke={C.bg} strokeWidth={3}>{p.label} {fmt(p.rate, 1)}{isFluid(p.item) ? ' m³' : ''}/min</text>
          </g>
        );
      })}

      {/* scale bar + north arrow */}
      <g transform={`translate(${W - 5 * F * s - 10}, ${H + 18})`}>
        <rect width={5 * F * s} height={4} fill={C.muted} />
        <text x={0} y={-3} fontSize={9} fill={C.muted}>0</text>
        <text x={5 * F * s} y={-3} fontSize={9} fill={C.muted} textAnchor="end">40 m (5 foundations)</text>
      </g>
      <g transform={`translate(${W + 14}, 14)`}>
        <path d="M0,-10 L6,6 L0,2 L-6,6 z" fill={C.text} />
        <text y={18} fontSize={9} fill={C.text} textAnchor="middle">N</text>
      </g>
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
