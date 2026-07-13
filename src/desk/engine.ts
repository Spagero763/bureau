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
import { feeCurrency, publicClient, walletClient, erc20Abi } from "../lib/celo.js";
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
    feeCurrency: feeCurrency(),
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
  const outUsd = usdValue(tokenOut, prepared.expectedAmountOut, usdPer);
  const txHash = await sendTagged(prepared.params as CallParamsLike);

  recordTrade(
    {
      at: new Date().toISOString(),
      pair: `${tokenIn.symbol}->${tokenOut.symbol}`,
      amountInUsd: Math.round(inUsd * 100) / 100,
      edgeBps: Math.round(edgeBps * 10) / 10,
      txHash,
      kind,
    },
    Math.max(0, Math.round((inUsd - outUsd) * 10000) / 10000),
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

    const counters = tokens.filter((t) =>
      config.desk.counterSymbols.some((s) => s.toLowerCase() === t.symbol.toLowerCase()),
    );
    if (counters.length === 0) throw new Error("no counter tokens found on Mento");

    const tradeUsd = config.desk.tradeUsd;
    const baseAmount = parseUnits(tradeUsd.toString(), base.decimals);
    const baseBal = await balanceOf(base);

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

      const out = await quote(base.address, c.address, baseAmount).catch(() => 0n);
      if (out === 0n) continue;
      const impliedUsdPer = tradeUsd / Number(formatUnits(out, c.decimals));
      const buyEdgeBps = ((refUsdPer - impliedUsdPer) / refUsdPer) * 10_000;

      // round-trip estimate for rotation costing
      const back = await quote(c.address, base.address, out).catch(() => 0n);
      const roundTripCostBps = back === 0n ? Infinity : (1 - Number(formatUnits(back, base.decimals)) / tradeUsd) * 10_000;

      if (baseBal >= baseAmount) {
        candidates.push({ tokenIn: base, tokenOut: c, amountIn: baseAmount, edgeBps: buyEdgeBps, roundTripCostBps });
      }

      const cBal = await balanceOf(c);
      const cBalUsd = usdValue(c, cBal, usdPer);
      if (cBalUsd >= tradeUsd * 0.9) {
        const sellAmount = parseUnits((tradeUsd / refUsdPer).toFixed(Math.min(6, c.decimals)), c.decimals);
        if (cBal >= sellAmount) {
          candidates.push({
            tokenIn: c,
            tokenOut: base,
            amountIn: sellAmount,
            edgeBps: -buyEdgeBps,
            roundTripCostBps,
          });
        }
      }
    }

    // 1. Best edge trade above threshold
    const best = candidates.filter((x) => x.edgeBps >= config.desk.minEdgeBps).sort((a, b) => b.edgeBps - a.edgeBps)[0];
    if (best) {
      await executeSwap(best.tokenIn, best.tokenOut, best.amountIn, "edge", best.edgeBps, usdPer);
      recordCycle();
      return;
    }

    // 2. Rotation: cheapest viable leg within cost budget
    if (config.desk.rotation) {
      const viable = candidates
        .filter((x) => x.roundTripCostBps <= config.desk.maxRotationCostBps)
        .sort((a, b) => b.edgeBps - a.edgeBps)[0]; // least-bad direction first
      if (viable) {
        const estLegCostUsd = (tradeUsd * (viable.roundTripCostBps / 2)) / 10_000;
        if (state.dayCostUsd + estLegCostUsd <= config.desk.dailyCostCapUsd) {
          await executeSwap(viable.tokenIn, viable.tokenOut, viable.amountIn, "rotation", viable.edgeBps, usdPer);
          recordCycle();
          return;
        }
      }
    }

    recordCycle();
  } catch (e) {
    recordCycle(e instanceof Error ? e.message : "cycle failed");
    console.error("[desk] cycle error:", e);
  }
}

let timer: NodeJS.Timeout | null = null;

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
    `[desk] live: base ${config.desk.baseSymbol}, pairs ${config.desk.counterSymbols.join("/")}, $${config.desk.tradeUsd}/trade, every ${config.desk.intervalSec}s, cost cap $${config.desk.dailyCostCapUsd}/day`,
  );
  const tick = () => void runCycle();
  timer = setInterval(tick, config.desk.intervalSec * 1000);
  setTimeout(tick, 5_000);
}

export function stopDesk(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
