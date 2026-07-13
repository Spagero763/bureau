import { encodeFunctionData } from "viem";
import { erc20Abi, feeCurrency, publicClient, walletClient } from "./celo.js";
import { withAttribution } from "./attribution.js";
import { config, USDC } from "../config.js";

/** USDC balance of the agent wallet (atomic units). */
export async function houseBalance(): Promise<bigint> {
  return publicClient.readContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [config.agentAddress as `0x${string}`],
  });
}

/** Send USDC from the agent wallet, tagged for onchain attribution. Returns the tx hash. */
export async function sendUsdc(to: string, amount: bigint): Promise<string> {
  const wallet = walletClient();
  const data = withAttribution(
    encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [to as `0x${string}`, amount],
    }),
  );
  const hash = await wallet.sendTransaction({
    to: USDC.address,
    data,
    chain: wallet.chain,
    account: wallet.account!,
    feeCurrency: feeCurrency(),
  } as Parameters<typeof wallet.sendTransaction>[0]);
  await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  return hash;
}
