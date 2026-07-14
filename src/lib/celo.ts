import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { config } from "../config.js";

export const publicClient: PublicClient = createPublicClient({
  chain: celo,
  transport: http(config.celoRpc),
}) as PublicClient;

// Pay gas in a Celo fee currency (e.g. USDm) so the agent needs no CELO.
export function feeCurrency(): `0x${string}` | undefined {
  const fc = process.env.FEE_CURRENCY ?? "";
  return fc.startsWith("0x") ? (fc as `0x${string}`) : undefined;
}

/**
 * Explicit CIP-64 fee params. Fees for a fee-currency tx are denominated in
 * that currency's units, so we ask the node for the gas price in those units
 * and set a 2x cap; auto-estimation sometimes lowballs it and the node
 * rejects with "fee cap cannot be lower than block base fee".
 */
export async function feeParams(): Promise<Record<string, unknown>> {
  const fc = feeCurrency();
  if (!fc) return {};
  try {
    // The node validates the cap against the block base fee, while the
    // fee-currency gas price oracle can lag far below it. Anchor on the
    // live base fee and cap generously: with EIP-1559 you pay base+tip,
    // never the cap.
    const [block, gpFc] = await Promise.all([
      publicClient.getBlock({ blockTag: "latest" }),
      publicClient
        .request({ method: "eth_gasPrice" as never, params: [fc] as never })
        .then((v) => BigInt(v as string))
        .catch(() => 0n),
    ]);
    const base = block.baseFeePerGas ?? 0n;
    const anchor = base > gpFc ? base : gpFc;
    if (anchor === 0n) return { feeCurrency: fc };
    // Cap at 2x the anchor: rich enough for inter-block swings, lean enough
    // that a small stablecoin balance still passes the node's allowance check
    // (allowance = balance / maxFeePerGas).
    const tip = anchor / 10n + 1n;
    return { feeCurrency: fc, maxFeePerGas: anchor * 2n + tip, maxPriorityFeePerGas: tip };
  } catch {
    return { feeCurrency: fc };
  }
}

let _wallet: WalletClient | null = null;

export function walletClient(): WalletClient {
  if (!config.agentPrivateKey) {
    throw new Error("AGENT_PRIVATE_KEY is not set; payouts are disabled");
  }
  if (!_wallet) {
    const account = privateKeyToAccount(config.agentPrivateKey as `0x${string}`);
    _wallet = createWalletClient({ account, chain: celo, transport: http(config.celoRpc) });
  }
  return _wallet;
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
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
