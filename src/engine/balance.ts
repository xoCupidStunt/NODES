// Load balancing with Conveyor Splitters and Mergers.
//
// A splitter sends items out evenly to the outputs that accept them, 2 or 3 ways. Chaining them gives an even
// split into any 2^a × 3^b ways. Other counts (5, 7, 10…) use the usual trick: build the next such size up and
// loop the spare outputs back into a merger at the start, so the items go round again until a real output
// takes them. Unequal shares (one row needs 7 parts, another 5) come from an even split whose outputs are
// merged back together in groups.

/** 2- and 3-way stages for a balancer of exactly `n` outputs (n must be 2^a·3^b), widest first. */
function stages(n: number): number[] {
  const out: number[] = [];
  let m = n;
  while (m % 3 === 0) { out.push(3); m /= 3; }
  while (m % 2 === 0) { out.push(2); m /= 2; }
  return m === 1 ? out : [];
}

/** True when n splits evenly with splitters alone (n = 2^a · 3^b). */
export function isSmooth(n: number) {
  return n >= 1 && Number.isInteger(n) && stages(n).reduce((a, b) => a * b, 1) === n;
}

/** Smallest 2^a·3^b that is at least n. */
export function smoothAtLeast(n: number) {
  let m = Math.max(1, Math.ceil(n));
  while (!isSmooth(m)) m++;
  return m;
}

export interface EvenSplit {
  /** Real outputs. */
  outputs: number;
  /** Size of the splitter tree (≥ outputs); size − outputs go back to the start. */
  size: number;
  /** 2- or 3-way stages, in build order. */
  stages: number[];
  splitters: number;
  /** Mergers for the loop-back (combining the spare outputs with the incoming belt). */
  mergers: number;
  loopBack: number;
  /** How much busier the belt into the tree is because of the loop-back (size / outputs). */
  beltLoad: number;
}

/** An even 1→n split. n ≤ 1 needs nothing. */
export function evenSplit(n: number): EvenSplit {
  if (n <= 1) return { outputs: n, size: n, stages: [], splitters: 0, mergers: 0, loopBack: 0, beltLoad: 1 };
  const size = smoothAtLeast(n);
  const st = stages(size);
  // One splitter at the first stage, then one per branch of each later stage.
  let splitters = 0, branches = 1;
  for (const s of st) { splitters += branches; branches *= s; }
  const loopBack = size - n;
  // A merger takes 3 belts in: the first joins the input and 2 loops, each next one adds 2 more.
  const mergers = loopBack ? Math.ceil(loopBack / 2) : 0;
  return { outputs: n, size, stages: st, splitters, mergers, loopBack, beltLoad: size / n };
}

export interface RatioSplit {
  /** Even split into this many parts. */
  parts: number;
  /** Parts given to each consumer, in the order given. */
  shares: number[];
  /** Largest shortfall of any consumer, as a fraction of what it needs (0 = everyone gets at least their share). */
  error: number;
  split: EvenSplit;
  /** Mergers to join each consumer's parts back into one belt. */
  joinMergers: number;
}

const SMOOTH = Array.from({ length: 108 }, (_, k) => k + 1).filter(isSmooth);

/**
 * Split one belt between consumers needing `need[i]` each, with an even split whose parts are handed out in
 * proportion. Takes the smallest split within 2 % of every need (or exact), else the closest up to 108 parts.
 */
export function ratioSplit(need: number[], tolerance = 0.02, maxParts = 108): RatioSplit {
  const total = need.reduce((a, b) => a + b, 0);
  const share = need.map((v) => (total > 0 ? v / total : 0));
  let best: RatioSplit | null = null;
  for (const k of SMOOTH) {
    if (k < need.length) continue;
    if (k > maxParts && best) break;
    // Largest remainder, with at least one part each.
    const raw = share.map((s) => s * k);
    const parts = raw.map((r) => Math.max(1, Math.floor(r)));
    let left = k - parts.reduce((a, b) => a + b, 0);
    const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
    for (let j = 0; left > 0; j = (j + 1) % order.length, left--) parts[order[j][1]]++;
    if (left < 0) continue; // more consumers than parts can cover fairly
    // Only a shortfall slows start-up; a belt that gets extra just fills sooner and passes its share on.
    const error = Math.max(...parts.map((p, i) => (share[i] > 0 ? Math.max(0, share[i] - p / k) / share[i] : 0)));
    const joinMergers = parts.reduce((a, p) => a + (p > 1 ? Math.ceil((p - 1) / 2) : 0), 0);
    const cand: RatioSplit = { parts: k, shares: parts, error, split: evenSplit(k), joinMergers };
    if (error <= tolerance + 1e-9) return cand;
    if (!best || error < best.error - 1e-9) best = cand;
  }
  return best!;
}

/** "3-way, then 2-way" for a list of stages. */
export function stagesText(st: number[]) {
  return st.map((s) => `${s}-way`).join(', then ');
}
