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
  /** Built production, for finding existing factories. */
  layout: SaveLayout;
}

/** Machines and extractors with the belt/pipe network they belong to. */
export interface SaveLayout {
  machines: { id: string; recipe: string; clock: number; boost: number; x: number; y: number; net: string }[];
  extractors: { id: string; node: string; clock: number; net: string }[];
  /** Map markers and train stations, to name factories. */
  labels: { name: string; x: number; y: number; kind: 'marker' | 'station' }[];
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

  // Belt and pipe links: union every building with what it's connected to (hypertubes don't count).
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (c !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const owner = (path: string) => path.slice(0, path.lastIndexOf('.'));
  const positions = new Map<string, { x: number; y: number }>();
  const layout: SaveLayout = { machines: [], extractors: [], labels: [] };
  const stationNames: { name: string; station: string }[] = [];

  for (const o of objects) {
    const linked = prop(o, 'mConnectedComponent')?.value?.pathName;
    if (typeof linked === 'string' && linked && !o.typePath.includes('Hyper')) {
      union((o as { parentEntityName?: string }).parentEntityName || owner(o.instanceName), owner(linked));
    }
    const t = (o as { transform?: { translation: { x: number; y: number } } }).transform?.translation;
    if (t && o.typePath.includes('TrainStation')) positions.set(o.instanceName, { x: t.x, y: t.y });

    const recipe = prop(o, 'mCurrentRecipe')?.value?.pathName;
    if (typeof recipe === 'string' && recipe && t) {
      layout.machines.push({
        id: o.instanceName,
        recipe: tail(recipe),
        clock: prop(o, 'mCurrentPotential')?.value ?? 1,
        boost: prop(o, 'mCurrentProductionBoost')?.value ?? 0,
        x: t.x,
        y: t.y,
        net: '',
      });
    }
    const station = prop(o, 'mStationName')?.value;
    const stationRef = prop(o, 'mStation')?.value?.pathName;
    if (station && stationRef) stationNames.push({ name: String(station.value ?? station), station: stationRef });

    if (o.typePath.includes('BP_MapManager')) {
      for (const m of prop(o, 'mMapMarkers')?.values ?? []) {
        const ps = m?.properties ?? {};
        const loc = ps.Location?.value?.properties;
        const name = ps.Name?.value;
        if (String(ps.MapMarkerType?.value?.value ?? '').includes('Stamp')) continue; // icon stamps, not named places
        if (loc &&typeof name === 'string' && name.trim()) layout.labels.push({ name: name.trim(), x: loc.X?.value ?? 0, y: loc.Y?.value ?? 0, kind: 'marker' });
      }
    }

    if (o.typePath.includes('BP_SchematicManager')) {
      for (const v of prop(o, 'mPurchasedSchematics')?.values ?? []) if (v?.pathName) purchased.add(tail(v.pathName));
    }

    const res = prop(o, 'mExtractableResource')?.value?.pathName;
    if (typeof res === 'string' && res) {
      occupied.add(tail(res));
      layout.extractors.push({ id: o.instanceName, node: tail(res), clock: prop(o, 'mCurrentPotential')?.value ?? 1, net: '' });
    }

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

  for (const m of layout.machines) m.net = find(m.id);
  for (const e of layout.extractors) e.net = find(e.id);
  for (const s of stationNames) {
    const at = positions.get(s.station);
    if (at && s.name.trim()) layout.labels.push({ name: s.name.trim(), ...at, kind: 'station' });
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
    layout,
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
