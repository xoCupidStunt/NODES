import { isFluid, itemColor, itemName, MACHINE_COLORS } from '../data/game';
import type { Plan } from '../engine/plan';
import { fmt } from './ui';

const BOX_W = 190;
const BOX_H = 64;
const COL_GAP = 120;
const ROW_GAP = 26;

interface Box { id: string; col: number; title: string; sub: string; color: string; x: number; y: number }

/** Layered diagram: inputs → machine groups by depth → outputs. */
export function FlowDiagram({ plan, target }: { plan: Plan; target: string }) {
  const boxes: Box[] = [];
  const maxDepth = Math.max(0, ...plan.groups.map((g) => g.depth));
  for (const x of plan.inputs) {
    if (boxes.some((b) => b.id === 'in:' + x.item)) continue;
    const rate = plan.solve.inputs[x.item] ?? x.rate;
    boxes.push({ id: 'in:' + x.item, col: 0, title: itemName(x.item), sub: `${fmt(rate)}${isFluid(x.item) ? ' m³' : ''}/min in`, color: itemColor(x.item), x: 0, y: 0 });
  }
  for (const g of plan.groups) {
    boxes.push({ id: g.id, col: g.depth + 1, title: `${g.count} × ${g.machine.name}`, sub: `${g.recipe.name} @ ${fmt(g.clock, 2)}%`, color: MACHINE_COLORS[g.machine.id] ?? '#888', x: 0, y: 0 });
  }
  boxes.push({ id: 'out', col: maxDepth + 2, title: itemName(target), sub: `${fmt(plan.rate)}/min product`, color: itemColor(target), x: 0, y: 0 });
  if (plan.surplus.length) boxes.push({ id: 'surplus', col: maxDepth + 2, title: 'Byproducts', sub: plan.surplus.map(([i]) => itemName(i)).join(', ').slice(0, 30), color: '#666', x: 0, y: 0 });

  const cols: Record<number, Box[]> = {};
  for (const b of boxes) (cols[b.col] ??= []).push(b);
  const tallest = Math.max(...Object.values(cols).map((c) => c.length));
  const height = tallest * (BOX_H + ROW_GAP) + 20;
  for (const [c, list] of Object.entries(cols)) {
    const colH = list.length * (BOX_H + ROW_GAP) - ROW_GAP;
    list.forEach((b, i) => {
      b.x = Number(c) * (BOX_W + COL_GAP) + 10;
      b.y = (height - colH) / 2 + i * (BOX_H + ROW_GAP);
    });
  }
  const width = (maxDepth + 3) * (BOX_W + COL_GAP) - COL_GAP + 20;
  const byId = Object.fromEntries(boxes.map((b) => [b.id, b]));

  // Merge flows between the same two boxes for the same item.
  const edges: Record<string, { from: Box; to: Box; item: string; rate: number; tier: string; lanes: number }> = {};
  for (const fl of plan.flows) {
    const from = byId[fl.from];
    const to = byId[fl.to];
    if (!from || !to) continue;
    const k = `${fl.from}|${fl.to}|${fl.item}`;
    if (edges[k]) edges[k].rate += fl.rate;
    else edges[k] = { from, to, item: fl.item, rate: fl.rate, tier: fl.transport.name.replace('Conveyor Belt ', 'Belt ').replace('Pipeline ', 'Pipe '), lanes: fl.lanes };
  }
  const list = Object.values(edges);
  // Spread multiple edges leaving/entering one box.
  const outCount: Record<string, number> = {};
  const inCount: Record<string, number> = {};
  const outIdx: number[] = [];
  const inIdx: number[] = [];
  list.forEach((e) => { outIdx.push((outCount[e.from.id] = (outCount[e.from.id] ?? 0) + 1) - 1); inIdx.push((inCount[e.to.id] = (inCount[e.to.id] ?? 0) + 1) - 1); });

  return (
    <div className="diagram-wrap">
      <svg width={width} height={height} className="flow">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
          </marker>
        </defs>
        {list.map((e, k) => {
          const back = e.to.x <= e.from.x;
          const y1 = e.from.y + ((outIdx[k] + 1) * BOX_H) / (outCount[e.from.id] + 1);
          const y2 = e.to.y + ((inIdx[k] + 1) * BOX_H) / (inCount[e.to.id] + 1);
          const x1 = e.from.x + BOX_W;
          const x2 = back ? e.to.x + BOX_W : e.to.x;
          const dx = back ? 60 : (x2 - x1) / 2;
          const d = back ? `M${x1},${y1} C${x1 + dx},${y1} ${x2 + dx},${y2} ${x2},${y2}` : `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
          const fluid = isFluid(e.item);
          const label = `${itemName(e.item)} ${fmt(e.rate, 1)}${fluid ? 'm³' : ''} · ${e.lanes > 1 ? `${e.lanes}× ` : ''}${e.tier}`;
          return (
            <g key={k}>
              <path d={d} fill="none" stroke={itemColor(e.item)} strokeWidth={fluid ? 4 : 2.5} strokeDasharray={fluid ? '1 0' : undefined} markerEnd="url(#arrow)" opacity={0.85} />
              {fluid && <path d={d} fill="none" stroke="var(--bg)" strokeWidth={1.4} />}
              <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} className="edge-label" textAnchor="middle">{label}<title>{label}</title></text>
            </g>
          );
        })}
        {boxes.map((b) => (
          <g key={b.id} transform={`translate(${b.x},${b.y})`}>
            <rect width={BOX_W} height={BOX_H} rx={6} className="flow-box" />
            <rect width={6} height={BOX_H} rx={3} fill={b.color} />
            <text x={14} y={24} className="box-title">{b.title}</text>
            <text x={14} y={44} className="box-sub">{b.sub}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}
