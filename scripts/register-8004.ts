// Register the agent on the Celo ERC-8004 Identity Registry.
// Usage: npm run register
// Needs AGENT_PRIVATE_KEY and PUBLIC_BASE_URL in .env, plus a little CELO for gas.

import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { config, ERC8004 } from "../src/config.js";
import { identityRegistryAbi } from "../src/lib/erc8004.js";
import { withAttribution } from "../src/lib/attribution.js";

async function main() {
  if (!config.agentPrivateKey) throw new Error("AGENT_PRIVATE_KEY is not set");
  const account = privateKeyToAccount(config.agentPrivateKey as `0x${string}`);
  const publicClient = createPublicClient({ chain: celo, transport: http(config.celoRpc) });
  const wallet = createWalletClient({ account, chain: celo, transport: http(config.celoRpc) });

  const agentURI = `${config.publicBaseUrl}/.well-known/agent-card.json`;
  console.log(`Registering agent`);
  console.log(`  registry: ${ERC8004.identityRegistry} (Celo mainnet)`);
  console.log(`  owner:    ${account.address}`);
  console.log(`  agentURI: ${agentURI}`);

  // Sanity check: the registration file must be publicly reachable.
  try {
    const res = await fetch(agentURI, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json();
    console.log("  agent card is live and valid JSON");
  } catch (e) {
    console.warn(`  WARNING: could not fetch agent card (${e instanceof Error ? e.message : e}).`);
    console.warn("  Deploy the server first so the registry points at a live file. Continuing anyway.");
  }

  const feeCurrency = (process.env.FEE_CURRENCY ?? "").startsWith("0x")
    ? (process.env.FEE_CURRENCY as `0x${string}`)
    : undefined;
  const hash = await wallet.sendTransaction({
    to: ERC8004.identityRegistry,
    data: withAttribution(
      encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: [agentURI] }),
    ),
    feeCurrency,
  } as Parameters<typeof wallet.sendTransaction>[0]);
  console.log(`  tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  status: ${receipt.status}`);

  for (const log of receipt.logs) {
    try {
      const parsed = decodeEventLog({ abi: identityRegistryAbi, data: log.data, topics: log.topics });
      if (parsed.eventName === "Registered") {
        const agentId = (parsed.args as { agentId: bigint }).agentId;
        console.log(`\nAgent ID: ${agentId}`);
        console.log(`Registry entry: https://celoscan.io/tx/${hash}`);
        console.log(`8004scan: https://8004scan.io/agents (filter Celo, id ${agentId})`);
        return;
      }
    } catch {
      // not our event
    }
  }
  console.log("Registered, but could not decode the Registered event; check the tx on celoscan.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
