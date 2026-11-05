import { FOUNDATION as F, isFluid, isPower, itemName, POWER, type Machine, type Recipe } from '../data/game';
import type { Plan } from './plan';
import { availableBelts, availablePipes } from './progression';
import type { SchematicOptions } from './types';
import { evenBalancer, layoutBalancer, ratioBalancer, ratioSplit, type BalancerGraph } from './balance';

/*
 * Floor-plan generator. Everything is in metres, x = east, y = south, origin at the floor's
 * north-west corner. One grid square = one 8 m × 8 m foundation.
 *
 * Layout per floor:
 *   ┌ wall ─────────────────────────────────────────────┐
 *   │ walkway                                            │
 *   │ ┌bus┐  [in manifold  ─┬────┬────┬── ]              │
 *   │ │ │ │  [ machine ][ machine ][ machine ]           │
 *   │ │ │ │  [out manifold ─┴────┴────┴── ]              │
 *   │ │ │ │   (row gap / walkway)                        │
 *   │ │ │ │  next row …                                  │
 *   └────────────────────────────────────────────────────┘
 * Each item has its own lane in the bus; rows pull inputs from it and push outputs back.
 */

export interface Pt { x: number; y: number }
export interface PlacedMachine {
  id: string; x: number; y: number; w: number; l: number;
  machine: Machine; recipe: Recipe; clock: number; index: number; rowId: string;
  inPorts: (Pt & { item: string })[]; outPorts: (Pt & { item: string })[];
}
export interface BeltPath {
  item: string; fluid: boolean; points: Pt[]; rate: number; hidden: boolean;
  kind: 'bus' | 'manifold' | 'feed' | 'port' | 'tree'; tier: string; lanes: number;
  /** Loop-back belt in a balancer (drawn dashed). */
  loop?: boolean;
  /** Where its rate label goes, when not at its far end. */
  labelAt?: Pt;
}
export interface Marker { x: number; y: number; kind: 'splitter' | 'merger' | 'junction' | 'lift' | 'hole' | 'pole'; item?: string; label?: string; title?: string }
export interface Port { x: number; y: number; item: string; rate: number; dir: 'in' | 'out'; label: string }
export interface WallSeg { a: Pt; b: Pt; holes?: number[] }
export interface Row {
  id: string; x: number; y: number; w: number; h: number; recipe: Recipe; machine: Machine;
  count: number; clock: number; inItems: string[]; outItems: string[];
}
export interface Floor {
  index: number; width: number; height: number; storeyHeight: number;
  rows: Row[]; machines: PlacedMachine[]; belts: BeltPath[]; markers: Marker[]; ports: Port[]; walls: WallSeg[];
  bus: { x: number; w: number } | null;
  /** Where each product leaves: boxes below the output wall, wired from their ports (y > height). */
  outBoxes: SourceBox[];
}
export interface BOMLine { name: string; count: number; unit?: string }
export type Facing = 'N' | 'E' | 'S' | 'W';
/** Where an input comes from, drawn in the yard outside the input wall and wired to its port. */
export interface SourceBox {
  x: number; y: number; w: number; h: number;
  kind: 'extractor' | 'water' | 'well' | 'import' | 'outside' | 'output' | 'surplus';
  item: string; rate: number; title: string; lines: string[];
  /** Path from the box to the input port on the ground floor. */
  wire: Pt[];
}
/** Where the factory is and who supplies it, so sources get distances and directions. */
export interface SchematicContext {
  location: Pt | null;
  imports: { name: string; item: string; rate: number; at: Pt | null }[];
}
export interface Schematic {
  floors: Floor[];
  width: number; height: number; // metres, same for all floors
  lanes: { item: string; x: number; fluid: boolean }[];
  bom: BOMLine[];
  notes: string[];
  /** Extraction yard on the input side of the ground floor (y < 0 in layout coordinates). */
  sources: SourceBox[];
  yardH: number;
  /** The compass side the input wall faces. The layout is drawn inputs-at-top and turned to this. */
  facing: Facing;
  facingWhy: string;
}

const LANE = 3; // metres between bus lanes
const STRIP_LANE = 4; // metres per manifold lane
const LEVEL = 3; // metres between the levels of a splitter tree
const LEAF = 3.5; // metres between the outputs of a sideways (bus) splitter tree
const SIDE_LEVEL = 4.5; // metres between the levels of a sideways (bus) splitter tree
const TRACK = 1.5; // metres between the belts leaving a bus splitter tree

function snap(v: number, mode: SchematicOptions['snap']) {
  const step = mode === 'full' ? F : mode === 'half' ? F / 2 : 1;
  return Math.ceil(v / step - 1e-9) * step;
}
const toF = (m: number) => Math.ceil(m / F - 1e-9) * F;

/** World direction from a to b as an 8-point compass label (map y points south). */
export function bearing(a: Pt, b: Pt) {
  const deg = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][((Math.round(deg / 45) % 8) + 8) % 8];
}
const metres = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y) / 100;
const distText = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
const FACING_NAME: Record<Facing, string> = { N: 'north', E: 'east', S: 'south', W: 'west' };

/** The side most input arrives from, weighted by rate (water pumped on site doesn't count). */
export function facingFor(plan: Plan, ctx?: SchematicContext): { facing: Facing; why: string } {
  const at = ctx?.location;
  if (!at) return { facing: 'N', why: 'The factory isn’t placed yet, so inputs are drawn coming in from the north.' };
  let vx = 0, vy = 0, total = 0, onSite = 0;
  const add = (p: Pt, rate: number) => {
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (rate <= 0) return;
    if (d < 1500) { onSite += rate; return; } // within 15 m: right at the factory
    vx += ((p.x - at.x) / d) * rate; vy += ((p.y - at.y) / d) * rate; total += rate;
  };
  for (const e of plan.extraction) if (e.node && e.rate > 0) add(e.node, e.rate);
  for (const imp of ctx?.imports ?? []) if (imp.at) add(imp.at, imp.rate);
  if (!total) return { facing: 'N', why: onSite ? 'Its supply is right at the factory’s spot, so inputs are drawn coming in from the north.' : 'No located nodes or supplying factories yet, so inputs are drawn coming in from the north.' };
  const facing: Facing = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 'E' : 'W') : vy > 0 ? 'S' : 'N';
  return { facing, why: `Turned so the input wall faces ${FACING_NAME[facing]}, where most of its supply comes from.` };
}

