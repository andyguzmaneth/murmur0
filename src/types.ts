export interface WalletConfig {
  name: string;
  displayName: string;
  storeId: string;
  firstPartyDomains: string[];
  onboarding?: string;
  notes?: string;
}

export type Phase = "cold" | "onboarding" | "active";

export interface CapturedRequest {
  ts: number;
  url: string;
  host: string;
  method: string;
  resourceType?: string;
  initiator?: string;
  targetType?: string;
  /** "extension" = originated from the wallet (its SW or chrome-extension:// UI);
   *  "web" = a web page open in the same browser (NOT wallet egress). */
  scope: "extension" | "web";
  /** Outgoing request body (POST/PUT), captured above TLS via CDP. Truncated. */
  postData?: string;
  source: "cdp" | "pcap";
}

export type Party = "first" | "third" | "chrome" | "unknown";
export type MatchSource = "curated" | "disconnect" | "exodus";

export interface ClassifiedHost {
  host: string;
  etldPlusOne: string;
  party: Party;
  vendor?: string;
  category?: string;
  matchedBy?: MatchSource;
  count: number;
  sampleUrls: string[];
  /** Which capture backends saw this host. */
  seenIn: Array<"cdp" | "pcap">;
}

export interface ScoreBreakdownRow {
  host: string;
  etldPlusOne: string;
  party: Party;
  vendor?: string;
  category?: string;
  matchedBy?: MatchSource;
  penalty: number;
}

export interface ScoreResult {
  wallet: string;
  displayName: string;
  phase: Phase;
  timestamp: string;
  score: number;
  totalRequests: number;
  uniqueThirdPartyHosts: number;
  uniqueThirdPartyEtldPlusOne: number;
  breakdown: ScoreBreakdownRow[];
  firstPartyHosts: string[];
  chromeHosts: string[];
  unknownThirdPartyHosts: string[];
  /** Capture backends that contributed (cdp, pcap). */
  captureBackends: Array<"cdp" | "pcap">;
  /** Hosts seen by the pcap backstop but NOT by CDP: possible out-of-band traffic. */
  pcapOnlyHosts: string[];
  /** Web-page requests excluded from scoring (not wallet egress). */
  excludedWebRequests: number;
  excludedWebHosts: string[];
  /** Was the wallet actually used? A near-idle install tells you nothing, so a
   *  high score on an un-exercised wallet is NOT meaningful. */
  exercised: boolean;
  /** SECOND AXIS — concentration / first-party exposure. The 0-100 score above
   *  is third-party SaaS only; this axis captures what that misses: analytics on
   *  the vendor's own domain, and backend/RPC routed through one owner. */
  concentrationRating: "low" | "medium" | "high";
  /** RPC/backend endpoints grouped by who owns them (one owner = one party that
   *  sees your IP + addresses across every chain it serves). */
  rpcConcentration: Array<{ owner: string; endpoints: string[] }>;
  /** Analytics/telemetry served from the wallet's OWN domains — not penalised by
   *  the third-party score, but it is still tracking. */
  firstPartyAnalytics: Array<{ host: string; reason: string; sample?: string }>;
  /** What the wallet actually SENT to third parties (request bodies via CDP). */
  thirdPartyPayloads: Array<{ host: string; method: string; sample: string }>;
}
