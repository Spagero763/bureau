// Recovery: sell held counter positions back to USDm so the agent has gas
// fuel again. Gas for the sale itself is paid in USDm (works with dust).
// Usage: npx tsx scripts/refuel.ts [symbol=BRLm]

import { createRequire } from "node:module";
import { encodeFunctionData, formatUnits, type Hex } from "viem";
import { config } from "../src/config.js";
import { erc20Abi, feeParams, publicClient, walletClient } from "../src/lib/celo.js";
import { withAttribution } from "../src/lib/attribution.js";
import { mento, tokenBySymbol } from "../src/desk/mento.js";

const require = createRequire(import.meta.url);
const { deadlineFromMinutes } = require("@mento-protocol/mento-sdk") as {
  deadlineFromMinutes: (m: number) => bigint;
};

async function sendTagged(params: { to: string; data: string; value?: string | bigint }) {
  const wallet = walletClient();
  const hash = await wallet.sendTransaction({
    to: params.to as `0x${string}`,
    data: withAttribution(params.data as Hex),
    value: params.value === undefined ? undefined : BigInt(params.value),
    chain: wallet.chain,
    account: wallet.account!,
    ...(await feeParams()),
  } as Parameters<typeof wallet.sendTransaction>[0]);
  const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  console.log(`  tx ${hash} -> ${r.status}`);
  return hash;
}

async function main() {
  const symbol = process.argv[2] ?? "BRLm";
  const [token, usdm] = await Promise.all([tokenBySymbol(symbol), tokenBySymbol("USDm")]);
  if (!token || !usdm) throw new Error("token not found");

  const bal = await publicClient.readContract({
    address: token.address as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [config.agentAddress as `0x${string}`],
  });
  console.log(`${symbol} balance: ${formatUnits(bal, token.decimals)}`);
  if (bal === 0n) return console.log("nothing to sell");

  const m = await mento();
  const prepared = await m.swap.prepareSwap({
    tokenIn: token.address,
    tokenOut: usdm.address,
    amountIn: bal,
    slippageTolerance: 0.5,
    recipient: config.agentAddress,
    owner: config.agentAddress,
    deadline: deadlineFromMinutes(5),
  });
  console.log(`  expected out: ${formatUnits(prepared.expectedAmountOut, usdm.decimals)} USDm`);
  if (prepared.approval) await sendTagged(prepared.approval as { to: string; data: string });
  if (!prepared.params) throw new Error("no swap params");
  await sendTagged(prepared.params as { to: string; data: string });

  const usdmBal = await publicClient.readContract({
    address: usdm.address as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [config.agentAddress as `0x${string}`],
  });
  console.log(`USDm now: ${formatUnits(usdmBal, usdm.decimals)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message.slice(0, 300) : e);
  process.exit(1);
});
