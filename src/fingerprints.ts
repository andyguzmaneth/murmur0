import { readFile } from "node:fs/promises";
import path from "node:path";

const FP_DIR = path.resolve("fingerprints");

export interface SaasPattern {
  name: string;
  category: string;
  host: string;
  path?: string;
}
export interface CuratedDb {
  categories: Record<string, { penalty: number; label: string }>;
  patterns: SaasPattern[];
}

export interface DisconnectHit {
  company: string;
  category: string; // our category
}
export interface ExodusSig {
  name: string;
  regex: RegExp;
  category: string; // our category
}

/** Disconnect's categories mapped onto our penalty categories. */
const DISCONNECT_CATEGORY: Record<string, string> = {
  Advertising: "ads",
  Analytics: "analytics",
  Social: "social",
  FingerprintingInvasive: "fraud-device",
  FingerprintingGeneral: "fraud-device",
  "Anti-fraud": "fraud-device",
  Content: "cdn",
  Email: "email-tracking",
  EmailAggressive: "email-tracking",
  ConsentManagers: "consent",
  Cryptomining: "cryptomining",
};

/** Severity order for resolving multi-category collisions (higher = keep). */
const SEVERITY: Record<string, number> = {
  cryptomining: 14,
  "session-replay": 13,
  attribution: 12,
  ads: 11,
  analytics: 10,
  "fraud-device": 9,
  social: 8,
  "email-tracking": 7,
  "install-id": 6,
  "crash-monitoring": 5,
  "remote-config": 4,
  "tag-manager": 3,
  consent: 2,
  cdn: 1,
  unknown: 0,
};

/** Exodus categories mapped onto ours. Being in Exodus means it IS a tracker,
 * so unmapped categories default to analytics rather than unknown. */
const EXODUS_CATEGORY: Record<string, string> = {
  Analytics: "analytics",
  Advertisement: "ads",
  Ads: "ads",
  "Crash reporting": "crash-monitoring",
  Profiling: "analytics",
  Identification: "install-id",
  Location: "analytics",
};

let curated: CuratedDb | null = null;
let disconnect: Map<string, DisconnectHit> | null = null;
let exodus: ExodusSig[] | null = null;

export async function loadCurated(): Promise<CuratedDb> {
  if (curated) return curated;
  curated = JSON.parse(await readFile(path.join(FP_DIR, "saas-patterns.json"), "utf8")) as CuratedDb;
  return curated;
}

/** domain -> {company, category}. Flattens Disconnect's category/company/url/domains tree. */
export async function loadDisconnect(): Promise<Map<string, DisconnectHit>> {
  if (disconnect) return disconnect;
  const map = new Map<string, DisconnectHit>();
  try {
    const raw = JSON.parse(await readFile(path.join(FP_DIR, "disconnect-services.json"), "utf8"));
    const categories = raw.categories ?? {};
    for (const [cat, entries] of Object.entries<any[]>(categories)) {
      const ourCat = DISCONNECT_CATEGORY[cat] ?? "analytics";
      for (const entry of entries) {
        for (const company of Object.keys(entry)) {
          const urls = entry[company];
          if (!urls || typeof urls !== "object") continue;
          for (const domains of Object.values<any>(urls)) {
            if (!Array.isArray(domains)) continue;
            for (const d of domains) {
              const dom = String(d).toLowerCase();
              const existing = map.get(dom);
              // On collision (a domain listed under several categories), keep the
              // higher-severity classification so ad/analytics beats e.g. email.
              if (!existing || (SEVERITY[ourCat] ?? 0) > (SEVERITY[existing.category] ?? 0)) {
                map.set(dom, { company, category: ourCat });
              }
            }
          }
        }
      }
    }
  } catch {
    // file absent (not yet vendored) -> empty map, classification degrades gracefully
  }
  disconnect = map;
  return map;
}

export async function loadExodus(): Promise<ExodusSig[]> {
  if (exodus) return exodus;
  const out: ExodusSig[] = [];
  try {
    const raw = JSON.parse(await readFile(path.join(FP_DIR, "exodus-trackers.json"), "utf8"));
    const trackers = raw.trackers ?? raw;
    for (const t of Object.values<any>(trackers)) {
      const sig = t?.network_signature;
      if (!sig || typeof sig !== "string") continue;
      let regex: RegExp;
      try {
        regex = new RegExp(sig, "i");
      } catch {
        continue;
      }
      const cats: string[] = Array.isArray(t.categories) ? t.categories : [];
      const ourCat = cats.map((c) => EXODUS_CATEGORY[c]).find(Boolean) ?? "analytics";
      out.push({ name: t.name ?? "Exodus tracker", regex, category: ourCat });
    }
  } catch {
    // absent -> empty
  }
  exodus = out;
  return out;
}

/** Look up a host (and its parent domains) in the Disconnect map. */
export function disconnectLookup(map: Map<string, DisconnectHit>, host: string): DisconnectHit | null {
  const h = host.toLowerCase();
  if (map.has(h)) return map.get(h)!;
  const labels = h.split(".");
  for (let i = 1; i < labels.length - 1; i++) {
    const parent = labels.slice(i).join(".");
    const hit = map.get(parent);
    if (hit) return hit;
  }
  return null;
}
