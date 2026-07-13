// Plays N optimal games against a locally running DEV_UNPAID server and
// reports the outcome distribution. Usage: npx tsx scripts/batch-local.ts
import { botMove, type Board } from "../src/lib/tictactoe.js";

const base = process.env.DEMO_BASE_URL ?? "http://localhost:3399";

async function req(path: string, init?: RequestInit) {
  const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(10_000) });
  return res.json() as Promise<Record<string, unknown>>;
}

async function main() {
  const results: Record<string, number> = { win: 0, draw: 0, lose: 0 };
  let payoutSeen = false;

  for (let i = 0; i < 12; i++) {
    const g = await req("/v1/game/normal", { method: "POST" });
    if (!g.id) throw new Error("failed to start game: " + JSON.stringify(g));
    let state = g;
    let guard = 0;
    while (!state.outcome && guard++ < 10) {
      const board = state.board as Board;
      const flip = board.map((c) => (c === "X" ? "O" : c === "O" ? "X" : c)) as Board;
      const cell = botMove(flip, 0);
      state = await req(`/v1/game/${g.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cell }),
      });
      if (state.error) throw new Error("move failed: " + JSON.stringify(state));
    }
    results[String(state.outcome)] = (results[String(state.outcome)] ?? 0) + 1;
    if (state.payoutTx) payoutSeen = true;
    process.stdout.write(`game ${i + 1}: ${state.outcome}\n`);
  }

  console.log("outcomes over 12 optimal games:", results);
  console.log("simulated payout tx present on win/draw:", payoutSeen);

  const g2 = await req("/v1/game/hard", { method: "POST" });
  console.log(`hard mode: stake ${g2.stakeUsdc}, win pays ${g2.winPaysUsdc}, draw refunds ${g2.drawRefundsUsdc}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
