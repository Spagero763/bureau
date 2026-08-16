import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";

export const CELO_CHAIN_ID = 42220;
export const CELO_NETWORK = "eip155:42220";

export const CELO_USDC = {
  address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as const,
  decimals: 6,
  eip712: { name: "USDC", version: "2" },
} as const;

export interface ChainOptions {
  rpcUrl?: string;
  /** CIP-64 fee currency. Set it and the agent never needs a CELO balance. */
  feeCurrency?: `0x${string}`;
}

const DEFAULT_RPC = "https://forno.celo.org";

export class CeloChain {
  readonly publicClient: PublicClient;
  readonly feeCurrency?: `0x${string}`;
  private wallet: WalletClient | null = null;

  constructor(private readonly opts: ChainOptions = {}) {
    this.publicClient = createPublicClient({
      chain: celo,
      transport: http(opts.rpcUrl ?? DEFAULT_RPC),
    }) as PublicClient;
    this.feeCurrency = opts.feeCurrency;
  }

  withSigner(privateKey: `0x${string}`): this {
    this.wallet = createWalletClient({
      account: privateKeyToAccount(privateKey),
      chain: celo,
      transport: http(this.opts.rpcUrl ?? DEFAULT_RPC),
    });
    return this;
  }

  walletClient(): WalletClient {
    if (!this.wallet) throw new Error("No signer attached; call withSigner(privateKey) first");
    return this.wallet;
  }

  account(): Account {
    return this.walletClient().account!;
  }

  /**
   * Fee params for a transaction. Empty for native CELO.
   *
   * Fee-currency transactions need explicit values for two reasons: the
   * fee-currency gas oracle lags the block base fee and the node then rejects
   * the cap, and its estimator rejects these transactions outright because
   * allowance is balance / maxFeePerGas. So anchor on the higher of the two
   * and skip estimation. Unused gas is refunded.
   */
  async feeParams(gasLimit?: bigint): Promise<Record<string, unknown>> {
    const fc = this.feeCurrency;
    if (!fc) return {};
    try {
      const [block, oracle] = await Promise.all([
        this.publicClient.getBlock({ blockTag: "latest" }),
        this.publicClient
          .request({ method: "eth_gasPrice" as never, params: [fc] as never })
          .then((v) => BigInt(v as string))
          .catch(() => 0n),
      ]);
      const base = block.baseFeePerGas ?? 0n;
      const anchor = base > oracle ? base : oracle;
      if (anchor === 0n) return { feeCurrency: fc };
      const tip = anchor / 10n + 1n;
      return {
        feeCurrency: fc,
        maxFeePerGas: anchor * 2n + tip,
        maxPriorityFeePerGas: tip,
        gas: gasLimit ?? 250_000n,
      };
    } catch {
      return { feeCurrency: fc, gas: gasLimit ?? 250_000n };
    }
  }
}

export const erc20Abi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;
