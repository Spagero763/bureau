import { attribution } from "celo-agent-kit";
import type { Hex } from "viem";
import { config } from "../config.js";

const tag = attribution(config.attributionTag);

/** Append the ERC-8021 attribution suffix to calldata when a tag is configured. */
export function withAttribution(calldata: Hex): Hex {
  return tag.apply(calldata);
}
