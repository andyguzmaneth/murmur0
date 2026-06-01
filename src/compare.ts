import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ScoreResult } from "./types.js";

const REPORTS = path.resolve("reports");

/**
 * Walks reports/<wallet>/<phase>/<timestamp>/score.json, keeps the most recent
 * run per (wallet, phase), and writes reports/comparison.md: a ranked table
 * across the whole matrix plus the worst offenders per wallet.
 */
async function main() {
  const scores = await collectLatest();
  if (scores.length === 0) {
    console.log("no score.json files under reports/ yet. run some audits first.");
    return;
  }

  scores.sort((a, b) => a.score - b.score || a.wallet.localeCompare(b.wallet));

  const lines: string[] = [];
  lines.push("# murmur0: wallet comparison");
  lines.push("");
  lines.push(`Generated from ${scores.length} runs. Lower score = more third-party egress.`);
  lines.push("");
  lines.push("| Wallet | Phase | Score | 3p hosts | 3p domains | Top vendors |");
  lines.push("|--------|-------|------:|---------:|-----------:|-------------|");
  for (const s of scores) {
    const top = s.breakdown.slice(0, 4).map((b) => b.vendor ?? b.host).join(", ") || "none";
    lines.push(
      `| ${s.displayName} | ${s.phase} | ${s.score} | ${s.uniqueThirdPartyHosts} | ${s.uniqueThirdPartyEtldPlusOne} | ${top} |`,
    );
  }
  lines.push("");
  lines.push("> Endpoint-only. Scores are directional, not a verdict. See each run's report.md.");

  const outFile = path.join(REPORTS, "comparison.md");
  await writeFile(outFile, lines.join("\n"));
  console.log(lines.join("\n"));
  console.log(`\n▸ written to ${outFile}`);
}

async function collectLatest(): Promise<ScoreResult[]> {
  const found = new Map<string, { result: ScoreResult; mtime: number }>();
  let wallets: string[];
  try {
    wallets = await readdir(REPORTS);
  } catch {
    return [];
  }
  for (const wallet of wallets) {
    const wDir = path.join(REPORTS, wallet);
    if (!(await isDir(wDir))) continue;
    for (const phase of await readdir(wDir)) {
      const pDir = path.join(wDir, phase);
      if (!(await isDir(pDir))) continue;
      for (const ts of await readdir(pDir)) {
        const scoreFile = path.join(pDir, ts, "score.json");
        try {
          const st = await stat(scoreFile);
          const result = JSON.parse(await readFile(scoreFile, "utf8")) as ScoreResult;
          const key = `${wallet}/${phase}`;
          const prev = found.get(key);
          if (!prev || st.mtimeMs > prev.mtime) found.set(key, { result, mtime: st.mtimeMs });
        } catch {
          /* skip incomplete runs */
        }
      }
    }
  }
  return [...found.values()].map((v) => v.result);
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

main().catch((e) => {
  console.error("✖", e?.message ?? e);
  process.exit(1);
});
