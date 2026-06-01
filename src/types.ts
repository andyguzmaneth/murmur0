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
}
