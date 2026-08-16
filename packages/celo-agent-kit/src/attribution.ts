import { toDataSuffix } from "@celo/attribution-tags";
import type { Hex } from "viem";

export type AttributionTag = string;

/**
 * ERC-8021 attribution. Suffixes carry multiple codes, so an existing code is
 * kept alongside the registered one rather than replaced. Pass an array.
 */
export class Attribution {
  private readonly codes: AttributionTag[];

  constructor(tags: AttributionTag | AttributionTag[] | undefined) {
    const list = tags === undefined ? [] : Array.isArray(tags) ? tags : [tags];
    this.codes = list.filter((t) => t && t.length > 0);
  }

  get enabled(): boolean {
    return this.codes.length > 0;
  }

  get tags(): readonly AttributionTag[] {
    return this.codes;
  }

  /** Returns calldata unchanged when no tag is set, so this is safe to always wrap. */
  apply(calldata: Hex): Hex {
    if (!this.enabled) return calldata;
    const suffix = toDataSuffix(this.codes.length === 1 ? this.codes[0] : this.codes);
    return (calldata + suffix.replace(/^0x/, "")) as Hex;
  }
}

export function attribution(tags: AttributionTag | AttributionTag[] | undefined): Attribution {
  return new Attribution(tags);
}
