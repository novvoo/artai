/**
 * Deterministic PRNG — Mulberry32 with SplitMix64-style seed hashing, dual
 * streams and a Box–Muller gaussian cache. Lineage: core/utils.js of p5.brush
 * (the reproducibility contract artai inherits); reimplemented minimal subset.
 */
function hashSeed(seed: number | string): number {
  let h = 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x9e3779b9) | 0;
    h ^= h >>> 15;
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) | 0;
  return (h ^ (h >>> 16)) >>> 0 || 1;
}

function mulberry32(state: number): () => number {
  let s = state | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) * 2.3283064365386963e-10;
  };
}

export class Rng {
  private next0: () => number;
  private next1: () => number;

  constructor(seed: number | string) {
    this.next0 = mulberry32(hashSeed(seed));
    this.next1 = mulberry32(hashSeed(`${seed}:2`));
  }

  /** uniform float in [0, 1) */
  float(): number {
    return this.next0();
  }
  float2(): number {
    return this.next1();
  }
  /** uniform in [min, max) */
  range(min: number, max: number): number {
    return min + this.next0() * (max - min);
  }
  int(minIncl: number, maxExcl: number): number {
    return Math.floor(this.range(minIncl, maxExcl));
  }
  /** weighted pick from {[key]: weight}; weights need not sum to 1 */
  weighted<T extends string>(weights: Readonly<Record<string, number>>): T {
    let total = 0;
    const entries: Array<[string, number]> = [];
    for (const key in weights) {
      total += weights[key]!;
      entries.push([key, total]);
    }
    const roll = this.next0() * total;
    for (const [key, cum] of entries) if (roll < cum) return key as T;
    return entries[entries.length - 1]![0] as T;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next0() * arr.length)]!;
  }
  /** Box–Muller with cached second variate */
  gaussian(mean = 0, stdev = 1): number {
    if (this.cached !== null) {
      const v = this.cached;
      this.cached = null;
      return v * stdev + mean;
    }
    const u = 1 - this.next0();
    const w = this.next0();
    const r = Math.sqrt(-2 * Math.log(u));
    this.cached = r * Math.sin(2 * Math.PI * w);
    return r * Math.cos(2 * Math.PI * w) * stdev + mean;
  }
  private cached: number | null = null;
}
