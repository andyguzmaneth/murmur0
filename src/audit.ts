import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchExtension } from "./fetch-extension.js";
import { launchBrowser } from "./launch.js";
import { CdpCapturer } from "./capture-cdp.js";
import { PcapCapturer } from "./capture-pcap.js";
import { parsePcap } from "./parse-pcap.js";
import { classifyHosts } from "./classify.js";
import { score } from "./score.js";
import { renderReport } from "./report.js";
import type { Phase, WalletConfig, CapturedRequest } from "./types.js";

const PHASES: Phase[] = ["cold", "onboarding", "active"];

const PHASE_SCRIPT: Record<Phase, string> = {
  cold: "COLD OPEN: do nothing. Let the wallet sit ~60s so startup phone-home fires.",
  onboarding: "ONBOARDING: create a NEW wallet, set a password. Do not fund it.",
  active: "ACTIVE: view balances, switch networks, open a swap QUOTE (do NOT send a tx).",
};

async function main() {
  const [walletName, phaseArg] = process.argv.slice(2);
  const decrypt = process.argv.includes("--decrypt");
  const phase = (phaseArg ?? "cold") as Phase;

  if (!walletName) {
    console.error("usage: npm run audit -- <wallet> [cold|onboarding|active] [--decrypt]");
    process.exit(1);
  }
  if (!PHASES.includes(phase)) {
    console.error(`unknown phase '${phase}'. one of: ${PHASES.join(", ")}`);
    process.exit(1);
  }

  const cfg = await loadWallet(walletName);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = path.resolve("reports", cfg.name, phase, timestamp);
  const profileDir = path.resolve("profiles", `${cfg.name}-${phase}-${timestamp}`);
  await mkdir(reportDir, { recursive: true });

  console.log(`\n▸ ${cfg.displayName}  ·  phase=${phase}${decrypt ? "  ·  --decrypt" : ""}`);
  console.log(`▸ fetching extension ${cfg.storeId} …`);
  const extPath = await fetchExtension(cfg.storeId);
  console.log(`▸ extension ready: ${extPath}`);

  const keylogPath = decrypt ? path.join(reportDir, "keys.log") : undefined;
  console.log(`▸ launching isolated Chrome (fresh profile) …`);
  const browser = await launchBrowser({ profileDir, extensionPaths: [extPath], keylogPath });

  const capturer = new CdpCapturer(browser);
  await capturer.start();

  // pcap backstop (best-effort). Needs tcpdump + sudo; prompts for the sudo
  // password in this terminal. If unavailable, we proceed CDP-only.
  const pcapPath = path.join(reportDir, "session.pcap");
  const pcap = new PcapCapturer(pcapPath);
  const pcapOn = await pcap.start();
  console.log(pcapOn ? "▸ pcap backstop on (sudo tcpdump, pktap)" : "▸ pcap backstop off (no tcpdump)");

  console.log("\n" + "─".repeat(64));
  console.log(PHASE_SCRIPT[phase]);
  console.log("─".repeat(64));
  console.log("Capturing all egress. Press Ctrl-C when the phase is done.\n");

  await waitForSigint(() => capturer.count);

  console.log("\n▸ stopping capture …");
  const cdpRequests = capturer.stop();
  if (pcapOn) await pcap.stop();
  await browser.close().catch(() => {});

  const pcapRequests = pcapOn ? await parsePcap(pcapPath) : [];
  if (pcapOn) console.log(`▸ pcap parsed: ${pcapRequests.length} host records`);

  await analyze([...cdpRequests, ...pcapRequests], cfg, phase, timestamp, reportDir);
}

async function analyze(
  requests: CapturedRequest[],
  cfg: WalletConfig,
  phase: Phase,
  timestamp: string,
  reportDir: string,
) {
  await writeFile(
    path.join(reportDir, "events.jsonl"),
    requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );

  const hosts = await classifyHosts(requests, cfg);
  const result = await score(hosts, cfg, phase, timestamp, requests.length);
  const md = renderReport(result);

  await writeFile(path.join(reportDir, "hosts.json"), JSON.stringify(hosts, null, 2));
  await writeFile(path.join(reportDir, "score.json"), JSON.stringify(result, null, 2));
  await writeFile(path.join(reportDir, "report.md"), md);

  console.log("\n" + md.split("\n").slice(0, 8).join("\n"));
  console.log(`\n▸ full report: ${path.join(reportDir, "report.md")}`);
}

async function loadWallet(name: string): Promise<WalletConfig> {
  const file = path.resolve("wallets", `${name}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8")) as WalletConfig;
  } catch {
    throw new Error(`no wallet config at ${file}`);
  }
}

function waitForSigint(count: () => number): Promise<void> {
  return new Promise((resolve) => {
    const handler = () => {
      process.off("SIGINT", handler);
      resolve();
    };
    process.on("SIGINT", handler);
    // heartbeat so the operator sees progress
    const iv = setInterval(() => {
      process.stdout.write(`\r  …captured ${count()} requests`);
    }, 1000);
    process.on("SIGINT", () => clearInterval(iv));
  });
}

main().catch((err) => {
  console.error("\n✖", err?.message ?? err);
  process.exit(1);
});
