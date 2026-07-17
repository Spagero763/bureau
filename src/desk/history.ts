// In-memory price history for the dashboard sparklines: samples the onchain
// implied USD price of every Mento stable every few minutes. Ring buffer per
// symbol, capped; survives nothing (dashboard degrades gracefully on restart).

import { formatUnits, parseUnits } from "viem";
import { config } from "../config.js";
import { quote, stableTokens, tokenBySymbol } from "./mento.js";
import { currencyOfSymbol, referenceRates } from "./reference.js";

export interface PricePoint {
  t: number; // unix ms
  usd: number;
}

const MAX_POINTS = 288; // 24h at 5-minute sampling
const series = new Map<string, PricePoint[]>();
let lastRates: { symbol: string; currency: string | null; onchainUsd: number; referenceUsd: number | null }[] = [];
let lastSampleAt: number | null = null;

export function history(): { asOf: number | null; series: Record<string, PricePoint[]> } {
  return { asOf: lastSampleAt, series: Object.fromEntries(series) };
}

export function latestRates() {
  return { asOf: lastSampleAt, rates: lastRates };
}

export async function sampleOnce(): Promise<void> {
  const [{ usdPer }, tokens] = await Promise.all([referenceRates(), stableTokens()]);
  const base = await tokenBySymbol(process.env.FX_PRICING_BASE ?? "USDm");
  if (!base) return;
  const probe = parseUnits("10", base.decimals);
  const now = Date.now();

  // Quote sequentially, not all-at-once: a concurrent burst against the RPC
  // during cold start gets rate-limited and returns mostly nulls.
  const rows: { symbol: string; currency: string | null; onchainUsd: number; referenceUsd: number | null }[] = [];
  for (const t of tokens) {
    if (t.address === base.address) continue;
    const out = await quote(base.address, t.address, probe).catch(() => 0n);
    if (out === 0n) continue;
    const onchainUsd = 10 / Number(formatUnits(out, t.decimals));
    const cur = currencyOfSymbol(t.symbol);
    rows.push({ symbol: t.symbol, currency: cur, onchainUsd, referenceUsd: cur ? (usdPer[cur] ?? null) : null });
  }

  // Only replace last-good with a sample that isn't obviously degraded, so a
  // rate-limited run can never blank the dashboard table.
  if (rows.length >= Math.max(3, Math.floor(lastRates.length * 0.6))) {
    lastRates = rows;
    lastSampleAt = now;
    for (const r of rows) {
      const s = series.get(r.symbol) ?? [];
      s.push({ t: now, usd: r.onchainUsd });
      if (s.length > MAX_POINTS) s.shift();
      series.set(r.symbol, s);
    }
  }
}

export function startHistorySampler(intervalSec = 90): void {
  const tick = () => sampleOnce().catch((e) => console.warn("[history] sample failed:", e instanceof Error ? e.message : e));
  setInterval(tick, intervalSec * 1000);
  setTimeout(tick, 12_000);
}
