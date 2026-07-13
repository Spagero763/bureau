// Desk statistics with JSON file persistence so the dashboard and volume
// numbers survive restarts.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface TradeRecord {
  at: string;
  pair: string; // e.g. "USDm->cEUR"
  amountInUsd: number;
  edgeBps: number; // signed edge vs reference at decision time
  txHash: string;
  kind: "edge" | "rotation";
}

export interface DeskState {
  startedAt: string;
  totalVolumeUsd: number;
  totalTrades: number;
  dayKey: string;
  dayCostUsd: number; // realized spread/fee cost today (positive = cost)
  dayVolumeUsd: number;
  lastCycleAt: string | null;
  lastError: string | null;
  paused: boolean;
  selfBuys: number; // x402 purchases of our own feed
  trades: TradeRecord[]; // most recent first, capped
}

const FILE = join(process.cwd(), "data", "desk.json");
const MAX_TRADES = 200;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function fresh(): DeskState {
  return {
    startedAt: new Date().toISOString(),
    totalVolumeUsd: 0,
    totalTrades: 0,
    dayKey: today(),
    dayCostUsd: 0,
    dayVolumeUsd: 0,
    lastCycleAt: null,
    lastError: null,
    paused: false,
    selfBuys: 0,
    trades: [],
  };
}

let state: DeskState = load();

function load(): DeskState {
  try {
    return { ...fresh(), ...JSON.parse(readFileSync(FILE, "utf8")) };
  } catch {
    return fresh();
  }
}

function save() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch {
    // persistence is best-effort
  }
}

function rollDay() {
  if (state.dayKey !== today()) {
    state.dayKey = today();
    state.dayCostUsd = 0;
    state.dayVolumeUsd = 0;
  }
}

export function deskState(): DeskState {
  rollDay();
  return state;
}

export function recordCycle(error?: string) {
  rollDay();
  state.lastCycleAt = new Date().toISOString();
  state.lastError = error ?? null;
  save();
}

export function recordTrade(t: TradeRecord, costUsd: number) {
  rollDay();
  state.totalTrades += 1;
  state.totalVolumeUsd += t.amountInUsd;
  state.dayVolumeUsd += t.amountInUsd;
  state.dayCostUsd += costUsd;
  state.trades.unshift(t);
  if (state.trades.length > MAX_TRADES) state.trades.length = MAX_TRADES;
  save();
}

export function setPaused(paused: boolean) {
  state.paused = paused;
  save();
}

export function recordSelfBuy() {
  state.selfBuys += 1;
  save();
}
