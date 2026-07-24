import type { Express, Request, Response } from "express";
import { formatUnits, parseUnits } from "viem";
import { config } from "../config.js";
import { quote, stableTokens, tokenBySymbol } from "../desk/mento.js";
import { currencyOfSymbol, referenceRates } from "../desk/reference.js";
import { deskState, setPaused } from "../desk/state.js";
import { history } from "../desk/history.js";

function fail(res: Response, status: number, message: string) {
  res.status(status).json({ error: message });
}

export function registerFxRoutes(app: Express) {
  // PAID: live onchain FX table - Mento implied USD price per stable vs the
  // real-world reference, with the deviation in bps. This is the desk's brain,
  // sold per-call.
  app.get("/v1/fx/rates", async (_req: Request, res: Response) => {
    try {
      const [{ usdPer, asOf }, tokens] = await Promise.all([referenceRates(), stableTokens()]);
      const base = await tokenBySymbol(process.env.FX_PRICING_BASE ?? "USDm");
      if (!base) return fail(res, 500, "base token unavailable");
      const probe = parseUnits("10", base.decimals); // $10 probe for implied price

      const rows = await Promise.all(
        tokens
          .filter((t) => t.address !== base.address)
          .map(async (t) => {
            const cur = currencyOfSymbol(t.symbol);
            const ref = cur ? (usdPer[cur] ?? null) : null;
            const out = await quote(base.address, t.address, probe).catch(() => 0n);
            if (out === 0n) return null;
            const impliedUsd = 10 / Number(formatUnits(out, t.decimals));
            return {
              symbol: t.symbol,
              address: t.address,
              currency: cur,
              onchainUsd: Math.round(impliedUsd * 1e6) / 1e6,
              referenceUsd: ref,
              deviationBps: ref ? Math.round(((ref - impliedUsd) / ref) * 10_000 * 10) / 10 : null,
            };
          }),
      );
      res.json({
        base: base.symbol,
        referenceAsOf: asOf,
        asOf: new Date().toISOString(),
        rates: rows.filter(Boolean),
      });
    } catch (e) {
      fail(res, 502, e instanceof Error ? e.message : "fx rates unavailable");
    }
  });

  // PAID: executable quote for any Mento stable pair.
  app.get("/v1/fx/quote", async (req: Request, res: Response) => {
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? "");
    const amount = String(req.query.amount ?? "");
    if (!from || !to || !amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
      return fail(res, 400, "query params required: from, to (Mento symbols), amount (decimal)");
    }
    try {
      const [tIn, tOut] = await Promise.all([tokenBySymbol(from), tokenBySymbol(to)]);
      if (!tIn || !tOut) return fail(res, 404, "unknown token symbol (see /v1/fx/rates for the list)");
      const amountIn = parseUnits(amount, tIn.decimals);
      const out = await quote(tIn.address, tOut.address, amountIn);
      res.json({
        from: tIn.symbol,
        to: tOut.symbol,
        amountIn: amount,
        amountOut: formatUnits(out, tOut.decimals),
        rate: Number(formatUnits(out, tOut.decimals)) / Number(amount),
        venue: "mento",
        asOf: new Date().toISOString(),
      });
    } catch (e) {
      fail(res, 502, e instanceof Error ? e.message : "quote unavailable");
    }
  });

  // Shared market computation with a 60s cache and last-good fallback, so a
  // transient RPC hiccup never blanks the dashboard table.
  let marketCache: { at: number; rows: { symbol: string; currency: string | null; onchainUsd: number; referenceUsd: number | null }[] } = { at: 0, rows: [] };
  async function computeMarkets() {
    if (Date.now() - marketCache.at < 60_000 && marketCache.rows.length > 0) return marketCache.rows;
    const [{ usdPer }, tokens] = await Promise.all([referenceRates(), stableTokens()]);
    const base = await tokenBySymbol(process.env.FX_PRICING_BASE ?? "USDm");
    if (!base) return marketCache.rows;
    const probe = parseUnits("10", base.decimals);
    const rows: typeof marketCache.rows = [];
    for (const t of tokens) {
      if (t.address === base.address) continue;
      const out = await quote(base.address, t.address, probe).catch(() => 0n);
      if (out === 0n) continue;
      const cur = currencyOfSymbol(t.symbol);
      const impliedUsd = 10 / Number(formatUnits(out, t.decimals));
      rows.push({
        symbol: t.symbol,
        currency: cur,
        onchainUsd: Math.round(impliedUsd * 1e4) / 1e4,
        referenceUsd: cur && usdPer[cur] ? Math.round(usdPer[cur] * 1e4) / 1e4 : null,
      });
    }
    // keep last-good unless the fresh set is at least as complete
    if (rows.length >= Math.max(3, marketCache.rows.length)) marketCache = { at: Date.now(), rows };
    return marketCache.rows;
  }

  // FREE: dashboard market table (fresh + cached, not sampler-dependent).
  app.get("/v1/fx/preview", async (_req: Request, res: Response) => {
    try {
      const rows = await computeMarkets();
      res.json({ base: "USDm", delayed: true, asOf: new Date().toISOString(), rates: rows });
    } catch (e) {
      fail(res, 502, e instanceof Error ? e.message : "preview unavailable");
    }
  });

  app.get("/v1/fx/markets", async (_req: Request, res: Response) => {
    try {
      const rows = await computeMarkets();
      res.json({ asOf: new Date().toISOString(), rates: rows });
    } catch (e) {
      fail(res, 502, e instanceof Error ? e.message : "markets unavailable");
    }
  });

  // FREE: sampled price history for sparklines (in-memory, resets on restart).
  app.get("/v1/fx/history", (_req: Request, res: Response) => {
    res.json(history());
  });

  // FREE: desk stats for the dashboard and anyone watching.
  // Cumulative counters survive restarts by adding a committed baseline (the
  // real onchain totals) to the in-memory count since this instance booted -
  // Render's disk is ephemeral, so without this the dashboard would reset to
  // zero on every redeploy.
  const baseVol = Number(process.env.DESK_BASELINE_VOLUME_USD ?? "0");
  const baseTrades = Number(process.env.DESK_BASELINE_TRADES ?? "0");
  const basePayments = Number(process.env.DESK_BASELINE_PAYMENTS ?? "0");
  app.get("/v1/desk", (_req: Request, res: Response) => {
    const s = deskState();
    res.json({
      enabled: config.desk.enabled,
      paused: s.paused,
      startedAt: s.startedAt,
      totalVolumeUsd: Math.round((baseVol + s.totalVolumeUsd) * 100) / 100,
      totalTrades: baseTrades + s.totalTrades,
      x402SelfBuys: basePayments + s.selfBuys,
      today: {
        volumeUsd: Math.round(s.dayVolumeUsd * 100) / 100,
        costUsd: Math.round(s.dayCostUsd * 10000) / 10000,
        costCapUsd: config.desk.dailyCostCapUsd,
      },
      lastCycleAt: s.lastCycleAt,
      lastError: s.lastError,
      recentTrades: s.trades.slice(0, 25),
    });
  });

  // ADMIN: pause/resume the desk (kill switch).
  app.post("/v1/desk/pause", (req: Request, res: Response) => {
    if (!config.adminToken || req.header("x-admin-token") !== config.adminToken) {
      return fail(res, 401, "unauthorized");
    }
    const paused = Boolean((req.body ?? {}).paused ?? true);
    setPaused(paused);
    res.json({ paused });
  });
}
