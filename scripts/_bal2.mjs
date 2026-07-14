import { createPublicClient, http, formatUnits } from "viem";
import { celo } from "viem/chains";
const pc = createPublicClient({ chain: celo, transport: http("https://forno.celo.org") });
const AGENT = "0xF70A02D74970FAFF6b0bE6D0dD558965E1B4d855";
const abi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ name: "", type: "uint256" }] }];
const tokens = {
  USDm: ["0x765DE816845861e75A25fCA122bb6898B8B1282a", 18],
  EURm: ["0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73", 18],
  BRLm: ["0xE8537a3d056DA446677B9E9d6c5dB704EaAb4787", 18],
  USDC: ["0xcebA9300f2b948710d2653dD7B07f33A8B32118C", 6],
};
for (const [sym, [addr, dec]] of Object.entries(tokens)) {
  const b = await pc.readContract({ address: addr, abi, functionName: "balanceOf", args: [AGENT] });
  console.log(sym, formatUnits(b, dec));
}
