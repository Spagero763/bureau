// Offline sanity checks for the game engine and its economics.
// Usage: npm run test:game

import { botMove, emptyBoard, terminal, type Board } from "../src/lib/tictactoe.js";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
}

// 1. A perfect bot (blunder 0) never loses, regardless of opponent strategy.
{
  let losses = 0;
  for (let trial = 0; trial < 500; trial++) {
    const board: Board = emptyBoard();
    while (!terminal(board).over) {
      // random player move
      const open = board.map((c, i) => (c === null ? i : -1)).filter((i) => i >= 0);
      board[open[Math.floor(Math.random() * open.length)]] = "X";
      if (terminal(board).over) break;
      board[botMove(board, 0)] = "O";
    }
    if (terminal(board).result === "win") losses++;
  }
  assert(losses === 0, "perfect bot never loses (500 random games)");
}

// 2. A blundering bot is genuinely beatable by a strong player.
{
  let wins = 0;
  const N = 2000;
  for (let trial = 0; trial < N; trial++) {
    const board: Board = emptyBoard();
    while (!terminal(board).over) {
      // strong player: use the engine itself with no blunders, from X's perspective
      const flipped = board.map((c) => (c === "X" ? "O" : c === "O" ? "X" : c)) as Board;
      board[botMove(flipped, 0)] = "X";
      if (terminal(board).over) break;
      board[botMove(board, 0.10)] = "O";
    }
    if (terminal(board).result === "win") wins++;
  }
  const rate = wins / N;
  console.log(`strong player win rate vs 10% blunder bot: ${(rate * 100).toFixed(1)}%`);
  assert(rate > 0.02, "blundering bot is beatable");
  assert(rate < 0.5, "blundering bot is not a pushover");
}

// 3. House edge simulation at default economics, against PERFECT players
//    (worst case for the house; casual players lose more).
for (const [label, blunder, payout, drawRefund] of [
  ["normal (1.5x win, 80% draw refund, 8% blunder)", 0.08, 1.5, 0.8],
  ["hard (3x win, 70% draw refund, 3% blunder)", 0.03, 3.0, 0.7],
] as Array<[string, number, number, number]>) {
  const N = 5000;
  let pnl = 0; // house profit in stakes
  for (let trial = 0; trial < N; trial++) {
    const board: Board = emptyBoard();
    while (!terminal(board).over) {
      const flipped = board.map((c) => (c === "X" ? "O" : c === "O" ? "X" : c)) as Board;
      board[botMove(flipped, 0)] = "X";
      if (terminal(board).over) break;
      board[botMove(board, blunder)] = "O";
    }
    const r = terminal(board).result;
    if (r === "win") pnl += 1 - payout;
    else if (r === "draw") pnl += 1 - drawRefund;
    else pnl += 1;
  }
  const edge = pnl / N;
  console.log(`house edge vs PERFECT players, ${label}: ${(edge * 100).toFixed(1)}% of stake per game`);
  assert(edge > -0.01, `house edge is not materially negative for ${label}`);
}

console.log("\nall game checks done");
