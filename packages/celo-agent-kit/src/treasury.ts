import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import { CeloChain, CELO_USDC, erc20Abi } from "./chain.js";
import { Attribution } from "./attribution.js";

export interface TreasuryOptions {
  chain: CeloChain;
  /** The wallet that spends, funded from the signer. */
  spender: `0x${string}`;
  token?: { address: `0x${string}`; decimals: number };
  /** Refill when the spender drops below this, in whole tokens. */
  refillBelow: number;
  refillAmount: number;
  attribution?: Attribution;
  /** Reconcile the tracked balance against the chain every N spends. */
  resyncEvery?: number;
  /** Warn below this many CELO. Refills cost gas. */
  gasFloor?: number;
  onEvent?: (e: TreasuryEvent) => void;
}

export type TreasuryEvent =
  | { type: "refilled"; amount: number; tx: string }
  | { type: "resync"; balance: number }
  | { type: "gas-low"; celo: number; floor: number }
  | { type: "error"; message: string };

/**
 * Keeps a spending wallet funded from an earning wallet.
 *
 * Three things here are not obvious until this runs under load: concurrent
 * refills collide on the sender nonce and lose the float, reading the balance
 * before every spend gets a public node to throttle you, and an agent can hold
 * plenty of stablecoin but no native token to move it with.
 */
export class Treasury {
  private readonly token: { address: `0x${string}`; decimals: number };
  private readonly resyncEvery: number;
  private readonly gasFloor: number;
  private cached: number | null = null;
  private sinceResync = 0;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly opts: TreasuryOptions) {
    this.token = opts.token ?? { address: CELO_USDC.address, decimals: CELO_USDC.decimals };
    this.resyncEvery = opts.resyncEvery ?? 50;
    this.gasFloor = opts.gasFloor ?? 0.05;
  }

  private emit(e: TreasuryEvent) {
    this.opts.onEvent?.(e);
  }

  async readBalance(): Promise<number> {
    const raw = await this.opts.chain.publicClient.readContract({
      address: this.token.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.opts.spender],
    });
    this.sinceResync = 0;
    return Number(formatUnits(raw, this.token.decimals));
  }

  get balance(): number | null {
    return this.cached;
  }

  /** Local bookkeeping, no RPC call. Call after each successful spend. */
  recordSpend(amount: number): void {
    if (this.cached !== null) this.cached -= amount;
    this.sinceResync += 1;
  }

  /** Safe to call before every spend, and safe to call concurrently. */
  async ensureFunded(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const p = this.refill();
    this.inFlight = p;
    try {
      await p;
    } finally {
      this.inFlight = null;
    }
  }

  private async refill(): Promise<void> {
    const stale = this.sinceResync >= this.resyncEvery;
    const nearThreshold = this.cached !== null && this.cached < this.opts.refillBelow * 2;
    if (this.cached === null || stale || nearThreshold) {
      this.cached = await this.readBalance();
      this.emit({ type: "resync", balance: this.cached });
    }
    if (this.cached >= this.opts.refillBelow) return;

    await this.assertGas();
    const amount = parseUnits(this.opts.refillAmount.toString(), this.token.decimals);
    const tx = await this.transfer(this.opts.spender, amount);
    this.cached += this.opts.refillAmount;
    this.emit({ type: "refilled", amount: this.opts.refillAmount, tx });
  }

  async transfer(to: `0x${string}`, amount: bigint, opts?: { attribute?: boolean }): Promise<string> {
    const wallet = this.opts.chain.walletClient();
    let data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
    // Some counterparties match transfers by exact calldata, so the suffix can be waived.
    if (opts?.attribute !== false && this.opts.attribution) {
      data = this.opts.attribution.apply(data);
    }
    const hash = await wallet.sendTransaction({
      to: this.token.address,
      data,
      chain: wallet.chain,
      account: wallet.account!,
      ...(await this.opts.chain.feeParams()),
    } as Parameters<typeof wallet.sendTransaction>[0]);
    await this.opts.chain.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    return hash;
  }

  async assertGas(): Promise<void> {
    if (this.opts.chain.feeCurrency) return;
    try {
      const wei = await this.opts.chain.publicClient.getBalance({
        address: this.opts.chain.account().address,
      });
      const celo = Number(formatUnits(wei, 18));
      if (celo < this.gasFloor) this.emit({ type: "gas-low", celo, floor: this.gasFloor });
    } catch (e) {
      this.emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }
}
