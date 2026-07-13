// Pays for Kiosk endpoints with a real wallet, exactly the way another agent would.
// Usage:
//   DEMO_PRIVATE_KEY=0x... DEMO_BASE_URL=http://localhost:3000 npm run demo
//   optional: DEMO_PLAY=1 to also play a game of noughts & crosses.
// The wallet needs USDC on Celo mainnet. Payments are gasless (EIP-3009).

import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { botMove, terminal, type Board } from "../src/lib/tictactoe.js";

const baseUrl = (process.env.DEMO_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const pk = process.env.DEMO_PRIVATE_KEY;
if (!pk) {
  console.error("Set DEMO_PRIVATE_KEY to a funded wallet (USDC on Celo mainnet).");
  process.exit(1);
}

const account = privateKeyToAccount(pk as `0x${string}`);
const client = new x402Client().register("eip155:42220", new ExactEvmScheme(account));
const payFetch = wrapFetchWithPayment(fetch, client);

async function show(name: string, res: Response) {
  const body = await res.json().catch(() => ({}));
  console.log(`\n=== ${name} -> HTTP ${res.status} ===`);
  console.log(JSON.stringify(body, null, 2).slice(0, 1200));
  return body;
}

async function main() {
  console.log(`payer: ${account.address}`);
  console.log(`target: ${baseUrl}`);

  await show("catalog (free)", await fetch(`${baseUrl}/v1/catalog`));
  await show("rates (paid)", await payFetch(`${baseUrl}/v1/rates`));
  await show("gas (paid)", await payFetch(`${baseUrl}/v1/gas`));

  if (process.env.DEMO_PLAY === "1") {
    const g = (await show("new game (paid stake)", await payFetch(`${baseUrl}/v1/game/normal`, { method: "POST" }))) as {
      id: string;
      board: Board;
    };
    let board = g.board;
    // Play using the same engine the server uses, with zero blunders,
    // so the demo player is a strong opponent.
    while (true) {
      const flipped = board.map((c) => (c === "X" ? "O" : c === "O" ? "X" : c)) as Board;
      const myCell = botMove(flipped, 0);
      const res = await fetch(`${baseUrl}/v1/game/${g.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cell: myCell }),
      });
      const state = (await show(`move ${myCell}`, res)) as { board: Board; outcome: string | null; payoutTx: string | null };
      board = state.board;
      if (state.outcome) {
        console.log(`\nGame over: ${state.outcome}${state.payoutTx ? `, payout tx ${state.payoutTx}` : ""}`);
        break;
      }
      if (terminal(board).over) break;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
