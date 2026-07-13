import { publicClient } from "./celo.js";
import { ERC8004 } from "../config.js";

export const identityRegistryAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
] as const;

export interface AgentInfo {
  agentId: string;
  owner: string;
  agentURI: string;
  registration?: unknown;
  registrationError?: string;
}

/** Look up an agent on the Celo ERC-8004 Identity Registry. */
export async function lookupAgent(agentId: bigint): Promise<AgentInfo> {
  const [owner, uri] = await Promise.all([
    publicClient.readContract({
      address: ERC8004.identityRegistry,
      abi: identityRegistryAbi,
      functionName: "ownerOf",
      args: [agentId],
    }),
    publicClient.readContract({
      address: ERC8004.identityRegistry,
      abi: identityRegistryAbi,
      functionName: "tokenURI",
      args: [agentId],
    }),
  ]);

  const info: AgentInfo = { agentId: agentId.toString(), owner, agentURI: uri };

  // Best-effort fetch of the registration file (public http(s) or ipfs only).
  try {
    let url = uri;
    if (url.startsWith("ipfs://")) url = `https://ipfs.io/ipfs/${url.slice(7)}`;
    if (url.startsWith("https://") || url.startsWith("http://")) {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "follow" });
      if (res.ok) info.registration = await res.json();
      else info.registrationError = `registration file returned HTTP ${res.status}`;
    } else if (url.startsWith("data:application/json")) {
      const comma = url.indexOf(",");
      const body = url.slice(comma + 1);
      const text = url.includes(";base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
      info.registration = JSON.parse(text);
    } else {
      info.registrationError = "unsupported agentURI scheme";
    }
  } catch (e) {
    info.registrationError = e instanceof Error ? e.message : "failed to fetch registration file";
  }

  return info;
}
