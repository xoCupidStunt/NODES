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
