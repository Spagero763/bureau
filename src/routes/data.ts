import type { Express, Request, Response } from "express";
import { formatUnits, getAddress, isAddress } from "viem";
import { erc20Abi, publicClient } from "../lib/celo.js";
import { lookupAgent } from "../lib/erc8004.js";
import { getRates } from "../lib/market.js";

const STABLES = [
  { symbol: "USDC", address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as const, decimals: 6 },
  { symbol: "USDT", address: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e" as const, decimals: 6 },
  { symbol: "USDm", address: "0x765DE816845861e75A25fCA122bb6898B8B1282a" as const, decimals: 18 },
];

function fail(res: Response, status: number, message: string) {
  res.status(status).json({ error: message });
}

export function registerDataRoutes(app: Express) {
  app.get("/v1/rates", async (_req: Request, res: Response) => {
    try {
      res.json(await getRates());
    } catch (e) {
      fail(res, 502, e instanceof Error ? e.message : "rates unavailable");
    }
  });

  app.get("/v1/gas", async (_req: Request, res: Response) => {
    try {
      const [gasPrice, block] = await Promise.all([
        publicClient.getGasPrice(),
        publicClient.getBlock({ blockTag: "latest" }),
      ]);
      res.json({
        chainId: 42220,
        gasPriceWei: gasPrice.toString(),
        gasPriceGwei: formatUnits(gasPrice, 9),
        baseFeePerGasWei: block.baseFeePerGas?.toString() ?? null,
        blockNumber: block.number.toString(),
        asOf: new Date().toISOString(),
      });
    } catch (e) {
      fail(res, 502, e instanceof Error ? e.message : "rpc unavailable");
    }
  });

  app.get("/v1/token/:address", async (req: Request, res: Response) => {
    const addr = req.params.address;
    if (!isAddress(addr)) return fail(res, 400, "invalid address");
    try {
      const target = getAddress(addr);
      const [name, symbol, decimals, totalSupply] = await Promise.all([
        publicClient.readContract({ address: target, abi: erc20Abi, functionName: "name" }),
        publicClient.readContract({ address: target, abi: erc20Abi, functionName: "symbol" }),
        publicClient.readContract({ address: target, abi: erc20Abi, functionName: "decimals" }),
        publicClient.readContract({ address: target, abi: erc20Abi, functionName: "totalSupply" }),
      ]);
      res.json({
        address: target,
        name,
        symbol,
        decimals,
        totalSupply: totalSupply.toString(),
        totalSupplyFormatted: formatUnits(totalSupply, decimals),
      });
    } catch {
      fail(res, 404, "not an ERC-20 token (or reverted)");
    }
  });

  app.get("/v1/agents/:id", async (req: Request, res: Response) => {
    let id: bigint;
    try {
      id = BigInt(req.params.id);
    } catch {
      return fail(res, 400, "invalid agent id");
    }
    try {
      res.json(await lookupAgent(id));
    } catch {
      fail(res, 404, "agent not found on the Celo ERC-8004 identity registry");
    }
  });

  app.get("/v1/wallet/:address", async (req: Request, res: Response) => {
    const addr = req.params.address;
    if (!isAddress(addr)) return fail(res, 400, "invalid address");
    const target = getAddress(addr);
    try {
      const [celoBal, nonce, rates, ...stableBals] = await Promise.all([
        publicClient.getBalance({ address: target }),
        publicClient.getTransactionCount({ address: target }),
        getRates().catch(() => null),
        ...STABLES.map((t) =>
          publicClient
            .readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [target] })
            .catch(() => 0n),
        ),
      ]);

      const celoUsd = rates?.usd["celo"] ?? null;
      const celoAmount = Number(formatUnits(celoBal, 18));
      const balances = [
        {
          symbol: "CELO",
          amount: celoAmount,
          usd: celoUsd !== null ? celoAmount * celoUsd : null,
        },
        ...STABLES.map((t, i) => {
          const amount = Number(formatUnits(stableBals[i] as bigint, t.decimals));
          return { symbol: t.symbol, amount, usd: amount };
        }),
      ];
      const totalUsd = balances.reduce((s, b) => s + (b.usd ?? 0), 0);

      res.json({
        address: target,
        chainId: 42220,
        transactionCount: nonce,
        balances,
        totalUsdEstimate: Math.round(totalUsd * 100) / 100,
        asOf: new Date().toISOString(),
      });
    } catch (e) {
      fail(res, 502, e instanceof Error ? e.message : "report unavailable");
    }
  });
}
