// Vercel serverless entry. Serves the dashboard, catalog, market data, paid
// endpoints and the game. Background loops (desk, self-buy, sampler) are NOT
// started here: serverless functions are request-scoped, so those run in the
// long-lived process started by src/index.ts instead.

import express from "express";
import { join } from "node:path";
import { config } from "../src/config.js";
import { buildPaymentMiddleware } from "../src/x402.js";
import { registerCatalogRoutes } from "../src/routes/catalog.js";
import { registerDataRoutes } from "../src/routes/data.js";
import { registerFxRoutes } from "../src/routes/fx.js";
import { gamePrecheck, registerGameRoutes } from "../src/routes/game.js";

const app = express();
app.use(express.json());
app.use(express.static(join(process.cwd(), "public"), { index: false, extensions: [] }));

registerCatalogRoutes(app);

app.post("/v1/game/normal", gamePrecheck("normal"));
app.post("/v1/game/hard", gamePrecheck("hard"));

if (!config.devUnpaid) {
  app.use(buildPaymentMiddleware());
}

registerDataRoutes(app);
registerFxRoutes(app);
registerGameRoutes(app);

export default app;
