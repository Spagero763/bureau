# Bureau

An autonomous FX desk on Celo, home to the largest onchain stablecoin FX market. Bureau continuously compares the onchain price of every Mento stablecoin (USDm, EURm, BRLm, KESm, PHPm, GHSm, COPm, XOFm, NGNm, ZARm, GBPm, CADm, AUDm, CHFm, JPYm) against real-world exchange rates, trades the drift automatically, and sells its live market data per-call over the [x402 payment protocol](https://docs.celo.org/build-on-celo/build-with-ai/x402), settled in USDC. It holds a portable onchain identity via [ERC-8004](https://docs.celo.org/build-on-celo/build-with-ai/8004) and attributes every transaction it sends with an ERC-8021 data suffix.

- **Live dashboard** at `/` — markets table with deviation and sparklines, the desk trade log with explorer links, stat tiles, and an FAQ.
- **Browser game** at `/play` — connect a wallet, stake USDC, beat the bot, get paid onchain.
- **Machine-readable catalog** at `/v1/catalog` — every endpoint and price, for other agents to consume.

## The desk

A self-directed loop that scans the whole market each cycle. It discovers every tradable Mento stable onchain (no hardcoded pair list) and ranks them by how far each has drifted from its real-world reference rate.

- **Edge trades.** When a stable's onchain price deviates from the reference by more than a configurable threshold (default 6 bps), the desk buys the cheap side, or sells a held position back to base on the reverse signal.
- **Rotations.** With no edge on the board, it stays active by cycling the cheapest round-trip pair, but only while estimated spread cost stays inside a hard daily budget and a per-leg cost ceiling.
- **Rebalancing.** When the base balance runs low, it sells the largest held position back to base at a relaxed cost allowance so capital always keeps moving.

Risk rails: stablecoins only (no directional crypto exposure), adaptive per-trade sizing with a gas reserve, slippage limits on every swap, a hard daily cost cap (idles until the next UTC day when hit), and an authenticated kill switch (`POST /v1/desk/pause`). Trades, volume, and cost persist to a local JSON file and render live on the dashboard.

Gas is paid in native CELO. The desk keeps a low-CELO safety check in its loop and warns before the tank runs low.

## The storefront

Every paid request is one x402 payment: the server replies HTTP 402 with payment requirements, the client signs a gasless USDC authorization, retries, and gets the data. No accounts, no API keys.

| Endpoint | Price | What you get |
|---|---|---|
| `GET /v1/fx/rates` | $0.01 | Live onchain FX table: Mento implied USD per stable vs reference, deviation in bps |
| `GET /v1/fx/quote` | $0.01 | Executable Mento quote for any stable pair (`?from=USDm&to=EURm&amount=100`) |
| `GET /v1/rates` | $0.005 | Spot USD prices for CELO, USDC, USDT, ETH, BTC |
| `GET /v1/gas` | $0.005 | Celo gas price + latest base fee |
| `GET /v1/token/:address` | $0.01 | ERC-20 metadata and supply on Celo |
| `GET /v1/agents/:id` | $0.01 | ERC-8004 agent lookup (owner, agentURI, registration file) |
| `GET /v1/wallet/:address` | $0.25 | Balance report with USD estimates |
| `POST /v1/game/normal` | $0.10 | Beat the desk at noughts & crosses: win pays 1.5x, draw refunds 80%, instant onchain payout |
| `POST /v1/game/hard` | $0.25 | Hard mode: win pays 3x, draw refunds 70% |
| `GET /v1/fx/preview` · `/v1/fx/markets` · `/v1/fx/history` | free | Delayed FX preview, latest sampled rates, and price history for sparklines |
| `GET /v1/desk` · `/v1/catalog` | free | Desk stats and the machine-readable catalog |

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

The payer wallet needs USDC on Celo mainnet and no CELO: payments use EIP-3009 `transferWithAuthorization` through the [Celo facilitator](https://x402.celo.org), which pays the gas.

## Play in the browser

`/play` implements the same x402 flow without any SDK: connect a browser wallet, it switches you to Celo, you sign one gasless USDC stake, play the board in the page, and the payout (or draw refund) hits your wallet within seconds with the explorer link shown inline.

## The game, briefly

Single-player noughts & crosses against a minimax bot with a configurable blunder rate, so it is beatable but not a pushover. Payouts are simulation-tuned (`npm run test:game`) so the house keeps a positive edge even against perfect players while wins stay common enough to be fun. Stakes are refused before payment settles if the wallet cannot cover the win; failed payouts are retryable and idempotent.

## Run it

```bash
cp .env.example .env
npm install
npm run dev                  # local
npm run build && npm start   # production
```

Required env: `AGENT_ADDRESS`, `AGENT_PRIVATE_KEY`, `PUBLIC_BASE_URL`, `ATTRIBUTION_TAG`, `X402_API_KEY`. See `.env.example` for the desk knobs (base, trade size, interval, edge threshold, cost cap) and the x402 self-consumption loop.

- `X402_API_KEY`: sign a message with the agent wallet at [x402.celo.org](https://x402.celo.org) (scriptable via `npm run x402:key`) and buy settlement credits.
- The agent wallet needs USDm/USDC working capital for the desk and game payouts, plus CELO for gas.
- `DESK_ENABLED=1` starts the trading loop; `SELF_BUY_ENABLED=1` starts the data self-consumption loop.

Deploy: a `Dockerfile` and a `render.yaml` blueprint are included; a GitHub Actions workflow keeps the free-tier host warm.

## Onchain identity and attribution

```bash
npm run register   # mints the agent on the Celo ERC-8004 Identity Registry, prints the agent id
```

The agent card is served at `/.well-known/agent-card.json`. With `ATTRIBUTION_TAG` set, every outbound transaction (swaps, approvals, payouts, registration) carries the ERC-8021 suffix, verifiable with `verifyTx` from `@celo/attribution-tags`.

## Test

```bash
npm run test:game                    # game engine correctness + house economics vs perfect players
npx tsx scripts/sweep-economics.ts   # tune game payout/blunder parameters
DEMO_PRIVATE_KEY=0x... DEMO_BASE_URL=https://<host> DEMO_PLAY=1 npm run demo   # real paid calls + a game, end to end
```

## Design notes

- **Costs are bounded, volume is not.** Daily spread spend is capped in USD; edge trades are expected to be cost-negative (favorable).
- **Self-discovery over configuration.** The desk trades whatever Mento lists; set `DESK_PAIRS` only to deliberately restrict it.
- **Solvency first.** Adaptive sizing reserves gas headroom, the house refuses games it cannot pay, and payouts are idempotent.
- **Single instance.** Games and desk stats live in process memory / a local JSON file. Move to Redis before scaling horizontally.

## Layout

```
src/
  index.ts            server wiring
  config.ts           all tunables (env-driven)
  x402.ts             paywall: x402 route table + facilitator
  desk/               the FX engine
    engine.ts         scan, decide, execute, risk rails, gas safety
    mento.ts          Mento SDK access (quotes, swaps, tokens)
    reference.ts      real-world FX reference rates
    history.ts        price sampler for sparklines
    selfbuy.ts        x402 self-consumption loop
    state.ts          persisted desk stats
  routes/             fx, data, game, catalog handlers
  lib/                celo client, attribution, payout, erc8004, market
public/               dashboard + play page
scripts/              register, demo, tests, key + economics tools
```
