import type { ScoreResult } from "./types.js";

export function renderReport(r: ScoreResult): string {
  const grade = scoreGrade(r.score);
  const lines: string[] = [];
  lines.push(`# ${r.displayName}: Egress Privacy Report`);
  lines.push("");
  lines.push(`**Score: ${r.score}/100** (${grade})  ·  phase: \`${r.phase}\`  ·  ${r.timestamp}`);
  lines.push("");
  lines.push(`- Total requests observed: **${r.totalRequests}**`);
  lines.push(`- Unique third-party hosts: **${r.uniqueThirdPartyHosts}** (${r.uniqueThirdPartyEtldPlusOne} distinct domains)`);
  lines.push(`- First-party hosts: ${r.firstPartyHosts.length} · Chrome-infra (excluded): ${r.chromeHosts.length}`);
  lines.push(`- Capture backends: ${r.captureBackends.join(" + ") || "none"}`);
  lines.push("");

  if (r.breakdown.length > 0) {
    lines.push("## Third-party endpoints (penalised)");
    lines.push("");
    lines.push("| Host | Domain | Vendor | Category | Source | −pts |");
    lines.push("|------|--------|--------|----------|--------|-----:|");
    for (const b of r.breakdown) {
      lines.push(
        `| \`${b.host}\` | ${b.etldPlusOne} | ${b.vendor ?? "?"} | ${b.category ?? "unknown"} | ${b.matchedBy ?? "?"} | ${b.penalty} |`,
      );
    }
    lines.push("");
  } else {
    lines.push("## Third-party endpoints");
    lines.push("");
    lines.push("_None observed. Wallet contacted only first-party / its own infrastructure._");
    lines.push("");
  }

  if (r.pcapOnlyHosts.length > 0) {
    lines.push("## Seen by pcap but NOT by CDP (possible out-of-band traffic)");
    lines.push("");
    lines.push("These hosts appeared in the packet capture but never in Chrome's own request");
    lines.push("reporting. Worth a closer look.");
    lines.push("");
    for (const h of r.pcapOnlyHosts) lines.push(`- \`${h}\``);
    lines.push("");
  }

  if (r.unknownThirdPartyHosts.length > 0) {
    lines.push("## Unclassified third parties (need investigation / fingerprint-DB join)");
    lines.push("");
    for (const h of r.unknownThirdPartyHosts) lines.push(`- \`${h}\``);
    lines.push("");
  }

  if (r.firstPartyHosts.length > 0) {
    lines.push("## First-party hosts (counted, not penalised)");
    lines.push("");
    for (const h of r.firstPartyHosts) lines.push(`- \`${h}\``);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("> **Limitation:** this is an endpoint-only audit. It proves IP and SaaS exposure,");
  lines.push("> not payload cleanliness. A wallet can score high here and still leak data inside");
  lines.push("> an encrypted first-party call. Use the `--decrypt` deep-dive to inspect payloads.");
  if (!r.captureBackends.includes("pcap")) {
    lines.push("> No pcap backstop in this run (tcpdump/sudo unavailable): CDP capture only.");
  }
  return lines.join("\n");
}

function scoreGrade(s: number): string {
  if (s >= 90) return "clean";
  if (s >= 70) return "fair";
  if (s >= 50) return "leaky";
  return "poor";
}
