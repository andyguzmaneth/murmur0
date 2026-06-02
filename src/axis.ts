import type { CapturedRequest, ClassifiedHost } from "./types.js";

/**
 * Second axis: concentration / first-party exposure.
 *
 * The third-party SaaS score rewards vertical integration — route analytics and
 * RPC through your own parent-company domains and the score stays clean. This
 * module surfaces what that misses:
 *   1. RPC/backend concentration, detected by JSON-RPC in request bodies (so it
 *      catches self-proxied RPC like api.rabby.io, not just Infura/Alchemy).
 *   2. Analytics served from the wallet's OWN domains (e.g. matomo.debank.com).
 */

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

/** Keyword substrings that mark an analytics/telemetry host. */
const ANALYTICS_KEYWORDS = [
  "matomo",
  "piwik",
  "telemetry",
  "analytics",
  "stats", // catches festats.*, fe-stats, etc.
  "tracking",
  "mixpanel",
  "amplitude",
  "posthog",
  "plausible",
  "segment",
  "heap",
];

function providerLabel(host: string): string | null {
  for (const p of RPC_PROVIDERS) if (p.re.test(host)) return p.label;
  return null;
}

/** A request is JSON-RPC if its body carries the jsonrpc marker or an eth_ method. */
function isJsonRpc(body: string | undefined): boolean {
  if (!body) return false;
  return /"jsonrpc"\s*:/.test(body) || /"method"\s*:\s*"(eth_|net_|web3_|wallet_|sol_|getAccountInfo)/.test(body);
}

export function computeRpcConcentration(
  requests: CapturedRequest[],
  hosts: ClassifiedHost[],
): Array<{ owner: string; endpoints: string[] }> {
  const etld = new Map(hosts.map((h) => [h.host, h.etldPlusOne]));
  const rpcHosts = new Set<string>();
  // by payload (generic, catches self-proxied RPC)
  for (const r of requests) if (isJsonRpc(r.postData)) rpcHosts.add(r.host);
  // by known provider hostname (catches RPC even if body wasn't retained)
  for (const h of hosts) if (providerLabel(h.host)) rpcHosts.add(h.host);

  const byOwner = new Map<string, Set<string>>();
  for (const host of rpcHosts) {
    const owner = providerLabel(host) ?? etld.get(host) ?? host;
    if (!byOwner.has(owner)) byOwner.set(owner, new Set());
    byOwner.get(owner)!.add(host);
  }
  return [...byOwner.entries()]
    .map(([owner, set]) => ({ owner, endpoints: [...set].sort() }))
    .sort((a, b) => b.endpoints.length - a.endpoints.length);
}

export function computeFirstPartyAnalytics(
  requests: CapturedRequest[],
  hosts: ClassifiedHost[],
): Array<{ host: string; reason: string; sample?: string }> {
  const out: Array<{ host: string; reason: string; sample?: string }> = [];
  const firstParty = hosts.filter((h) => h.party === "first");
  for (const h of hosts.length ? firstParty : []) {
    const lower = h.host.toLowerCase();
    const kw = ANALYTICS_KEYWORDS.find((k) => lower.includes(k));
    if (!kw) continue;
    const sample = requests.find((r) => r.host === h.host && r.postData)?.postData?.slice(0, 300);
    out.push({ host: h.host, reason: `name contains "${kw}"`, sample });
  }
  return out;
}

export function concentrationRating(
  rpc: Array<{ owner: string; endpoints: string[] }>,
  fpAnalytics: Array<{ host: string }>,
): "low" | "medium" | "high" {
  const top = rpc[0]?.endpoints.length ?? 0;
  const fpa = fpAnalytics.length;
  if (top >= 5 || (top >= 2 && fpa > 0)) return "high";
  if (top >= 2 || fpa > 0) return "medium";
  return "low";
}
