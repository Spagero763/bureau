// One-time bootstrap: convert part of the agent's USDm into USDC reserve
// (for game payouts and self-buy refills) via Mento, with gas paid in USDm
// and the attribution tag on every transaction. Then verify the tag decodes.
// Usage: npx tsx scripts/bootstrap-usdc.ts [usd amount, default 3]

import { createRequire } from "node:module";
import { formatUnits, parseUnits, type Hex } from "viem";
import { config, USDC } from "../src/config.js";
import { erc20Abi, feeCurrency, publicClient, walletClient } from "../src/lib/celo.js";
import { withAttribution } from "../src/lib/attribution.js";
import { mento, tokenBySymbol } from "../src/desk/mento.js";

const require = createRequire(import.meta.url);
const { verifyTx } = require("@celo/attribution-tags") as {
  verifyTx: (args: { client: unknown; hash: string }) => Promise<{ codes: string[] } | null>;
};
const { deadlineFromMinutes } = require("@mento-protocol/mento-sdk") as {
  deadlineFromMinutes: (m: number) => bigint;
};

async function sendTagged(params: { to: string; data: string; value?: string | bigint }): Promise<string> {
  const wallet = walletClient();
  const hash = await wallet.sendTransaction({
    to: params.to as `0x${string}`,
    data: withAttribution(params.data as Hex),
    value: params.value === undefined ? undefined : BigInt(params.value),
    chain: wallet.chain,
    account: wallet.account!,
    feeCurrency: feeCurrency(),
  } as Parameters<typeof wallet.sendTransaction>[0]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  console.log(`  tx ${hash} -> ${receipt.status}`);
  return hash;
}

async function main() {
  const amountUsd = process.argv[2] ?? "3";
  const usdm = await tokenBySymbol("USDm");
  if (!usdm) throw new Error("USDm not found");
  const amountIn = parseUnits(amountUsd, usdm.decimals);

  console.log(`Converting ${amountUsd} USDm -> USDC (agent ${config.agentAddress})`);
  const m = await mento();
  const prepared = await m.swap.prepareSwap({
    tokenIn: usdm.address,
    tokenOut: USDC.address,
    amountIn,
    slippageTolerance: 0.5,
    recipient: config.agentAddress,
    owner: config.agentAddress,
    deadline: deadlineFromMinutes(5),
  });
  console.log(`  expected out: ${formatUnits(prepared.expectedAmountOut, USDC.decimals)} USDC`);

  let lastHash = "";
  if (prepared.approval) {
    console.log("  sending approval (tagged)...");
    lastHash = await sendTagged(prepared.approval as { to: string; data: string });
  }
  if (!prepared.params) throw new Error("no swap params");
  console.log("  sending swap (tagged)...");
  lastHash = await sendTagged(prepared.params as { to: string; data: string });

  // Verify the attribution tag decodes from the swap tx.
  const decoded = await verifyTx({ client: publicClient, hash: lastHash });
  console.log(`  attribution codes: ${JSON.stringify(decoded?.codes ?? [])}`);
  if (!decoded?.codes.includes(config.attributionTag)) {
    throw new Error("TAG NOT FOUND IN TX - do not scale up until fixed");
  }

  const usdcBal = await publicClient.readContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [config.agentAddress as `0x${string}`],
  });
  console.log(`\nDone. USDC reserve: ${formatUnits(usdcBal, USDC.decimals)}. Tag verified onchain.`);
  console.log(`celoscan: https://celoscan.io/tx/${lastHash}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
