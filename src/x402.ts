// Bureau's price list. The x402 wiring lives in celo-agent-kit.

import { celoSeller, type PricedRoute } from "celo-agent-kit";
import { config, usd } from "./config.js";

/** Atomic USDC (6dp) to whole dollars, which is what the kit prices in. */
const whole = (atomic: bigint): number => Number(atomic) / 1e6;

export function routeTable(): Record<string, PricedRoute> {
  const p = config.prices;
  const g = config.game;
  return {
    "GET /v1/fx/rates": {
      price: whole(p.lookup),
      description:
        "Live onchain FX table: Mento implied USD price per Celo stable vs real-world reference, deviation in bps",
    },
    "GET /v1/fx/quote": {
      price: whole(p.lookup),
      description: "Executable Mento quote for any Celo stable pair (from, to, amount)",
    },
    "GET /v1/rates": {
      price: whole(p.micro),
      description: "Spot USD prices for CELO, USDC, USDT, ETH, BTC",
    },
    "GET /v1/gas": {
      price: whole(p.micro),
      description: "Current Celo gas price and base fee",
    },
    "GET /v1/token/*": {
      price: whole(p.lookup),
      description: "ERC-20 metadata and supply on Celo",
    },
    "GET /v1/agents/*": {
      price: whole(p.lookup),
      description: "ERC-8004 agent lookup on Celo",
    },
    "GET /v1/wallet/*": {
      price: whole(p.premium),
      description: "Celo wallet balance report with USD estimates",
    },
    "POST /v1/game/normal": {
      price: whole(g.normal.stake),
      description: `Stake ${usd(g.normal.stake)} on noughts & crosses vs the agent; win pays ${g.normal.payoutNum / 100}x`,
    },
    "POST /v1/game/hard": {
      price: whole(g.hard.stake),
      description: `Stake ${usd(g.hard.stake)} on hard-mode noughts & crosses; win pays ${g.hard.payoutNum / 100}x`,
    },
  };
}

export function buildPaymentMiddleware() {
  return celoSeller({
    payTo: config.agentAddress as `0x${string}`,
    routes: routeTable(),
    facilitatorUrl: config.facilitatorUrl,
    apiKey: config.x402ApiKey,
    onEvent: (e) => {
      switch (e.type) {
        case "settled":
          console.log(`[x402] settled ${e.amount} to ${e.payTo} tx ${e.tx}`);
          break;
        case "out-of-credits":
          console.error("[x402] facilitator credits exhausted; top up at x402.celo.org");
          break;
        case "settle-failed":
          console.warn("[x402] settle failed:", e.detail);
          break;
        case "verify-failed":
          console.warn("[x402] verify failed:", e.detail);
          break;
      }
    },
  });
}
