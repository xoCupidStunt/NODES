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
}
