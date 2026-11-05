import { describe, expect, it } from 'vitest';
import { evenBalancer, evenSplit, isSmooth, ratioBalancer, ratioSplit, smoothAtLeast } from '../balance';

describe('balancers', () => {
  it('knows which counts split evenly with splitters alone', () => {
    expect([1, 2, 3, 4, 6, 8, 9, 12, 16, 18, 24, 27].every(isSmooth)).toBe(true);
    expect([5, 7, 10, 11, 13, 14, 15].some(isSmooth)).toBe(false);
    expect(smoothAtLeast(10)).toBe(12);
    expect(smoothAtLeast(5)).toBe(6);
  });

  it('builds exact trees and loop-backs', () => {
    expect(evenSplit(6)).toMatchObject({ size: 6, stages: [3, 2], splitters: 4, loopBack: 0, mergers: 0 });
    // 10 machines: a 1→12 tree (3-way, then 2-way, then 2-way) with 2 outputs looped back through 1 merger.
    expect(evenSplit(10)).toMatchObject({ size: 12, stages: [3, 2, 2], splitters: 1 + 3 + 6, loopBack: 2, mergers: 1 });
    expect(evenSplit(10).beltLoad).toBeCloseTo(1.2);
    expect(evenSplit(1).splitters).toBe(0);
  });

  it('splits by ratio', () => {
    const equal = ratioSplit([5, 5, 5]);
    expect(equal).toMatchObject({ parts: 3, shares: [1, 1, 1], error: 0 });
    const r = ratioSplit([10, 7]); // 10:7 → 12 parts as 7 + 5, within 2 %
    expect(r.parts).toBe(12);
    expect(r.shares).toEqual([7, 5]);
    expect(r.error).toBeLessThanOrEqual(0.02);
    expect(ratioSplit([2, 1])).toMatchObject({ parts: 3, shares: [2, 1], error: 0, joinMergers: 1 });
  });
});

describe('balanced schematic', () => {
  it('gives each row an even tree and shares the bus between rows', async () => {
    const { buildPlan } = await import('../plan');
    const { buildSchematic } = await import('../schematic');
    const { milestonesUpTo } = await import('../progression');
    const { defaultSchematic } = await import('../types');
    const f = {
      id: 'a', name: 'T', target: 'Desc_IronIngot_C', rate: 900, mode: 'power' as const, placement: 'manual' as const, location: null,
      nodes: [], extraSupply: {}, also: [], imports: [], excluded: [], unlimitedRaw: true, clockCap: 100, useShards: false,
      schematic: { ...defaultSchematic }, createdAt: 0,
    };
    const plan = buildPlan(f, { tier: 4, milestones: milestonesUpTo(4), mam: [], alts: [], shards: 0, sloops: 0 });
    const sch = buildSchematic(plan, { ...defaultSchematic, maxPerRow: 10 }, f.target);
    const fl = sch.floors[0];
    const splitters = sch.bom.find((x) => x.name === 'Conveyor Splitters')!.count;
    expect(splitters).toBe(3 * 7 + 1); // three 1:10 trees + one 3-way split of the bus
    // Each row's tree is drawn in that row's input strip, above its machines.
    for (const row of fl.rows) {
      const top = Math.min(...fl.machines.filter((m) => m.rowId === row.id).map((m) => m.y));
      const inRow = fl.markers.filter((m) => m.kind === 'splitter' && m.x >= row.x - 1 && m.x <= row.x + row.w + 1 && m.y > row.y && m.y < top);
      expect(inRow).toHaveLength(7);
    }
    // The bus split sits in the gap between the bus and the rows.
    const gap = fl.markers.filter((m) => m.kind === 'splitter' && fl.bus && m.x > fl.bus.x + fl.bus.w && m.x < fl.rows[0].x);
    expect(gap).toHaveLength(1);
    // Loop-backs are drawn (2 per 1:10 tree), and every machine's input is reached by a tree belt.
    expect(fl.belts.filter((x) => x.loop)).toHaveLength(6);
    for (const m of fl.machines) {
      const p = m.inPorts[0];
      expect(fl.belts.some((x) => x.kind === 'tree' && x.points.some((q) => Math.abs(q.x - p.x) < 0.01 && Math.abs(q.y - p.y) < 0.01))).toBe(true);
    }

    const manifold = buildSchematic(plan, { ...defaultSchematic, maxPerRow: 10, distribution: 'manifold' }, f.target);
    expect(manifold.floors[0].belts.some((x) => x.kind === 'tree')).toBe(false);
    expect(manifold.notes.join(' ')).toMatch(/back up/);
  });
});

describe('balancer layouts', () => {
  const outRates = (g: ReturnType<typeof evenBalancer>) =>
    g.nodes.filter((n) => n.kind === 'out').map((n) => g.edges.filter((e) => e.to === n.id).reduce((a, e) => a + e.rate, 0));
  it('matches the standard designs', () => {
    expect(evenBalancer(8, 80)).toMatchObject({ splitters: 7, mergers: 0 });
    expect(evenBalancer(6, 60)).toMatchObject({ splitters: 3, mergers: 0 });
    expect(evenBalancer(5, 50)).toMatchObject({ splitters: 3, mergers: 1, maxRate: 60 }); // 1:6 with 1 looped back
    expect(evenBalancer(7, 70)).toMatchObject({ splitters: 7, mergers: 1 }); // 1:8 with 1 looped back
    expect(evenBalancer(10, 100)).toMatchObject({ splitters: 7, mergers: 2 }); // split in two, then 1:5 each
    for (const n of [5, 7, 10, 11, 13, 14, 15, 17, 30]) {
      const r = outRates(evenBalancer(n, n * 10));
      expect(r).toHaveLength(n);
      for (const v of r) expect(v).toBeCloseTo(10, 6);
    }
  });
  it('gives whole branches to one belt instead of splitting and merging back', () => {
    const g = ratioBalancer([7, 5], 120);
    expect(g).toMatchObject({ splitters: 3, mergers: 2 });
    const r = outRates(g);
    expect(r[0]).toBeCloseTo(70);
    expect(r[1]).toBeCloseTo(50);
  });
});

