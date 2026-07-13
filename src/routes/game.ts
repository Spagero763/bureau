import type { Express, NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { payerFromRequest } from "../lib/payment.js";
import { houseBalance, sendUsdc } from "../lib/payout.js";
import { botMove, emptyBoard, terminal } from "../lib/tictactoe.js";
import { countGame, createGame, gamesToday, getGame, type Game, type GameMode } from "../lib/store.js";

function view(g: Game) {
  return {
    id: g.id,
    mode: g.mode,
    board: g.board,
    you: "X",
    status: g.status,
    outcome: g.outcome ?? null,
    stakeUsdc: g.stake.toString(),
    winPaysUsdc: ((g.stake * BigInt(g.payoutNum)) / 100n).toString(),
    drawRefundsUsdc: ((g.stake * BigInt(g.drawRefundNum)) / 100n).toString(),
    payoutTx: g.payoutTx ?? null,
    payer: g.payer,
  };
}

async function settleGame(g: Game): Promise<void> {
  if (g.status === "settled" || !g.outcome) return;
  if (g.outcome === "lose") {
    g.status = "settled";
    return;
  }
  if (config.devUnpaid) {
    g.payoutTx = "0xDEV_SIMULATED_PAYOUT";
    g.status = "settled";
    return;
  }
  const amount =
    g.outcome === "win"
      ? (g.stake * BigInt(g.payoutNum)) / 100n
      : (g.stake * BigInt(g.drawRefundNum)) / 100n;
  if (amount === 0n) {
    g.status = "settled";
    return;
  }
  g.payoutTx = await sendUsdc(g.payer, amount);
  g.status = "settled";
}

/**
 * Runs BEFORE the payment middleware settles a stake: refuses the game while
 * the request is still unpaid if the house cannot cover the win or the payer
 * is over the daily cap, so nobody's money is taken for a game we cannot pay.
 */
export function gamePrecheck(mode: GameMode) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (config.devUnpaid) return next();

    const params = config.game[mode];
    const maxPayout = (params.stake * BigInt(params.payoutNum)) / 100n;

    if (!config.agentPrivateKey) {
      return res.status(503).json({ error: "games are temporarily disabled (payouts unavailable)" });
    }

    try {
      const bal = await houseBalance();
      if (bal < maxPayout) {
        return res.status(503).json({ error: "house cannot cover a win right now, try again later" });
      }
    } catch {
      return res.status(503).json({ error: "cannot verify house balance, try again later" });
    }

    const payer = payerFromRequest(req);
    if (payer && gamesToday(payer) >= config.game.dailyCap) {
      return res.status(429).json({ error: `daily cap of ${config.game.dailyCap} games reached for this wallet` });
    }

    next();
  };
}

function startGame(mode: GameMode) {
  return (req: Request, res: Response) => {
    let payer = payerFromRequest(req);
    if (!payer && config.devUnpaid) {
      payer = "0x000000000000000000000000000000000000dEaD";
    }
    if (!payer) {
      // The middleware only lets paid requests through, so this should not
      // happen; refuse rather than start a game we cannot pay out.
      return res.status(400).json({ error: "could not determine payer wallet from payment header" });
    }
    const params = config.game[mode];
    const game = createGame({
      mode,
      board: emptyBoard(),
      payer,
      stake: params.stake,
      payoutNum: params.payoutNum,
      drawRefundNum: params.drawRefundNum,
      blunder: params.blunder,
    });
    countGame(payer);
    res.status(201).json({
      ...view(game),
      howToPlay: `POST ${config.publicBaseUrl}/v1/game/${game.id}/move with JSON body {"cell": 0-8}. You are X, cells are row-major, you move first.`,
    });
  };
}

export function registerGameRoutes(app: Express) {
  app.post("/v1/game/normal", startGame("normal"));
  app.post("/v1/game/hard", startGame("hard"));

  app.get("/v1/game/:id", (req: Request, res: Response) => {
    const g = getGame(req.params.id);
    if (!g) return res.status(404).json({ error: "game not found or expired" });
    res.json(view(g));
  });

  app.post("/v1/game/:id/move", async (req: Request, res: Response) => {
    const g = getGame(req.params.id);
    if (!g) return res.status(404).json({ error: "game not found or expired" });
    if (g.outcome) return res.status(409).json({ error: "game is already finished", game: view(g) });

    const cell = Number((req.body ?? {}).cell);
    if (!Number.isInteger(cell) || cell < 0 || cell > 8) {
      return res.status(400).json({ error: "body must be {\"cell\": 0-8}" });
    }
    if (g.board[cell] !== null) {
      return res.status(400).json({ error: "cell is taken" });
    }

    g.board[cell] = "X";
    let t = terminal(g.board);
    let botCell: number | null = null;
    if (!t.over) {
      botCell = botMove(g.board, g.blunder);
      g.board[botCell] = "O";
      t = terminal(g.board);
    }

    if (t.over) {
      g.outcome = t.result;
      try {
        await settleGame(g);
      } catch (e) {
        // Payout failed; outcome stands and can be retried below.
        return res.status(202).json({
          ...view(g),
          botCell,
          settlement: "pending",
          settlementError: e instanceof Error ? e.message : "payout failed",
          retry: `POST ${config.publicBaseUrl}/v1/game/${g.id}/settle`,
        });
      }
    }

    res.json({ ...view(g), botCell });
  });

  // Retry a payout that failed (e.g. transient RPC error). Idempotent.
  app.post("/v1/game/:id/settle", async (req: Request, res: Response) => {
    const g = getGame(req.params.id);
    if (!g) return res.status(404).json({ error: "game not found or expired" });
    if (!g.outcome) return res.status(409).json({ error: "game is not finished" });
    try {
      await settleGame(g);
      res.json(view(g));
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : "payout failed", game: view(g) });
    }
  });
}
