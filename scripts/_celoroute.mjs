import { createRequire } from "node:module";
import { createPublicClient, http } from "viem";
import { celo } from "viem/chains";
const require = createRequire(import.meta.url);
const { Mento } = require("@mento-protocol/mento-sdk");
const pc = createPublicClient({ chain: celo, transport: http("https://forno.celo.org") });
const m = await Mento.create(42220, pc);
const CELO = "0x471EcE3750Da237f93B8E339c536989b8978a438";
const pairs = await m.getTradablePairs?.().catch(() => null);
if (pairs) { console.log("tradable pairs count:", pairs.length); }
// Try to find any route from USDm and USDC to CELO
const USDm = "0x765DE816845861e75A25fCA122bb6898B8B1282a";
const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
for (const [name, from] of [["USDm", USDm], ["USDC", USDC]]) {
  try { const r = await m.routes.findRoute(from, CELO); console.log(name + "->CELO: ROUTE FOUND, hops:", r.path?.length ?? "?"); }
  catch (e) { console.log(name + "->CELO:", e.message.slice(0, 60)); }
}
// what pools involve CELO?
const pools = await m.pools.getPools().catch(() => []);
const celoPools = pools.filter((p) => [p.asset0, p.asset1].map((a) => a?.toLowerCase()).includes(CELO.toLowerCase()));
console.log("pools with CELO:", celoPools.length);
for (const p of celoPools.slice(0, 6)) console.log("  ", p.asset0, "<->", p.asset1);
