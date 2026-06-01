import type { ScoreResult } from "./types.js";

export function renderReport(r: ScoreResult): string {
  const grade = scoreEmoji(r.score);
  const lines: string[] = [];
  lines.push(`# ${r.displayName} — Egress Privacy Report`);
  lines.push("");
  lines.push(`**Score: ${r.score}/100** ${grade}  ·  phase: \`${r.phase}\`  ·  ${r.timestamp}`);
  lines.push("");
  lines.push(`- Total requests observed: **${r.totalRequests}**`);
  lines.push(`- Unique third-party hosts: **${r.uniqueThirdPartyHosts}** (${r.uniqueThirdPartyEtldPlusOne} distinct domains)`);
  lines.push(`- First-party hosts: ${r.firstPartyHosts.length} · Chrome-infra (excluded): ${r.chromeHosts.length}`);
  lines.push("");

  if (r.breakdown.length > 0) {
    lines.push("## Third-party endpoints (penalised)");
    lines.push("");
    lines.push("| Host | Domain | Vendor | Category | −pts |");
    lines.push("|------|--------|--------|----------|-----:|");
    for (const b of r.breakdown) {
      lines.push(
        `| \`${b.host}\` | ${b.etldPlusOne} | ${b.vendor ?? "—"} | ${b.category ?? "unknown"} | ${b.penalty} |`,
      );
    }
    lines.push("");
  } else {
    lines.push("## Third-party endpoints");
    lines.push("");
    lines.push("_None observed. Wallet contacted only first-party / its own infrastructure._");
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
  lines.push("> **Limitation:** endpoint-only audit. Proves IP/SaaS exposure, not payload");
  lines.push("> cleanliness — a wallet can score high here and still leak data *inside* an");
  lines.push("> encrypted first-party call. Use the `--decrypt` deep-dive to inspect payloads.");
  lines.push("> CDP capture only; pcap backstop not yet merged (Milestone 2).");
  return lines.join("\n");
}

function scoreEmoji(s: number): string {
  if (s >= 90) return "🟢";
  if (s >= 70) return "🟡";
  if (s >= 50) return "🟠";
  return "🔴";
}
