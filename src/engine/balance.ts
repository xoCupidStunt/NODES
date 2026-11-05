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

// ---- Balancer layouts: the actual splitters and mergers, with the rate on every belt ----

export type BalNodeKind = 'in' | 'S' | 'M' | 'out';
export interface BalNode {
  id: number;
  kind: BalNodeKind;
  /** For 'out' (and its joining mergers): which destination. */
  dest?: number;
  /** Mergers that join a destination's belts ('join') or several loop-backs ('loopjoin'). */
  role?: 'join' | 'loopjoin';
}
export interface BalEdge {
  from: number; to: number; rate: number;
  /** Loop-back belt (drawn dashed). */
  loop?: boolean;
  /** Build order, so belts leave each splitter left to right in the order they were laid out. */
  order?: number;
}
export interface BalancerGraph {
  nodes: BalNode[];
  edges: BalEdge[];
  splitters: number;
  mergers: number;
  /** Busiest belt in the balancer (a loop-back makes some belts busier than the input). */
  maxRate: number;
  input: number;
  /** Parts each destination gets (equal split: 1 each). */
  shares: number[];
}

type Leaf = { kind: 'dest'; d: number } | { kind: 'loop'; id: number } | { kind: 'sub'; slots: number[]; factors: number[] };

/** Prime factors in build order: 2s, then 3s, then the ones that need a loop-back (5, 7, 11…), smallest first. */
function buildOrder(n: number): number[] {
  const out: number[] = [];
  let m = n;
  for (let p = 2; m > 1 && p <= m; p++) while (m % p === 0) { out.push(p); m /= p; }
  return out;
}

/**
 * Splitter/merger layout that shares `input` over `slots` equal parts (slot = destination index), splitting by
 * `factors` in order. A factor of 2 or 3 is one splitter per branch; any other factor f is a merger feeding an
 * even tree for the next 2^a·3^b size up, whose spare outputs loop back into that merger. Branches whose parts
 * all go to the same place aren't split further.
 */
function buildGraph(input: number, slots: number[], factors: number[], dests: number): BalancerGraph {
  const nodes: BalNode[] = [{ id: 0, kind: 'in' }];
  const edges: BalEdge[] = [];
  const add = (kind: BalNodeKind) => { const id = nodes.length; nodes.push({ id, kind }); return id; };
  let tick = 0;
  const toDest: { from: number; rate: number; order?: number }[][] = Array.from({ length: dests }, () => []);
  const loops = new Map<number, { from: number; rate: number }[]>();
  let loopSeq = 0;

  const leaf = (from: number, rate: number, l: Leaf) => {
    if (l.kind === 'dest') toDest[l.d].push({ from, rate, order: tick++ });
    else if (l.kind === 'loop') loops.get(l.id)!.push({ from, rate });
    else grow(from, rate, l.slots, l.factors);
  };
  const oneTarget = (ls: Leaf[]) => {
    const a = ls[0];
    if (a.kind === 'dest') return ls.every((x) => x.kind === 'dest' && x.d === a.d);
    if (a.kind === 'loop') return ls.every((x) => x.kind === 'loop' && x.id === a.id);
    return ls.length === 1;
  };
  // Even tree over `ls` (its length is 2^a·3^b): 2-way stages first, then 3-way.
  const tree = (from: number, rate: number, ls: Leaf[]) => {
    if (oneTarget(ls)) {
      if (ls.length === 1 || ls[0].kind !== 'sub') return leaf(from, rate, ls[0]);
    }
    const f = ls.length % 2 === 0 ? 2 : 3;
    const s = add('S');
    edges.push({ from, to: s, rate, order: tick++ });
    const c = ls.length / f;
    for (let i = 0; i < f; i++) tree(s, rate / f, ls.slice(i * c, (i + 1) * c));
  };
  const grow = (from: number, rate: number, sl: number[], fs: number[]) => {
    if (sl.every((x) => x === sl[0])) { toDest[sl[0]].push({ from, rate, order: tick++ }); return; }
    const f = fs[0];
    const rest = fs.slice(1);
    const c = sl.length / f;
    const subs: Leaf[] = Array.from({ length: f }, (_, i) => ({ kind: 'sub', slots: sl.slice(i * c, (i + 1) * c), factors: rest }));
    if (f === 2 || f === 3) { tree(from, rate, subs); return; }
    // Loop-back: merger → tree for the next even size up; spare outputs come back round to the merger.
    const m = smoothAtLeast(f);
    const id = loopSeq++;
    loops.set(id, []);
    const merger = add('M');
    edges.push({ from, to: merger, rate, order: tick++ });
    tree(merger, (rate * m) / f, [...subs, ...Array.from({ length: m - f }, (): Leaf => ({ kind: 'loop', id }))]);
    // A merger takes 3 belts: the incoming one and up to 2 loops; more loops are joined first.
    let back = loops.get(id)!;
    while (back.length > 2) {
      const j = add('M');
      nodes[j].role = 'loopjoin';
      const take = back.slice(0, 3);
      for (const e of take) edges.push({ from: e.from, to: j, rate: e.rate, loop: true });
      back = [{ from: j, rate: take.reduce((a, e) => a + e.rate, 0) }, ...back.slice(3)];
    }
    for (const e of back) edges.push({ from: e.from, to: merger, rate: e.rate, loop: true });
  };

  grow(0, input, slots, factors);
  // Each destination's belts are merged into one, 3 at a time.
  toDest.forEach((ins, d) => {
    const out = add('out');
    nodes[out].dest = d;
    let list = ins;
    while (list.length > 1) {
      const j = add('M');
      nodes[j].role = 'join';
      nodes[j].dest = d;
      const take = list.slice(0, 3);
      for (const e of take) edges.push({ from: e.from, to: j, rate: e.rate, order: e.order });
      list = [{ from: j, rate: take.reduce((a, e) => a + e.rate, 0), order: tick++ }, ...list.slice(3)];
    }
    if (list[0]) edges.push({ from: list[0].from, to: out, rate: list[0].rate, order: list[0].order });
  });
  const shares = Array.from({ length: dests }, (_, d) => slots.filter((x) => x === d).length);
  return {
    nodes, edges, input, shares,
    splitters: nodes.filter((n) => n.kind === 'S').length,
    mergers: nodes.filter((n) => n.kind === 'M').length,
    maxRate: Math.max(input, ...edges.map((e) => e.rate)),
  };
}

