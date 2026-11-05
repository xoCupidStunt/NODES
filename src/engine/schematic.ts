import { FOUNDATION as F, isFluid, isPower, itemName, POWER, type Machine, type Recipe } from '../data/game';
import type { Plan } from './plan';
import { availableBelts, availablePipes } from './progression';
import type { SchematicOptions } from './types';
import { evenSplit, ratioSplit, stagesText } from './balance';

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
  kind: 'bus' | 'manifold' | 'feed' | 'port'; tier: string; lanes: number;
}
export interface Marker { x: number; y: number; kind: 'splitter' | 'merger' | 'junction' | 'lift' | 'hole' | 'pole' | 'balancer'; item?: string; label?: string; title?: string }
/** How to build one balanced split, for the build guide. */
export interface BalanceStep {
  floor: number; item: string; where: 'bus' | 'row'; title: string; steps: string[];
  splitters: number; mergers: number; warn?: string;
}
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
  /** Splitter trees that give every machine (and every row) an equal share, when distribution is 'balanced'. */
  balancing: BalanceStep[];
}

const LANE = 3; // metres between bus lanes
const STRIP_LANE = 4; // metres per manifold lane

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
  const balancing: BalanceStep[] = [];
  const plural = (n: number, w: string) => `${n} ${n === 1 ? w : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`}`;
  const r1 = (v: number) => Math.round(v * 10) / 10;

  // ---- rows: split each machine group into chunks of maxPerRow ----
  type RowSpec = Omit<Row, 'x' | 'y' | 'w' | 'h'> & { pitch: number; bodyH: number; inH: number; outH: number; groupId: string; frac: number };
  const specs: RowSpec[] = [];
  for (const g of plan.groups) {
    const per = Math.max(1, opt.maxPerRow);
    const chunks = Math.ceil(g.count / per);
    for (let c = 0; c < chunks; c++) {
      const count = Math.min(per, g.count - c * per);
      const inItems = g.recipe.in.map(([i]) => i);
      const outItems = g.recipe.out.map(([i]) => i);
      specs.push({
        id: `${g.id}#${c}`, groupId: g.id, recipe: g.recipe, machine: g.machine, count, clock: g.clock,
        inItems, outItems,
        pitch: snap(g.machine.w + opt.machineGap, opt.snap),
        bodyH: snap(g.machine.l, opt.snap),
        inH: toF(Math.max(1, inItems.length) * STRIP_LANE),
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
  const rowX = busX + busW + F;
  const rowLen = (s: RowSpec) => s.count * s.pitch;
  const maxRowLen = Math.max(F, ...specs.map(rowLen));
  const width = toF(rowX + maxRowLen + F + border);
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
    /** Belts taking each item from the bus on this floor (rows, and what leaves the floor), for the bus split. */
    const busUse: Record<string, { name: string; need: number; y: number }[]> = {};
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
      // Input manifolds (one lane per input item), fed from the bus on the west.
      s.inItems.forEach((item, j) => {
        const ly = y + s.inH - 2 - j * STRIP_LANE;
        const rate = perMachine(r.in[j][1]) * s.count;
        const t = transportName(item, rate);
        const lastX = ms[ms.length - 1].inPorts[j].x;
        belts.push({ item, fluid: isFluid(item), points: [{ x: laneX[item], y: ly }, { x: lastX, y: ly }], rate, hidden: hiddenManifold, kind: 'manifold', ...t });
        touch(item, ly);
        // Balanced: a splitter tree at the start of the row gives each machine an equal share from the start.
        const even = balanced && !isFluid(item) && s.count > 1;
        if (!balanced || isFluid(item)) markers.push({ x: laneX[item], y: ly, kind: isFluid(item) ? 'junction' : 'splitter', item });
        if (balanced && !isFluid(item)) {
          const consumers = (busUse[item] ??= []);
          consumers.push({ name: rowName(s), need: rate, y: ly });
        }
        if (even) {
          const es = evenSplit(s.count);
          const load = rate * es.beltLoad;
          const lt = transportName(item, load);
          const machinesTxt = plural(s.count, s.machine.name);
          markers.push({ x: rowX - F / 2, y: ly, kind: 'balancer', item, label: `1→${s.count}`, title: `${itemName(item)}: balanced 1→${s.count} split` });
          balancing.push({
            floor: fi, item, where: 'row',
            title: `${itemName(item)} → ${machinesTxt} (${rowName(s)})`,
            splitters: es.splitters, mergers: es.mergers,
            steps: es.loopBack
              ? [
                  `Build a 1→${es.size} splitter tree: ${stagesText(es.stages)} (${plural(es.splitters, 'splitter')}).`,
                  `Run ${s.count} of its outputs to the ${machinesTxt}, one each.`,
                  `Loop the other ${plural(es.loopBack, 'output')} back and merge ${es.loopBack === 1 ? 'it' : 'them'} into the incoming belt just before the first splitter (${plural(es.mergers, 'merger')}).`,
                  `With the loop-back, the belt into the first splitter carries about ${r1(load)}/min — ${lt.lanes > 1 ? 'more than one belt can take' : `${lt.tier} or faster`}.`,
                ]
              : [
                  `Build a 1→${s.count} splitter tree: ${stagesText(es.stages)} (${plural(es.splitters, 'splitter')}).`,
                  `Run one output to each ${s.machine.name}.`,
                ],
            warn: lt.lanes > 1 ? `The loop-back pushes this belt past ${t.tier}’s limit — lower “Machines per row” so the row splits in two, or unlock a faster belt.` : undefined,
          });
        }
        for (const m of ms.slice(-s.count)) {
          const p = m.inPorts[j];
          if (!even) markers.push({ x: p.x, y: ly, kind: isFluid(item) ? 'junction' : 'splitter', item });
          belts.push({ item, fluid: isFluid(item), points: [{ x: p.x, y: ly }, { x: p.x, y: p.y }], rate: perMachine(r.in[j][1]), hidden: hiddenManifold, kind: 'feed', ...transportName(item, perMachine(r.in[j][1])) });
          if (opt.logistics === 'underfloor') markers.push({ x: p.x, y: p.y - 1, kind: 'hole', item });
        }
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
        for (const m of ms.slice(-s.count)) {
          const p = m.outPorts[j];
          markers.push({ x: p.x, y: ly, kind: isFluid(item) ? 'junction' : 'merger', item });
          belts.push({ item, fluid: isFluid(item), points: [{ x: p.x, y: p.y }, { x: p.x, y: ly }], rate: perMachine(r.out[j][1]), hidden: hiddenManifold, kind: 'feed', ...transportName(item, perMachine(r.out[j][1])) });
          if (opt.logistics === 'underfloor') markers.push({ x: p.x, y: p.y + 1, kind: 'hole', item });
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
    for (const lane of lanes) {
      const span = laneSpan[lane.item];
      if (!span) continue;
      const rate = flowRate(lane.item);
      belts.push({ item: lane.item, fluid: lane.fluid, points: [{ x: lane.x, y: span[0] }, { x: lane.x, y: span[1] }], rate, hidden: hiddenBus, kind: 'bus', ...transportName(lane.item, rate) });
    }

    // Balanced: where a bus lane feeds several belts, one splitter tree shares it out by what each needs.
    if (balanced) {
      for (const [item, rowsUsing] of Object.entries(busUse)) {
        const users = [...rowsUsing];
        const out = ports.filter((p) => p.dir === 'out' && p.item === item).reduce((a, p) => a + p.rate, 0);
        if (out > 1e-6) users.push({ name: 'the output port', need: out, y: portBottom });
        // Made here and used upstairs/downstairs where it isn't made: that share goes to the lift.
        if (makers[item]?.has(fi)) {
          let away = 0;
          floorSpecs.forEach((rs2, f2) => {
            if (f2 === fi || makers[item]?.has(f2)) return;
            for (const s of rs2) s.inItems.forEach((i, j) => { if (i === item) away += (s.recipe.in[j][1] * 60) / s.recipe.time * (s.clock / 100) * s.count; });
          });
          if (away > 1e-6) users.push({ name: 'the lift to other floors', need: away, y: top - 3 });
        }
        if (users.length < 2) continue;
        // A balanced split corrects small misses by itself (a full branch's share goes to the others), so a
        // small tree within a few percent beats a huge exact one.
        const rs = ratioSplit(users.map((x) => x.need), 0.05, 18);
        const x = laneX[item];
        const y = Math.min(...users.map((x2) => x2.y)) - 2.5;
        markers.push({ x, y, kind: 'balancer', item, label: `÷${rs.parts}`, title: `${itemName(item)}: bus split into ${rs.parts} parts` });
        const sp = rs.split;
        const give = users.map((x2, i) => `${rs.shares[i]} to ${x2.name}`).join(', ');
        balancing.push({
          floor: fi, item, where: 'bus',
          title: `${itemName(item)} bus → ${users.length} belts`,
          splitters: sp.splitters, mergers: sp.mergers + rs.joinMergers,
          steps: [
            `Bring all the ${itemName(item)} for this floor onto one belt, then build a 1→${rs.parts} splitter tree: ${stagesText(sp.stages)} (${plural(sp.splitters, 'splitter')})${sp.loopBack ? `, looping ${plural(sp.loopBack, 'output')} back into its start (${plural(sp.mergers, 'merger')})` : ''}.`,
            `Hand out its ${rs.parts} outputs: ${give}${rs.joinMergers ? ` — merge each group into one belt (${plural(rs.joinMergers, 'merger')})` : ''}.`,
            rs.error < 1e-3
              ? 'Every belt gets at least what it needs; any that get a little extra fill up first and pass the rest on.'
              : `One belt gets up to ${Math.max(1, Math.round(rs.error * 100))} % less than it needs at first. The belts that get a little extra fill up within minutes, then the splitters pass their share on and it catches up — only those short stretches back up, not the whole line.`,
          ],
          warn: rs.error > 0.2 ? `The closest small split is off by up to ${Math.round(rs.error * 100)} % for one belt — it still evens out, but the short belt waits a little longer at start-up. Giving that row its own supply line avoids it.` : undefined,
        });
      }
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
  for (const b of balancing) { splitters += b.splitters; mergers += b.mergers; }
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
    if (balancing.length) notes.push('Balanced feeds: splitter trees (marked 1→N and ÷N) give every machine and every row its share from the first minute, so nothing has to back up before the last machine runs. Build steps are under “Load balancing”.');
    notes.push('Outputs join their belts through mergers; belts are sized for the full flow, so machines don’t back up as long as the next step takes what they make.');
    if (lanes.some((l) => l.fluid)) notes.push('Pipes can’t be balanced with parts — a pipe manifold evens out by itself once it’s full. Feed long rows from both ends (loop the pipe back to the start) so the far machines fill sooner. Valves aren’t needed unless you want to cap one branch.');
  } else {
    notes.push('Manifold feeds: one belt runs past the machines with a splitter at each. The first machines fill up first, so let the belt back up before the last ones run at full speed.');
  }
  if (sources.length) notes.push('Miners, extractors and other supply are drawn in a yard outside the input wall, each wired to its input port. Distances and directions are from the factory’s spot on the map.');
  notes.push(facingWhy);
  return { floors, width, height, lanes, bom, notes, sources, yardH, facing, facingWhy, balancing };
}
