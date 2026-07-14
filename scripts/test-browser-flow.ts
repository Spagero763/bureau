// Replicates public/play.html's payment construction EXACTLY (no x402 SDK)
// to prove the browser flow works end to end against production.
// Usage: npx tsx scripts/test-browser-flow.ts

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { botMove, type Board } from "../src/lib/tictactoe.js";

const BASE = process.env.DEMO_BASE_URL ?? "https://bureau-fnw3.onrender.com";
const account = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY as `0x${string}`);

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const fromB64 = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

async function main() {
  console.log("payer:", account.address);
  const path = "/v1/game/normal";
  const first = await fetch(BASE + path, { method: "POST" });
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
  const challenge = fromB64(first.headers.get("PAYMENT-REQUIRED")!);
  const acc = challenge.accepts[0];
  console.log(`challenge: ${acc.amount} of ${acc.asset.slice(0, 10)}… to ${acc.payTo.slice(0, 10)}…`);

  const authorization = {
    from: account.address,
    to: acc.payTo,
    value: acc.amount,
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + (acc.maxTimeoutSeconds ?? 300)),
    nonce: ("0x" + randomBytes(32).toString("hex")) as `0x${string}`,
  };
  // identical typed data to the page (viem adds EIP712Domain itself)
  const signature = await account.signTypedData({
    domain: { name: acc.extra.name, version: acc.extra.version, chainId: 42220, verifyingContract: acc.asset },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" },
        { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from as `0x${string}`,
      to: authorization.to as `0x${string}`,
      value: BigInt(authorization.value),
      validAfter: 0n,
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });

  const header = b64({ x402Version: 2, payload: { authorization, signature }, resource: challenge.resource, accepted: acc });
  const paid = await fetch(BASE + path, { method: "POST", headers: { "PAYMENT-SIGNATURE": header } });
  console.log("paid start:", paid.status);
  if (!paid.ok) throw new Error(await paid.text());
  let game = (await paid.json()) as { id: string; board: Board; outcome: string | null; payoutTx: string | null };

  while (!game.outcome) {
    const flip = game.board.map((c) => (c === "X" ? "O" : c === "O" ? "X" : c)) as Board;
    const cell = botMove(flip, 0);
    const res = await fetch(`${BASE}/v1/game/${game.id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cell }),
    });
    game = await res.json();
  }
  console.log(`outcome: ${game.outcome}${game.payoutTx ? `, payout/refund tx: ${game.payoutTx}` : ""}`);
  console.log("BROWSER FLOW VERIFIED");
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message.slice(0, 400) : e);
  process.exit(1);
});
