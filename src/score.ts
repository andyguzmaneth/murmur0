import { categoryPenalty } from "./classify.js";
import type { ClassifiedHost, Phase, ScoreResult, ScoreBreakdownRow, WalletConfig } from "./types.js";

/** Known RPC providers. Concentration here = one party correlates your IP with
 *  every chain you touch, an IP-exposure surface the third-party score misses. */
const RPC_PROVIDERS: Array<{ label: string; re: RegExp }> = [
  { label: "Infura (Consensys)", re: /(^|\.)infura\.io$/ },
  { label: "Alchemy", re: /(^|\.)(alchemy\.com|alchemyapi\.io)$/ },
  { label: "QuickNode", re: /(^|\.)(quiknode\.pro|quicknode\.com)$/ },
  { label: "Ankr", re: /(^|\.)ankr\.com$/ },
  { label: "dRPC", re: /(^|\.)drpc\.org$/ },
  { label: "LlamaRPC", re: /(^|\.)llamarpc\.com$/ },
  { label: "PublicNode", re: /(^|\.)publicnode\.com$/ },
  { label: "BlastAPI", re: /(^|\.)blastapi\.io$/ },
];

function detectRpcProviders(hosts: ClassifiedHost[]): Array<{ provider: string; endpoints: string[] }> {
  const byProvider = new Map<string, Set<string>>();
  for (const h of hosts) {
    for (const p of RPC_PROVIDERS) {
      if (p.re.test(h.host)) {
        if (!byProvider.has(p.label)) byProvider.set(p.label, new Set());
        byProvider.get(p.label)!.add(h.host);
      }
    }
  }
  return [...byProvider.entries()]
    .map(([provider, set]) => ({ provider, endpoints: [...set].sort() }))
    .sort((a, b) => b.endpoints.length - a.endpoints.length);
}

/**
 * Rubric (weighted by category): start at 100, subtract a penalty per distinct
 * THIRD-PARTY host. First-party and Chrome-infra hosts are counted but never
 * penalized. Clamp to [0, 100].
 */
export async function score(
  hosts: ClassifiedHost[],
  wallet: WalletConfig,
  phase: Phase,
  timestamp: string,
  totalRequests: number,
): Promise<ScoreResult> {
  const breakdown: ScoreBreakdownRow[] = [];
  let penaltyTotal = 0;

  const thirdParty = hosts.filter((h) => h.party === "third");
  for (const h of thirdParty) {
    const penalty = await categoryPenalty(h.category);
    penaltyTotal += penalty;
    breakdown.push({
      host: h.host,
      etldPlusOne: h.etldPlusOne,
      party: h.party,
      vendor: h.vendor,
      category: h.category,
      matchedBy: h.matchedBy,
      penalty,
    });
  }

  breakdown.sort((a, b) => b.penalty - a.penalty || a.host.localeCompare(b.host));

  const finalScore = Math.max(0, Math.min(100, Math.round(100 - penaltyTotal)));
  const thirdEtlds = new Set(thirdParty.map((h) => h.etldPlusOne));

  const backends = new Set<"cdp" | "pcap">();
  for (const h of hosts) for (const s of h.seenIn) backends.add(s);
  const pcapOnlyHosts = hosts
    .filter((h) => h.seenIn.includes("pcap") && !h.seenIn.includes("cdp"))
    .map((h) => h.host);

  return {
    wallet: wallet.name,
    displayName: wallet.displayName,
    phase,
    timestamp,
    score: finalScore,
    totalRequests,
    uniqueThirdPartyHosts: thirdParty.length,
    uniqueThirdPartyEtldPlusOne: thirdEtlds.size,
    breakdown,
    firstPartyHosts: hosts.filter((h) => h.party === "first").map((h) => h.host),
    chromeHosts: hosts.filter((h) => h.party === "chrome").map((h) => h.host),
    unknownThirdPartyHosts: thirdParty.filter((h) => h.category === "unknown").map((h) => h.host),
    captureBackends: [...backends],
    pcapOnlyHosts,
    excludedWebRequests: 0,
    excludedWebHosts: [],
    // Heuristic: a wallet that made very few requests was never really used.
    // A high score on an un-exercised wallet says nothing about its privacy.
    exercised: totalRequests >= 25,
    rpcProviders: detectRpcProviders(hosts),
    thirdPartyPayloads: [],
  };
}
