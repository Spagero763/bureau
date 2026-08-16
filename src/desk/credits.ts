import { Credits } from "celo-agent-kit";
import { chain, walletClient } from "../lib/celo.js";

const ENABLED = process.env.CREDIT_AUTO_TOPUP === "1";
const BATCH_USD = Number(process.env.CREDIT_TOPUP_BATCH_USD ?? "2");
const DAILY_CAP_USD = Number(process.env.CREDIT_TOPUP_DAILY_CAP_USD ?? "2");

let credits: Credits | null = null;

function client(): Credits {
  if (!credits) {
    walletClient(); // attaches the signer to the shared chain
    credits = new Credits({
      chain,
      batchUsd: BATCH_USD,
      dailyCapUsd: DAILY_CAP_USD,
      onEvent: (e) => {
        switch (e.type) {
          case "topped-up":
            console.log(
              `[credits] topped up $${e.usd} (~${e.usd / 0.001} payments); day spend $${e.daySpent}/${DAILY_CAP_USD}`,
            );
            break;
          case "cap-reached":
            console.warn(`[credits] daily cap $${e.cap} reached; x402 loop paused until UTC midnight`);
            break;
          case "unmatched":
            console.warn(`[credits] top-up tx ${e.tx} not credited (pending or unmatched)`);
            break;
          case "error":
            console.warn("[credits] top-up failed:", e.message);
            break;
        }
      },
    });
  }
  return credits;
}

/** Returns true if a top-up was performed. Safe to call on every 402. */
export async function maybeTopUpCredits(): Promise<boolean> {
  if (!ENABLED) return false;
  return client().topUp();
}
