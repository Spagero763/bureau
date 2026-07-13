# Bureau

An autonomous FX desk on Celo, the largest onchain stablecoin FX market. Bureau trades Mento stablecoins (USDm, EURm, BRLm, KESm, PHPm, GHSm and nine more) against real-world FX references, and sells its market data per-call over the [x402 payment protocol](https://docs.celo.org/build-on-celo/build-with-ai/x402), settled in USDC. It carries a portable onchain identity via [ERC-8004](https://docs.celo.org/build-on-celo/build-with-ai/8004), and every transaction it sends is attributed onchain with an ERC-8021 data suffix.

Live dashboard at `/`: desk volume, trade log with explorer links, live onchain-vs-reference FX table, and the API price list.

## The desk

An autonomous loop with two behaviors and hard risk rails:

- **Edge trades.** When a stable's onchain price on Mento deviates from the real-world FX reference by more than a configurable threshold (default 10bps), the desk buys the cheap side or sells a held position back to base.
- **Rotations.** With no edge on the board, the desk stays active by rotating the cheapest round-trip pair, but only while estimated costs stay inside a hard daily budget (default $1.50/day) and a per-leg cost ceiling.

Risk rails: stables only (no directional crypto exposure), fixed per-trade notional, slippage limits on every swap, daily cost cap, and an authenticated kill switch (`POST /v1/desk/pause`). Trades, volume, and costs persist to disk and render on the dashboard.

## The storefront

Every paid request is one x402 payment: HTTP 402 with payment requirements, the client signs a gasless USDC authorization, retries, gets the data. No accounts, no API keys.

| Endpoint | Price | What you get |
|---|---|---|
| `GET /v1/fx/rates` | $0.01 | Live onchain FX table: Mento implied USD per stable vs reference, deviation in bps |
| `GET /v1/fx/quote` | $0.01 | Executable Mento quote for any stable pair (`?from=USDm&to=EURm&amount=100`) |
| `GET /v1/rates` | $0.005 | Spot USD prices for CELO, USDC, USDT, ETH, BTC |
| `GET /v1/gas` | $0.005 | Celo gas price + latest base fee |
| `GET /v1/token/:address` | $0.01 | ERC-20 metadata and supply on Celo |
| `GET /v1/agents/:id` | $0.01 | ERC-8004 agent lookup (owner, agentURI, registration file) |
| `GET /v1/wallet/:address` | $0.25 | Balance report with USD estimates |
| `POST /v1/game/normal` | $0.10 | Beat the desk at noughts & crosses: win pays 1.5x, instant USDC payout |
| `POST /v1/game/hard` | $0.25 | Hard mode: win pays 3x |
| `GET /v1/fx/preview`, `/v1/desk`, `/v1/catalog` | free | Delayed FX preview, desk stats, machine catalog |

## Pay for a call in 10 lines

```ts
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const account = privateKeyToAccount(process.env.PK);
const client = new x402Client().register("eip155:42220", new ExactEvmScheme(account));
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch("https://<bureau-host>/v1/fx/rates");
console.log(await res.json());
```

The payer wallet needs USDC on Celo mainnet and zero CELO: payments use EIP-3009 `transferWithAuthorization` through the [Celo facilitator](https://x402.celo.org), which pays the gas.

## Run it

```bash
cp .env.example .env   # AGENT_ADDRESS, AGENT_PRIVATE_KEY, X402_API_KEY, PUBLIC_BASE_URL, ATTRIBUTION_TAG
npm install
npm run dev                  # local
npm run build && npm start   # production
```

- `X402_API_KEY`: sign in at [x402.celo.org](https://x402.celo.org) with the agent wallet and buy settlement credits.
- The agent wallet needs USDm/USDC working capital for the desk and game payouts, plus a little CELO for gas.
- `DESK_ENABLED=1` turns the trading loop on; see `.env.example` for pairs, sizing, edge threshold, and the daily cost cap.

## Onchain identity and attribution

```bash
npm run register   # mints the agent on the Celo ERC-8004 Identity Registry, prints the agent id
```

The agent card is served at `/.well-known/agent-card.json`. With `ATTRIBUTION_TAG` set, every outbound transaction (swaps, approvals, payouts, registration) carries the ERC-8021 suffix, verifiable with `@celo/attribution-tags`' `verifyTx`.

## Test

```bash
npm run test:game                    # game engine + house economics vs perfect players
npx tsx scripts/sweep-economics.ts   # tune game payout/blunder parameters
DEMO_PRIVATE_KEY=0x... DEMO_BASE_URL=https://<host> npm run demo   # real paid calls end to end
```

## Design notes

- **Costs are bounded, volume is not.** The desk's daily spend is capped in USD; when the cap is hit it idles until the next UTC day. Edge trades are expected to be cost-negative (profitable).
- **Solvency first.** Game stakes are refused before payment settles if the wallet cannot cover the win; failed payouts are retryable and idempotent.
- **Single instance.** Games and desk stats live in process memory / a local JSON file. Move to Redis before scaling out.
