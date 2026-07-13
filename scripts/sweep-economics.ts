// Sweeps bot blunder rates against a PERFECT player (worst case for the house)
// and prints the house edge for payout-multiplier / draw-refund combinations.
// Usage: npx tsx scripts/sweep-economics.ts

import { botMove, emptyBoard, terminal, type Board } from "../src/lib/tictactoe.js";

for (const b of [0.03, 0.05, 0.08, 0.1, 0.15]) {
  let w = 0,
    d = 0,
    l = 0;
  const N = 4000;
  for (let t = 0; t < N; t++) {
    const board: Board = emptyBoard();
    while (!terminal(board).over) {
      const flip = board.map((c) => (c === "X" ? "O" : c === "O" ? "X" : c)) as Board;
      board[botMove(flip, 0)] = "X";
      if (terminal(board).over) break;
      board[botMove(board, b)] = "O";
    }
    const r = terminal(board).result;
    if (r === "win") w++;
    else if (r === "draw") d++;
    else l++;
  }
  const pw = w / N,
    pd = d / N,
    pl = l / N;
  const combos: Array<[number, number]> = [
    [1.5, 1],
    [1.5, 0.8],
    [1.6, 0.8],
    [1.8, 0.7],
    [2.0, 0.6],
  ];
  const edges = combos
    .map(([m, r]) => `${m}x/${r * 100}%ref: ${((1 - (pw * m + pd * r)) * 100).toFixed(1)}%`)
    .join("  ");
  console.log(
    `blunder ${b}: Pwin=${pw.toFixed(3)} Pdraw=${pd.toFixed(3)} Plose=${pl.toFixed(3)} | ${edges}`,
  );
}
