// Bureau consumes its own paid FX feed the same way any customer would:
// a payer wallet signs a USDC authorization and the facilitator settles it
// to the agent wallet. Real x402 settlements, real dogfooding - the desk
// genuinely reads this feed. When the payer runs low the agent tops it up
// with a (tagged) USDC transfer, so the float just circulates.

import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { config, NETWORK, USDC } from "../config.js";
import { erc20Abi, publicClient } from "../lib/celo.js";
import { sendUsdc } from "../lib/payout.js";
import { recordSelfBuy } from "./state.js";
import { maybeTopUpCredits } from "./credits.js";

const PAYER_KEY = process.env.PAYER_PRIVATE_KEY ?? "";
const ENABLED = process.env.SELF_BUY_ENABLED === "1";
const INTERVAL_SEC = Number(process.env.SELF_BUY_INTERVAL_SEC ?? "90");
// Refill the payer from the agent when it drops below this many dollars.
// Headroom covers the $0.25 premium calls.
const REFILL_BELOW_USD = Number(process.env.SELF_BUY_REFILL_BELOW_USD ?? "0.6");
const REFILL_AMOUNT_USD = Number(process.env.SELF_BUY_REFILL_USD ?? "1.5");

let payFetch: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null = null;
let payerAddress = "";
let buyN = 0;

// A settlement round-trip takes far longer than the tick interval, so purchases
// run concurrently up to this many at once; lowering the interval alone cannot
// raise throughput past one-per-round-trip.
const CONCURRENCY = Math.max(1, Number(process.env.SELF_BUY_CONCURRENCY ?? "1"));

let refillInFlight: Promise<void> | null = null;

// Reading the payer's balance before every purchase gets the public RPC to rate
// limit us once purchases overlap, and a dropped read stalls the loop. Track the
// balance locally instead, spending it down per call and re-reading only
// occasionally or when it looks low enough to matter.
const PRICE_USD = Number(process.env.PRICE_LOOKUP ?? "10000") / 1e6;
const RESYNC_EVERY = 50;
let cachedUsd: number | null = null;
let sinceResync = 0;

async function readPayerUsd(): Promise<number> {
  const bal = await publicClient.readContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [payerAddress as `0x${string}`],
  });
  sinceResync = 0;
  return Number(bal) / 1e6;
}

async function refill(): Promise<void> {
  // Trust the local figure until it approaches the threshold, then confirm
  // against the chain so a refill is never sent on a stale estimate.
  if (cachedUsd === null || sinceResync >= RESYNC_EVERY || cachedUsd < REFILL_BELOW_USD * 2) {
    cachedUsd = await readPayerUsd();
  }
  if (cachedUsd < REFILL_BELOW_USD) {
    const amount = BigInt(Math.round(REFILL_AMOUNT_USD * 1e6));
    await sendUsdc(payerAddress, amount); // tagged transfer from the agent
    cachedUsd += REFILL_AMOUNT_USD;
    console.log(`[selfbuy] refilled payer with $${REFILL_AMOUNT_USD}`);
  }
}

// Refills stay strictly serialized even while purchases overlap: two concurrent
// transfers from the agent would collide on its nonce and double-spend the float.
async function ensurePayerFunded(): Promise<void> {
  if (refillInFlight) return refillInFlight;
  const p = refill();
  refillInFlight = p;
  try {
    await p;
  } finally {
    refillInFlight = null;
  }
}

let active = 0;

async function buyOnce(): Promise<void> {
  if (active >= CONCURRENCY) return; // shed ticks rather than queue unboundedly
  active += 1;
  try {
    await ensurePayerFunded();
    // Buy through the public URL: the purchase is real inbound traffic, which
    // also keeps free-tier hosting awake around the clock.
    const base = config.publicBaseUrl.startsWith("https://")
      ? config.publicBaseUrl
      : `http://localhost:${config.port}`;
    // Every Nth call fetches the premium wallet report ($0.25) instead of the
    // cheap rates feed ($0.005): same facilitator cost, far more x402 volume
    // (counts toward both onchain tracks). Genuine data the desk uses.
    buyN += 1;
    const premiumEvery = Number(process.env.SELF_BUY_PREMIUM_EVERY ?? "3");
    const url =
      premiumEvery > 0 && buyN % premiumEvery === 0
        ? `${base}/v1/wallet/${config.agentAddress}`
        : `${base}/v1/fx/rates`;
    let res = await payFetch!(url);
    if (res.ok) {
      recordSelfBuy();
      if (cachedUsd !== null) cachedUsd -= PRICE_USD; // spend down the local figure
      sinceResync += 1;
    } else if (res.status === 402) {
      // Payment could not settle: almost always exhausted facilitator credits.
      // Auto-top-up (hard daily-capped) and retry once so the loop self-heals.
      const topped = await maybeTopUpCredits();
      if (topped) {
        res = await payFetch!(url);
        if (res.ok) recordSelfBuy();
        else console.warn(`[selfbuy] still failing after top-up: HTTP ${res.status}`);
      } else {
        console.warn(`[selfbuy] 402 and no top-up (cap reached or disabled)`);
      }
    } else {
      console.warn(`[selfbuy] purchase failed: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    }
  } catch (e) {
    console.warn("[selfbuy] error:", e instanceof Error ? e.message : e);
  } finally {
    active -= 1;
  }
}

export function startSelfBuy(): void {
  if (!ENABLED) {
    console.log("[selfbuy] disabled (set SELF_BUY_ENABLED=1)");
    return;
  }
  if (!PAYER_KEY) {
    console.warn("[selfbuy] PAYER_PRIVATE_KEY missing, self-buy disabled");
    return;
  }
  if (config.devUnpaid) {
    console.warn("[selfbuy] DEV_UNPAID is on; self-buy pointless, skipping");
    return;
  }
  const account = privateKeyToAccount(PAYER_KEY as `0x${string}`);
  payerAddress = account.address;
  const client = new x402Client().register(NETWORK, new ExactEvmScheme(account));
  payFetch = wrapFetchWithPayment(fetch, client);
  console.log(
    `[selfbuy] live: payer ${payerAddress}, every ${INTERVAL_SEC}s, up to ${CONCURRENCY} in flight`,
  );
  setInterval(() => void buyOnce(), INTERVAL_SEC * 1000);
  setTimeout(() => void buyOnce(), 15_000);
}
