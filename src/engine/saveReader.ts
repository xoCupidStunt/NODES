import { Parser } from '@etothepii/satisfactory-file-parser';

/** What N.O.D.E.S needs from a Satisfactory save. Plain data, so it can cross from the worker. */
export interface SaveSummary {
  sessionName: string;
  saveName: string;
  /** When the game wrote the save (ms since epoch), or null if unknown. */
  savedAt: number | null;
  playSeconds: number;
  /** Class names of every purchased schematic (milestones, MAM research, alternates, ...). */
  purchased: string[];
  /** Resource node ids that already have a miner, pump or extractor on them. */
  occupied: string[];
  shards: { total: number; slotted: number };
  sloops: { total: number; slotted: number };
}

const SHARD = 'Desc_CrystalShard_C';
const SLOOP = 'Desc_WAT1_C';

const tail = (path: string) => path.split('.').pop() ?? path;

// The parser's object types are loose; read properties defensively.
type Obj = { typePath: string; instanceName: string; properties?: Record<string, any> };

function prop(o: Obj, name: string): any {
  const p = o.properties?.[name];
  return Array.isArray(p) ? p[0] : p;
}

/** Parse a .sav file and pull out progression, occupied nodes and shard/somersloop counts. */
export function readSave(bytes: ArrayBuffer, fileName: string, onProgress?: (p: number) => void): SaveSummary {
  const save = Parser.ParseSave(fileName.replace(/\.sav$/i, ''), bytes, {
    throwErrors: false,
    onProgressCallback: (p: number) => onProgress?.(p),
  });
  const objects: Obj[] = [];
  for (const level of Object.values(save.levels as Record<string, { objects: Obj[] }>)) objects.push(...level.objects);

  const purchased = new Set<string>();
  const occupied = new Set<string>();
  const shards = { total: 0, slotted: 0 };
  const sloops = { total: 0, slotted: 0 };

  for (const o of objects) {
    if (o.typePath.includes('BP_SchematicManager')) {
      for (const v of prop(o, 'mPurchasedSchematics')?.values ?? []) if (v?.pathName) purchased.add(tail(v.pathName));
    }

    const res = prop(o, 'mExtractableResource')?.value?.pathName;
    if (typeof res === 'string' && res) occupied.add(tail(res));

    const stacks = prop(o, 'mInventoryStacks')?.values;
    if (Array.isArray(stacks)) {
      const slotted = /InventoryPotential/i.test(o.instanceName);
      for (const st of stacks) {
        const item = st?.properties?.Item?.value?.itemReference?.pathName;
        const n = st?.properties?.NumItems?.value ?? 0;
        if (!item || !n) continue;
        const id = tail(item);
        const bucket = id === SHARD ? shards : id === SLOOP ? sloops : null;
        if (!bucket) continue;
        bucket.total += n;
        if (slotted) bucket.slotted += n;
      }
    }

    // Dimensional Depot (central storage) keeps its own item list.
    const stored = prop(o, 'mStoredItems')?.values;
    if (Array.isArray(stored)) {
      for (const st of stored) {
        const ps = st?.properties ?? {};
        const item = (ps.ItemClass ?? ps.Item)?.value?.pathName ?? (ps.ItemClass ?? ps.Item)?.value?.itemReference?.pathName;
        const n = (ps.Amount ?? ps.NumItems)?.value ?? 0;
        if (!item || !n) continue;
        const id = tail(item);
        if (id === SHARD) shards.total += n;
        if (id === SLOOP) sloops.total += n;
      }
    }
  }

  const h = save.header as { sessionName?: string; saveName?: string; saveDateTime?: string | number; playDurationSeconds?: number };
  return {
    sessionName: h.sessionName ?? sessionFromFile(fileName),
    saveName: h.saveName ?? fileName,
    savedAt: ticksToMs(h.saveDateTime),
    playSeconds: h.playDurationSeconds ?? 0,
    purchased: [...purchased],
    occupied: [...occupied],
    shards,
    sloops,
  };
}

/** The parser gives save time in ms; older versions gave raw .NET ticks (100 ns since year 1). */
function ticksToMs(v: string | number | undefined): number | null {
  if (v === undefined || v === null) return null;
  try {
    const n = BigInt(v);
    const ms = n < 10n ** 14n ? Number(n) : Number(n / 10000n - 62135596800000n);
    return ms > 0 && ms < 4e12 ? ms : null;
  } catch {
    return null;
  }
}

/** "My World_autosave_2.sav" / "My World_301026-163923.sav" → "My World". */
export function sessionFromFile(name: string) {
  return name
    .replace(/\.sav$/i, '')
    .replace(/_autosave_\d+$/i, '')
    .replace(/_(continue|quicksave|autosave)$/i, '')
    .replace(/_\d{6}-\d{6}$/, '');
}
