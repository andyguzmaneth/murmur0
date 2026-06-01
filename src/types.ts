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
  source: "cdp" | "pcap";
}

export type Party = "first" | "third" | "chrome" | "unknown";

export interface ClassifiedHost {
  host: string;
  etldPlusOne: string;
  party: Party;
  vendor?: string;
  category?: string;
  count: number;
  sampleUrls: string[];
}

export interface ScoreBreakdownRow {
  host: string;
  etldPlusOne: string;
  party: Party;
  vendor?: string;
  category?: string;
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
}
