import { nodes, schematicsById } from '../data/game';
import type { Progress } from './progression';
import type { SaveLayout, SaveSummary } from './saveReader';

const nodeIds = new Set(nodes.map((n) => n.id));

/** What the app remembers about the last save it synced. */
export interface GameSync {
  sessionName: string;
  saveName: string;
  savedAt: number | null;
  syncedAt: number;
  /** File modified time of the synced save, to spot newer saves. */
  fileModified: number | null;
  /** "folder" when it came from the watched folder, "file" for a one-off import. */
  source: 'folder' | 'file';
  /** Node ids with a miner/pump/extractor in the game. */
  occupied: string[];
  shards: { total: number; slotted: number };
  sloops: { total: number; slotted: number };
  /** Production machines, extractors and labels — factories are worked out from these. */
  layout: SaveLayout;
}

/** Progress as recorded in the save. Shards and somersloops are the totals owned (slotted + spare). */
export function progressFromSave(s: SaveSummary): Progress {
  const milestones: string[] = [];
  const mam: string[] = [];
  const alts: string[] = [];
  let tier = 0;
  for (const id of s.purchased) {
    const sch = schematicsById[id];
    if (!sch) continue;
    if (sch.type === 'milestone') {
      milestones.push(id);
      tier = Math.max(tier, sch.tier);
    } else if (sch.type === 'mam') mam.push(id);
    else if (sch.type === 'alt') alts.push(id);
  }
  return { tier, milestones, mam, alts, shards: s.shards.total, sloops: s.sloops.total };
}

export function gameSyncFromSave(s: SaveSummary, fileModified: number | null, source: GameSync['source']): GameSync {
  return {
    sessionName: s.sessionName,
    saveName: s.saveName,
    savedAt: s.savedAt,
    syncedAt: Date.now(),
    fileModified,
    source,
    // Only map nodes (water extractors point at lakes, not nodes).
    occupied: s.occupied.filter((id) => nodeIds.has(id)),
    shards: s.shards,
    sloops: s.sloops,
    layout: s.layout,
  };
}

/** Short "what changed" text for the sync status line. */
export function describeChange(before: Progress, after: Progress) {
  const parts: string[] = [];
  const added = (a: string[], b: string[]) => b.filter((x) => !a.includes(x)).length;
  const m = added(before.milestones, after.milestones);
  const r = added(before.mam, after.mam);
  const al = added(before.alts, after.alts);
  if (after.tier !== before.tier) parts.push(`tier ${before.tier} → ${after.tier}`);
  if (m) parts.push(`+${m} milestone${m > 1 ? 's' : ''}`);
  if (r) parts.push(`+${r} research`);
  if (al) parts.push(`+${al} alternate${al > 1 ? 's' : ''}`);
  if (after.shards !== before.shards) parts.push(`${after.shards} shards`);
  if (after.sloops !== before.sloops) parts.push(`${after.sloops} somersloops`);
  return parts.length ? parts.join(', ') : 'no changes';
}
