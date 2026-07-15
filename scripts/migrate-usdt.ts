// Moves idle USDT from the payer wallet into the agent wallet and swaps it to
// USDm trading base (tagged). Usage: npx tsx scripts/migrate-usdt.ts
import { createRequire } from "node:module";
import {
  createWalletClient, http, encodeFunctionData, parseEther, formatUnits, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { config, USDC } from "../src/config.js";
import { erc20Abi, feeParams, publicClient, walletClient } from "../src/lib/celo.js";
import { withAttribution } from "../src/lib/attribution.js";
import { mento, tokenBySymbol } from "../src/desk/mento.js";

const require = createRequire(import.meta.url);
const { deadlineFromMinutes } = require("@mento-protocol/mento-sdk") as { deadlineFromMinutes: (m: number) => bigint };

const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as const;
const AGENT = config.agentAddress as `0x${string}`;

async function bal(token: `0x${string}`, who: `0x${string}`) {
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
}

async function main() {
  const payer = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY as `0x${string}`);
  const payerWallet = createWalletClient({ account: payer, chain: celo, transport: http(config.celoRpc) });
  const agent = walletClient();

  const usdtBal = await bal(USDT, payer.address);
  console.log(`payer USDT: ${formatUnits(usdtBal, 6)}`);
  if (usdtBal === 0n) return console.log("nothing to migrate");

  // 1. gas the payer (it holds no CELO)
  const payerCelo = await publicClient.getBalance({ address: payer.address });
  if (payerCelo < parseEther("0.05")) {
    console.log("funding payer with 0.2 CELO for gas...");
    const h = await agent.sendTransaction({ to: payer.address, value: parseEther("0.2"), chain: celo, account: agent.account! });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }

  // 2. move USDT payer -> agent
  console.log("moving USDT to agent...");
  const h2 = await payerWallet.sendTransaction({
    to: USDT,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [AGENT, usdtBal] }),
    chain: celo, account: payer.account!,
  } as Parameters<typeof payerWallet.sendTransaction>[0]);
  await publicClient.waitForTransactionReceipt({ hash: h2 });

  // 3. swap USDT -> USDm on the agent, tagged
  const usdm = await tokenBySymbol("USDm");
  if (!usdm) throw new Error("USDm not found");
  const amount = await bal(USDT, AGENT);
  console.log(`swapping ${formatUnits(amount, 6)} USDT -> USDm (tagged)...`);
  const m = await mento();
  const prepared = await m.swap.prepareSwap({
    tokenIn: USDT, tokenOut: usdm.address, amountIn: amount,
    slippageTolerance: 0.5, recipient: AGENT, owner: AGENT, deadline: deadlineFromMinutes(5),
  });
  if (prepared.approval) {
    const ha = await agent.sendTransaction({ to: (prepared.approval as any).to, data: withAttribution((prepared.approval as any).data as Hex), chain: celo, account: agent.account!, ...(await feeParams()) } as any);
    await publicClient.waitForTransactionReceipt({ hash: ha });
  }
  const hs = await agent.sendTransaction({ to: (prepared.params as any).to, data: withAttribution((prepared.params as any).data as Hex), chain: celo, account: agent.account!, ...(await feeParams()) } as any);
  const r = await publicClient.waitForTransactionReceipt({ hash: hs });
  console.log(`swap ${r.status}: https://celoscan.io/tx/${hs}`);

  const newUsdm = await bal(usdm.address as `0x${string}`, AGENT);
  const newUsdc = await bal(USDC.address, AGENT);
  console.log(`\nagent base now: ${formatUnits(newUsdm, 18)} USDm, ${formatUnits(newUsdc, 6)} USDC`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message.slice(0, 300) : e); process.exit(1); });