/** Even 1:n balancer (n outputs, `input` per minute in). */
export function evenBalancer(n: number, input: number): BalancerGraph {
  return buildGraph(input, Array.from({ length: n }, (_, i) => i), buildOrder(n), n);
}

/** Shares one belt out by parts (from ratioSplit): destination i gets shares[i] of sum(shares) equal parts. */
export function ratioBalancer(shares: number[], input: number): BalancerGraph {
  const k = shares.reduce((a, b) => a + b, 0);
  // Biggest shares first: they line up with whole branches, so fewer splitters and mergers.
  const order = shares.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]);
  const slots = order.flatMap(([s, i]) => Array.from({ length: s }, () => i));
  return buildGraph(input, slots, buildOrder(k), shares.length);
}

/**
 * Where to draw each node (units: columns, rows). The splitter tree hangs from the input; every belt that leaves
 * it for a destination gets its own column, in order; each destination's joining mergers sit under its belts and
 * all outputs share the bottom row. `edgeCol` gives those leaving belts their column.
 */
export function layoutBalancer(g: BalancerGraph) {
  const inTree = (id: number) => { const n = g.nodes[id]; return n.kind === 'in' || ((n.kind === 'S' || n.kind === 'M') && !n.role); };
  const col = new Map<number, number>();
  const row = new Map<number, number>();
  const edgeCol = new Map<number, number>();
  let next = 0;
  const out = new Map<number, number[]>();
  g.edges.forEach((e, i) => { if (!e.loop) out.set(e.from, [...(out.get(e.from) ?? []), i]); });
  for (const list of out.values()) list.sort((a, b) => (g.edges[a].order ?? 0) - (g.edges[b].order ?? 0));
  // The tree, depth first: children in build order; belts leaving the tree each take the next column.
  const place = (id: number, depth: number): number => {
    row.set(id, depth);
    const xs = (out.get(id) ?? []).map((i) => {
      const to = g.edges[i].to;
      if (inTree(to)) return place(to, depth + 1);
      edgeCol.set(i, next);
      return next++;
    });
    const x = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : next++;
    col.set(id, x);
    return x;
  };
  place(0, 0);
  let bottom = Math.max(...row.values()) + 1;
  // Joining mergers: one row per merge step, centred over what they join.
  const xOf = (i: number) => edgeCol.get(i) ?? col.get(g.edges[i].from)!;
  const joins = g.nodes.filter((n) => n.role === 'join');
  const done = new Set<number>();
  for (let level = 0; done.size < joins.length && level < 50; level++) {
    for (const n of joins) {
      if (done.has(n.id)) continue;
      const ins = g.edges.map((e, i) => [e, i] as const).filter(([e]) => e.to === n.id);
      if (ins.some(([e]) => g.nodes[e.from].role === 'join' && !done.has(e.from))) continue;
      const xs = ins.map(([e, i]) => (g.nodes[e.from].role === 'join' ? col.get(e.from)! : xOf(i)));
      col.set(n.id, (Math.min(...xs) + Math.max(...xs)) / 2);
      row.set(n.id, bottom + Math.max(0, ...ins.map(([e]) => (g.nodes[e.from].role === 'join' ? row.get(e.from)! - bottom + 1 : 0))));
      done.add(n.id);
    }
  }
  if (joins.length) bottom = Math.max(...joins.map((n) => row.get(n.id)!)) + 1;
  for (const n of g.nodes) {
    if (n.kind !== 'out') continue;
    const i = g.edges.findIndex((e) => e.to === n.id);
    const from = g.edges[i].from;
    col.set(n.id, g.nodes[from].role === 'join' ? col.get(from)! : xOf(i));
    row.set(n.id, bottom);
  }
  // Mergers joining several loop-backs: off to the right, level with their merger.
  for (const n of g.nodes) {
    if (n.role !== 'loopjoin') continue;
    const target = g.edges.find((e) => e.from === n.id)!.to;
    col.set(n.id, next + 0.2);
    row.set(n.id, (row.get(target) ?? 0) + 1);
  }
  return { col, row, edgeCol, cols: next + (g.nodes.some((n) => n.role === 'loopjoin') ? 1 : 0), rows: bottom + 1 };
}

/** "3-way, then 2-way" for a list of stages. */
export function stagesText(st: number[]) {
  return st.map((s) => `${s}-way`).join(', then ');
}
