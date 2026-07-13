// Market data with a small in-process cache so bursts of paid calls do not
// hammer the upstream source.

interface CacheEntry<T> {
  at: number;
  value: T;
}

const cache = new Map<string, CacheEntry<unknown>>();

async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

const COINGECKO_IDS = "celo,usd-coin,tether,ethereum,bitcoin";

export interface Rates {
  asOf: string;
  source: string;
  usd: Record<string, number>;
}

export async function getRates(): Promise<Rates> {
  return cached("rates", 30_000, async () => {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_IDS}&vs_currencies=usd`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`price source returned HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, { usd: number }>;
    const usd: Record<string, number> = {};
    for (const [id, v] of Object.entries(data)) usd[id] = v.usd;
    return { asOf: new Date().toISOString(), source: "coingecko", usd };
  });
}
