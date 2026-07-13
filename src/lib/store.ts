import { randomUUID } from "node:crypto";
import type { Board } from "./tictactoe.js";

export type GameMode = "normal" | "hard";

export interface Game {
  id: string;
  mode: GameMode;
  board: Board;
  payer: string; // wallet that paid the stake; receives winnings/refunds
  stake: bigint;
  payoutNum: number;
  drawRefundNum: number;
  blunder: number;
  status: "open" | "settled";
  outcome?: "win" | "draw" | "lose";
  payoutTx?: string;
  createdAt: number;
}

const games = new Map<string, Game>();
const GAME_TTL_MS = 60 * 60 * 1000;

// paid games per payer per UTC day, for the daily cap
const dailyCount = new Map<string, number>();
let dailyKeyDate = new Date().toISOString().slice(0, 10);

function rollDaily() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyKeyDate) {
    dailyCount.clear();
    dailyKeyDate = today;
  }
}

export function gamesToday(payer: string): number {
  rollDaily();
  return dailyCount.get(payer.toLowerCase()) ?? 0;
}

export function countGame(payer: string): void {
  rollDaily();
  const k = payer.toLowerCase();
  dailyCount.set(k, (dailyCount.get(k) ?? 0) + 1);
}

export function createGame(g: Omit<Game, "id" | "createdAt" | "status">): Game {
  sweep();
  const game: Game = { ...g, id: randomUUID(), createdAt: Date.now(), status: "open" };
  games.set(game.id, game);
  return game;
}

export function getGame(id: string): Game | undefined {
  return games.get(id);
}

function sweep() {
  const cutoff = Date.now() - GAME_TTL_MS;
  for (const [id, g] of games) {
    if (g.createdAt < cutoff) games.delete(id);
  }
}