describe('direct lines between machine types', () => {
  const build = async (target: string, rate: number, perRow = 12) => {
    const { buildPlan } = await import('../plan');
    const { buildSchematic } = await import('../schematic');
    const { milestonesUpTo } = await import('../progression');
    const { defaultSchematic } = await import('../types');
    const f = {
      id: 'a', name: 'T', target, rate, mode: 'power' as const, placement: 'manual' as const, location: null,
      nodes: [], extraSupply: {}, also: [], imports: [], excluded: [], unlimitedRaw: true, clockCap: 100, useShards: false,
      schematic: { ...defaultSchematic }, createdAt: 0,
    };
    const plan = buildPlan(f, { tier: 4, milestones: milestonesUpTo(4), mam: [], alts: [], shards: 0, sloops: 0 });
    return { plan, sch: buildSchematic(plan, { ...defaultSchematic, maxPerRow: perRow }, target) };
  };
  const ingot = 'Desc_IronIngot_C';

  it('feeds each constructor straight from a smelter when the counts match (no merging or splitting)', async () => {
    const { plan, sch } = await build('Desc_IronPlate_C', 200); // 10 smelters → 10 constructors
    expect(plan.groups.map((g) => g.count).sort()).toEqual([10, 10]);
    const fl = sch.floors[0];
    expect(sch.lanes.some((l) => l.item === ingot)).toBe(false); // ingots skip the bus
    expect(fl.markers.filter((m) => m.item === ingot && (m.kind === 'splitter' || m.kind === 'merger'))).toHaveLength(0);
    expect(sch.notes.join(' ')).toMatch(/Iron Ingot: 10 lines \(1→1 machines each\)/);
  });

  it('splits each smelter 1:2 when one smelter feeds two constructors', async () => {
    const { plan, sch } = await build('Desc_IronRod_C', 150); // 5 smelters → 10 constructors
    expect(plan.groups.map((g) => g.count).sort((a, b) => a - b)).toEqual([5, 10]);
    const fl = sch.floors[0];
    expect(fl.markers.filter((m) => m.item === ingot && m.kind === 'splitter')).toHaveLength(5);
    expect(fl.markers.filter((m) => m.item === ingot && m.kind === 'merger')).toHaveLength(0);
    expect(sch.notes.join(' ')).toMatch(/Iron Ingot: 5 lines \(1→2 machines each\)/);
  });

});

describe('moving machines on the schematic', () => {
  const setup = async () => {
    const { buildPlan } = await import('../plan');
    const { buildSchematic } = await import('../schematic');
    const { milestonesUpTo } = await import('../progression');
    const { defaultSchematic } = await import('../types');
    const f = {
      id: 'a', name: 'T', target: 'Desc_IronRod_C', rate: 150, mode: 'power' as const, placement: 'manual' as const, location: null,
      nodes: [], extraSupply: {}, also: [], imports: [], excluded: [], unlimitedRaw: true, clockCap: 100, useShards: false,
      schematic: { ...defaultSchematic }, createdAt: 0,
    };
    const plan = buildPlan(f, { tier: 4, milestones: milestonesUpTo(4), mam: [], alts: [], shards: 0, sloops: 0 });
    return { build: (o: object) => buildSchematic(plan, { ...defaultSchematic, ...o }, f.target), defaultSchematic };
  };
  const straight = (pts: { x: number; y: number }[]) => pts.every((p, k) => k === 0 || Math.abs(p.x - pts[k - 1].x) < 0.01 || Math.abs(p.y - pts[k - 1].y) < 0.01);

  it('moves a dragged machine and keeps every belt straight-run and connected', async () => {
    const { build } = await setup();
    const before = build({});
    const m0 = before.floors[0].machines.find((m) => m.recipe.name === 'Iron Rod')!;
    const after = build({ moves: { [m0.id]: { dx: 8, dy: 4 } } });
    const m1 = after.floors[0].machines.find((m) => m.id === m0.id)!;
    expect(m1.x).toBeCloseTo(m0.x + 8);
    expect(m1.y).toBeCloseTo(m0.y + 4);
    for (const b of after.floors[0].belts) expect(straight(b.points)).toBe(true);
    const p = m1.inPorts[0];
    expect(after.floors[0].belts.some((b) => b.points.some((q) => Math.abs(q.x - p.x) < 0.01 && Math.abs(q.y - p.y) < 0.01))).toBe(true);
  });

  it('centres short rows when asked', async () => {
    const { build } = await setup();
    const left = build({});
    const mid = build({ center: true });
    const short = (s: typeof left) => s.floors[0].rows.reduce((a, r) => (r.w < a.w ? r : a));
    const wide = (s: typeof left) => s.floors[0].rows.reduce((a, r) => (r.w > a.w ? r : a));
    expect(short(mid).x).toBeGreaterThan(short(left).x);
    expect(short(mid).x + short(mid).w / 2).toBeCloseTo(wide(mid).x + wide(mid).w / 2, 0);
  });
});
