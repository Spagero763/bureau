import { toDataSuffix } from "@celo/attribution-tags";
import type { Hex } from "viem";
import { config } from "../config.js";

/** Append the ERC-8021 attribution suffix to calldata when a tag is configured. */
export function withAttribution(calldata: Hex): Hex {
  if (!config.attributionTag) return calldata;
  const suffix = toDataSuffix(config.attributionTag);
  return (calldata + suffix.replace(/^0x/, "")) as Hex;
}
