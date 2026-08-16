# celo-agent-kit

Operational toolkit for autonomous agents on Celo.

Writing an agent that earns money onchain is mostly not about the agent. It is
about the plumbing underneath: taking payment without holding anyone's keys,
keeping a spending wallet funded without double-spending it, staying attributable
onchain, and knowing when you are actually dead rather than merely reachable.

This package is that plumbing, extracted from an agent that ran unattended on
Celo mainnet and settled **23,303 x402 payments**. Every non-obvious decision in
here traces to a specific production failure, and those are documented inline
rather than smoothed over.

```bash
npm install celo-agent-kit
```

Requires `viem`, `express`, and the `@x402/*` packages as peers.

---

## Sell something over x402

x402 is HTTP 402 with a machine-readable price attached. A client calls your
endpoint, gets a 402 describing what to pay and where, signs an EIP-3009
authorization, and retries. The facilitator submits the transfer, so **the buyer
never needs gas and you never touch their key**.

```ts
import express from "express";
import { celoSeller, catalog } from "celo-agent-kit";

const routes = {
  "GET /v1/rates": { price: 0.01, description: "Spot USD prices" },
  "GET /v1/token/*": { price: 0.01, description: "ERC-20 metadata on Celo" },
};

const app = express();
app.use(celoSeller({ payTo: "0xYourAgent", routes }));

// Publish what you sell so other agents can discover it without paying first.
app.get("/v1/catalog", (_req, res) => res.json(catalog({ payTo: "0xYourAgent", routes })));

app.get("/v1/rates", (_req, res) => res.json({ CELO: 0.0618 }));
```

No accounts, no API keys, no signup. Any x402 client pays in one retry.

The EIP-712 domain is pinned explicitly. Get it wrong and settlement fails with
a signature that verifies as garbage rather than a readable error, which is an
unpleasant afternoon.

## Stay attributable

ERC-8021 suffixes are how Celo credits onchain activity back to a project. The
part that catches people is that suffixes carry **multiple** codes, so you add
your registered tag alongside any existing one rather than replacing it.

```ts
import { attribution } from "celo-agent-kit";

const tag = attribution(["your_own_code", "celo_c45e8f941f0f"]);
wallet.sendTransaction({ to, data: tag.apply(calldata) });
```

## Keep the agent solvent

An earning agent needs two wallets: one that receives settlements and one that
spends. Left alone, the spender drains and the agent stops without erroring.
Refilling it looks trivial and is not.

```ts
import { CeloChain, Treasury, attribution } from "celo-agent-kit";

const chain = new CeloChain().withSigner(process.env.AGENT_KEY as `0x${string}`);

const treasury = new Treasury({
  chain,
  spender: "0xYourPayerWallet",
  refillBelow: 0.05,
  refillAmount: 0.75,
  attribution: attribution("celo_c45e8f941f0f"),
  onEvent: (e) => console.log("[treasury]", e),
});

await treasury.ensureFunded();   // safe to call before every spend
treasury.recordSpend(0.001);     // local, no RPC round trip
```

Three failures are handled that only appear under load:

- **Nonce collisions.** Concurrent refills silently replace each other and the
  float goes missing. `ensureFunded()` serialises refills even when callers run
  in parallel: overlapping callers await the same in-flight transaction.
- **RPC rate limiting.** Reading the balance before every spend gets a public
  node to throttle you the moment spends overlap, and a dropped read stalls the
  whole loop. The balance is tracked locally and reconciled every N spends, or
  sooner if it approaches the threshold.
- **Gas exhaustion.** Refills are transactions and cost gas. An agent can hold
  plenty of stablecoin and still stop dead with no native token to move it.
  `assertGas()` warns before that happens. Or set a `feeCurrency` and pay gas in
  a stablecoin so it never can.

## Buy your own settlement credits

Settlement on Celo is prepaid at roughly $0.001 each. When credits run out,
every payment fails with a 402 that is indistinguishable from a client error.

```ts
import { Credits } from "celo-agent-kit";

const credits = new Credits({ chain, dailyCapUsd: 5 });
// on a 402 that you believe is yours, not the client's:
await credits.topUp();
```

The daily cap is a hard rail: a bug cannot drain the treasury past it.

## Know when you are actually dead

This module exists because of a two day silent outage. The agent was dead, the
health check was green, and an unrelated dev server had taken the port and was
answering `200` with an HTML page.

```ts
import { Heartbeat, probe } from "celo-agent-kit";

const heart = new Heartbeat({ service: "bureau", stallAfterSec: 900 });

app.get("/healthz", (_req, res) => {
  const r = heart.report();
  res.status(r.ok ? 200 : 503).json(r);
});

// wherever real work completes:
heart.progress();
```

From a supervisor:

```ts
const { healthy, reason } = await probe({
  url: "http://localhost:3100/healthz",
  expectService: "bureau",
});
if (!healthy) restart(reason);
```

Two rules are enforced:

1. **A status code proves something is listening, not that it is yours.** `probe`
   rejects HTML bodies and requires the response to name your service.
2. **"Up" is not "working".** An agent that has settled nothing in an hour is
   broken even though every process runs and every port answers. `Heartbeat`
   measures liveness in useful work done, not uptime.

## Run work concurrently without dropping it

```ts
import { startConcurrentLoop } from "celo-agent-kit";

const stop = startConcurrentLoop({
  intervalSec: 3,
  concurrency: 5,
  task: () => buyOnce(),
});
```

The naive version guards with a single `if (busy) return`, which quietly drops
every tick landing during an operation. When each operation takes far longer
than the interval, throughput collapses to one per round trip and lowering the
interval changes nothing. Nothing errors, so it is genuinely hard to see. Fixing
exactly this took one agent from ~5,000 to ~28,000 settlements per day.

---

## Reference implementation

[Bureau](https://github.com/Spagero763/bureau) is an autonomous FX desk built on
this kit: it trades Mento stablecoins against real-world rates and sells its
market data per call over x402. ERC-8004 identity `#9675`, attribution tag
`celo_c45e8f941f0f`, Celo mainnet.

## License

MIT
