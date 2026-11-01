import { FOUNDATION as F, isFluid, itemName, type Machine, type Recipe } from '../data/game';
import type { Plan } from './plan';
import { availableBelts, availablePipes } from './progression';
import type { SchematicOptions } from './types';

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
export interface Marker { x: number; y: number; kind: 'splitter' | 'merger' | 'junction' | 'lift' | 'hole' | 'pole'; item?: string; label?: string }
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
}
export interface BOMLine { name: string; count: number; unit?: string }
export interface Schematic {
  floors: Floor[];
  width: number; height: number; // metres, same for all floors
  lanes: { item: string; x: number; fluid: boolean }[];
  bom: BOMLine[];
  notes: string[];
}

const LANE = 3; // metres between bus lanes
const STRIP_LANE = 4; // metres per manifold lane

function snap(v: number, mode: SchematicOptions['snap']) {
  const step = mode === 'full' ? F : mode === 'half' ? F / 2 : 1;
  return Math.ceil(v / step - 1e-9) * step;
}
const toF = (m: number) => Math.ceil(m / F - 1e-9) * F;

export function buildSchematic(plan: Plan, opt: SchematicOptions, target: string): Schematic {
  const notes: string[] = [];
  const u = plan.unlocks;
  const belt = availableBelts(u).at(-1)!;
  const pipe = availablePipes(u).at(-1)!;
  const hiddenManifold = opt.logistics !== 'visible';
  const hiddenBus = opt.logistics !== 'visible';

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

  // ---- bus lanes: one per item that moves between rows or crosses the factory edge ----
  const laneItems: string[] = [];
  const addLane = (i: string) => { if (!laneItems.includes(i)) laneItems.push(i); };
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

  const floors: Floor[] = [];
  floorSpecs.forEach((rowsSpec, fi) => {
    const rows: Row[] = [];
    const ms: PlacedMachine[] = [];
    const belts: BeltPath[] = [];
    const markers: Marker[] = [];
    const ports: Port[] = [];
    const walls: WallSeg[] = [];
    const laneSpan: Record<string, [number, number]> = {};
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
        markers.push({ x: laneX[item], y: ly, kind: isFluid(item) ? 'junction' : 'splitter', item });
        for (const m of ms.slice(-s.count)) {
          const p = m.inPorts[j];
          markers.push({ x: p.x, y: ly, kind: isFluid(item) ? 'junction' : 'splitter', item });
          belts.push({ item, fluid: isFluid(item), points: [{ x: p.x, y: ly }, { x: p.x, y: p.y }], rate: perMachine(r.in[j][1]), hidden: hiddenManifold, kind: 'feed', ...transportName(item, perMachine(r.in[j][1])) });
          if (opt.logistics === 'underfloor') markers.push({ x: p.x, y: p.y - 1, kind: 'hole', item });
        }
      });
      // Output manifolds back to the bus.
      s.outItems.forEach((item, j) => {
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
    floors.push({ index: fi, width, height, storeyHeight, rows, machines: ms, belts, markers, ports, walls, bus: { x: busX, w: busW } });
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

  if (opt.logistics === 'underfloor') notes.push('Belts and pipes run on a service level 1 wall (4 m) below each floor and come up through Conveyor Floor Holes at every machine port.');
  if (opt.logistics === 'walls') notes.push('The bus runs in a walled service corridor; manifolds sit behind low walls with Conveyor Wall Holes at each machine.');
  if (lanes.some((l) => l.fluid) && pipe) notes.push(`Pipes shown as double lines (${pipe.name}, ${pipe.rate} m³/min max). Mind pump head lift on upper floors.`);
  notes.push(`Belts sized from what you have unlocked (best: ${belt.name}, ${belt.rate}/min). Labels like “×2” mean parallel lines.`);
  notes.push('Machine input/output port positions are approximate — check each machine’s arrows in game and flip the row if needed.');

  return { floors, width, height, lanes, bom, notes };
}
