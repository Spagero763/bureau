# Kiosk

An autonomous storefront agent on Celo. Kiosk sells API calls and arcade games for USDC, settled per-request with the [x402 payment protocol](https://docs.celo.org/build-on-celo/build-with-ai/x402), and carries a portable onchain identity via [ERC-8004](https://docs.celo.org/build-on-celo/build-with-ai/8004).

Every request is paid: no accounts, no API keys, no invoices. A client (human app or another agent) hits an endpoint, gets HTTP 402 with payment requirements, signs a gasless USDC authorization, retries, and gets the result. Money lands in the agent's wallet on Celo mainnet.

## What it sells

| Endpoint | Price | What you get |
|---|---|---|
| `GET /v1/rates` | $0.005 | Spot USD prices for CELO, USDC, USDT, ETH, BTC |
| `GET /v1/gas` | $0.005 | Celo gas price + latest base fee |
| `GET /v1/token/:address` | $0.01 | ERC-20 metadata and supply on Celo |
| `GET /v1/agents/:id` | $0.01 | ERC-8004 agent lookup (owner, agentURI, registration file) |
| `GET /v1/wallet/:address` | $0.25 | Balance report with USD estimates |
| `POST /v1/game/normal` | $0.10 | Noughts & crosses vs the agent. Win pays 1.5x, draw refunds 80% |
| `POST /v1/game/hard` | $0.25 | Near-perfect bot. Win pays 3x, draw refunds 70% |
| `GET /v1/catalog` | free | Machine-readable price list |

Game moves (`POST /v1/game/:id/move`, body `{"cell": 0-8}`) are free; only the stake is paid. Winnings and draw refunds are sent automatically in USDC to the wallet that paid the stake, with the tx hash in the response.

## Pay for a call in 10 lines

```ts
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const account = privateKeyToAccount(process.env.PK);
const client = new x402Client().register("eip155:42220", new ExactEvmScheme(account));
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch("https://<kiosk-host>/v1/rates");
console.log(await res.json());
```

The wallet needs USDC on Celo mainnet and zero CELO: payments use EIP-3009 `transferWithAuthorization`, so the facilitator pays gas.

## Run it

```bash
cp .env.example .env   # fill in AGENT_ADDRESS, AGENT_PRIVATE_KEY, X402_API_KEY, PUBLIC_BASE_URL
npm install
npm run dev            # local
npm run build && npm start  # production
```

- `X402_API_KEY` comes from [x402.celo.org](https://x402.celo.org): sign a message with the agent wallet, buy settlement credits (each successful settlement consumes one).
- The agent wallet needs USDC to cover game payouts (the server refuses stakes it cannot pay out) and a little CELO for the payout transactions and registration.

## Register the onchain identity

Deploy first so `/.well-known/agent-card.json` is publicly reachable, then:

```bash
npm run register
```

This mints the agent on the Celo mainnet ERC-8004 Identity Registry (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`) with the agent card as its `agentURI`, and prints the agent id.

## Test

```bash
npm run test:game                    # engine correctness + house economics vs perfect players
npx tsx scripts/sweep-economics.ts   # tune payout/blunder parameters
DEMO_PRIVATE_KEY=0x... DEMO_BASE_URL=https://<host> DEMO_PLAY=1 npm run demo  # end-to-end paid calls
```

## Design notes

- **Solvency first.** A pre-payment check refuses new games when the house wallet cannot cover the maximum payout, and a per-wallet daily cap (default 50) limits grinding.
- **Beatable, not exploitable.** The bot plays minimax with a configurable blunder rate. Draw refunds are less than 100% on purpose: simulation (`test:game`) shows the house keeps a positive edge even against perfect players, while wins stay common enough to be fun.
- **Failed payouts are recoverable.** If a payout transaction fails, the outcome is preserved and `POST /v1/game/:id/settle` retries it idempotently.
- **Games are held in memory** with a 1-hour TTL. Run a single instance; if you scale out, move the store to Redis first.
