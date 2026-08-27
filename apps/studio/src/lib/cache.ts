/**
 * Generation-phase cache (§11.3 rule 7 operationalized):
 * key = sha256(theme | preset | model | kind | promptVersion)
 * Stored in localStorage; results are content-addressed so repeated
 * generations of the SAME theme reuse the model's prior thinking instantly,
 * while different themes always pay fresh inference.
 */
const NS = "artai.cache.v1.";

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CacheSlots {
  intent?: unknown;
  motif?: unknown;
  prompt?: string;
}

export async function cacheKey(parts: {
  theme: string; preset: string; model: string; kindOf: string;
}): Promise<string> {
  return sha256(`${parts.theme}\u0000${parts.preset}\u0000${parts.model}\u0000${parts.kindOf}`);
}

export async function getCached<T>(key: string): Promise<T | null> {
  try {
    const raw = localStorage.getItem(NS + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: T };
    return (parsed.v ?? null) as T | null;
  } catch { return null; }
}

export function setCached<T>(key: string, value: T): void {
  try {
    localStorage.setItem(NS + key, JSON.stringify({ v: value }));
  } catch { /* quota exceeded \u2014 cache is best-effort */ }
}

/** 清空本应用全部生成缓存（intent/motif/prompt） */
export function clearGenerationCache(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS)) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  } catch { /* best-effort */ }
}

/** 当前缓存条目数（供设置页展示） */
export function cacheCount(): number {
  let n = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS)) n++;
    }
  } catch { /* ignore */ }
  return n;
}
