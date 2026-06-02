import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchExtension } from "./fetch-extension.js";
import { launchBrowser } from "./launch.js";
import { CdpCapturer } from "./capture-cdp.js";
import { PcapCapturer } from "./capture-pcap.js";
import { parsePcap } from "./parse-pcap.js";
import { DRIVERS, findExtensionId } from "./drivers/index.js";
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
  const argv = process.argv.slice(2);
  const positionals = argv.filter((a) => !a.startsWith("-"));
  const [walletName, phaseArg] = positionals;
  const decrypt = argv.includes("--decrypt");
  const noPcap = argv.includes("--no-pcap");
  const drive = argv.includes("--drive");
  const metrics = argv.includes("--metrics");
  const secondsFlag = argv.findIndex((a) => a === "--seconds");
  const autoSeconds = secondsFlag >= 0 ? Number(argv[secondsFlag + 1]) : undefined;
  const phase = (phaseArg ?? "cold") as Phase;

  if (!walletName) {
    console.error("usage: npm run audit -- <wallet> [cold|onboarding|active] [--decrypt] [--no-pcap] [--seconds N]");
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

  // Write our PID + report dir so an external controller can stop this run
  // (SIGINT) when the operator finishes driving, instead of a terminal Ctrl-C.
  await writeFile(path.resolve("reports", ".current-audit.pid"), `${process.pid}\n${reportDir}\n`);

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
  const pcapOn = noPcap ? false : await pcap.start();
  console.log(
    noPcap ? "▸ pcap backstop disabled (--no-pcap)" : pcapOn ? "▸ pcap backstop on (sudo tcpdump, pktap)" : "▸ pcap backstop off (no tcpdump)",
  );

  console.log("\n" + "─".repeat(64));
  console.log(PHASE_SCRIPT[phase]);
  console.log("─".repeat(64));

  const driver = DRIVERS[cfg.name];
  if (drive && driver) {
    // Scripted onboarding: actually exercise the wallet so the score reflects a
    // used wallet, not an idle install. metrics flag picks the opt-in branch.
    console.log(`▸ driving ${cfg.displayName} onboarding (metrics ${metrics ? "ACCEPTED" : "declined"}) …`);
    const extId = await findExtensionId(browser);
    if (!extId) {
      console.log("✖ could not find extension id; is it loaded?");
    } else {
      // MetaMask auto-opens its own onboarding tab; open one only if missing.
      const pages = await browser.pages();
      const hasTab = pages.some((p) => {
        try {
          return p.url().includes(`${extId}/home.html`);
        } catch {
          return false;
        }
      });
      if (!hasTab) {
        const np = await browser.newPage();
        await np.goto(`chrome-extension://${extId}/home.html#onboarding/welcome`, { waitUntil: "domcontentloaded" }).catch(() => {});
      }
      const result = await Promise.race([
        driver(browser, extId, { metrics }),
        new Promise<{ steps: string[]; completed: boolean }>((r) =>
          setTimeout(() => r({ steps: ["(driver timed out after 90s)"], completed: false }), 90000),
        ),
      ]);
      await writeFile(path.join(reportDir, "drive-log.txt"), result.steps.join("\n") + "\n");
      console.log(`▸ onboarding ${result.completed ? "completed ✓" : "INCOMPLETE (see drive-log.txt)"}`);
    }
    const trailing = autoSeconds && autoSeconds > 0 ? autoSeconds : 20;
    console.log(`▸ capturing ${trailing}s of trailing traffic …`);
    await waitForStop(() => capturer.count, trailing);
  } else if (autoSeconds && autoSeconds > 0) {
    console.log(`Capturing for ${autoSeconds}s, then stopping automatically.\n`);
    await waitForStop(() => capturer.count, autoSeconds);
  } else {
    // Interactive manual drive: open the wallet UI so the operator sees it.
    if (phase !== "cold") {
      const extId = await findExtensionId(browser);
      if (extId) {
        const np = await browser.newPage();
        await np
          .goto(`chrome-extension://${extId}/home.html#onboarding/welcome`, { waitUntil: "domcontentloaded" })
          .catch(() => {});
      }
    }
    console.log("Capturing all egress. Drive the wallet, then stop the run when done.\n");
    await waitForStop(() => capturer.count);
  }

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
  // Keep the full forensic record (extension + web) in events.jsonl …
  await writeFile(
    path.join(reportDir, "events.jsonl"),
    requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );

  // … but only score the wallet's own egress. Web pages open in the same
  // browser (dapps, stray tabs) are not the wallet phoning home.
  const walletReqs = requests.filter((r) => r.scope === "extension");
  const webReqs = requests.filter((r) => r.scope === "web");
  const webHosts = [...new Set(webReqs.map((r) => r.host))].sort();

  const hosts = await classifyHosts(walletReqs, cfg);
  const result = await score(hosts, cfg, phase, timestamp, walletReqs.length);
  result.excludedWebRequests = webReqs.length;
  result.excludedWebHosts = webHosts;

  // What did the wallet SEND to third parties? One sample body per third-party host.
  const thirdHosts = new Set(hosts.filter((h) => h.party === "third").map((h) => h.host));
  const seenPayload = new Set<string>();
  for (const r of walletReqs) {
    if (!r.postData || !thirdHosts.has(r.host) || seenPayload.has(r.host)) continue;
    seenPayload.add(r.host);
    result.thirdPartyPayloads.push({ host: r.host, method: r.method, sample: r.postData.slice(0, 500) });
  }

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

/** Resolves on Ctrl-C, or after `seconds` if given (for unattended cold runs). */
function waitForStop(count: () => number, seconds?: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(iv);
      if (timer) clearTimeout(timer);
      process.off("SIGINT", finish);
      resolve();
    };
    process.on("SIGINT", finish);
    const iv = setInterval(() => {
      process.stdout.write(`\r  …captured ${count()} requests`);
    }, 1000);
    const timer = seconds && seconds > 0 ? setTimeout(finish, seconds * 1000) : null;
  });
}

main().catch((err) => {
  console.error("\n✖", err?.message ?? err);
  process.exit(1);
});
