// Traces the x402 client flow for one self-buy purchase.
// Usage: npx tsx scripts/selfbuy-debug.ts

import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const payerKey = process.env.PAYER_PRIVATE_KEY!;
const account = privateKeyToAccount(payerKey as `0x${string}`);
console.log("payer:", account.address);

const tracingFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers);
  const hasPayment = [...headers.keys()].filter((k) => k.toLowerCase().includes("payment"));
  console.log(`>> ${init?.method ?? "GET"} ${url} payment-headers: [${hasPayment.join(", ")}]`);
  const res = await fetch(input, init);
  console.log(`<< HTTP ${res.status}; PAYMENT-REQUIRED hdr: ${res.headers.get("PAYMENT-REQUIRED") ? "yes" : "no"}; X-PAYMENT-RESPONSE: ${res.headers.get("X-PAYMENT-RESPONSE") ? "yes" : "no"}`);
  if (res.status === 402) {
    const hdr = res.headers.get("PAYMENT-REQUIRED");
    if (hdr) {
      const decoded = JSON.parse(Buffer.from(hdr, "base64").toString("utf8"));
      console.log("   402 accepts:", JSON.stringify(decoded.accepts ?? decoded));
    }
  }
  return res;
};

const client = new x402Client().register("eip155:42220", new ExactEvmScheme(account));
const payFetch = wrapFetchWithPayment(tracingFetch, client);

try {
  const res = await payFetch("http://localhost:3000/v1/rates");
  console.log("final:", res.status, (await res.text()).slice(0, 200));
} catch (e) {
  console.error("CLIENT THREW:", e instanceof Error ? `${e.name}: ${e.message}` : e);
  if (e instanceof Error && e.cause) console.error("cause:", e.cause);
}
