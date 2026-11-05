import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodes } from '../../data/game';
import { readSave, sessionFromFile } from '../saveReader';
import { gameSyncFromSave, progressFromSave } from '../saveSync';

describe('save file names', () => {
  it('finds the session name', () => {
    expect(sessionFromFile('Project Make it Worse_autosave_1.sav')).toBe('Project Make it Worse');
    expect(sessionFromFile('Project Make it Worse_301026-163923.sav')).toBe('Project Make it Worse');
    expect(sessionFromFile('Project Make it Worse_101026-005500_continue.sav')).toBe('Project Make it Worse');
    expect(sessionFromFile('My_World.sav')).toBe('My_World');
  });
});

describe('progress from a save', () => {
  it('sorts schematics and sets the tier from milestones', () => {
    const p = progressFromSave({
      sessionName: 's', saveName: 's', savedAt: null, playSeconds: 0, occupied: [],
      purchased: ['Schematic_1-1_C', 'Schematic_3-1_C', 'Research_Caterium_0_C', 'Schematic_Alternate_PureIronIngot_C', 'ResourceSink_Ladders_C'],
      shards: { total: 5, slotted: 2 }, sloops: { total: 1, slotted: 0 },
      layout: { machines: [], extractors: [], labels: [] },
    });
    expect(p.tier).toBe(3);
    expect(p.milestones).toEqual(['Schematic_1-1_C', 'Schematic_3-1_C']);
    expect(p.mam).toEqual(['Research_Caterium_0_C']);
    expect(p.alts).toEqual(['Schematic_Alternate_PureIronIngot_C']);
    expect(p.shards).toBe(5);
  });
});

// Reads a real save when one is on this machine (skipped elsewhere, e.g. CI).
const dir = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'FactoryGame', 'Saved', 'SaveGames') : '';
const realSave = (() => {
  if (!dir || !existsSync(dir)) return null;
  const files: string[] = [];
  for (const d of readdirSync(dir)) {
    const p = join(dir, d);
    if (statSync(p).isDirectory()) for (const f of readdirSync(p)) if (f.endsWith('.sav')) files.push(join(p, f));
  }
  return files.filter((f) => statSync(f).size > 1024).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
})();

describe.skipIf(!realSave)('real save', () => {
  it('reads progression and occupied nodes', () => {
    const buf = readFileSync(realSave!);
    const s = readSave(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), realSave!);
    const p = progressFromSave(s);
    expect(s.sessionName.length).toBeGreaterThan(0);
    expect(p.milestones.length).toBeGreaterThan(0);
    const g = gameSyncFromSave(s, null, 'file');
    const ids = new Set(nodes.map((n) => n.id));
    expect(g.occupied.length).toBeGreaterThan(0);
    expect(g.occupied.every((id) => ids.has(id))).toBe(true);
  }, 60000);
});

describe.skipIf(!realSave)('factories in a real save', () => {
  it('finds connected factories with a product and rate', async () => {
    const { detectFactories } = await import('../gameFactories');
    const { computeUnlocks } = await import('../progression');
    const buf = readFileSync(realSave!);
    const s = readSave(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), realSave!);
    const found = detectFactories(s.layout, computeUnlocks(progressFromSave(s)));
    if (process.env.SHOW_FACTORIES) {
      for (const f of found) console.log(`${f.machines}\t${f.name}\t${f.target} ${f.rate}/min\tnodes ${f.nodes.length}\textra ${JSON.stringify(f.extraSupply)}\t${f.built.power} MW`);
    }
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) expect(f.rate).toBeGreaterThan(0);
  }, 60000);
});

