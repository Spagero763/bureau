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

const PAYER_KEY = process.env.PAYER_PRIVATE_KEY ?? "";
const ENABLED = process.env.SELF_BUY_ENABLED === "1";
const INTERVAL_SEC = Number(process.env.SELF_BUY_INTERVAL_SEC ?? "180");
// Refill the payer from the agent when it drops below this many dollars.
const REFILL_BELOW_USD = Number(process.env.SELF_BUY_REFILL_BELOW_USD ?? "0.5");
const REFILL_AMOUNT_USD = Number(process.env.SELF_BUY_REFILL_USD ?? "1");

let payFetch: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null = null;
let payerAddress = "";

async function ensurePayerFunded(): Promise<void> {
  const bal = await publicClient.readContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [payerAddress as `0x${string}`],
  });
  if (Number(bal) / 1e6 < REFILL_BELOW_USD) {
    const amount = BigInt(Math.round(REFILL_AMOUNT_USD * 1e6));
    await sendUsdc(payerAddress, amount); // tagged transfer from the agent
    console.log(`[selfbuy] refilled payer with $${REFILL_AMOUNT_USD}`);
  }
}

async function buyOnce(): Promise<void> {
  try {
    await ensurePayerFunded();
    const target = `http://localhost:${config.port}/v1/fx/rates`;
    const res = await payFetch!(target);
    if (res.ok) {
      recordSelfBuy();
    } else {
      console.warn(`[selfbuy] purchase failed: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    }
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
  payerAddress = account.address;
  const client = new x402Client().register(NETWORK, new ExactEvmScheme(account));
  payFetch = wrapFetchWithPayment(fetch, client);
  console.log(`[selfbuy] live: payer ${payerAddress}, every ${INTERVAL_SEC}s`);
  setInterval(() => void buyOnce(), INTERVAL_SEC * 1000);
  setTimeout(() => void buyOnce(), 15_000);
}
