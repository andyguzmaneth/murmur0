import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CapturedRequest } from "./types.js";

const execFileP = promisify(execFile);

/**
 * Parses a pcap with tshark into pseudo-requests. We can't see HTTP paths
 * without decryption, so each TLS ClientHello (SNI) and each DNS query becomes
 * one host-level record. These merge with the CDP requests; the host set is
 * what the score uses, so host-level granularity is enough for the backstop.
 *
 * Requires tshark (`brew install wireshark`). Returns [] if tshark is absent.
 */
export async function parsePcap(pcapPath: string): Promise<CapturedRequest[]> {
  if (!(await hasTshark())) return [];

  const out: CapturedRequest[] = [];

  // TLS SNI from ClientHello
  const sni = await runTshark(pcapPath, [
    "-Y",
    "tls.handshake.type == 1",
    "-T",
    "fields",
    "-e",
    "frame.time_epoch",
    "-e",
    "ip.dst",
    "-e",
    "tls.handshake.extensions_server_name",
  ]);
  for (const line of sni) {
    const [ts, ip, host] = line.split("\t");
    if (!host) continue;
    out.push(rec(ts, host, `https://${host}/`, ip));
  }

  // DNS queries (catches plaintext lookups for hosts that never complete TLS)
  const dns = await runTshark(pcapPath, [
    "-Y",
    "dns.flags.response == 0",
    "-T",
    "fields",
    "-e",
    "frame.time_epoch",
    "-e",
    "dns.qry.name",
  ]);
  for (const line of dns) {
    const [ts, host] = line.split("\t");
    if (!host) continue;
    out.push(rec(ts, host, `dns://${host}`, undefined));
  }

  return out;
}

function rec(tsEpoch: string | undefined, host: string, url: string, ip?: string): CapturedRequest {
  const h = host.trim().toLowerCase();
  return {
    ts: tsEpoch ? Math.round(parseFloat(tsEpoch) * 1000) : 0,
    url,
    host: h,
    method: "GET",
    resourceType: ip ? "tls" : "dns",
    source: "pcap",
  };
}

async function runTshark(pcapPath: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await execFileP("tshark", ["-r", pcapPath, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function hasTshark(): Promise<boolean> {
  try {
    await execFileP("which", ["tshark"]);
    return true;
  } catch {
    return false;
  }
}
