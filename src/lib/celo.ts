import { CeloChain, erc20Abi } from "celo-agent-kit";
import type { PublicClient, WalletClient } from "viem";
import { config } from "../config.js";

export { erc20Abi };

/** Pay gas in a Celo fee currency (e.g. USDm) so the agent needs no CELO. */
export function feeCurrency(): `0x${string}` | undefined {
  const fc = process.env.FEE_CURRENCY ?? "";
  return fc.startsWith("0x") ? (fc as `0x${string}`) : undefined;
}

export const chain = new CeloChain({
  rpcUrl: config.celoRpc,
  feeCurrency: feeCurrency(),
});

export const publicClient: PublicClient = chain.publicClient;

export async function feeParams(gasLimit?: bigint): Promise<Record<string, unknown>> {
  return chain.feeParams(gasLimit);
}

let signed = false;

export function walletClient(): WalletClient {
  if (!config.agentPrivateKey) {
    throw new Error("AGENT_PRIVATE_KEY is not set; payouts are disabled");
  }
  if (!signed) {
    chain.withSigner(config.agentPrivateKey as `0x${string}`);
    signed = true;
  }
  return chain.walletClient();
}
