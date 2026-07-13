import type { Request } from "express";
import { getAddress } from "viem";

/**
 * Extract the payer address from the x402 payment header that the payment
 * middleware has already verified and settled. The header is base64 JSON with
 * payload.authorization.from for the exact/EIP-3009 scheme.
 */
export function payerFromRequest(req: Request): string | null {
  const raw = req.header("x-payment") ?? req.header("payment-signature");
  if (!raw) return null;
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    const from = decoded?.payload?.authorization?.from;
    if (typeof from === "string" && from.startsWith("0x") && from.length === 42) {
      return getAddress(from);
    }
  } catch {
    // fall through
  }
  return null;
}
