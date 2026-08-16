// Bureau consumes its own paid feed the same way any customer would: a payer
// wallet signs a USDC authorization and the facilitator settles it to the agent
// wallet. When the payer runs low the agent tops it up with a tagged transfer,
// so the float circulates.

import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { Treasury, attribution, startConcurrentLoop } from "celo-agent-kit";
import { config, NETWORK } from "../config.js";
import { chain, walletClient } from "../lib/celo.js";
import { heartbeat } from "../lib/health.js";
import { recordSelfBuy } from "./state.js";
import { maybeTopUpCredits } from "./credits.js";

const PAYER_KEY = process.env.PAYER_PRIVATE_KEY ?? "";
const ENABLED = process.env.SELF_BUY_ENABLED === "1";
const INTERVAL_SEC = Number(process.env.SELF_BUY_INTERVAL_SEC ?? "90");
const REFILL_BELOW_USD = Number(process.env.SELF_BUY_REFILL_BELOW_USD ?? "0.6");
const REFILL_AMOUNT_USD = Number(process.env.SELF_BUY_REFILL_USD ?? "1.5");
// A settlement outlasts the tick interval, so purchases overlap. Lowering the
// interval alone cannot raise throughput past one per round trip.
const CONCURRENCY = Math.max(1, Number(process.env.SELF_BUY_CONCURRENCY ?? "1"));
const PRICE_USD = Number(process.env.PRICE_LOOKUP ?? "10000") / 1e6;

let payFetch: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null = null;
let treasury: Treasury | null = null;
let buyN = 0;

async function buyOnce(): Promise<void> {
  try {
    await treasury!.ensureFunded();
    // Buy through the public URL so the purchase is real inbound traffic.
    const base = config.publicBaseUrl.startsWith("https://")
      ? config.publicBaseUrl
      : `http://localhost:${config.port}`;
    // Every Nth call takes the premium wallet report instead of the cheap rates
    // feed: same facilitator cost, far more x402 volume.
    buyN += 1;
    const premiumEvery = Number(process.env.SELF_BUY_PREMIUM_EVERY ?? "3");
    const url =
      premiumEvery > 0 && buyN % premiumEvery === 0
        ? `${base}/v1/wallet/${config.agentAddress}`
        : `${base}/v1/fx/rates`;

    let res = await payFetch!(url);
    if (res.ok) {
      recordSelfBuy();
      heartbeat.progress();
      treasury!.recordSpend(PRICE_USD);
      return;
    }

    if (res.status === 402) {
      // Almost always exhausted facilitator credits rather than a bad payment.
      const topped = await maybeTopUpCredits();
      if (!topped) {
        console.warn("[selfbuy] 402 and no top-up (cap reached or disabled)");
        return;
      }
      res = await payFetch!(url);
      if (res.ok) {
        recordSelfBuy();
        heartbeat.progress();
        treasury!.recordSpend(PRICE_USD);
      } else {
        console.warn(`[selfbuy] still failing after top-up: HTTP ${res.status}`);
      }
      return;
    }

    console.warn(`[selfbuy] purchase failed: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  } catch (e) {
    console.warn("[selfbuy] error:", e instanceof Error ? e.message : e);
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
  const client = new x402Client().register(NETWORK, new ExactEvmScheme(account));
  payFetch = wrapFetchWithPayment(fetch, client);

  walletClient(); // refills are sent from the agent wallet
  treasury = new Treasury({
    chain,
    spender: account.address,
    refillBelow: REFILL_BELOW_USD,
    refillAmount: REFILL_AMOUNT_USD,
    attribution: attribution(config.attributionTag),
    onEvent: (e) => {
      if (e.type === "refilled") console.log(`[selfbuy] refilled payer with $${e.amount}`);
      else if (e.type === "gas-low") console.warn(`[selfbuy] agent CELO low: ${e.celo} < ${e.floor}, refills will fail`);
      else if (e.type === "error") console.warn("[selfbuy] treasury:", e.message);
    },
  });

  console.log(`[selfbuy] live: payer ${account.address}, every ${INTERVAL_SEC}s, up to ${CONCURRENCY} in flight`);
  startConcurrentLoop({ intervalSec: INTERVAL_SEC, concurrency: CONCURRENCY, task: buyOnce });
  setTimeout(() => void buyOnce(), 15_000);
}
