import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDomain } from "tldts";
import type { CapturedRequest, ClassifiedHost, WalletConfig } from "./types.js";

interface SaasPattern {
  name: string;
  category: string;
  host: string;
  path?: string;
}
interface SaasDb {
  categories: Record<string, { penalty: number; label: string }>;
  patterns: SaasPattern[];
}

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

let cachedDb: SaasDb | null = null;
async function loadDb(): Promise<SaasDb> {
  if (cachedDb) return cachedDb;
  const file = path.resolve("fingerprints/saas-patterns.json");
  cachedDb = JSON.parse(await readFile(file, "utf8")) as SaasDb;
  return cachedDb;
}

export async function classifyHosts(
  requests: CapturedRequest[],
  wallet: WalletConfig,
): Promise<ClassifiedHost[]> {
  const db = await loadDb();
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

    let result: ClassifiedHost = {
      host,
      etldPlusOne: etld,
      party: "unknown",
      count: reqs.length,
      sampleUrls,
    };

    if (CHROME_INFRA.some((re) => re.test(host))) {
      result.party = "chrome";
    } else if (firstParty.has(etld)) {
      result.party = "first";
    } else {
      const match = matchSaas(db, host, reqs);
      if (match) {
        result.party = "third";
        result.vendor = match.name;
        result.category = match.category;
      } else {
        result.party = "third";
        result.category = "unknown";
      }
    }
    out.push(result);
  }

  // stable sort: third parties first (by category penalty desc), then others
  return out.sort((a, b) => partyRank(a.party) - partyRank(b.party) || a.host.localeCompare(b.host));
}

function matchSaas(db: SaasDb, host: string, reqs: CapturedRequest[]): SaasPattern | null {
  for (const p of db.patterns) {
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
  const db = await loadDb();
  if (!category) return db.categories.unknown?.penalty ?? 3;
  return db.categories[category]?.penalty ?? db.categories.unknown?.penalty ?? 3;
}
