import { getDomain } from "tldts";
import type { CapturedRequest, ClassifiedHost, WalletConfig } from "./types.js";
import {
  loadCurated,
  loadDisconnect,
  loadExodus,
  disconnectLookup,
  type SaasPattern,
} from "./fingerprints.js";
import { loadBaselineHosts } from "./baseline.js";

/** Hosts that belong to Chrome itself, not the extension. Excluded from scoring. */
const CHROME_INFRA = [
  /(^|\.)gvt1\.com$/,
  /(^|\.)gvt2\.com$/,
  /(^|\.)gstatic\.com$/,
  /(^|\.)clients\d?\.google\.com$/,
  /(^|\.)update\.googleapis\.com$/,
  /(^|\.)dl\.google\.com$/,
  /(^|\.)edgedl\.me$/,
  /(^|\.)optimizationguide-pa\.googleapis\.com$/,
  /(^|\.)content-autofill\.googleapis\.com$/,
  /(^|\.)safebrowsing\.googleapis\.com$/,
  /(^|\.)accounts\.google\.com$/,
  /(^|\.)redirector\.gvt1\.com$/,
];

export async function classifyHosts(
  requests: CapturedRequest[],
  wallet: WalletConfig,
): Promise<ClassifiedHost[]> {
  const curatedDb = await loadCurated();
  const disconnect = await loadDisconnect();
  const exodus = await loadExodus();
  const baseline = await loadBaselineHosts();
  const firstParty = new Set(wallet.firstPartyDomains.map((d) => d.toLowerCase()));

  // group requests by host
  const byHost = new Map<string, CapturedRequest[]>();
  for (const r of requests) {
    if (!byHost.has(r.host)) byHost.set(r.host, []);
    byHost.get(r.host)!.push(r);
  }

  const out: ClassifiedHost[] = [];
  for (const [host, reqs] of byHost) {
    const etld = (getDomain(host) ?? host).toLowerCase();
    const sampleUrls = [...new Set(reqs.map((r) => r.url))].slice(0, 3);
    const seenIn = [...new Set(reqs.map((r) => r.source))];

    const c: ClassifiedHost = {
      host,
      etldPlusOne: etld,
      party: "unknown",
      count: reqs.length,
      sampleUrls,
      seenIn,
    };

    if (CHROME_INFRA.some((re) => re.test(host)) || baseline.has(host)) {
      c.party = "chrome";
    } else if (firstParty.has(etld) || firstParty.has(host.toLowerCase())) {
      // first-party match on eTLD+1 OR full host (covers vendor content on a
      // shared public suffix, e.g. metamask.github.io).
      c.party = "first";
    } else {
      c.party = "third";
      // Precedence: curated (most specific) -> Disconnect -> Exodus -> unknown.
      const curatedHit = matchCurated(curatedDb.patterns, host, reqs);
      if (curatedHit) {
        c.vendor = curatedHit.name;
        c.category = curatedHit.category;
        c.matchedBy = "curated";
      } else {
        const d = disconnectLookup(disconnect, host);
        if (d) {
          c.vendor = d.company;
          c.category = d.category;
          c.matchedBy = "disconnect";
        } else {
          const e = exodus.find((sig) => sig.regex.test(host));
          if (e) {
            c.vendor = e.name;
            c.category = e.category;
            c.matchedBy = "exodus";
          } else {
            c.category = "unknown";
          }
        }
      }
    }
    out.push(c);
  }

  return out.sort((a, b) => partyRank(a.party) - partyRank(b.party) || a.host.localeCompare(b.host));
}

function matchCurated(patterns: SaasPattern[], host: string, reqs: CapturedRequest[]): SaasPattern | null {
  for (const p of patterns) {
    let hostRe: RegExp;
    try {
      hostRe = new RegExp(p.host, "i");
    } catch {
      continue;
    }
    if (!hostRe.test(host)) continue;
    if (!p.path) return p;
    let pathRe: RegExp;
    try {
      pathRe = new RegExp(p.path, "i");
    } catch {
      continue;
    }
    const pathMatches = reqs.some((r) => {
      try {
        return pathRe.test(new URL(r.url).pathname);
      } catch {
        return false;
      }
    });
    if (pathMatches) return p;
  }
  return null;
}

function partyRank(p: string): number {
  return p === "third" ? 0 : p === "unknown" ? 1 : p === "first" ? 2 : 3;
}

export async function categoryPenalty(category: string | undefined): Promise<number> {
  const db = await loadCurated();
  if (!category) return db.categories.unknown?.penalty ?? 3;
  return db.categories[category]?.penalty ?? db.categories.unknown?.penalty ?? 3;
}
