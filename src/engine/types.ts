import type { Mode } from './solver';

export interface SchematicOptions {
  /** Gap between machines in a row, metres. */
  machineGap: number;
  /** Extra foundations between production rows (walkways). */
  rowGap: number;
  /** Number of floors to spread the rows across. */
  floors: number;
  /** Max machines per row before wrapping into a new row. */
  maxPerRow: number;
  /** How belts and pipes are shown/hidden. */
  logistics: 'visible' | 'underfloor' | 'walls';
  perimeterWalls: boolean;
  /** Walkway ring (in foundations) inside the perimeter. */
  border: number;
  snap: 'none' | 'half' | 'full';
  showLabels: boolean;
  showRates: boolean;
  showPower: boolean;
}

export const defaultSchematic: SchematicOptions = {
  machineGap: 0,
  rowGap: 1,
  floors: 1,
  maxPerRow: 10,
  logistics: 'visible',
  perimeterWalls: true,
  border: 1,
  snap: 'half',
  showLabels: true,
  showRates: true,
  showPower: true,
};

export interface Import { factoryId: string; item: string; rate: number }

/** Machines running one recipe in a factory found in the save. */
export interface BuiltGroup {
  recipe: string;
  count: number;
  /** [clock %, how many machines] */
  clocks: [number, number][];
  /** Machines with somersloops in them. */
  boosted: number;
}

/** What a factory looks like in the game, as read from the save. */
export interface BuiltInfo {
  /** Save ids of its production machines, to recognise it in later saves. */
  machineIds: string[];
  groups: BuiltGroup[];
  /** Net output and input per item, per minute, at the clocks set in game. */
  outputs: [string, number][];
  inputs: [string, number][];
  power: number;
  /** Area the machines cover (cm, world coordinates). */
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
  updatedAt: number;
  /** True when the last synced save no longer has these machines. */
  missing?: boolean;
}

export interface Factory {
  id: string;
  name: string;
  target: string;
  /** Wanted output per minute; null = maximise. */
  rate: number | null;
  mode: Mode;
  placement: 'manual' | 'suggested';
  location: { x: number; y: number } | null;
  /** Resource nodes claimed by this factory. */
  nodes: string[];
  /** Manually entered extra supply per raw item (trains, trucks, existing belts…), per minute. */
  extraSupply: Record<string, number>;
  imports: Import[];
  /** Recipes the user switched off for this factory. */
  excluded: string[];
  /** Treat raw resources as unlimited (ignore nodes) — handy for quick "what if" plans. */
  unlimitedRaw: boolean;
  /** Clock limit for production machines (%), e.g. 250 with power shards. */
  clockCap: number;
  useShards: boolean;
  schematic: SchematicOptions;
  createdAt: number;
  /** Other products this factory also makes, at fixed rates. */
  also: { item: string; rate: number }[];
  /** Set when the factory was added from the synced save. */
  game?: BuiltInfo;
}
