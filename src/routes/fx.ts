import type { Express, Request, Response } from "express";
import { formatUnits, parseUnits } from "viem";
import { config } from "../config.js";
import { quote, stableTokens, tokenBySymbol } from "../desk/mento.js";
import { currencyOfSymbol, referenceRates } from "../desk/reference.js";
import { deskState, setPaused } from "../desk/state.js";

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
      const base = await tokenBySymbol(config.desk.baseSymbol);
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

  // FREE: delayed, rounded FX preview for the dashboard (60s cache).
  // The precise, machine-grade table is the paid /v1/fx/rates.
  let previewCache: { at: number; body: unknown } | null = null;
  app.get("/v1/fx/preview", async (_req: Request, res: Response) => {
    if (previewCache && Date.now() - previewCache.at < 60_000) return res.json(previewCache.body);
    try {
      const [{ usdPer }, tokens] = await Promise.all([referenceRates(), stableTokens()]);
      const base = await tokenBySymbol(config.desk.baseSymbol);
      if (!base) return fail(res, 500, "base token unavailable");
      const probe = parseUnits("10", base.decimals);
      const rows = await Promise.all(
        tokens
          .filter((t) => t.address !== base.address)
          .map(async (t) => {
            const cur = currencyOfSymbol(t.symbol);
            const ref = cur ? (usdPer[cur] ?? null) : null;
            const out = await quote(base.address, t.address, probe).catch(() => 0n);
            if (out === 0n || !ref) return null;
            const impliedUsd = 10 / Number(formatUnits(out, t.decimals));
            return {
              symbol: t.symbol,
              currency: cur,
              onchainUsd: Math.round(impliedUsd * 1e4) / 1e4,
              referenceUsd: Math.round(ref * 1e4) / 1e4,
            };
          }),
      );
      const body = { base: base.symbol, delayed: true, asOf: new Date().toISOString(), rates: rows.filter(Boolean) };
      previewCache = { at: Date.now(), body };
      res.json(body);
    } catch (e) {
      fail(res, 502, e instanceof Error ? e.message : "preview unavailable");
    }
  });

  // FREE: desk stats for the dashboard and anyone watching.
  app.get("/v1/desk", (_req: Request, res: Response) => {
    const s = deskState();
    res.json({
      enabled: config.desk.enabled,
      paused: s.paused,
      startedAt: s.startedAt,
      totalVolumeUsd: Math.round(s.totalVolumeUsd * 100) / 100,
      totalTrades: s.totalTrades,
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
