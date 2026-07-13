// Creates an x402.celo.org facilitator API key by signing with the agent
// wallet (no gas, no transaction). New keys include free mainnet credits.
// Usage: npx tsx scripts/get-x402-key.ts
// Prints the key once; put it in .env as X402_API_KEY.

import { privateKeyToAccount } from "viem/accounts";
import { config } from "../src/config.js";

const SITE = "https://x402.celo.org";

async function main() {
  if (!config.agentPrivateKey) throw new Error("AGENT_PRIVATE_KEY is not set");
  const account = privateKeyToAccount(config.agentPrivateKey as `0x${string}`);

  const { nonce } = (await (await fetch(`${SITE}/api/keys/nonce`)).json()) as { nonce: string };
  const message = `x402.celo.org wants you to create an x402 API key.\n\nAddress: ${account.address}\nNonce: ${nonce}\n\nSigning this message proves you control this wallet. It costs no gas and sends no transaction.`;
  const signature = await account.signMessage({ message });

  const res = await fetch(`${SITE}/api/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: account.address, nonce, signature }),
  });
  const body = (await res.json()) as { apiKey?: string; balances?: unknown; message?: string };
  if (!res.ok || !body.apiKey) {
    throw new Error(`key creation failed (HTTP ${res.status}): ${body.message ?? JSON.stringify(body)}`);
  }

  console.log("API key (shown once, save it to .env as X402_API_KEY):");
  console.log(body.apiKey);
  console.log("credit balances:", JSON.stringify(body.balances));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
