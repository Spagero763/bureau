// Buys x402 facilitator credits by transferring USDC to the facilitator
// treasury from the agent wallet, then registering it via /api/topup/{txHash}.
// Credits are matched to the account by sender address. $0.001 per credit.
// Usage: node scripts/topup-credits.mjs <usdAmount>
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";

const TREASURY = "0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48";
const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const RPC = "https://forno.celo.org";

const pk = process.env.AGENT_PRIVATE_KEY || readFileSync(".env", "utf8").match(/^AGENT_PRIVATE_KEY=(.+)$/m)?.[1]?.trim();
const acct = privateKeyToAccount(pk);
const usd = process.argv[2] || "3";
const amount = parseUnits(usd, 6);

const pc = createPublicClient({ chain: celo, transport: http(RPC) });
const wc = createWalletClient({ account: acct, chain: celo, transport: http(RPC) });

const data = encodeFunctionData({
  abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }],
  functionName: "transfer",
  args: [TREASURY, amount],
});

console.log(`Buying ~${Number(usd) / 0.001} credits ($${usd} USDC) for ${acct.address}`);
const hash = await wc.sendTransaction({ to: USDC, data });
console.log("treasury tx:", hash);
await pc.waitForTransactionReceipt({ hash, timeout: 120000 });
console.log("confirmed. registering with facilitator…");

for (let i = 0; i < 20; i++) {
  const r = await fetch(`https://x402.celo.org/api/topup/${hash}`).then((x) => x.json()).catch(() => ({}));
  const status = r.status ?? JSON.stringify(r).slice(0, 80);
  console.log(`  topup status: ${status}`);
  if (status === "credited") break;
  if (status === "unmatched") { console.log("  NOT matched to account — check sender wallet"); break; }
  await new Promise((s) => setTimeout(s, 3000));
}

const acc = await fetch(`https://x402.celo.org/api/account?address=${acct.address}`).then((x) => x.json());
console.log("new balance:", JSON.stringify(acc.balances));
