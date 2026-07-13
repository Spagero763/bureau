// Real-world FX reference rates (USD base), cached in-process.
// Source: open.er-api.com (free, daily updates) - good enough as a sanity
// reference for stable-pair pricing; execution decisions use onchain quotes.

interface RefRates {
  asOf: string;
  usdPer: Record<string, number>; // e.g. { EUR: 1.143 } = USD per 1 EUR
}

let cache: { at: number; rates: RefRates } | null = null;
const TTL_MS = 60 * 60 * 1000;

const SYMBOL_BY_CURRENCY: Record<string, string> = {
  USD: "USD",
  EUR: "EUR",
  BRL: "BRL",
  KES: "KES",
  GHS: "GHS",
  COP: "COP",
  PHP: "PHP",
  XOF: "XOF",
  NGN: "NGN",
  ZAR: "ZAR",
  GBP: "GBP",
  CAD: "CAD",
  AUD: "AUD",
  CHF: "CHF",
  JPY: "JPY",
};

export async function referenceRates(): Promise<RefRates> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rates;
  const res = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`fx reference returned HTTP ${res.status}`);
  const data = (await res.json()) as { result: string; time_last_update_utc: string; rates: Record<string, number> };
  if (data.result !== "success") throw new Error("fx reference unavailable");
  const usdPer: Record<string, number> = {};
  for (const cur of Object.keys(SYMBOL_BY_CURRENCY)) {
    const perUsd = data.rates[cur];
    if (perUsd) usdPer[cur] = 1 / perUsd; // convert "CUR per USD" to "USD per CUR"
  }
  const rates = { asOf: data.time_last_update_utc, usdPer };
  cache = { at: Date.now(), rates };
  return rates;
}

/** Currency code for a Mento stable symbol, e.g. EURm -> EUR, cEUR -> EUR, USDm -> USD. */
export function currencyOfSymbol(symbol: string): string | null {
  const s = symbol.toUpperCase();
  if (s === "USDM" || s === "CUSD" || s === "USDC" || s === "USDT") return "USD";
  // current Mento naming: <CUR>m (EURm, BRLm, KESm, ...)
  if (s.endsWith("M") && SYMBOL_BY_CURRENCY[s.slice(0, -1)]) return s.slice(0, -1);
  // legacy naming: c<CUR> (cEUR, cREAL, cKES, ...)
  if (s.startsWith("C") && SYMBOL_BY_CURRENCY[s.slice(1)]) return s.slice(1);
  if (s === "CREAL") return "BRL";
  if (s === "EXOF") return "XOF";
  if (s === "PUSO") return "PHP";
  if (SYMBOL_BY_CURRENCY[s]) return s;
  return null;
}
