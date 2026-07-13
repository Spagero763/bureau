import { erc20Abi, publicClient, walletClient } from "./celo.js";
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

/** Send USDC from the agent wallet. Returns the tx hash. */
export async function sendUsdc(to: string, amount: bigint): Promise<string> {
  const wallet = walletClient();
  const hash = await wallet.writeContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to as `0x${string}`, amount],
    chain: wallet.chain,
    account: wallet.account!,
  });
  await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  return hash;
}
