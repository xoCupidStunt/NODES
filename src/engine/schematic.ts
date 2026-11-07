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

/**
 * Belts only run straight: where two points differ both ways (a dragged machine), add two corners halfway along
 * the longer direction, so the belt jogs across instead of cutting diagonally.
 */
export function squareOff(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  pts.forEach((p, k) => {
    const a = pts[k - 1];
    if (a && Math.abs(p.x - a.x) > 0.01 && Math.abs(p.y - a.y) > 0.01) {
      if (Math.abs(p.y - a.y) >= Math.abs(p.x - a.x)) { const my = (a.y + p.y) / 2; out.push({ x: a.x, y: my }, { x: p.x, y: my }); }
      else { const mx = (a.x + p.x) / 2; out.push({ x: mx, y: a.y }, { x: mx, y: p.y }); }
    }
    out.push(p);
  });
  return out;
}

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
  /**
   * A direct line: one block of producer machines (merged) feeding one block of consumer machines (split evenly),
   * instead of going through the bus. slot = its place among the lines leaving / entering the same row strip.
   */
  type Line = {
    id: number; item: string; rate: number;
    from: { rowId: string; start: number; n: number; slot: number };
    to: { rowId: string; start: number; n: number; slot: number; tree: Tree | null };
  };
  /** One input item's strip above a row: a manifold lane, a splitter tree, or direct lines. y values from the row top. */
  type Band = { tree: Tree | null; top: number; h: number; feedY: number; rate: number; lines?: Line[] };
  /** One output item's strip below a row: a line back to the bus, or direct lines. */
  type OutBand = { top: number; h: number; lines?: Line[] };
  type RowSpec = Omit<Row, 'x' | 'y' | 'w' | 'h'> & { pitch: number; bodyH: number; inH: number; outH: number; groupId: string; frac: number; bands: Band[]; outBands: OutBand[] };
  /** What line-finding needs to know about a row (or, before rows exist, a whole machine group). */
  type LineRow = { id: string; groupId: string; count: number; recipe: Recipe; clock: number; inItems: string[]; outItems: string[] };
  const perMin = (sp: LineRow, side: 'in' | 'out', item: string) => {
    const list = side === 'in' ? sp.recipe.in : sp.recipe.out;
    const j = list.findIndex(([i]) => i === item);
    return ((list[j][1] * 60) / sp.recipe.time) * (sp.clock / 100);
  };
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

  // ---- balanced: link each machine type straight to the next ----
  // For a part made by one machine type and used by others in the factory, split the makers and the users into the
  // most identical lines that fit evenly (both counts divide by it, and no block crosses a row): each line merges
  // its own few makers and splits evenly to its own few users. 10 Smelters → 6 Foundries = 2 lines of 5 → 3;
  // 6 Foundries → 12 Constructors = 6 lines of 1 → 2. Anything that doesn't fit exactly goes through the bus.
  const findLines = (rowsIn: LineRow[]) => {
    const found: Line[] = [];
    const items = new Set<string>();
    const fromOutside = new Set(plan.inputs.map((x) => x.item));
    const leaves = new Set([target, ...plan.also.map(([i]) => i), ...plan.surplus.map(([i]) => i)]);
    const oneRow = (list: { rowId: string }[], size: number) => {
      for (let i = 0; i < list.length; i += size) if (list[i].rowId !== list[i + size - 1].rowId) return false;
      return true;
    };
    for (const item of new Set(rowsIn.flatMap((sp) => sp.outItems))) {
      if (isFluid(item) || isPower(item) || fromOutside.has(item) || leaves.has(item)) continue;
      const makersRows = rowsIn.filter((sp) => sp.outItems.includes(item));
      const usersRows = rowsIn.filter((sp) => sp.inItems.includes(item));
      if (!usersRows.length || new Set(makersRows.map((sp) => sp.groupId)).size !== 1) continue;
      const each = perMin(makersRows[0], 'out', item);
      const makerMs = makersRows.flatMap((sp) => Array.from({ length: sp.count }, (_, k) => ({ rowId: sp.id, k })));
      const made: Line[] = [];
      let used = 0;
      let ok = true;
      for (const gid of new Set(usersRows.map((sp) => sp.groupId))) {
        const rows = usersRows.filter((sp) => sp.groupId === gid);
        const userMs = rows.flatMap((sp) => Array.from({ length: sp.count }, (_, k) => ({ rowId: sp.id, k })));
        const needMakers = (userMs.length * perMin(rows[0], 'in', item)) / each;
        const pk = Math.round(needMakers);
        if (pk < 1 || Math.abs(needMakers - pk) > 1e-4 || used + pk > makerMs.length) { ok = false; break; }
        const mine = makerMs.slice(used, used + pk);
        used += pk;
        let m = 0;
        for (let d = gcd(pk, userMs.length); d >= 1; d--) {
          if (pk % d || userMs.length % d) continue;
          if (oneRow(mine, pk / d) && oneRow(userMs, userMs.length / d)) { m = d; break; }
        }
        if (!m) { ok = false; break; }
        const pb = pk / m;
        const cb = userMs.length / m;
        for (let l = 0; l < m; l++) {
          const p0 = mine[l * pb];
          const c0 = userMs[l * cb];
          made.push({ id: 0, item, rate: pb * each, from: { rowId: p0.rowId, start: p0.k, n: pb, slot: 0 }, to: { rowId: c0.rowId, start: c0.k, n: cb, slot: 0, tree: null } });
        }
      }
      if (!ok || used !== makerMs.length) continue;
      items.add(item);
      found.push(...made);
    }
    return { found, items };
  };

  // Row sizes. When balancing, each machine type's rows hold whole line blocks (rows of 9 for blocks of 3), so no
  // line has to cross from one row to the next; and a type that feeds another is cut to match the rows it feeds
  // (9 Smelters for each row of 9 Constructors), so each of its rows can sit right above the row it supplies.
  // Worked out on whole groups first, users before makers.
  const rowCounts = new Map<string, number[]>();
  const maxRow = Math.max(1, opt.maxPerRow);
  const evenRows = (count: number, unit: number) => {
    const per = unit <= maxRow ? Math.floor(maxRow / unit) * unit : maxRow;
    const out: number[] = [];
    for (let left = count; left > 0; left -= per) out.push(Math.min(per, left));
    return out;
  };
  if (balanced) {
    const ideal = findLines(plan.groups.map((g) => ({ id: g.id, groupId: g.id, count: g.count, recipe: g.recipe, clock: g.clock, inItems: g.recipe.in.map(([i]) => i), outItems: g.recipe.out.map(([i]) => i) })));
    const lcm = (x: number, y: number) => (x / gcd(x, y)) * y;
    const unit = new Map<string, number>();
    for (const l of ideal.found) {
      unit.set(l.from.rowId, lcm(unit.get(l.from.rowId) ?? 1, l.from.n));
      unit.set(l.to.rowId, lcm(unit.get(l.to.rowId) ?? 1, l.to.n));
    }
    for (const g of [...plan.groups].reverse()) {
      const u2 = unit.get(g.id) ?? 1;
      const outs = ideal.found.filter((l) => l.from.rowId === g.id);
      // The part this type sends down the most lines decides how its rows are cut.
      const byItem = new Map<string, Line[]>();
      for (const l of outs) byItem.set(l.item, [...(byItem.get(l.item) ?? []), l]);
      const main = [...byItem.values()].sort((x, y) => y.length - x.length)[0];
      let rowsOut: number[] | null = null;
      if (main) {
        const segs: number[] = [];
        for (const gid of [...new Set(main.map((l) => l.to.rowId))]) {
          const first = main.find((l) => l.to.rowId === gid)!;
          for (const rc of rowCounts.get(gid) ?? [plan.groups.find((x) => x.id === gid)!.count]) {
            if (rc % first.to.n) { segs.length = 0; break; }
            segs.push((rc / first.to.n) * first.from.n);
          }
        }
        if (segs.length && segs.reduce((x, y) => x + y, 0) === g.count) {
          const pb = main[0].from.n;
          const piece = Math.max(u2, Math.floor(maxRow / u2) * u2);
          const packed: number[] = [];
          let cur = 0;
          for (let seg of segs) {
            while (seg > maxRow) { if (cur) { packed.push(cur); cur = 0; } packed.push(piece); seg -= piece; }
            if (cur + seg > maxRow) { packed.push(cur); cur = 0; }
            cur += seg;
          }
          if (cur) packed.push(cur);
          if (packed.every((n) => n % u2 === 0 && n % pb === 0)) rowsOut = packed;
        }
      }
      rowCounts.set(g.id, rowsOut ?? evenRows(g.count, u2));
    }
  }

  const specs: RowSpec[] = [];
  for (const g of plan.groups) {
    const counts = rowCounts.get(g.id) ?? evenRows(g.count, 1);
    for (let c = 0; c < counts.length; c++) {
      const count = counts[c];
      specs.push({
        id: `${g.id}#${c}`, groupId: g.id, recipe: g.recipe, machine: g.machine, count, clock: g.clock,
        inItems: g.recipe.in.map(([i]) => i), outItems: g.recipe.out.map(([i]) => i),
        pitch: snap(g.machine.w + opt.machineGap, opt.snap),
        bodyH: snap(g.machine.l, opt.snap),
        inH: 0, outH: 0, bands: [], outBands: [],
        frac: count / g.count,
      });
    }
  }

  const lines: Line[] = [];
  const direct = new Set<string>();
  if (balanced) {
    const real = findLines(specs);
    lines.push(...real.found);
    for (const i of real.items) direct.add(i);
    // Chains: link each row to the row it sends the most lines to (each row one link in, one out, no loops), then
    // lay the rows out chain by chain, so most lines drop straight down into the next row.
    const counts = new Map<string, Map<string, number>>();
    for (const l of real.found) {
      const m = counts.get(l.from.rowId) ?? new Map<string, number>();
      m.set(l.to.rowId, (m.get(l.to.rowId) ?? 0) + 1);
      counts.set(l.from.rowId, m);
    }
    const pairs = [...counts.entries()].flatMap(([f, m]) => [...m.entries()].map(([t, n]) => ({ f, t, n }))).sort((x, y) => y.n - x.n);
    const next = new Map<string, string>();
    const prev = new Map<string, string>();
    const head = (id: string) => { let h = id; while (prev.has(h)) h = prev.get(h)!; return h; };
    for (const { f, t } of pairs) {
      if (f === t || next.has(f) || prev.has(t) || head(f) === t) continue;
      next.set(f, t);
      prev.set(t, f);
    }
    const byId = new Map(specs.map((sp) => [sp.id, sp]));
    const ordered: RowSpec[] = [];
    const seen = new Set<string>();
    for (const sp of specs) {
      for (let h: string | undefined = head(sp.id); h && !seen.has(h); h = next.get(h)) { seen.add(h); ordered.push(byId.get(h)!); }
    }
    specs.splice(0, specs.length, ...ordered);
    lines.forEach((l, i) => {
      l.id = i;
      if (l.to.n > 1) { const g = evenBalancer(l.to.n, l.rate); l.to.tree = { g, lay: layoutBalancer(g) }; }
    });
    const slotUp = (key: (l: Line) => string, start: (l: Line) => number, set: (l: Line, k: number) => void) => {
      const by = new Map<string, Line[]>();
      for (const l of lines) by.set(key(l), [...(by.get(key(l)) ?? []), l]);
      for (const list of by.values()) list.sort((a, b) => start(a) - start(b)).forEach((l, k) => set(l, k));
    };
    slotUp((l) => `${l.item}|${l.from.rowId}`, (l) => l.from.start, (l, k) => { l.from.slot = k; });
    slotUp((l) => `${l.item}|${l.to.rowId}`, (l) => l.to.start, (l, k) => { l.to.slot = k; });
  }

  // ---- each row's belt strips ----
  const LINE_GAP = 1.5;
  for (const sp of specs) {
    const raw = sp.inItems.map((item, j) => {
      const rate = ((sp.recipe.in[j][1] * 60) / sp.recipe.time) * (sp.clock / 100) * sp.count;
      if (direct.has(item)) {
        const ls = lines.filter((l) => l.item === item && l.to.rowId === sp.id).sort((a, b) => a.to.slot - b.to.slot);
        const depth = Math.max(0, ...ls.map((l) => (l.to.tree ? l.to.tree.lay.rows - 1 : 0)));
        return { tree: null, lines: ls, h: 1 + ls.length * LINE_GAP + 0.5 + depth * LEVEL + 1, rate };
      }
      if (!balanced || isFluid(item) || sp.count < 2) return { tree: null, h: STRIP_LANE, rate };
      const tg = evenBalancer(sp.count, rate);
      const lay = layoutBalancer(tg);
      return { tree: { g: tg, lay }, h: 2 + (lay.rows - 1) * LEVEL + 1, rate };
    });
    sp.inH = toF(Math.max(STRIP_LANE, raw.reduce((a, b) => a + b.h, 0)));
    // The first input sits next to the machines; the others stack above it.
    let edge = sp.inH;
    sp.bands = raw.map((b) => { edge -= b.h; return { ...b, top: edge, feedY: b.tree ? edge + 1.5 : edge + b.h - 2 }; });
    const outRaw = sp.outItems.map((item) => {
      if (!direct.has(item)) return { h: STRIP_LANE };
      const ls = lines.filter((l) => l.item === item && l.from.rowId === sp.id).sort((a, b) => a.from.slot - b.from.slot);
      return { lines: ls, h: 1.5 + ls.length * LINE_GAP + 0.5 };
    });
    sp.outH = toF(Math.max(STRIP_LANE, outRaw.reduce((a, b) => a + b.h, 0)));
    let down = 0;
    sp.outBands = outRaw.map((b) => { const band = { ...b, top: down }; down += b.h; return band; });
  }

  // Rows of one recipe are numbered when it needs several.
  const chunks: Record<string, number> = {};
  for (const s of specs) chunks[s.groupId] = (chunks[s.groupId] ?? 0) + 1;
  const rowName = (s: { id: string; groupId: string; recipe: Recipe }) =>
    `${s.recipe.name}${chunks[s.groupId] > 1 ? ` row ${Number(s.id.split('#')[1]) + 1}` : ''}`;

  // ---- bus lanes: one per item that moves between rows or crosses the factory edge ----
  const laneItems: string[] = [];
  const addLane = (i: string) => { if (!laneItems.includes(i) && !isPower(i) && !direct.has(i)) laneItems.push(i); };
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
        if (!isFluid(item) && !direct.has(item)) (users[item] ??= []).push({ name: rowName(sp), need: sp.bands[j].rate, y: ry + sp.bands[j].feedY, rowId: sp.id, kind: 'row' });
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
      if (list.length === 2 && list.some((x) => x.kind === 'row') && list.some((x) => x.kind !== 'row')) continue;
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
  const treesW = Math.max(0, ...busTrees.map((ts) => ts.reduce((a, t) => Math.max(a, t.dx + t.w), 0)));
  const trackX0 = busX + busW + 1 + treesW + (treesW ? 1 : 0);
  // A line into the very next row on the same floor drops straight down; the others get a track in the gap.
  const nextOnFloor = new Map<string, string>();
  for (const rs2 of floorSpecs) rs2.forEach((sp, k) => { if (rs2[k + 1]) nextOnFloor.set(sp.id, rs2[k + 1].id); });
  const adjacent = (l: Line) => nextOnFloor.get(l.from.rowId) === l.to.rowId;
  const trackOf = new Map<number, number>();
  for (const l of lines) if (!adjacent(l)) trackOf.set(l.id, trackOf.size);
  const gapW = treesW + (trackOf.size ? trackOf.size * TRACK + 2 : 0);
  const rowX = busX + busW + Math.max(F, toF(gapW + 2));
  const floorOf = new Map<string, number>();
  floorSpecs.forEach((rs2, fi) => rs2.forEach((sp) => floorOf.set(sp.id, fi)));
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
    /** Where each direct line leaves its makers' row and reaches its users' row on this floor. */
    const lineOut = new Map<number, Pt>();
    const lineIn = new Map<number, Pt>();
    /** Where each bus lane gets items (src) and gives them out (sink) on this floor, to know which way it runs. */
    const laneEnds: Record<string, { src: number[]; sink: number[] }> = {};
    /** Where row outputs join a lane, and where rows take straight from it: mergers / splitters go there as needed. */
    const joins: { item: string; y: number }[] = [];
    const takes: { item: string; y: number }[] = [];
    const touch = (item: string, y: number, role: 'src' | 'sink') => {
      const s = laneSpan[item];
      laneSpan[item] = s ? [Math.min(s[0], y), Math.max(s[1], y)] : [y, y];
      (laneEnds[item] ??= { src: [], sink: [] })[role].push(y);
    };
    /** A splitter tree next to the bus already takes this item to the lift or the output, so the lane needn't. */
    const treeFeeds = (item: string, kind: 'lift' | 'out') => busTrees[fi].some((t) => t.item === item && t.users.some((x) => x.kind === kind));
    /**
     * The stretches of a lane that carry items, each running from where items get on toward where they get off:
     * down where something above feeds something below, up where something below feeds something above.
     */
    const laneRuns = (item: string) => {
      const e = laneEnds[item];
      if (!e) return [];
      const ys = [...new Set([...e.src, ...e.sink].map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b);
      const runs: { a: number; b: number; up: boolean }[] = [];
      for (let k = 0; k + 1 < ys.length; k++) {
        const [a, b] = [ys[k], ys[k + 1]];
        const down = e.src.some((v) => v <= a + 0.01) && e.sink.some((v) => v >= b - 0.01);
        const up = !down && e.src.some((v) => v >= b - 0.01) && e.sink.some((v) => v <= a + 0.01);
        if (!down && !up) continue;
        const last = runs[runs.length - 1];
        if (last && last.up === up && Math.abs(last.b - a) < 0.01) last.b = b;
        else runs.push({ a, b, up });
      }
      return runs;
    };

    let y = top;
    for (const s of rowsSpec) {
      // Rows line up on the left, or sit centred across the floor.
      const rowStart = rowX + (opt.center ? Math.round((maxRowLen - rowLen(s)) / 2) : 0);
      // Where a machine's port sits before any dragging (splitter trees keep to this grid).
      const homeIn = (k: number, j: number) => rowStart + k * s.pitch + (s.pitch - s.machine.w) / 2 + (s.machine.w * (j + 1)) / (s.inItems.length + 1);
      const row: Row = { id: s.id, x: rowStart, y, w: rowLen(s), h: rowH(s), recipe: s.recipe, machine: s.machine, count: s.count, clock: s.clock, inItems: s.inItems, outItems: s.outItems };
      rows.push(row);
      const bodyY = y + s.inH;
      const outY = bodyY + s.bodyH;
      const r = s.recipe;
      const perMachine = (amt: number) => (amt * 60) / r.time * (s.clock / 100);
      // Machines
      for (let k = 0; k < s.count; k++) {
        const mv = opt.moves?.[`${s.id}:${k}`];
        const mx = rowStart + k * s.pitch + (s.pitch - s.machine.w) / 2 + (mv?.dx ?? 0);
        const my = bodyY + (s.bodyH - s.machine.l) / 2 + (mv?.dy ?? 0);
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
        if (band.lines) {
          // Direct lines: each comes in on its own lane (the leftmost block's lowest, so none cross) and drops into
          // an even splitter tree over just its block of machines.
          const k = band.lines.length;
          const rootY = y + band.top + 1 + k * LINE_GAP + 0.5;
          band.lines.forEach((l, slot) => {
            const laneY = y + band.top + 1 + (k - 1 - slot) * LINE_GAP;
            const block = rowMs.slice(l.to.start, l.to.start + l.to.n);
            const drop = adjacent(l) ? lineOut.get(l.id) : undefined;
            const entry = drop ? { x: drop.x, y: laneY } : { x: rowX - 1, y: laneY };
            if (drop) belts.push({ item, fluid: false, points: [drop, entry], rate: l.rate, hidden: hiddenManifold, kind: 'tree', ...transportName(item, l.rate) });
            else lineIn.set(l.id, entry);
            const lt = transportName(item, l.rate);
            const kind = slot === 0 ? 'manifold' : 'tree';
            const labelAt = { x: lastX, y: laneY };
            if (l.to.tree) {
              const x0 = homeIn(l.to.start, j);
              const map = (c: number, rr: number) => ({ x: x0 + c * s.pitch, y: rootY + rr * LEVEL });
              const top0 = map(l.to.tree.lay.col.get(0)!, 0);
              belts.push({ item, fluid: false, points: [entry, { x: top0.x, y: laneY }, top0], rate: l.rate, hidden: hiddenManifold, kind, labelAt, ...lt });
              drawTree(l.to.tree, map, (d) => block[d].inPorts[j], item, belts, markers);
            } else {
              const p = block[0].inPorts[j];
              belts.push({ item, fluid: false, points: [entry, { x: p.x, y: laneY }, p], rate: l.rate, hidden: hiddenManifold, kind, labelAt, ...lt });
            }
            if (lt.lanes > 1) beltWarnings.add(`Each ${itemName(item)} line into ${rowName(s)} carries ${r1(l.rate)}/min, more than one ${lt.tier} — unlock a faster belt or lower "Machines per row".`);
          });
          if (opt.logistics === 'underfloor') for (const m of rowMs) markers.push({ x: m.inPorts[j].x, y: m.inPorts[j].y - 1, kind: 'hole', item });
          return;
        }
        if (!balanced || isFluid(item)) {
          belts.push({ item, fluid: isFluid(item), points: [{ x: laneX[item], y: ly }, { x: lastX, y: ly }], rate, hidden: hiddenManifold, kind: 'manifold', ...t });
          touch(item, ly, 'sink');
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
          const x0 = homeIn(0, j);
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
        const band = s.outBands[j];
        const rate = perMachine(r.out[j][1]) * s.count;
        const t = transportName(item, rate);
        const row = ms.slice(-s.count);
        const lastX = row[row.length - 1].outPorts[j].x;
        // Balanced: just enough mergers. From the far end, the first merger takes 3 machines (odd counts) or 2, then
        // each next one takes the line plus 2 more. A single machine needs none.
        const mergeGroups = (list: PlacedMachine[]) => {
          const out: PlacedMachine[][] = [];
          const rev = [...list].reverse();
          let k = 0;
          if (rev.length > 1 && rev.length % 2 === 1) { out.push(rev.slice(0, 3)); k = 3; }
          for (; k < rev.length; k += 2) out.push(rev.slice(k, k + 2));
          return out;
        };
        const mergerX = (grp: PlacedMachine[]) => {
          const xs = grp.map((m) => m.outPorts[j].x);
          return grp.length === 1 ? xs[0] : (Math.min(...xs) + Math.max(...xs)) / 2;
        };
        const each = perMachine(r.out[j][1]);
        const feedTo = (pts: Pt[], m: PlacedMachine) => {
          belts.push({ item, fluid: isFluid(item), points: pts, rate: each, hidden: hiddenManifold, kind: 'feed', ...transportName(item, each) });
          if (opt.logistics === 'underfloor') markers.push({ x: m.outPorts[j].x, y: m.outPorts[j].y + 1, kind: 'hole', item });
        };
        const mergeOnto = (list: PlacedMachine[], ly: number) => {
          const gs = mergeGroups(list);
          for (const grp of gs) {
            const mx = mergerX(grp);
            if (list.length > 1) markers.push({ x: mx, y: ly, kind: 'merger', item });
            for (const m of grp) {
              const p = m.outPorts[j];
              feedTo(Math.abs(p.x - mx) < 0.01 ? [{ x: p.x, y: p.y }, { x: p.x, y: ly }] : [{ x: p.x, y: p.y }, { x: p.x, y: ly - 1.5 }, { x: mx, y: ly - 1.5 }, { x: mx, y: ly }], m);
            }
          }
          return { start: mergerX(gs[0]), end: mergerX(gs[gs.length - 1]) };
        };
        if (band.lines) {
          // Direct lines: each block of makers merges onto its own line (leftmost block nearest the machines, so
          // none cross). Into the very next row it drops straight down from its last merger; otherwise it leaves
          // for the gap, where it runs to the machines it feeds.
          band.lines.forEach((l, slot) => {
            const ly = outY + band.top + 1.5 + slot * LINE_GAP;
            const block = row.slice(l.from.start, l.from.start + l.from.n);
            const { start, end } = mergeOnto(block, ly);
            const lt = transportName(item, l.rate);
            const kind = slot === 0 ? 'manifold' : 'tree';
            if (adjacent(l)) {
              if (Math.abs(start - end) > 0.01) belts.push({ item, fluid: false, points: [{ x: start, y: ly }, { x: end, y: ly }], rate: l.rate, hidden: hiddenManifold, kind, labelAt: { x: lastX, y: ly }, ...lt });
              lineOut.set(l.id, { x: end, y: ly });
            } else {
              belts.push({ item, fluid: false, points: [{ x: start, y: ly }, { x: rowX - 1, y: ly }], rate: l.rate, hidden: hiddenManifold, kind, labelAt: { x: lastX, y: ly }, ...lt });
              lineOut.set(l.id, { x: rowX - 1, y: ly });
            }
          });
          return;
        }
        const ly = outY + band.top + 2;
        const grouped = balanced && !isFluid(item);
        const groups: PlacedMachine[][] = grouped ? mergeGroups(row) : [];
        // The line starts at the far-end merger (or the far machine), so nothing sticks out past it.
        const startX = grouped ? mergerX(groups[0]) : lastX;
        belts.push({ item, fluid: isFluid(item), points: [{ x: startX, y: ly }, { x: laneX[item], y: ly }], rate, hidden: hiddenManifold, kind: 'manifold', labelAt: { x: lastX, y: ly }, ...t });
        touch(item, ly, 'src');
        joins.push({ item, y: ly });
        const feed = (pts: Pt[], m: PlacedMachine) => {
          belts.push({ item, fluid: isFluid(item), points: pts, rate: perMachine(r.out[j][1]), hidden: hiddenManifold, kind: 'feed', ...transportName(item, perMachine(r.out[j][1])) });
          if (opt.logistics === 'underfloor') markers.push({ x: m.outPorts[j].x, y: m.outPorts[j].y + 1, kind: 'hole', item });
        };
        if (grouped) {
          for (const grp of groups) {
            const mx = mergerX(grp);
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
          const px = rowStart + k * s.pitch + Math.min(per, s.count - k) * s.pitch / 2;
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
        touch(item, portTop, 'src');
      }
      const outByTree = treeFeeds(item, 'out');
      if (item === target && fi === lastFloorFor(item)) {
        ports.push({ x: lane.x, y: portBottom, item, rate: plan.rate, dir: 'out', label: `OUT ${itemName(item)}${fi > 0 ? ' (lift to ground)' : ''}` });
        if (!outByTree) touch(item, portBottom, 'sink');
      }
      const extra = plan.also.find(([i]) => i === item);
      if (extra && item !== target && fi === lastFloorFor(item)) {
        ports.push({ x: lane.x, y: portBottom, item, rate: extra[1], dir: 'out', label: `OUT ${itemName(item)}${fi > 0 ? ' (lift to ground)' : ''}` });
        if (!outByTree) touch(item, portBottom, 'sink');
      }
      const sur = plan.surplus.find(([i]) => i === item);
      if (sur && item !== target && fi === lastFloorFor(item)) {
        ports.push({ x: lane.x, y: portBottom, item, rate: sur[1], dir: 'out', label: `SURPLUS ${itemName(item)}` });
        if (!outByTree) touch(item, portBottom, 'sink');
      }
      // Lifts where an item has to reach another floor.
      const otherMakers = [...(makers[item] ?? [])].some((f2) => f2 !== fi);
      const otherUsers = [...(usersOf[item] ?? [])].some((f2) => f2 !== fi);
      if ((usedHere && otherMakers && !madeHere) || (madeHere && otherUsers)) {
        const ly = top - 3;
        const up = madeHere ? [...usersOf[item]].some((f2) => f2 > fi) : [...makers[item]].some((f2) => f2 < fi);
        markers.push({ x: lane.x, y: ly, kind: 'lift', item, label: madeHere ? (up ? '↑' : '↓') : up ? '↑in' : '↓in' });
        // Coming in from another floor, the lift feeds the lane; going out, the lane (or a splitter tree) feeds it.
        if (!madeHere) touch(item, ly, 'src');
        else if (!treeFeeds(item, 'lift')) touch(item, ly, 'sink');
      }
    }
    // Direct lines: each has its own track in the gap; a line between floors goes up or down a lift there.
    for (const l of lines) {
      const a = lineOut.get(l.id);
      const b = lineIn.get(l.id);
      if ((!a && !b) || !trackOf.has(l.id)) continue;
      const tx = trackX0 + trackOf.get(l.id)! * TRACK;
      const liftY = top - 3;
      const tr = transportName(l.item, l.rate);
      if (a && b) belts.push({ item: l.item, fluid: false, points: [a, { x: tx, y: a.y }, { x: tx, y: b.y }, b], rate: l.rate, hidden: hiddenBus, kind: 'tree', ...tr });
      else {
        const up = (floorOf.get(l.to.rowId) ?? 0) > (floorOf.get(l.from.rowId) ?? 0);
        markers.push({ x: tx, y: liftY, kind: 'lift', item: l.item, label: a ? (up ? '↑' : '↓') : up ? '↑in' : '↓in' });
        belts.push({ item: l.item, fluid: false, points: a ? [a, { x: tx, y: a.y }, { x: tx, y: liftY }] : [{ x: tx, y: liftY }, { x: tx, y: b!.y }, b!], rate: l.rate, hidden: hiddenBus, kind: 'tree', ...tr });
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
        touch(bt.item, root.y, 'sink');
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
        touch(en.item, en.pt.y, 'sink');
        takes.push({ item: en.item, y: en.pt.y });
      }
    }

    const runsOf = new Map(lanes.map((l) => [l.item, laneRuns(l.item)]));
    for (const lane of lanes) {
      const rate = flowRate(lane.item);
      for (const r of runsOf.get(lane.item)!) {
        const pts = [{ x: lane.x, y: r.a }, { x: lane.x, y: r.b }];
        belts.push({ item: lane.item, fluid: lane.fluid, points: r.up ? pts.reverse() : pts, rate, hidden: hiddenBus, kind: 'bus', ...transportName(lane.item, rate) });
      }
    }
    // Where a row's output joins a lane: a merger if items already arrive along the lane, a splitter if it heads
    // both ways from there. Where a row takes from a lane that carries on past it: a splitter.
    const flowAt = (item: string, y: number) => {
      let into = 0, away = 0;
      for (const r of runsOf.get(item) ?? []) {
        const [from, to] = r.up ? [r.b, r.a] : [r.a, r.b];
        if (Math.abs(to - y) < 0.02) into++;
        else if (Math.abs(from - y) < 0.02) away++;
        else if (y > r.a && y < r.b) { into++; away++; } // the lane runs on past it
      }
      return { into, away };
    };
    for (const j of joins) {
      const { into, away } = flowAt(j.item, j.y);
      const kind = into > 0 ? 'merger' : away > 1 ? 'splitter' : null;
      if (kind) markers.push({ x: laneX[j.item], y: j.y, kind: isFluid(j.item) ? 'junction' : kind, item: j.item });
    }
    for (const t of takes) if (flowAt(t.item, t.y).away > 0) markers.push({ x: laneX[t.item], y: t.y, kind: 'splitter', item: t.item });

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
    for (const b of belts) b.points = squareOff(b.points);
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
    if (lines.length) {
      const byItem = new Map<string, Line[]>();
      for (const l of lines) byItem.set(l.item, [...(byItem.get(l.item) ?? []), l]);
      const desc = [...byItem.entries()].map(([item, ls]) => {
        const kinds = [...new Set(ls.map((l) => `${l.from.n}→${l.to.n}`))];
        return `${itemName(item)}: ${ls.length} line${ls.length === 1 ? '' : 's'} (${kinds.join(', ')} machines each)`;
      });
      notes.push(`Direct lines (no bus): each line merges a few makers and splits evenly to a few users, so every machine gets its share with the fewest mergers and splitters — ${desc.join('; ')}.`);
    }
    notes.push('Balanced feeds: rows are fed through splitter trees drawn above them, and a bus belt that feeds several rows is shared out by a sideways splitter tree next to the bus — every machine gets its share from the first minute, so nothing has to back up first. Dashed belts loop spare splitter outputs back into the merger above them.');
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
