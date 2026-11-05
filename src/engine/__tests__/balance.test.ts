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
    const rows = sch.balancing.filter((b) => b.where === 'row');
    expect(rows).toHaveLength(3);
    expect(rows[0].graph).toMatchObject({ splitters: 7, mergers: 2 }); // 10 machines: split in two, then 1:5 each
    expect(rows[0].id).toMatch(/^B[0-9]+$/);
    const bus = sch.balancing.find((b) => b.where === 'bus')!;
    expect(bus.graph.splitters).toBe(1); // three equal rows: one 3-way splitter
    expect(bus.steps.join(' ')).toMatch(/at least what it needs/);
    const splitters = sch.bom.find((b) => b.name === 'Conveyor Splitters')!.count;
    expect(splitters).toBe(3 * 7 + 1); // three 1:10 balancers + one 3-way bus split

    const manifold = buildSchematic(plan, { ...defaultSchematic, maxPerRow: 10, distribution: 'manifold' }, f.target);
    expect(manifold.balancing).toHaveLength(0);
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
