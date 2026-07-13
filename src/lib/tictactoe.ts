// Noughts & crosses engine. The player is X and always moves first; the bot is O.
// The bot plays minimax-optimal moves, except that with probability `blunder`
// it deliberately picks a suboptimal move, which is what makes it beatable.

export type Cell = "X" | "O" | null;
export type Board = Cell[]; // length 9, row-major

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
] as const;

export function emptyBoard(): Board {
  return Array(9).fill(null);
}

export function winner(board: Board): Cell {
  for (const [a, b, c] of LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return null;
}

export function isFull(board: Board): boolean {
  return board.every((c) => c !== null);
}

export type Terminal = { over: boolean; result?: "win" | "draw" | "lose" }; // from the player's (X) perspective

export function terminal(board: Board): Terminal {
  const w = winner(board);
  if (w === "X") return { over: true, result: "win" };
  if (w === "O") return { over: true, result: "lose" };
  if (isFull(board)) return { over: true, result: "draw" };
  return { over: false };
}

function legalMoves(board: Board): number[] {
  const moves: number[] = [];
  for (let i = 0; i < 9; i++) if (board[i] === null) moves.push(i);
  return moves;
}

// Minimax score from O's perspective: +1 O wins, 0 draw, -1 X wins.
// Depth-adjusted so the bot prefers fast wins and slow losses.
const memo = new Map<string, number>();

function score(board: Board, toMove: "X" | "O", depth: number): number {
  const w = winner(board);
  if (w === "O") return 10 - depth;
  if (w === "X") return depth - 10;
  if (isFull(board)) return 0;

  const key = board.map((c) => c ?? "-").join("") + toMove;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  const moves = legalMoves(board);
  let best = toMove === "O" ? -Infinity : Infinity;
  for (const m of moves) {
    board[m] = toMove;
    const s = score(board, toMove === "O" ? "X" : "O", depth + 1);
    board[m] = null;
    if (toMove === "O") best = Math.max(best, s);
    else best = Math.min(best, s);
  }
  memo.set(key, best);
  return best;
}

/** Pick the bot's move. With probability `blunder` it plays a random non-best move. */
export function botMove(board: Board, blunder: number, rng: () => number = Math.random): number {
  const moves = legalMoves(board);
  if (moves.length === 0) throw new Error("no legal moves");

  const scored = moves.map((m) => {
    board[m] = "O";
    const s = score(board, "X", 1);
    board[m] = null;
    return { m, s };
  });
  scored.sort((a, b) => b.s - a.s);

  const bestScore = scored[0].s;
  const bestMoves = scored.filter((x) => x.s === bestScore).map((x) => x.m);
  const subMoves = scored.filter((x) => x.s !== bestScore).map((x) => x.m);

  if (subMoves.length > 0 && rng() < blunder) {
    return subMoves[Math.floor(rng() * subMoves.length)];
  }
  return bestMoves[Math.floor(rng() * bestMoves.length)];
}
