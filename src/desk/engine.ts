// The Bureau FX desk: an autonomous loop that trades Celo stablecoins on
// Mento with strict cost controls. Two behaviors:
//
//   1. Edge trades: when the onchain price of a stable deviates from the
//      real-world FX reference by more than DESK_MIN_EDGE_BPS, buy the cheap
//      side (or sell a held position back to base on the reverse signal).
//   2. Rotations: when no edge exists, keep the desk active by rotating the
//      cheapest round-trip pair, but only while the estimated cost stays
//      inside DESK_DAILY_COST_CAP_USD and DESK_MAX_ROTATION_COST_BPS.
//
// Every transaction (approvals included) carries the ERC-8021 attribution tag.

import { formatUnits, parseUnits, type Hex } from "viem";
import { createRequire } from "node:module";
import type { Token } from "@mento-protocol/mento-sdk";

const require = createRequire(import.meta.url);
const { deadlineFromMinutes } = require("@mento-protocol/mento-sdk") as {
  deadlineFromMinutes: (minutes: number) => bigint;
};
import { config } from "../config.js";
import { feeParams, publicClient, walletClient, erc20Abi } from "../lib/celo.js";
import { withAttribution } from "../lib/attribution.js";
import { mento, stableTokens, quote, tokenBySymbol } from "./mento.js";
import { currencyOfSymbol, referenceRates } from "./reference.js";
import { deskState, recordCycle, recordTrade } from "./state.js";

interface CallParamsLike {
  to: string;
  data: string;
  value?: bigint | string;
}

async function sendTagged(params: CallParamsLike): Promise<string> {
  const wallet = walletClient();
  const hash = await wallet.sendTransaction({
    to: params.to as `0x${string}`,
    data: withAttribution(params.data as Hex),
    value: params.value === undefined ? undefined : BigInt(params.value),
    chain: wallet.chain,
    account: wallet.account!,
    ...(await feeParams()),
  } as Parameters<typeof wallet.sendTransaction>[0]);
  await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
  return hash;
}

async function balanceOf(token: Token): Promise<bigint> {
  return publicClient.readContract({
    address: token.address as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [config.agentAddress as `0x${string}`],
  });
}

/** USD value of a token amount using the FX reference. */
function usdValue(token: Token, amount: bigint, usdPer: Record<string, number>): number {
  const cur = currencyOfSymbol(token.symbol);
  const rate = cur ? (usdPer[cur] ?? 0) : 0;
  return Number(formatUnits(amount, token.decimals)) * rate;
}

async function executeSwap(
  tokenIn: Token,
  tokenOut: Token,
  amountIn: bigint,
  kind: "edge" | "rotation",
  edgeBps: number,
  usdPer: Record<string, number>,
  roundTripCostBps: number,
): Promise<void> {
  const m = await mento();
  const prepared = await m.swap.prepareSwap({
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn,
    slippageTolerance: config.desk.slippagePct,
    recipient: config.agentAddress,
    owner: config.agentAddress,
    deadline: deadlineFromMinutes(5),
  });

  if (prepared.approval) {
    await sendTagged(prepared.approval as CallParamsLike);
  }
  if (!prepared.params) throw new Error("mento returned no swap params");

  const inUsd = usdValue(tokenIn, amountIn, usdPer);
  const txHash = await sendTagged(prepared.params as CallParamsLike);

  // True cash cost of a leg is half the measured round-trip spread, not the
  // reference-price delta (the reference is a daily snapshot and would
  // massively overstate cost, choking the daily cap). Edge legs trade at
  // favorable prices and book zero.
  const legCostUsd =
    kind === "edge" || !Number.isFinite(roundTripCostBps)
      ? 0
      : Math.max(0, (inUsd * (roundTripCostBps / 2)) / 10_000);

  recordTrade(
    {
      at: new Date().toISOString(),
      pair: `${tokenIn.symbol}->${tokenOut.symbol}`,
      amountInUsd: Math.round(inUsd * 100) / 100,
      edgeBps: Math.round(edgeBps * 10) / 10,
      txHash,
      kind,
    },
    Math.round(legCostUsd * 10000) / 10000,
  );
  console.log(`[desk] ${kind} ${tokenIn.symbol}->${tokenOut.symbol} $${inUsd.toFixed(2)} edge ${edgeBps.toFixed(1)}bps tx ${txHash}`);
}

