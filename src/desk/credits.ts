// Auto-top-up for x402 facilitator credits. When the self-buy loop hits a 402
// (credits exhausted), buy a small batch by sending USDC to the facilitator
// treasury and registering it, but never spend more than a hard daily cap.

import { encodeFunctionData, parseUnits } from "viem";
import { erc20Abi, feeParams, publicClient, walletClient } from "../lib/celo.js";
import { config, USDC } from "../config.js";

const TREASURY = "0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48";

const ENABLED = process.env.CREDIT_AUTO_TOPUP === "1";
const BATCH_USD = Number(process.env.CREDIT_TOPUP_BATCH_USD ?? "2");
const DAILY_CAP_USD = Number(process.env.CREDIT_TOPUP_DAILY_CAP_USD ?? "2");
const SITE = "https://x402.celo.org";

let daySpent = 0;
let dayKey = new Date().toISOString().slice(0, 10);
let busy = false;

function rollDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    daySpent = 0;
  }
}

/** Returns true if a top-up was performed. Safe to call on every 402. */
export async function maybeTopUpCredits(): Promise<boolean> {
  if (!ENABLED || busy) return false;
  rollDay();
  if (daySpent + BATCH_USD > DAILY_CAP_USD) {
    console.warn(`[credits] daily top-up cap $${DAILY_CAP_USD} reached; x402 loop paused until UTC midnight`);
    return false;
  }
  busy = true;
  try {
    const wallet = walletClient();
    const amount = parseUnits(BATCH_USD.toString(), USDC.decimals);
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [TREASURY, amount] });
    // clean transfer (no attribution suffix) so the facilitator matches it
    const hash = await wallet.sendTransaction({
      to: USDC.address,
      data,
      chain: wallet.chain,
      account: wallet.account!,
      ...(await feeParams()),
    } as Parameters<typeof wallet.sendTransaction>[0]);
    await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });

    let credited = false;
    for (let i = 0; i < 15; i++) {
      const r = (await fetch(`${SITE}/api/topup/${hash}`).then((x) => x.json()).catch(() => ({}))) as { status?: string };
      if (r.status === "credited") {
        credited = true;
        break;
      }
      if (r.status === "unmatched") break;
      await new Promise((s) => setTimeout(s, 3000));
    }
    if (credited) {
      daySpent += BATCH_USD;
      console.log(`[credits] topped up $${BATCH_USD} (~${BATCH_USD / 0.001} payments); day spend $${daySpent}/${DAILY_CAP_USD}`);
      return true;
    }
    console.warn(`[credits] top-up tx ${hash} not credited (status pending/unmatched)`);
    return false;
  } catch (e) {
    console.warn("[credits] top-up failed:", e instanceof Error ? e.message.slice(0, 120) : e);
    return false;
  } finally {
    busy = false;
  }
}
