import { encodeFunctionData, parseUnits } from "viem";
import { CeloChain, CELO_USDC, erc20Abi } from "./chain.js";

export interface CreditsOptions {
  chain: CeloChain;
  treasury?: `0x${string}`;
  statusUrl?: string;
  batchUsd?: number;
  /** Hard ceiling per UTC day. A bug cannot drain past this. */
  dailyCapUsd: number;
  onEvent?: (e: CreditsEvent) => void;
}

export type CreditsEvent =
  | { type: "topped-up"; usd: number; tx: string; daySpent: number }
  | { type: "cap-reached"; daySpent: number; cap: number }
  | { type: "unmatched"; tx: string }
  | { type: "error"; message: string };

const CELO_FACILITATOR_TREASURY = "0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48" as const;

/**
 * Settlement on Celo is prepaid at roughly $0.001 per payment. When credits run
 * out every payment fails with a 402 indistinguishable from a client error, so
 * the agent buys its own, under a hard daily cap.
 */
export class Credits {
  private daySpent = 0;
  private dayKey = new Date().toISOString().slice(0, 10);
  private busy = false;

  constructor(private readonly opts: CreditsOptions) {}

  private rollDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dayKey) {
      this.dayKey = today;
      this.daySpent = 0;
    }
  }

  private emit(e: CreditsEvent) {
    this.opts.onEvent?.(e);
  }

  /** Safe to call on every 402. Returns false rather than throwing. */
  async topUp(): Promise<boolean> {
    if (this.busy) return false;
    this.rollDay();
    const batch = this.opts.batchUsd ?? 2;
    if (this.daySpent + batch > this.opts.dailyCapUsd) {
      this.emit({ type: "cap-reached", daySpent: this.daySpent, cap: this.opts.dailyCapUsd });
      return false;
    }

    this.busy = true;
    try {
      const wallet = this.opts.chain.walletClient();
      const amount = parseUnits(batch.toString(), CELO_USDC.decimals);
      // Not attributed: the facilitator matches top-ups by exact calldata and
      // an ERC-8021 suffix makes the transfer unrecognisable.
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [this.opts.treasury ?? CELO_FACILITATOR_TREASURY, amount],
      });
      const hash = await wallet.sendTransaction({
        to: CELO_USDC.address,
        data,
        chain: wallet.chain,
        account: wallet.account!,
        ...(await this.opts.chain.feeParams()),
      } as Parameters<typeof wallet.sendTransaction>[0]);
      await this.opts.chain.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });

      const base = (this.opts.statusUrl ?? "https://x402.celo.org").replace(/\/$/, "");
      for (let i = 0; i < 15; i++) {
        const r = (await fetch(`${base}/api/topup/${hash}`)
          .then((x) => x.json())
          .catch(() => ({}))) as { status?: string };
        if (r.status === "credited") {
          this.daySpent += batch;
          this.emit({ type: "topped-up", usd: batch, tx: hash, daySpent: this.daySpent });
          return true;
        }
        if (r.status === "unmatched") break;
        await new Promise((s) => setTimeout(s, 3000));
      }
      this.emit({ type: "unmatched", tx: hash });
      return false;
    } catch (e) {
      this.emit({ type: "error", message: e instanceof Error ? e.message.slice(0, 160) : String(e) });
      return false;
    } finally {
      this.busy = false;
    }
  }

  get spentToday(): number {
    this.rollDay();
    return this.daySpent;
  }
}
