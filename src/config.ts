import "dotenv/config";

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var ${name}`);
  }
  return v;
}

function num(name: string, fallback: string): number {
  const v = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(v)) throw new Error(`Env var ${name} is not a number`);
  return v;
}

export const CHAIN_ID = 42220;
export const NETWORK = "eip155:42220"; // x402 v2 network id for Celo mainnet

export const USDC = {
  address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as const,
  decimals: 6,
  eip712: { name: "USDC", version: "2" },
};

export const ERC8004 = {
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const,
  reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as const,
};

export const config = {
  agentAddress: req("AGENT_ADDRESS"),
  agentPrivateKey: process.env.AGENT_PRIVATE_KEY ?? "",
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  agentName: process.env.AGENT_NAME ?? "Kiosk",
  agentDescription:
    process.env.AGENT_DESCRIPTION ??
    "Autonomous storefront agent on Celo. Pay-per-call market data, onchain lookups, and stake-to-play arcade games, settled in USDC via x402.",
  agentImageUrl: process.env.AGENT_IMAGE_URL ?? "",
  facilitatorUrl: (process.env.X402_FACILITATOR_URL ?? "https://api.x402.celo.org").replace(/\/$/, ""),
  x402ApiKey: process.env.X402_API_KEY ?? "",
  celoRpc: process.env.CELO_RPC ?? "https://forno.celo.org",
  port: num("PORT", "3000"),
  // DEV ONLY: skip the paywall and simulate payouts so the full flow can be
  // exercised locally without real money. Never set in production.
  devUnpaid: process.env.DEV_UNPAID === "1",
  prices: {
    micro: BigInt(req("PRICE_MICRO", "5000")),
    lookup: BigInt(req("PRICE_LOOKUP", "10000")),
    premium: BigInt(req("PRICE_PREMIUM", "250000")),
  },
  game: {
    normal: {
      stake: BigInt(req("GAME_NORMAL_STAKE", "100000")),
      payoutNum: num("GAME_NORMAL_PAYOUT_NUM", "150"),
      drawRefundNum: num("GAME_NORMAL_DRAW_REFUND_NUM", "80"),
      blunder: num("GAME_NORMAL_BLUNDER", "0.08"),
    },
    hard: {
      stake: BigInt(req("GAME_HARD_STAKE", "250000")),
      payoutNum: num("GAME_HARD_PAYOUT_NUM", "300"),
      drawRefundNum: num("GAME_HARD_DRAW_REFUND_NUM", "70"),
      blunder: num("GAME_HARD_BLUNDER", "0.03"),
    },
    dailyCap: num("GAME_DAILY_CAP", "50"),
  },
};

export function usd(atomic: bigint): string {
  const whole = atomic / 1000000n;
  const frac = (atomic % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `$${whole}.${frac}` : `$${whole}`;
}
