import express from "express";
import { config } from "./config.js";
import { buildPaymentMiddleware } from "./x402.js";
import { registerCatalogRoutes } from "./routes/catalog.js";
import { registerDataRoutes } from "./routes/data.js";
import { registerFxRoutes } from "./routes/fx.js";
import { gamePrecheck, registerGameRoutes } from "./routes/game.js";
import { startDesk } from "./desk/engine.js";
import { startSelfBuy } from "./desk/selfbuy.js";

const app = express();
app.use(express.json());

// Free discovery routes go before the paywall.
registerCatalogRoutes(app);

// Refuse game stakes we could not pay out BEFORE any money moves.
app.post("/v1/game/normal", gamePrecheck("normal"));
app.post("/v1/game/hard", gamePrecheck("hard"));

// x402 paywall: verifies and settles USDC payments on Celo for paid routes.
if (config.devUnpaid) {
  console.warn("WARNING: DEV_UNPAID=1 - paywall disabled, payouts simulated. Local testing only.");
} else {
  app.use(buildPaymentMiddleware());
}

// Paid handlers (only reached once payment has settled).
// Note: /v1/desk and /v1/desk/pause inside fx routes are free/admin and are
// not in the paywall route table, so the middleware passes them through.
registerDataRoutes(app);
registerFxRoutes(app);
registerGameRoutes(app);

app.listen(config.port, () => {
  console.log(`${config.agentName} listening on :${config.port}`);
  console.log(`network eip155:42220, payTo ${config.agentAddress}`);
  console.log(`facilitator ${config.facilitatorUrl}${config.x402ApiKey ? "" : " (no API key set: settlement will fail)"}`);
  console.log(`attribution ${config.attributionTag || "(no tag set: transactions will NOT be attributed)"}`);
  startDesk();
  startSelfBuy();
});