export async function runCycle(): Promise<void> {
  const state = deskState();
  if (state.paused) {
    recordCycle();
    return;
  }
  if (state.dayCostUsd >= config.desk.dailyCostCapUsd) {
    recordCycle("daily cost cap reached, desk idle until tomorrow");
    return;
  }

  try {
    const [{ usdPer }, tokens] = await Promise.all([referenceRates(), stableTokens()]);
    const base = tokens.find((t) => t.symbol.toLowerCase() === config.desk.baseSymbol.toLowerCase());
    if (!base) throw new Error(`base token ${config.desk.baseSymbol} not found on Mento`);

    // Self-discovery: trade everything Mento lists unless explicitly restricted.
    const counters = tokens.filter(
      (t) =>
        t.address !== base.address &&
        (config.desk.counterSymbols.length === 0 ||
          config.desk.counterSymbols.some((s) => s.toLowerCase() === t.symbol.toLowerCase())),
    );
    if (counters.length === 0) throw new Error("no counter tokens found on Mento");

    // Adaptive sizing: use the configured notional when the base balance
    // covers it, otherwise trade whatever base is available (floor $1),
    // always keeping headroom because gas is paid in the base currency.
    const gasReserve = parseUnits("0.5", base.decimals);
    const baseBalRaw = await balanceOf(base);
    const baseBal = baseBalRaw > gasReserve ? baseBalRaw - gasReserve : 0n;
    const configured = parseUnits(config.desk.tradeUsd.toString(), base.decimals);
    const floor = parseUnits("1", base.decimals);
    const baseAmount = baseBal >= configured ? configured : baseBal >= floor ? baseBal : 0n;
    const tradeUsd = Number(formatUnits(baseAmount > 0n ? baseAmount : configured, base.decimals));

    // Evaluate edges: positive edge means the counter is cheap onchain (buy);
    // for held counters, a negative edge means it is rich onchain (sell back).
    type Candidate = {
      tokenIn: Token;
      tokenOut: Token;
      amountIn: bigint;
      edgeBps: number;
      roundTripCostBps: number;
    };
    const candidates: Candidate[] = [];

    for (const c of counters) {
      const cur = currencyOfSymbol(c.symbol);
      const refUsdPer = cur ? usdPer[cur] : undefined;
      if (!refUsdPer) continue;

      const probe = baseAmount > 0n ? baseAmount : configured;
      const probeUsd = Number(formatUnits(probe, base.decimals));
      const out = await quote(base.address, c.address, probe).catch(() => 0n);
      if (out === 0n) continue;
      const impliedUsdPer = probeUsd / Number(formatUnits(out, c.decimals));
      const buyEdgeBps = ((refUsdPer - impliedUsdPer) / refUsdPer) * 10_000;

      // round-trip estimate for rotation costing
      const back = await quote(c.address, base.address, out).catch(() => 0n);
      const roundTripCostBps = back === 0n ? Infinity : (1 - Number(formatUnits(back, base.decimals)) / probeUsd) * 10_000;

      if (baseAmount > 0n) {
        candidates.push({ tokenIn: base, tokenOut: c, amountIn: baseAmount, edgeBps: buyEdgeBps, roundTripCostBps });
      }

      // Sell whatever we hold (whole position, capped at the configured
      // notional) so capital always cycles back to base.
      const cBal = await balanceOf(c);
      const cBalUsd = usdValue(c, cBal, usdPer);
      if (cBalUsd >= 1) {
        const maxTokens = parseUnits((config.desk.tradeUsd / refUsdPer).toFixed(Math.min(6, c.decimals)), c.decimals);
        candidates.push({
          tokenIn: c,
          tokenOut: base,
          amountIn: cBal > maxTokens ? maxTokens : cBal,
          edgeBps: -buyEdgeBps,
          roundTripCostBps,
        });
      }
    }

    // Build the attempt list: edge trades above threshold first (best edge
    // first), then cost-capped rotation legs. Try candidates in order; a
    // failing send (gas, slippage, tradability) falls through to the next.
    let attempts: Array<{ c: Candidate; kind: "edge" | "rotation" }> = [
      ...candidates
        .filter((x) => x.edgeBps >= config.desk.minEdgeBps)
        .sort((a, b) => b.edgeBps - a.edgeBps)
        .map((c) => ({ c, kind: "edge" as const })),
      ...(config.desk.rotation
        ? candidates
            .filter((x) => x.edgeBps < config.desk.minEdgeBps && x.roundTripCostBps <= config.desk.maxRotationCostBps)
            .sort((a, b) => b.edgeBps - a.edgeBps)
            .map((c) => ({ c, kind: "rotation" as const }))
        : []),
    ];

    // Rebalance: if base is too low to buy anything, selling a held position
    // back is worth a wider cost allowance than a normal rotation; a desk
    // sitting on positions produces nothing.
    const rebalanceCostBps = Number(process.env.DESK_REBALANCE_COST_BPS ?? "60");
    if (baseAmount === 0n && attempts.length === 0) {
      const sells = candidates
        .filter((x) => x.tokenOut.address === base.address && x.roundTripCostBps <= rebalanceCostBps)
        .sort((a, b) => a.roundTripCostBps - b.roundTripCostBps);
      attempts.push(...sells.map((c) => ({ c, kind: "rotation" as const })));
    }

    // Pair variety: rotate the starting candidate each cycle so activity
    // spreads across currencies instead of hammering the single widest edge.
    cycleN += 1;
    if (attempts.length > 1) {
      const k = cycleN % attempts.length;
      attempts = [...attempts.slice(k), ...attempts.slice(0, k)];
    }

    let lastFailure: string | null = null;
    for (const { c, kind } of attempts.slice(0, 3)) {
      if (kind === "rotation") {
        const estLegCostUsd = (tradeUsd * (c.roundTripCostBps / 2)) / 10_000;
        if (state.dayCostUsd + estLegCostUsd > config.desk.dailyCostCapUsd) continue;
      }
      try {
        await executeSwap(c.tokenIn, c.tokenOut, c.amountIn, kind, c.edgeBps, usdPer, c.roundTripCostBps);
        recordCycle();
        return;
      } catch (e) {
        lastFailure = e instanceof Error ? e.message.slice(0, 200) : "swap failed";
        console.warn(`[desk] ${kind} ${c.tokenIn.symbol}->${c.tokenOut.symbol} failed, trying next:`, lastFailure);
      }
    }

    recordCycle(lastFailure ?? undefined);
  } catch (e) {
    recordCycle(e instanceof Error ? e.message : "cycle failed");
    console.error("[desk] cycle error:", e);
  }
}

let timer: NodeJS.Timeout | null = null;
let cycleN = 0;

export function startDesk(): void {
  if (!config.desk.enabled) {
    console.log("[desk] disabled (set DESK_ENABLED=1 to trade)");
    return;
  }
  if (!config.agentPrivateKey) {
    console.warn("[desk] AGENT_PRIVATE_KEY missing, desk cannot trade");
    return;
  }
  console.log(
    `[desk] live: base ${config.desk.baseSymbol}, pairs ${config.desk.counterSymbols.length ? config.desk.counterSymbols.join("/") : "ALL (self-discovered)"}, $${config.desk.tradeUsd}/trade, every ${config.desk.intervalSec}s, cost cap $${config.desk.dailyCostCapUsd}/day`,
  );
  const tick = () => void runCycle();
  timer = setInterval(tick, config.desk.intervalSec * 1000);
  setTimeout(tick, 5_000);
}

export function stopDesk(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
