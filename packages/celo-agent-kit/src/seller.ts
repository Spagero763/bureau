import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer, type RoutesConfig } from "@x402/core/server";
import type { PaymentOption } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { CELO_NETWORK, CELO_USDC } from "./chain.js";

export interface PricedRoute {
  /** Price in whole USDC, e.g. 0.01 */
  price: number;
  description: string;
  mimeType?: string;
}

export interface SellerOptions {
  payTo: `0x${string}`;
  /** Keyed like "GET /v1/rates". Wildcards work: "GET /v1/token/*". */
  routes: Record<string, PricedRoute>;
  facilitatorUrl?: string;
  apiKey?: string;
  token?: { address: `0x${string}`; decimals: number; eip712: { name: string; version: string } };
  onEvent?: (e: SellerEvent) => void;
}

export type SellerEvent =
  | { type: "settled"; amount: string; payTo: string; tx?: string }
  | { type: "settle-failed"; detail: string }
  | { type: "verify-failed"; detail: string }
  | { type: "out-of-credits" };

/**
 * x402 paywall for Celo. Mount before your routes.
 *
 * The EIP-712 domain is pinned explicitly because a wrong one produces a
 * signature that verifies as garbage rather than a readable error.
 */
export function celoSeller(opts: SellerOptions) {
  const token = opts.token ?? CELO_USDC;

  const priceOf = (whole: number): PaymentOption => ({
    scheme: "exact",
    network: CELO_NETWORK,
    payTo: opts.payTo,
    price: {
      amount: Math.round(whole * 10 ** token.decimals).toString(),
      asset: token.address,
      extra: { name: token.eip712.name, version: token.eip712.version },
    },
  });

  const facilitator = new HTTPFacilitatorClient({
    url: (opts.facilitatorUrl ?? "https://api.x402.celo.org").replace(/\/$/, ""),
    createAuthHeaders: async () => {
      const auth: Record<string, string> = opts.apiKey ? { "X-API-Key": opts.apiKey } : {};
      return { verify: { ...auth }, settle: { ...auth }, supported: { ...auth } };
    },
  });

  // Without this a caller only sees a second 402 and cannot tell a bad
  // signature from an exhausted facilitator balance.
  const emit = (e: SellerEvent) => opts.onEvent?.(e);
  const origVerify = facilitator.verify.bind(facilitator);
  const origSettle = facilitator.settle.bind(facilitator);

  facilitator.verify = async (payload, requirements) => {
    const r = await origVerify(payload, requirements);
    if (!r.isValid) emit({ type: "verify-failed", detail: JSON.stringify(r) });
    return r;
  };

  facilitator.settle = async (payload, requirements) => {
    try {
      const r = await origSettle(payload, requirements);
      if (r.success) {
        emit({ type: "settled", amount: requirements.amount, payTo: requirements.payTo, tx: r.transaction });
      } else {
        emit({ type: "settle-failed", detail: JSON.stringify(r) });
      }
      return r;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      if (detail.includes("insufficient_credits")) emit({ type: "out-of-credits" });
      else emit({ type: "settle-failed", detail });
      throw e;
    }
  };

  const server = new x402ResourceServer(facilitator).register(CELO_NETWORK, new ExactEvmScheme());

  const routes: RoutesConfig = Object.fromEntries(
    Object.entries(opts.routes).map(([pattern, r]) => [
      pattern,
      { accepts: priceOf(r.price), description: r.description, mimeType: r.mimeType ?? "application/json" },
    ]),
  );

  return paymentMiddleware(routes, server);
}

/** Machine-readable price list, so other agents can discover you without paying first. */
export function catalog(opts: Pick<SellerOptions, "payTo" | "routes">) {
  return {
    network: CELO_NETWORK,
    payTo: opts.payTo,
    asset: CELO_USDC.address,
    endpoints: Object.entries(opts.routes).map(([pattern, r]) => {
      const [method, path] = pattern.split(" ");
      return { method, path, priceUsd: r.price, description: r.description };
    }),
  };
}