describe.skipIf(!realSave)('combine and separate with a real save', () => {
  it('splits by distance, merges, and round-trips planner factories', async () => {
    const { noRules, factoryFromFound } = await import('../gameFactories');
    const g = await import('../grouping');
    const buf = readFileSync(realSave!);
    const s = readSave(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), realSave!);
    const progress = progressFromSave(s);
    const game = gameSyncFromSave(s, null, 'file');
    const base = { factories: [] as import('../types').Factory[], game, progress, groupRules: noRules };
    const found = g.foundOf(base);
    const big = found[0];

    // Separate the biggest found factory.
    const split = g.foundOf({ ...base, groupRules: g.separateFound(noRules, big.key, 100) });
    const parts = split.filter((ff) => ff.origin?.kind === 'split');
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.reduce((a, p) => a + p.machines, 0)).toBe(big.machines);
    // Undo puts it back.
    const undone = g.foundOf({ ...base, groupRules: g.undoFound(g.separateFound(noRules, big.key, 100), parts[0]) });
    expect(undone.length).toBe(found.length);

    // Combine the next two.
    const merged = g.foundOf({ ...base, groupRules: g.combineFound(noRules, [found[1].key, found[2].key]) });
    expect(merged.length).toBe(found.length - 1);
    expect(merged.find((ff) => ff.origin?.kind === 'merged')!.machines).toBe(found[1].machines + found[2].machines);

    // Planner: add two found factories, combine them, then separate again.
    const make = (n: number) => ({
      id: 'f' + n + Math.random(), name: `F${n}`, target: '', rate: 1, mode: 'power' as const, placement: 'manual' as const, location: null,
      nodes: [], extraSupply: {}, also: [], imports: [], excluded: [], unlimitedRaw: false, clockCap: 100, useShards: false,
      schematic: { machineGap: 0, rowGap: 1, floors: 1, maxPerRow: 10, logistics: 'visible' as const, perimeterWalls: true, border: 1, snap: 'half' as const, showLabels: true, showRates: true, showPower: true, orientation: 'auto' as const, distribution: 'balanced' as const },
      createdAt: 0,
    });
    const a = { ...make(1), ...factoryFromFound(found[1]) };
    const b = { ...make(2), ...factoryFromFound(found[2]) };
    const st1 = { ...base, factories: [a, b] };
    const c = g.combineFactories(st1, [a.id, b.id]);
    expect(c.factories.length).toBe(1);
    expect(c.factories[0].game!.machineIds.length).toBe(found[1].machines + found[2].machines);
    const st2 = { ...st1, ...c };
    const linkedNow = g.refreshLinked(st2.factories, g.foundOf(st2));
    expect(linkedNow[0].game!.missing).toBeFalsy();
    const sep = g.separateFactory({ ...st2, factories: linkedNow }, linkedNow[0].id, 100, make);
    expect(sep.factories.length).toBeGreaterThan(1);
  }, 60000);
});

describe.skipIf(!realSave)('generators in a real save', () => {
  it('counts the power factories make', async () => {
    const g = await import('../grouping');
    const { noRules } = await import('../gameFactories');
    const buf = readFileSync(realSave!);
    const s = readSave(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), realSave!);
    const found = g.foundOf({ game: gameSyncFromSave(s, null, 'file'), progress: progressFromSave(s), groupRules: noRules });
    const power = found.reduce((a, ff) => a + (ff.built.outputs.find(([i]) => i === 'Desc_Power_C')?.[1] ?? 0), 0);
    if (process.env.SHOW_FACTORIES) for (const ff of found.filter((x) => x.built.outputs.some(([i]) => i === 'Desc_Power_C'))) console.log(`POWER ${ff.name} | main ${ff.target} | ${ff.built.outputs.map(([i, v]) => `${v} ${i}`).join(', ')} | ${ff.machines} machines`);
    expect(power).toBeGreaterThan(0);
  }, 60000);
});

describe.skipIf(!realSave)('outside supply in a real save', () => {
  it('never lists items a factory makes itself as coming from outside', async () => {
    const g = await import('../grouping');
    const { noRules, madeInside } = await import('../gameFactories');
    const buf = readFileSync(realSave!);
    const s = readSave(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), realSave!);
    const found = g.foundOf({ game: gameSyncFromSave(s, null, 'file'), progress: progressFromSave(s), groupRules: noRules });
    for (const ff of found) {
      const made = madeInside(ff.built);
      expect(Object.keys(ff.extraSupply).filter((i) => made.has(i))).toEqual([]);
    }
  }, 60000);
});
