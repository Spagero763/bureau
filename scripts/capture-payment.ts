// Captures the exact payment header the @x402 client produces, so the
// browser play page can replicate it without the SDK.
// Usage: npx tsx scripts/capture-payment.ts

import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const account = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY as `0x${string}`);

const spy: typeof fetch = async (input, init) => {
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  for (const [k, v] of headers.entries()) {
    if (k.toLowerCase().includes("payment")) {
      console.log(`HEADER NAME: ${k}`);
      console.log("DECODED PAYLOAD:");
      console.log(JSON.stringify(JSON.parse(Buffer.from(v, "base64").toString("utf8")), null, 2));
    }
  }
  return fetch(input as RequestInfo, init);
};

const client = new x402Client().register("eip155:42220", new ExactEvmScheme(account));
const payFetch = wrapFetchWithPayment(spy, client);
const res = await payFetch("https://bureau-fnw3.onrender.com/v1/rates");
console.log("result:", res.status);
