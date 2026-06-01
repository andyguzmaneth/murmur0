import puppeteer, { type Browser } from "puppeteer";

/**
 * Canonical Chrome isolation flag set (chrome-launcher / Lighthouse derived).
 * Silences Chrome's own phone-home so the capture isolates the extension, and
 * CRITICALLY disables DnsOverHttps + EncryptedClientHello so the pcap backstop
 * can read cleartext DNS/SNI. CDP capture is above TLS and unaffected, but we
 * keep the flags on for both layers' consistency.
 */
export const ISOLATION_FLAGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-domain-reliability",
  "--disable-breakpad",
  "--no-pings",
  "--metrics-recording-only",
  "--disable-default-apps",
  "--disable-client-side-phishing-detection",
  "--disable-features=DnsOverHttps,EncryptedClientHello,OptimizationHints,AutofillServerCommunication,MediaRouter,Translate,InterestFeedContentSuggestions",
];

export interface LaunchOptions {
  profileDir: string;
  /** Absolute path(s) to unpacked extension dirs to load. */
  extensionPaths?: string[];
  /** Opt-in TLS key logging for the SSLKEYLOGFILE deep-dive (pairs with pcap). */
  keylogPath?: string;
}

export async function launchBrowser(opts: LaunchOptions): Promise<Browser> {
  const args = [...ISOLATION_FLAGS];

  if (opts.extensionPaths && opts.extensionPaths.length > 0) {
    const joined = opts.extensionPaths.join(",");
    args.push(`--disable-extensions-except=${joined}`);
    args.push(`--load-extension=${joined}`);
  }

  const env = { ...process.env };
  if (opts.keylogPath) env.SSLKEYLOGFILE = opts.keylogPath;

  const browser = await puppeteer.launch({
    headless: false, // extensions + MV3 service workers require headed Chrome
    args,
    env,
    userDataDir: opts.profileDir,
    // Use Puppeteer's bundled Chrome for Testing (vanilla, reproducible).
    // userDataDir is passed via args so Puppeteer doesn't create a temp one.
    handleSIGINT: false, // audit.ts owns Ctrl-C
    handleSIGTERM: false,
    handleSIGHUP: false,
    defaultViewport: null,
  });

  return browser;
}
