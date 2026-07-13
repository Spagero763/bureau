// The SDK's ESM build has extensionless relative imports that Node cannot
// resolve, so load the CJS build explicitly via createRequire.
import { createRequire } from "node:module";
import type { Mento as MentoType, Token } from "@mento-protocol/mento-sdk";
import { publicClient } from "../lib/celo.js";
import { CHAIN_ID } from "../config.js";

const require = createRequire(import.meta.url);
const { Mento } = require("@mento-protocol/mento-sdk") as { Mento: typeof MentoType };
type Mento = MentoType;

let _mento: Mento | null = null;
let _stables: Token[] | null = null;

export async function mento(): Promise<Mento> {
  if (!_mento) {
    _mento = await Mento.create(CHAIN_ID, publicClient);
  }
  return _mento;
}

export async function stableTokens(): Promise<Token[]> {
  if (!_stables) {
    const m = await mento();
    _stables = await m.tokens.getStableTokens();
  }
  return _stables;
}

export async function tokenBySymbol(symbol: string): Promise<Token | undefined> {
  const tokens = await stableTokens();
  return tokens.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase());
}

/** Onchain Mento quote: how much tokenOut for amountIn of tokenIn. */
export async function quote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<bigint> {
  const m = await mento();
  return m.quotes.getAmountOut(tokenIn, tokenOut, amountIn);
}
