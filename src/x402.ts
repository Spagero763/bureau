import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer, type RoutesConfig } from "@x402/core/server";
import type { PaymentOption } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { config, NETWORK, USDC, usd } from "./config.js";

function priceOf(atomic: bigint): PaymentOption {
  return {
    scheme: "exact",
    network: NETWORK,
    payTo: config.agentAddress,
    price: {
      amount: atomic.toString(),
      asset: USDC.address,
      // EIP-712 domain of Celo USDC, required for EIP-3009 signing
      extra: { name: USDC.eip712.name, version: USDC.eip712.version },
    },
  };
}

export function buildPaymentMiddleware() {
  const facilitator = new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
    createAuthHeaders: async () => {
      const auth: Record<string, string> = config.x402ApiKey ? { "X-API-Key": config.x402ApiKey } : {};
      return { verify: { ...auth }, settle: { ...auth }, supported: { ...auth } };
    },
  });

  const server = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());

  const p = config.prices;
  const g = config.game;

  const routes: RoutesConfig = {
    "GET /v1/rates": {
      accepts: priceOf(p.micro),
      description: "Spot USD prices for CELO, USDC, USDT, ETH, BTC",
      mimeType: "application/json",
    },
    "GET /v1/gas": {
      accepts: priceOf(p.micro),
      description: "Current Celo gas price and base fee",
      mimeType: "application/json",
    },
    "GET /v1/token/*": {
      accepts: priceOf(p.lookup),
      description: "ERC-20 metadata and supply on Celo",
      mimeType: "application/json",
    },
    "GET /v1/agents/*": {
      accepts: priceOf(p.lookup),
      description: "ERC-8004 agent lookup on Celo",
      mimeType: "application/json",
    },
    "GET /v1/wallet/*": {
      accepts: priceOf(p.premium),
      description: "Celo wallet balance report with USD estimates",
      mimeType: "application/json",
    },
    "POST /v1/game/normal": {
      accepts: priceOf(g.normal.stake),
      description: `Stake ${usd(g.normal.stake)} on noughts & crosses vs the agent; win pays ${g.normal.payoutNum / 100}x`,
      mimeType: "application/json",
    },
    "POST /v1/game/hard": {
      accepts: priceOf(g.hard.stake),
      description: `Stake ${usd(g.hard.stake)} on hard-mode noughts & crosses; win pays ${g.hard.payoutNum / 100}x`,
      mimeType: "application/json",
    },
  };

  return paymentMiddleware(routes, server);
}
