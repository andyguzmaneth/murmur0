import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getDomain } from "tldts";
import { launchBrowser } from "./launch.js";
import { CdpCapturer } from "./capture-cdp.js";

const BASELINE_FILE = path.resolve("fingerprints", "chrome-baseline.json");

export interface Baseline {
  capturedAt: string;
  seconds: number;
  hosts: string[];
  etldPlusOne: string[];
}

/**
 * Launches a clean Chrome with NO extension and records what it contacts on its
 * own. The result is a denylist of Chrome's residual background traffic, which
 * the audit subtracts so a wallet is never blamed for the browser's own pings.
 * Fully automated: no manual driving, no sudo.
 */
export async function runBaseline(seconds = 45): Promise<Baseline> {
  const profileDir = path.resolve("profiles", `baseline-${Date.now()}`);
  const browser = await launchBrowser({ profileDir });
  const capturer = new CdpCapturer(browser);
  await capturer.start();

  // open a blank page so Chrome does its normal startup chatter
  const page = await browser.newPage();
  await page.goto("about:blank").catch(() => {});

  await new Promise((r) => setTimeout(r, seconds * 1000));

  const requests = capturer.stop();
  await browser.close().catch(() => {});

  const hosts = [...new Set(requests.map((r) => r.host))].sort();
  const etlds = [...new Set(hosts.map((h) => (getDomain(h) ?? h).toLowerCase()))].sort();
  const baseline: Baseline = {
    capturedAt: new Date().toISOString(),
    seconds,
    hosts,
    etldPlusOne: etlds,
  };

  await mkdir(path.dirname(BASELINE_FILE), { recursive: true });
  await writeFile(BASELINE_FILE, JSON.stringify(baseline, null, 2));
  return baseline;
}

let cached: Set<string> | null = null;
/** Host set of Chrome's own baseline traffic; empty if no baseline captured yet. */
export async function loadBaselineHosts(): Promise<Set<string>> {
  if (cached) return cached;
  try {
    const b = JSON.parse(await readFile(BASELINE_FILE, "utf8")) as Baseline;
    cached = new Set(b.hosts);
  } catch {
    cached = new Set();
  }
  return cached;
}

/** CLI: tsx src/baseline.ts [seconds] */
if (import.meta.url === `file://${process.argv[1]}`) {
  const secs = Number(process.argv[2] ?? 45);
  console.log(`▸ capturing Chrome baseline for ${secs}s (no extension) …`);
  const b = await runBaseline(secs);
  console.log(`▸ baseline: ${b.hosts.length} hosts, ${b.etldPlusOne.length} domains`);
  console.log(`▸ written to ${BASELINE_FILE}`);
  if (b.hosts.length) console.log(b.hosts.map((h) => `  - ${h}`).join("\n"));
  process.exit(0);
}
