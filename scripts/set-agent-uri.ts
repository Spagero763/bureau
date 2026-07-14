// One-shot: update the agent's onchain metadata URI (ERC-8004 setAgentURI),
// gas paid in USDm, attribution-tagged. Reads the data URI from data-uri.txt.
// Usage: npx tsx scripts/set-agent-uri.ts

import { readFileSync } from "node:fs";
import { encodeFunctionData } from "viem";
import { config, ERC8004 } from "../src/config.js";
import { feeParams, publicClient, walletClient } from "../src/lib/celo.js";
import { withAttribution } from "../src/lib/attribution.js";

const AGENT_ID = 9675n;

const setAgentUriAbi = [
  {
    type: "function",
    name: "setAgentURI",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newUri", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

async function main() {
  const newUri = readFileSync("scripts/data-uri.txt", "utf8").trim();
  if (!newUri.startsWith("data:application/json;base64,")) throw new Error("data-uri.txt malformed");
  // sanity: decodes to valid JSON with our name
  const decoded = JSON.parse(Buffer.from(newUri.split(",")[1], "base64").toString("utf8"));
  console.log(`metadata ok: name=${decoded.name}, services=${decoded.services?.length}, x402=${decoded.x402support}`);

  const wallet = walletClient();
  const hash = await wallet.sendTransaction({
    to: ERC8004.identityRegistry,
    data: withAttribution(
      encodeFunctionData({ abi: setAgentUriAbi, functionName: "setAgentURI", args: [AGENT_ID, newUri] }),
    ),
    chain: wallet.chain,
    account: wallet.account!,
    ...(await feeParams()),
  } as Parameters<typeof wallet.sendTransaction>[0]);
  console.log(`tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  console.log(`status: ${receipt.status}`);

  const uri = await publicClient.readContract({
    address: ERC8004.identityRegistry,
    abi: setAgentUriAbi,
    functionName: "tokenURI",
    args: [AGENT_ID],
  });
  console.log(`onchain URI now ${uri.startsWith("data:") ? "is the data URI" : uri.slice(0, 60)} (${uri.length} chars)`);
  console.log(`celoscan: https://celoscan.io/tx/${hash}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message.slice(0, 400) : e);
  process.exit(1);
});
