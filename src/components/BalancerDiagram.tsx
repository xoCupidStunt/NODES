import { itemColor, itemName } from '../data/game';
import { layoutBalancer } from '../engine/balance';
import type { BalanceStep } from '../engine/schematic';
import { fmt } from './ui';

const CW = 46; // column width
const RH = 58; // row height
const BOX = 24;
const TOP = 34;
const SIDE = 20;
const BOTTOM = 34;

/** A balancer drawn the way players sketch them: S and M boxes, belts with their rates, loop-backs dashed. */
export function BalancerDiagram({ step }: { step: BalanceStep }) {
  const g = step.graph;
  const lay = layoutBalancer(g);
  const loops = g.edges.filter((e) => e.loop);
  const loopLane = SIDE + lay.cols * CW + 14;
  const width = loopLane + loops.length * 12 + SIDE;
  const height = TOP + (lay.rows - 1) * RH + BOTTOM + 8;
  const at = (id: number) => ({ x: SIDE + lay.col.get(id)! * CW + CW / 2, y: TOP + lay.row.get(id)! * RH });
  const half = (id: number) => (g.nodes[id].kind === 'S' || g.nodes[id].kind === 'M' ? BOX / 2 : 0);
  const colour = itemColor(step.item);
  const outs = g.nodes.filter((n) => n.kind === 'out');
  const label = (d: number) => (step.where === 'row' ? String(d + 1) : String.fromCharCode(65 + d));
  const rate = (v: number) => fmt(v, 1);

  return (
    <svg width={width} height={height} className="balancer-svg" role="img" aria-label={`Balancer ${step.id}: ${step.title}`}>
      <defs>
        <marker id={`arr-${step.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </marker>
      </defs>
      {/* belts */}
      {g.edges.map((e, k) => {
        if (e.loop) return null;
        const a = at(e.from);
        const b = at(e.to);
        const y1 = a.y + half(e.from);
        const y2 = b.y - half(e.to) - (g.nodes[e.to].kind === 'out' ? 4 : 0);
        const ym = y2 - 12;
        const c = lay.edgeCol.get(k);
        if (c !== undefined) {
          // A belt leaving the tree: down from its splitter, across to its own column, down to its merger/output.
          const cx = SIDE + c * CW + CW / 2;
          const yb = y1 + 10;
          return (
            <g key={k}>
              <path d={`M${a.x},${y1} V${yb} H${cx} V${ym} H${b.x} V${y2}`} fill="none" stroke={colour} strokeWidth={2} markerEnd={`url(#arr-${step.id})`} style={{ color: colour }} />
              {step.where === 'bus' && <text x={cx + 3} y={yb + 14} fontSize={10} fill="var(--muted)">{rate(e.rate)}</text>}
            </g>
          );
        }
        const toBox = g.nodes[e.to].kind !== 'out';
        return (
          <g key={k}>
            <path d={`M${a.x},${y1} V${ym} H${b.x} V${y2}`} fill="none" stroke={colour} strokeWidth={2} markerEnd={`url(#arr-${step.id})`} style={{ color: colour }} />
            {toBox && <text x={b.x + (b.x >= a.x ? 4 : -4)} y={ym - 3} fontSize={10} fill="var(--muted)" textAnchor={b.x >= a.x ? 'start' : 'end'}>{rate(e.rate)}</text>}
          </g>
        );
      })}
      {/* loop-backs: out to the right, up, and back into the merger */}
      {loops.map((e, k) => {
        const a = at(e.from);
        const b = at(e.to);
        const lx = loopLane + k * 12;
        return (
          <g key={'l' + k}>
            <path d={`M${a.x + half(e.from)},${a.y} H${lx} V${b.y} H${b.x + half(e.to) + 2}`} fill="none" stroke={colour} strokeWidth={1.6} strokeDasharray="5 4" markerEnd={`url(#arr-${step.id})`} style={{ color: colour }} />
            <text x={lx + 3} y={(a.y + b.y) / 2} fontSize={10} fill="var(--muted)">{rate(e.rate)}</text>
          </g>
        );
      })}
      {/* input */}
      <text x={at(0).x} y={TOP - 10} fontSize={12} fontWeight={700} fill="var(--text)" textAnchor="middle">{rate(g.input)}/min in</text>
      {/* splitters and mergers */}
      {g.nodes.filter((n) => n.kind === 'S' || n.kind === 'M').map((n) => {
        const p = at(n.id);
        const s = n.kind === 'S';
        return (
          <g key={n.id}>
            <rect x={p.x - BOX / 2} y={p.y - BOX / 2} width={BOX} height={BOX} rx={2} fill={s ? '#f4f4f4' : '#2b2f36'} stroke={s ? '#111' : '#ddd'} strokeWidth={1.5} />
            <text x={p.x} y={p.y + 5} fontSize={14} fontWeight={700} textAnchor="middle" fill={s ? '#111' : '#eee'}>{n.kind}</text>
            <title>{s ? 'Conveyor Splitter' : 'Conveyor Merger'}</title>
          </g>
        );
      })}
      {/* outputs */}
      {outs.map((n) => {
        const p = at(n.id);
        return <text key={n.id} x={p.x} y={p.y + 12} fontSize={13} fontWeight={700} fill="var(--text)" textAnchor="middle">{label(n.dest!)}</text>;
      })}
    </svg>
  );
}

/** One balancer: what it is, the drawing, and what each output feeds. */
export function BalancerBlock({ step }: { step: BalanceStep }) {
  const g = step.graph;
  const outRate = (d: number) => g.edges.filter((e) => g.nodes[e.to].kind === 'out' && g.nodes[e.to].dest === d).reduce((a, e) => a + e.rate, 0);
  const equal = step.where === 'row';
  return (
    <div className="balancer-block" id={`bal-${step.id}`}>
      <div className="row gap wrap balancer-head">
        <span className="balancer-id">{step.id}</span>
        <b><span className="mdot" style={{ background: itemColor(step.item) }} />{step.title}</b>
        <span className="muted small-text">{g.splitters} splitter{g.splitters === 1 ? '' : 's'}{g.mergers ? ` · ${g.mergers} merger${g.mergers === 1 ? '' : 's'}` : ''}</span>
      </div>
      <div className="balancer-scroll"><BalancerDiagram step={step} /></div>
      <p className="small-text muted balancer-outs">
        {equal
          ? <>Outputs 1–{step.destNames.length} → {step.destNames[0].replace(/ \d+$/, '')} 1–{step.destNames.length}, {fmt(outRate(0), 2)} {itemName(step.item)}/min each.</>
          : step.destNames.map((n, d) => <span key={d}>{n} — {fmt(outRate(d), 1)}/min{d < step.destNames.length - 1 ? ' · ' : ''}</span>)}
      </p>
      <ul className="balancer-steps small-text">{step.steps.map((st) => <li key={st}>{st}</li>)}</ul>
      {step.warn && <p className="warn-text small-text">{step.warn}</p>}
    </div>
  );
}