export function buildSchematic(plan: Plan, opt: SchematicOptions, target: string, ctx?: SchematicContext): Schematic {
  const notes: string[] = [];
  const u = plan.unlocks;
  const belt = availableBelts(u).at(-1)!;
  const pipe = availablePipes(u).at(-1)!;
  const hiddenManifold = opt.logistics !== 'visible';
  const hiddenBus = opt.logistics !== 'visible';
  const balanced = (opt.distribution ?? 'balanced') === 'balanced';
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const beltWarnings = new Set<string>();

  // ---- rows: split each machine group into chunks of maxPerRow ----
type Tree = { g: BalancerGraph; lay: ReturnType<typeof layoutBalancer> };
  /** One input item's strip above a row: a manifold lane, or (balanced) a splitter tree. y values from the row top. */
  type Band = { tree: Tree | null; top: number; h: number; feedY: number; rate: number };
  type RowSpec = Omit<Row, 'x' | 'y' | 'w' | 'h'> & { pitch: number; bodyH: number; inH: number; outH: number; groupId: string; frac: number; bands: Band[] };
  const specs: RowSpec[] = [];
  for (const g of plan.groups) {
    const per = Math.max(1, opt.maxPerRow);
    const chunks = Math.ceil(g.count / per);
    for (let c = 0; c < chunks; c++) {
      const count = Math.min(per, g.count - c * per);
      const inItems = g.recipe.in.map(([i]) => i);
      const outItems = g.recipe.out.map(([i]) => i);
      const raw = inItems.map((item, j) => {
        const rate = ((g.recipe.in[j][1] * 60) / g.recipe.time) * (g.clock / 100) * count;
        if (!balanced || isFluid(item) || count < 2) return { tree: null, h: STRIP_LANE, rate };
        const tg = evenBalancer(count, rate);
        const lay = layoutBalancer(tg);
        return { tree: { g: tg, lay }, h: 2 + (lay.rows - 1) * LEVEL + 1, rate };
      });
      const inH = toF(Math.max(STRIP_LANE, raw.reduce((a, b) => a + b.h, 0)));
      // The first input sits next to the machines; the others stack above it.
      let edge = inH;
      const bands: Band[] = raw.map((b) => { edge -= b.h; return { ...b, top: edge, feedY: b.tree ? edge + 1.5 : edge + b.h - 2 }; });
      specs.push({
        id: `${g.id}#${c}`, groupId: g.id, recipe: g.recipe, machine: g.machine, count, clock: g.clock,
        inItems, outItems,
        pitch: snap(g.machine.w + opt.machineGap, opt.snap),
        bodyH: snap(g.machine.l, opt.snap),
        inH, bands,
        outH: toF(Math.max(1, outItems.length) * STRIP_LANE),
        frac: count / g.count,
      });
    }
  }

  // Rows of one recipe are numbered when it needs several.
  const chunks: Record<string, number> = {};
  for (const s of specs) chunks[s.groupId] = (chunks[s.groupId] ?? 0) + 1;
  const rowName = (s: { id: string; groupId: string; recipe: Recipe }) =>
    `${s.recipe.name}${chunks[s.groupId] > 1 ? ` row ${Number(s.id.split('#')[1]) + 1}` : ''}`;

  // ---- bus lanes: one per item that moves between rows or crosses the factory edge ----
  const laneItems: string[] = [];
  const addLane = (i: string) => { if (!laneItems.includes(i) && !isPower(i)) laneItems.push(i); };
  for (const [i] of plan.inputs.map((x) => [x.item])) addLane(i);
  for (const s of specs) { s.inItems.forEach(addLane); s.outItems.forEach(addLane); }
  const border = opt.border * F;
  const busX = border + F / 2;
  const busW = toF(laneItems.length * LANE + 2);
  const lanes = laneItems.map((item, k) => ({ item, x: busX + 1.5 + k * LANE, fluid: isFluid(item) }));
  const laneX = Object.fromEntries(lanes.map((l) => [l.item, l.x]));
  const rowLen = (s: RowSpec) => s.count * s.pitch;
  const maxRowLen = Math.max(F, ...specs.map(rowLen));
  const top = border + F; // room for input ports
  const rowH = (s: RowSpec) => s.inH + s.bodyH + s.outH;

  // ---- spread rows over floors, balancing depth ----
  const floorsN = Math.max(1, Math.min(opt.floors, specs.length || 1));
  const total = specs.reduce((a, s) => a + rowH(s) + opt.rowGap * F, 0);
  const perFloor = total / floorsN;
  const floorSpecs: RowSpec[][] = Array.from({ length: floorsN }, () => []);
  let acc = 0;
  for (const s of specs) {
    const fi = Math.min(floorsN - 1, Math.floor((acc + (rowH(s) + opt.rowGap * F) / 2) / perFloor));
    floorSpecs[fi].push(s);
    acc += rowH(s) + opt.rowGap * F;
  }
  if (opt.floors > floorsN) notes.push(`Only ${floorsN} floor${floorsN > 1 ? 's' : ''} used — there are not enough production rows to fill ${opt.floors}.`);

  const floorHeights = floorSpecs.map((rows) => rows.reduce((a, s) => a + rowH(s), 0) + Math.max(0, rows.length - 1) * opt.rowGap * F);
  const height = toF(top + Math.max(F, ...floorHeights) + F * 2 + border);

  // Which floors make / use each item (for lifts).
  const makers: Record<string, Set<number>> = {};
  const usersOf: Record<string, Set<number>> = {};
  floorSpecs.forEach((rows, fi) => rows.forEach((s) => {
    s.outItems.forEach((i) => (makers[i] ??= new Set()).add(fi));
    s.inItems.forEach((i) => (usersOf[i] ??= new Set()).add(fi));
  }));
  const inputItems = new Set(plan.inputs.map((x) => x.item));
  for (const i of inputItems) (makers[i] ??= new Set()).add(0);
  (usersOf[target] ??= new Set()).add(0);
  for (const [i] of plan.surplus) (usersOf[i] ??= new Set()).add(0);
  for (const [i] of plan.also) (usersOf[i] ??= new Set()).add(0);

  const lastFloor = (item: string) => Math.max(...[...(makers[item] ?? [])]);

  // ---- balanced: where a bus lane feeds several belts on a floor, a sideways splitter tree in the gap between
  // the bus and the rows shares it out by need. Worked out first, since the gap has to fit them. ----
  type BusUser = { name: string; need: number; y: number; rowId?: string; kind: 'row' | 'out' | 'lift' };
  type BusTree = Tree & { item: string; users: BusUser[]; parts: number; shares: number[]; error: number; gy: number; dx: number; w: number };
  const bottomPortY = height - border - 2;
  const busTrees: BusTree[][] = floorSpecs.map((rowsSpec, fi) => {
    if (!balanced) return [];
    const users: Record<string, BusUser[]> = {};
    let ry = top;
    for (const sp of rowsSpec) {
      sp.inItems.forEach((item, j) => {
        if (!isFluid(item)) (users[item] ??= []).push({ name: rowName(sp), need: sp.bands[j].rate, y: ry + sp.bands[j].feedY, rowId: sp.id, kind: 'row' });
      });
      ry += rowH(sp) + opt.rowGap * F;
    }
    for (const item of Object.keys(users)) {
      if (fi === lastFloor(item)) {
        let out = item === target ? plan.rate : 0;
        if (item !== target) out += [...plan.also, ...plan.surplus].filter(([i]) => i === item).reduce((a, [, v]) => a + v, 0);
        if (out > 1e-6) users[item].push({ name: 'the output', need: out, y: bottomPortY, kind: 'out' });
      }
      // Made here and used on floors that don't make it: that share goes to the lift.
      if (makers[item]?.has(fi)) {
        let away = 0;
        floorSpecs.forEach((rs2, f2) => {
          if (f2 === fi || makers[item]?.has(f2)) return;
          for (const sp of rs2) sp.inItems.forEach((i, j) => { if (i === item) away += sp.bands[j].rate; });
        });
        if (away > 1e-6) users[item].push({ name: 'the lift', need: away, y: top - 3, kind: 'lift' });
      }
    }
    const trees: BusTree[] = [];
    for (const [item, list] of Object.entries(users)) {
      if (list.length < 2) continue;
      list.sort((a, b) => b.need - a.need);
      const rs = ratioSplit(list.map((x) => x.need), 0.05, 18);
      const g = ratioBalancer(rs.shares, list.reduce((a, x) => a + x.need, 0));
      const lay = layoutBalancer(g);
      const firstRow = Math.min(...list.filter((x) => x.kind === 'row').map((x) => x.y));
      trees.push({ item, users: list, parts: rs.parts, shares: rs.shares, error: rs.error, g, lay, gy: firstRow - 2, dx: 0, w: (lay.rows - 1) * SIDE_LEVEL + 2 + list.length * TRACK + 1 });
    }
    // Side by side only where they'd overlap top to bottom.
    const slots: { x: number; w: number; end: number }[] = [];
    let used = 0;
    for (const t of trees.sort((a, b) => a.gy - b.gy)) {
      const start = t.gy - 1;
      const end = t.gy + Math.max(0, t.lay.cols - 1) * LEAF + 1;
      let slot = slots.find((sl) => sl.end < start - 2 && sl.w >= t.w);
      if (!slot) { slot = { x: used, w: t.w, end: -Infinity }; slots.push(slot); used += t.w; }
      t.dx = slot.x;
      slot.end = end;
    }
    return trees;
  });
  const gapW = Math.max(0, ...busTrees.map((ts) => ts.reduce((a, t) => Math.max(a, t.dx + t.w), 0)));
  const rowX = busX + busW + Math.max(F, toF(gapW + 2));
  const width = toF(rowX + maxRowLen + F + border);

  const flowRate = (item: string) => {
    let r = 0;
    for (const fl of plan.flows) if (fl.item === item) r += fl.rate;
    return r / 2 || r;
  };
  const transportName = (item: string, rate: number) => {
    const list = isFluid(item) ? availablePipes(u) : availableBelts(u);
    const t = list.find((b) => b.rate >= rate - 1e-6) ?? list[list.length - 1];
    return { tier: t.name, lanes: Math.max(1, Math.ceil(rate / t.rate - 1e-6)) };
  };

  /**
   * Lay a balancer onto the floor: its splitters and mergers, and every belt between them. map turns the layout's
   * (column, level) into a floor point; outPt gives where each destination's belt ends.
   */
  const drawTree = (t: Tree, map: (c: number, r: number) => Pt, outPt: (dest: number, c: number, r: number) => Pt, item: string, belts: BeltPath[], markers: Marker[]) => {
    const { g, lay } = t;
    const C = (id: number) => lay.col.get(id)!;
    const R = (id: number) => lay.row.get(id)!;
    const add = (pts: Pt[], rate: number, loop = false) => {
      const clean = pts.filter((p, k) => k === 0 || Math.abs(p.x - pts[k - 1].x) > 0.01 || Math.abs(p.y - pts[k - 1].y) > 0.01);
      if (clean.length > 1) belts.push({ item, fluid: false, points: clean, rate, hidden: hiddenManifold, kind: 'tree', loop, ...transportName(item, rate) });
    };
    // Rightmost output column under a node, so a loop-back can turn just past its own branch.
    const right = (id: number): number => Math.max(C(id), ...g.edges.map((e, i) => [e, i] as const)
      .filter(([e]) => e.from === id && !e.loop)
      .map(([e, i]) => lay.edgeCol.get(i) ?? (g.nodes[e.to].role ? C(id) : right(e.to))));
    const turns = new Map<number, number>();
    g.edges.forEach((e, i) => {
      const cf = C(e.from), rf = R(e.from), ct = C(e.to), rt = R(e.to);
      const to = g.nodes[e.to];
      if (e.loop) {
        // Out just past this merger's branch, back up, and into the side of the merger.
        const k = turns.get(e.to) ?? 0;
        turns.set(e.to, k + 1);
        const lc = right(e.to) + 0.45 + 0.25 * k;
        add([map(cf, rf), map(lc, rf), map(lc, rt), map(ct + 0.3, rt)], e.rate, true);
        return;
      }
      const col = lay.edgeCol.get(i);
      const end = to.kind === 'out' ? outPt(to.dest!, col ?? ct, rt) : map(ct, rt);
      if (col !== undefined) add([map(cf, rf), map(cf, rf + 0.4), map(col, rf + 0.4), ...(to.kind === 'out' ? [] : [map(col, rt - 0.4), map(ct, rt - 0.4)]), end], e.rate);
      else add([map(cf, rf), map(cf, rt - 0.4), map(ct, rt - 0.4), end], e.rate);
    });
    for (const n of g.nodes) {
      if (n.kind !== 'S' && n.kind !== 'M') continue;
      const p = map(C(n.id), R(n.id));
      markers.push({ x: p.x, y: p.y, kind: n.kind === 'S' ? 'splitter' : 'merger', item });
    }
  };

  // ---- extraction yard: where each input comes from, outside the input wall ----
  const portTopY = border + 2;
  const BOX_W = 4 * F;
  const BOX_H = 4 * F; // square, so it reads the same when the plan is turned
  const YARD_GAP = 4;
  type Src = Omit<SourceBox, 'x' | 'y' | 'w' | 'h' | 'wire'>;
  const srcs: Src[] = [];
  const at = ctx?.location ?? null;
  const where = (pts: Pt[]) => {
    if (!at || !pts.length) return '';
    const ds = pts.map((p) => metres(at, p));
    const c = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
    const lo = Math.min(...ds), hi = Math.max(...ds);
    if (hi < 15) return 'at the factory';
    return `${Math.abs(hi - lo) < 50 ? distText(hi) : `${distText(lo)}–${distText(hi)}`} ${bearing(at, c)}`;
  };
  const rateTxt = (item: string, v: number) => `${Math.round(v * 10) / 10}${isFluid(item) ? ' m³' : ''}/min`;
  const byKey = new Map<string, typeof plan.extraction>();
  for (const e of plan.extraction) {
    const key = e.extractor.kind === 'pressurizer' || e.extractor.kind === 'well' ? `well|${e.item}` : `${e.extractor.id}|${e.item}`;
    byKey.set(key, [...(byKey.get(key) ?? []), e]);
  }
  for (const [key, list] of byKey) {
    const item = list[0].item;
    const rate = list.reduce((a, e) => a + e.rate, 0);
    if (key.startsWith('well|')) {
      const sats = list.filter((e) => e.extractor.kind === 'well');
      const press = list.filter((e) => e.extractor.kind === 'pressurizer').length;
      srcs.push({
        kind: 'well', item, rate,
        title: `${sats.length} × Well Extractor${press ? ` + ${press} Pressurizer${press > 1 ? 's' : ''}` : ''}`,
        lines: [`${itemName(item)} well · ${rateTxt(item, rate)}`, where(sats.map((e) => e.node!))].filter(Boolean),
      });
      continue;
    }
    const ex = list[0].extractor;
    const count = list.reduce((a, e) => a + e.count, 0);
    if (!list[0].node) {
      srcs.push({ kind: 'water', item, rate, title: `${count} × ${ex.name}`, lines: [`${itemName(item)} · ${rateTxt(item, rate)}`, 'on site, any water'] });
      continue;
    }
    const pur = (['pure', 'normal', 'impure'] as const).map((p) => [p, list.filter((e) => e.node!.purity === p).length] as const).filter(([, c]) => c).map(([p, c]) => `${c} ${p}`).join(', ');
    const clocks = [...new Set(list.map((e) => `${Math.round(e.clock * 10) / 10}%`))].join(' / ');
    srcs.push({
      kind: 'extractor', item, rate,
      title: `${count} × ${ex.name}`,
      lines: [`${itemName(item)} · ${rateTxt(item, rate)}`, `${pur} · ${clocks}`, where(list.map((e) => e.node!))].filter(Boolean),
    });
  }
  for (const line of plan.inputs) {
    if (line.source === 'import') {
      const from = (ctx?.imports ?? []).filter((i) => i.item === line.item);
      const names = [...new Set(from.map((i) => i.name))];
      srcs.push({
        kind: 'import', item: line.item, rate: line.rate,
        title: names.length ? `From ${names.join(', ')}` : 'From another factory',
        lines: [`${itemName(line.item)} · ${rateTxt(line.item, line.rate)}`, where(from.map((i) => i.at).filter((p): p is Pt => !!p))].filter(Boolean),
      });
    } else if (line.source === 'manual' || line.source === 'unlimited') {
      srcs.push({
        kind: 'outside', item: line.item, rate: line.rate,
        title: line.source === 'manual' ? 'Outside supply' : 'Not assigned yet',
        lines: [`${itemName(line.item)} · ${rateTxt(line.item, line.rate)}`, line.source === 'manual' ? 'train, truck or belt' : 'claim nodes or import it'],
      });
    }
  }
  // Left to right in bus-lane order so wires don't cross much.
  srcs.sort((a, b) => (laneX[a.item] ?? 0) - (laneX[b.item] ?? 0));
  const yardH = srcs.length ? BOX_H + 3 * F : 0;
  const sources: SourceBox[] = srcs.map((src, k) => {
    const x = k * (BOX_W + YARD_GAP);
    const y = -yardH;
    const lane = laneX[src.item] ?? x + BOX_W / 2;
    const mid = -F - (k % 3) * 2; // stagger the horizontal runs a little
    return { ...src, x, y, w: BOX_W, h: BOX_H, wire: [{ x: x + BOX_W / 2, y: y + BOX_H }, { x: x + BOX_W / 2, y: mid }, { x: lane, y: mid }, { x: lane, y: portTopY }] };
  });
  const { facing: autoFacing, why } = facingFor(plan, ctx);
  const facing: Facing = opt.orientation && opt.orientation !== 'auto' ? opt.orientation : autoFacing;
  const facingWhy = opt.orientation && opt.orientation !== 'auto' ? `Input wall set to face ${FACING_NAME[facing]}.` : why;

  const floors: Floor[] = [];
  floorSpecs.forEach((rowsSpec, fi) => {
    const rows: Row[] = [];
    const ms: PlacedMachine[] = [];
    const belts: BeltPath[] = [];
    const markers: Marker[] = [];
    const ports: Port[] = [];
    const walls: WallSeg[] = [];
    const laneSpan: Record<string, [number, number]> = {};
    /** Balanced: where each row's input belt starts (just past the bus gap); the lane or a bus split feeds it. */
    const entries: { item: string; rowId: string; pt: Pt }[] = [];
    const touch = (item: string, y: number) => {
      const s = laneSpan[item];
      laneSpan[item] = s ? [Math.min(s[0], y), Math.max(s[1], y)] : [y, y];
    };

    let y = top;
    for (const s of rowsSpec) {
      const row: Row = { id: s.id, x: rowX, y, w: rowLen(s), h: rowH(s), recipe: s.recipe, machine: s.machine, count: s.count, clock: s.clock, inItems: s.inItems, outItems: s.outItems };
      rows.push(row);
      const bodyY = y + s.inH;
      const outY = bodyY + s.bodyH;
      const r = s.recipe;
      const perMachine = (amt: number) => (amt * 60) / r.time * (s.clock / 100);
      // Machines
      for (let k = 0; k < s.count; k++) {
        const mx = rowX + k * s.pitch + (s.pitch - s.machine.w) / 2;
        const my = bodyY + (s.bodyH - s.machine.l) / 2;
        const inPorts = s.inItems.map((item, j) => ({ item, x: mx + (s.machine.w * (j + 1)) / (s.inItems.length + 1), y: my }));
        const outPorts = s.outItems.map((item, j) => ({ item, x: mx + (s.machine.w * (j + 1)) / (s.outItems.length + 1), y: my + s.machine.l }));
        ms.push({ id: `${s.id}:${k}`, x: mx, y: my, w: s.machine.w, l: s.machine.l, machine: s.machine, recipe: r, clock: s.clock, index: k + 1, rowId: s.id, inPorts, outPorts });
      }
      // Inputs: balanced rows get a splitter tree; otherwise a manifold (one lane per item) fed from the bus.
      s.inItems.forEach((item, j) => {
        const band = s.bands[j];
        const ly = y + band.feedY;
        const rate = band.rate;
        const t = transportName(item, rate);
        const rowMs = ms.slice(-s.count);
        const lastX = rowMs[rowMs.length - 1].inPorts[j].x;
        if (!balanced || isFluid(item)) {
          belts.push({ item, fluid: isFluid(item), points: [{ x: laneX[item], y: ly }, { x: lastX, y: ly }], rate, hidden: hiddenManifold, kind: 'manifold', ...t });
          touch(item, ly);
          markers.push({ x: laneX[item], y: ly, kind: isFluid(item) ? 'junction' : 'splitter', item });
          for (const m of rowMs) {
            const p = m.inPorts[j];
            markers.push({ x: p.x, y: ly, kind: isFluid(item) ? 'junction' : 'splitter', item });
            belts.push({ item, fluid: isFluid(item), points: [{ x: p.x, y: ly }, { x: p.x, y: p.y }], rate: perMachine(r.in[j][1]), hidden: hiddenManifold, kind: 'feed', ...transportName(item, perMachine(r.in[j][1])) });
            if (opt.logistics === 'underfloor') markers.push({ x: p.x, y: p.y - 1, kind: 'hole', item });
          }
          return;
        }
        const entry = { x: rowX - 1, y: ly };
        entries.push({ item, rowId: s.id, pt: entry });
        const label = { x: lastX, y: ly };
        if (band.tree) {
          const x0 = rowMs[0].inPorts[j].x;
          const map = (c: number, rr: number) => ({ x: x0 + c * s.pitch, y: y + band.top + 1.5 + rr * LEVEL });
          const top0 = map(band.tree.lay.col.get(0)!, 0);
          belts.push({ item, fluid: false, points: [entry, top0], rate, hidden: hiddenManifold, kind: 'manifold', labelAt: label, ...t });
          drawTree(band.tree, map, (d) => rowMs[d].inPorts[j], item, belts, markers);
          const lt = transportName(item, band.tree.g.maxRate);
          if (t.lanes > 1) beltWarnings.add(`${rowName(s)} takes ${r1(rate)} ${itemName(item)}/min, more than one ${t.tier} carries — lower "Machines per row" so each row fits on one belt, or unlock a faster belt.`);
          else if (lt.lanes > 1) beltWarnings.add(`In ${rowName(s)}, the ${itemName(item)} loop-back pushes a belt past ${t.tier}'s limit — lower "Machines per row", or unlock a faster belt.`);
        } else {
          const p = rowMs[0].inPorts[j];
          belts.push({ item, fluid: false, points: [entry, { x: p.x, y: ly }, { x: p.x, y: p.y }], rate, hidden: hiddenManifold, kind: 'manifold', labelAt: label, ...t });
        }
        if (opt.logistics === 'underfloor') for (const m of rowMs) markers.push({ x: m.inPorts[j].x, y: m.inPorts[j].y - 1, kind: 'hole', item });
      });
      // Output manifolds back to the bus.
      s.outItems.forEach((item, j) => {
        if (isPower(item)) return; // generators feed the grid through power lines, not belts
        const ly = outY + 2 + j * STRIP_LANE;
        const rate = perMachine(r.out[j][1]) * s.count;
        const t = transportName(item, rate);
        const lastX = ms[ms.length - 1].outPorts[j].x;
        belts.push({ item, fluid: isFluid(item), points: [{ x: lastX, y: ly }, { x: laneX[item], y: ly }], rate, hidden: hiddenManifold, kind: 'manifold', ...t });
        touch(item, ly);
        markers.push({ x: laneX[item], y: ly, kind: isFluid(item) ? 'junction' : 'merger', item });
        const row = ms.slice(-s.count);
        const feed = (pts: Pt[], m: PlacedMachine) => {
          belts.push({ item, fluid: isFluid(item), points: pts, rate: perMachine(r.out[j][1]), hidden: hiddenManifold, kind: 'feed', ...transportName(item, perMachine(r.out[j][1])) });
          if (opt.logistics === 'underfloor') markers.push({ x: m.outPorts[j].x, y: m.outPorts[j].y + 1, kind: 'hole', item });
        };
        if (balanced && !isFluid(item)) {
          // Just enough mergers: from the far end, the first merger takes 3 machines (odd rows) or 2, then each
          // next one takes the line plus 2 more. A single machine needs none.
          const rev = [...row].reverse();
          const groups: PlacedMachine[][] = [];
          let k = 0;
          if (rev.length > 1 && rev.length % 2 === 1) { groups.push(rev.slice(0, 3)); k = 3; }
          for (; k < rev.length; k += 2) groups.push(rev.slice(k, k + 2));
          for (const grp of groups) {
            const xs = grp.map((m) => m.outPorts[j].x);
            const mx = grp.length === 1 ? xs[0] : (Math.min(...xs) + Math.max(...xs)) / 2;
            if (row.length > 1) markers.push({ x: mx, y: ly, kind: 'merger', item });
            for (const m of grp) {
              const p = m.outPorts[j];
              feed(Math.abs(p.x - mx) < 0.01 ? [{ x: p.x, y: p.y }, { x: p.x, y: ly }] : [{ x: p.x, y: p.y }, { x: p.x, y: ly - 1.5 }, { x: mx, y: ly - 1.5 }, { x: mx, y: ly }], m);
            }
          }
        } else {
          for (const m of row) {
            const p = m.outPorts[j];
            markers.push({ x: p.x, y: ly, kind: isFluid(item) ? 'junction' : 'merger', item });
            feed([{ x: p.x, y: p.y }, { x: p.x, y: ly }], m);
          }
        }
      });
      // Power poles between machine pairs on the walkway side.
      if (opt.showPower) {
        const per = 6;
        for (let k = 0; k < s.count; k += per) {
          const px = rowX + k * s.pitch + Math.min(per, s.count - k) * s.pitch / 2;
          markers.push({ x: px, y: outY + s.outH - 0.5, kind: 'pole' });
        }
      }
      y += rowH(s) + opt.rowGap * F;
    }

    // Inputs enter the ground floor from the north; product and byproducts leave to the south.
    const portTop = border + 2;
    const portBottom = height - border - 2;
    const lastFloorFor = (item: string) => Math.max(...[...(makers[item] ?? [])]);
    for (const lane of lanes) {
      const item = lane.item;
      const madeHere = makers[item]?.has(fi);
      const usedHere = usersOf[item]?.has(fi);
      if (!madeHere && !usedHere) continue;
      if (fi === 0 && inputItems.has(item)) {
        const line = plan.inputs.filter((x) => x.item === item).reduce((a, b) => a + b.rate, 0);
        ports.push({ x: lane.x, y: portTop, item, rate: line, dir: 'in', label: `IN ${itemName(item)}` });
        touch(item, portTop);
      }
      if (item === target && fi === lastFloorFor(item)) {
        ports.push({ x: lane.x, y: portBottom, item, rate: plan.rate, dir: 'out', label: `OUT ${itemName(item)}${fi > 0 ? ' (lift to ground)' : ''}` });
        touch(item, portBottom);
      }
      const extra = plan.also.find(([i]) => i === item);
      if (extra && item !== target && fi === lastFloorFor(item)) {
        ports.push({ x: lane.x, y: portBottom, item, rate: extra[1], dir: 'out', label: `OUT ${itemName(item)}${fi > 0 ? ' (lift to ground)' : ''}` });
        touch(item, portBottom);
      }
      const sur = plan.surplus.find(([i]) => i === item);
      if (sur && item !== target && fi === lastFloorFor(item)) {
        ports.push({ x: lane.x, y: portBottom, item, rate: sur[1], dir: 'out', label: `SURPLUS ${itemName(item)}` });
        touch(item, portBottom);
      }
      // Lifts where an item has to reach another floor.
      const otherMakers = [...(makers[item] ?? [])].some((f2) => f2 !== fi);
      const otherUsers = [...(usersOf[item] ?? [])].some((f2) => f2 !== fi);
      if ((usedHere && otherMakers && !madeHere) || (madeHere && otherUsers)) {
        const ly = top - 3;
        const up = madeHere ? [...usersOf[item]].some((f2) => f2 > fi) : [...makers[item]].some((f2) => f2 < fi);
        markers.push({ x: lane.x, y: ly, kind: 'lift', item, label: madeHere ? (up ? '↑' : '↓') : up ? '↑in' : '↓in' });
        touch(item, ly);
      }
    }
    if (balanced) {
      // Bus splitter trees: sideways in the gap, one belt from each output to the row (or lift / output) it feeds.
      const fed = new Set<string>();
      for (const bt of busTrees[fi]) {
        const gx = busX + busW + 1 + bt.dx;
        const map = (c: number, rr: number) => ({ x: gx + rr * SIDE_LEVEL, y: bt.gy + c * LEAF });
        const root = map(bt.lay.col.get(0)!, 0);
        belts.push({ item: bt.item, fluid: false, points: [{ x: laneX[bt.item], y: root.y }, root], rate: bt.g.input, hidden: hiddenBus, kind: 'tree', ...transportName(bt.item, bt.g.input) });
        touch(bt.item, root.y);
        const outs = new Map<number, Pt>();
        drawTree(bt, map, (d, c, rr) => { const p = map(c, rr); outs.set(d, p); return p; }, bt.item, belts, markers);
        const trackX0 = gx + (bt.lay.rows - 1) * SIDE_LEVEL + 1.5;
        bt.users.forEach((u, d) => {
          const from = outs.get(d);
          if (!from) return;
          const rate = (bt.g.input * bt.shares[d]) / bt.parts;
          const tx = trackX0 + d * TRACK;
          let to: Pt;
          if (u.kind === 'row') {
            const en = entries.find((x) => x.item === bt.item && x.rowId === u.rowId);
            if (!en) return;
            fed.add(`${bt.item}|${u.rowId}`);
            to = en.pt;
          } else to = { x: laneX[bt.item] + 1, y: u.kind === 'out' ? portBottom - 1 : top - 2 };
          belts.push({ item: bt.item, fluid: false, points: [from, { x: tx, y: from.y }, { x: tx, y: to.y }, to], rate, hidden: hiddenManifold, kind: 'tree', ...transportName(bt.item, rate) });
        });
        if (bt.error > 1e-3) beltWarnings.add(`${itemName(bt.item)} is shared ${bt.shares.join(':')} between ${bt.users.map((u2) => u2.name).join(', ')} — within ${Math.max(1, Math.round(bt.error * 100))} % of what each needs. The belts that get a little extra fill up within minutes, then the splitters pass their share on.`);
      }
      // Rows with the lane to themselves take it straight from the bus.
      for (const en of entries) {
        if (fed.has(`${en.item}|${en.rowId}`)) continue;
        belts.push({ item: en.item, fluid: false, points: [{ x: laneX[en.item], y: en.pt.y }, en.pt], rate: 0, hidden: hiddenBus, kind: 'tree', tier: '', lanes: 1 });
        touch(en.item, en.pt.y);
      }
    }

    for (const lane of lanes) {
      const span = laneSpan[lane.item];
      if (!span) continue;
      const rate = flowRate(lane.item);
      belts.push({ item: lane.item, fluid: lane.fluid, points: [{ x: lane.x, y: span[0] }, { x: lane.x, y: span[1] }], rate, hidden: hiddenBus, kind: 'bus', ...transportName(lane.item, rate) });
    }

    // Walls
    if (opt.perimeterWalls) {
      const doorsTop = ports.filter((p) => p.dir === 'in').map((p) => p.x);
      const doorsBottom = ports.filter((p) => p.dir === 'out').map((p) => p.x);
      walls.push({ a: { x: 0, y: 0 }, b: { x: width, y: 0 }, holes: doorsTop });
      walls.push({ a: { x: width, y: 0 }, b: { x: width, y: height } });
      walls.push({ a: { x: width, y: height }, b: { x: 0, y: height }, holes: doorsBottom });
      walls.push({ a: { x: 0, y: height }, b: { x: 0, y: 0 } });
    }
    if (opt.logistics === 'walls') {
      // A service corridor: the bus sits between two walls; manifolds run behind low walls with wall holes at each machine.
      const holes = rows.flatMap((r) => [r.y + 2, r.y + r.h - 2]);
      walls.push({ a: { x: busX, y: top - 4 }, b: { x: busX, y: height - border - 4 } });
      walls.push({ a: { x: busX + busW, y: top - 4 }, b: { x: busX + busW, y: height - border - 4 }, holes });
      for (const r of rows) {
        const inEdge = r.y + toF(Math.max(1, r.inItems.length) * STRIP_LANE);
        const outEdge = r.y + r.h - toF(Math.max(1, r.outItems.length) * STRIP_LANE);
        const machinesHere = ms.filter((m) => m.rowId === r.id);
        walls.push({ a: { x: r.x, y: inEdge }, b: { x: r.x + r.w, y: inEdge }, holes: machinesHere.flatMap((m) => m.inPorts.map((p) => p.x)) });
        walls.push({ a: { x: r.x, y: outEdge }, b: { x: r.x + r.w, y: outEdge }, holes: machinesHere.flatMap((m) => m.outPorts.map((p) => p.x)) });
      }
    }

    // The game data under-reports some heights (e.g. Assembler), so keep at least 3 walls (12 m) of headroom.
    const tallest = Math.max(10, ...rowsSpec.map((s) => s.machine.h));
    const storeyHeight = Math.ceil((tallest + (opt.logistics === 'underfloor' ? 4 : 2)) / 4) * 4;
    // Output yard: one box per product leaving this floor, below the output wall.
    const outs = ports.filter((p) => p.dir === 'out').sort((a, b) => a.x - b.x);
    const outBoxes: SourceBox[] = outs.map((p, k) => {
      const x = k * (BOX_W + YARD_GAP);
      const y = height + 2 * F;
      const cx = x + BOX_W / 2;
      const mid = height + F - (k % 3) * 2;
      const main = p.item === target;
      const also = !main && plan.also.some(([i]) => i === p.item);
      return {
        kind: main || also ? 'output' : 'surplus', item: p.item, rate: p.rate, x, y, w: BOX_W, h: 3 * F,
        title: `${main ? 'OUT' : also ? 'ALSO OUT' : 'SURPLUS'} ${itemName(p.item)}`,
        lines: [rateTxt(p.item, p.rate), main ? 'main product' : also ? 'extra product' : 'ship, sink or store', ...(fi > 0 ? ['lift to ground'] : [])],
        wire: [{ x: p.x, y: p.y }, { x: p.x, y: mid }, { x: cx, y: mid }, { x: cx, y }],
      };
    });
    floors.push({ index: fi, width, height, storeyHeight, rows, machines: ms, belts, markers, ports, walls, bus: { x: busX, w: busW }, outBoxes });
  });

  // ---- bill of materials ----
  const bom: BOMLine[] = [];
  const fx = width / F;
  const fy = height / F;
  bom.push({ name: 'Foundations (8 m × 8 m)', count: fx * fy * floors.length });
  if (opt.perimeterWalls) {
    const wallsPerStorey = floors.reduce((a, f) => a + (2 * (fx + fy)) * Math.ceil(f.storeyHeight / 4), 0);
    bom.push({ name: 'Walls (8 m × 4 m)', count: wallsPerStorey });
  }
  const beltLen: Record<string, number> = {};
  let splitters = 0, mergers = 0, junctions = 0, lifts = 0, holes = 0, poles = 0, wallHoles = 0;
  for (const f of floors) {
    for (const b of f.belts) {
      const len = b.points.slice(1).reduce((a, p, i) => a + Math.abs(p.x - b.points[i].x) + Math.abs(p.y - b.points[i].y), 0);
      beltLen[b.tier] = (beltLen[b.tier] ?? 0) + len * b.lanes;
    }
    for (const m of f.markers) {
      if (m.kind === 'splitter') splitters++;
      else if (m.kind === 'merger') mergers++;
      else if (m.kind === 'junction') junctions++;
      else if (m.kind === 'lift') lifts++;
      else if (m.kind === 'hole') holes++;
      else if (m.kind === 'pole') poles++;
    }
    for (const w of f.walls) wallHoles += w.holes?.length ?? 0;
  }
  for (const [tier, len] of Object.entries(beltLen).sort()) bom.push({ name: tier, count: Math.ceil(len), unit: 'm' });
  if (splitters) bom.push({ name: 'Conveyor Splitters', count: splitters });
  if (mergers) bom.push({ name: 'Conveyor Mergers', count: mergers });
  if (junctions) bom.push({ name: 'Pipeline Junctions', count: junctions });
  if (lifts) bom.push({ name: 'Conveyor Lifts / vertical pipes', count: lifts });
  if (holes) bom.push({ name: 'Conveyor Floor Holes', count: holes });
  if (opt.logistics === 'walls' && wallHoles) bom.push({ name: 'Conveyor Wall Holes / Pipe Wall Supports', count: wallHoles });
  if (poles) bom.push({ name: 'Power Poles', count: poles });
  const machineTotals: Record<string, number> = {};
  for (const g of plan.groups) machineTotals[g.machine.name] = (machineTotals[g.machine.name] ?? 0) + g.count;
  for (const [name, count] of Object.entries(machineTotals)) bom.push({ name, count });
  const extractorTotals: Record<string, number> = {};
  for (const e of plan.extraction) extractorTotals[e.extractor.name] = (extractorTotals[e.extractor.name] ?? 0) + e.count;
  for (const [name, count] of Object.entries(extractorTotals)) bom.push({ name: `${name} (at the nodes)`, count });

  if (plan.power.generated > 0) notes.push(`Generators make ${Math.round(plan.power.generated)} MW — connect them to your grid with power lines (not drawn).`);
  if (target === POWER && plan.power.generated > 0) notes.push('The product is power, so there is no output belt.');
  if (opt.logistics === 'underfloor') notes.push('Belts and pipes run on a service level 1 wall (4 m) below each floor and come up through Conveyor Floor Holes at every machine port.');
  if (opt.logistics === 'walls') notes.push('The bus runs in a walled service corridor; manifolds sit behind low walls with Conveyor Wall Holes at each machine.');
  if (lanes.some((l) => l.fluid) && pipe) notes.push(`Pipes shown as double lines (${pipe.name}, ${pipe.rate} m³/min max). Mind pump head lift on upper floors.`);
  notes.push(`Belts sized from what you have unlocked (best: ${belt.name}, ${belt.rate}/min). Labels like “×2” mean parallel lines.`);
  notes.push('Machine input/output port positions are approximate — check each machine’s arrows in game and flip the row if needed.');

  if (balanced) {
    notes.push('Balanced feeds: each row is fed through a splitter tree drawn above it, and a bus belt that feeds several rows is shared out by a sideways splitter tree next to the bus — every machine gets its share from the first minute, so nothing has to back up first. Dashed belts loop spare splitter outputs back into the merger above them.');
    for (const w of beltWarnings) notes.push(w);
    notes.push('Outputs join their belts through mergers; belts are sized for the full flow, so machines don’t back up as long as the next step takes what they make.');
    if (lanes.some((l) => l.fluid)) notes.push('Pipes can’t be balanced with parts — a pipe manifold evens out by itself once it’s full. Feed long rows from both ends (loop the pipe back to the start) so the far machines fill sooner. Valves aren’t needed unless you want to cap one branch.');
  } else {
    notes.push('Manifold feeds: one belt runs past the machines with a splitter at each. The first machines fill up first, so let the belt back up before the last ones run at full speed.');
  }
  if (sources.length) notes.push('Miners, extractors and other supply are drawn in a yard outside the input wall, each wired to its input port. Distances and directions are from the factory’s spot on the map.');
  notes.push(facingWhy);
  return { floors, width, height, lanes, bom, notes, sources, yardH, facing, facingWhy };
}
