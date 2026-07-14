import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Express, Request, Response } from "express";
import { config, NETWORK, USDC, usd, ERC8004 } from "../config.js";

function catalog() {
  const p = config.prices;
  const g = config.game;
  return {
    name: config.agentName,
    description: config.agentDescription,
    baseUrl: config.publicBaseUrl,
    payment: {
      protocol: "x402",
      network: NETWORK,
      asset: { symbol: "USDC", address: USDC.address, decimals: USDC.decimals },
      payTo: config.agentAddress,
      facilitator: config.facilitatorUrl,
    },
    endpoints: [
      { method: "GET", path: "/v1/fx/rates", price: usd(p.lookup), description: "Live onchain FX table: Mento implied USD per Celo stable vs real-world reference, deviation in bps" },
      { method: "GET", path: "/v1/fx/quote", price: usd(p.lookup), description: "Executable Mento quote for any Celo stable pair (?from=USDm&to=cEUR&amount=100)" },
      { method: "GET", path: "/v1/fx/preview", price: "free", description: "Delayed, rounded FX preview (60s cache)" },
      { method: "GET", path: "/v1/desk", price: "free", description: "Live desk stats: volume, trades, cost controls" },
      { method: "GET", path: "/v1/rates", price: usd(p.micro), description: "Spot USD prices for CELO, USDC, USDT, ETH, BTC (30s cache)" },
      { method: "GET", path: "/v1/gas", price: usd(p.micro), description: "Current Celo gas price and latest block base fee" },
      { method: "GET", path: "/v1/token/:address", price: usd(p.lookup), description: "ERC-20 metadata and total supply on Celo" },
      { method: "GET", path: "/v1/agents/:id", price: usd(p.lookup), description: "ERC-8004 agent lookup: owner, agentURI, registration file" },
      { method: "GET", path: "/v1/wallet/:address", price: usd(p.premium), description: "Wallet report: CELO + stablecoin balances with USD estimate, nonce" },
      { method: "POST", path: "/v1/game/normal", price: usd(g.normal.stake), description: `Noughts & crosses vs the agent. Win pays ${g.normal.payoutNum / 100}x your stake, draw refunds ${g.normal.drawRefundNum}%.` },
      { method: "POST", path: "/v1/game/hard", price: usd(g.hard.stake), description: `Hard mode: near-perfect bot. Win pays ${g.hard.payoutNum / 100}x your stake, draw refunds ${g.hard.drawRefundNum}%.` },
      { method: "POST", path: "/v1/game/:id/move", price: "free", description: "Play a move in an open game (body: { cell: 0-8 })" },
      { method: "GET", path: "/v1/game/:id", price: "free", description: "Game state" },
      { method: "GET", path: "/v1/catalog", price: "free", description: "This catalog" },
    ],
    notes: [
      "Paid endpoints reply HTTP 402 with x402 payment requirements. Retry with a signed X-PAYMENT header; any x402 client works.",
      "Game payouts are sent automatically in USDC to the wallet that paid the stake.",
    ],
  };
}

export function registerCatalogRoutes(app: Express) {
  app.get("/healthz", (_req: Request, res: Response) => res.json({ ok: true }));

  // Dashboard for humans; machine catalog stays at /v1/catalog.
  let dashboardHtml: string | null = null;
  app.get("/", (req: Request, res: Response) => {
    if (req.accepts(["html", "json"]) === "json") return res.json(catalog());
    try {
      dashboardHtml ??= readFileSync(join(process.cwd(), "public", "dashboard.html"), "utf8");
      res.type("html").send(dashboardHtml);
    } catch {
      res.json(catalog());
    }
  });
  app.get("/v1/catalog", (_req: Request, res: Response) => res.json(catalog()));

  // Browser play page: connect a wallet, sign the stake, play in the page.
  let playHtml: string | null = null;
  app.get("/play", (_req: Request, res: Response) => {
    try {
      playHtml ??= readFileSync(join(process.cwd(), "public", "play.html"), "utf8");
      res.type("html").send(playHtml);
    } catch {
      res.redirect("/");
    }
  });

  // ERC-8004 registration file
  app.get("/.well-known/agent-card.json", (_req: Request, res: Response) => {
    res.json({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: config.agentName,
      description: config.agentDescription,
      image: config.agentImageUrl || undefined,
      services: [
        { name: "web", url: config.publicBaseUrl },
        { name: "catalog", url: `${config.publicBaseUrl}/v1/catalog` },
      ],
      endpoints: [
        { type: "web", url: config.publicBaseUrl },
        { type: "wallet", address: config.agentAddress, chainId: 42220 },
      ],
      x402: {
        network: NETWORK,
        payTo: config.agentAddress,
        catalog: `${config.publicBaseUrl}/v1/catalog`,
      },
      registrations: [
        {
          agentRegistry: `eip155:42220:${ERC8004.identityRegistry}`,
        },
      ],
      supportedTrust: ["reputation"],
    });
  });
}
