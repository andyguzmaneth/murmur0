import type { Browser, Page } from "puppeteer";
import { driveMetaMask, type DriveResult } from "./metamask.js";

export type WalletDriver = (browser: Browser, extId: string, opts: { metrics: boolean }) => Promise<DriveResult>;

/** Scripted onboarding drivers, keyed by wallet name. Add more over time. */
export const DRIVERS: Record<string, WalletDriver> = {
  metamask: driveMetaMask,
};

/** Polls the browser targets for the loaded extension's id. */
export async function findExtensionId(browser: Browser, tries = 25): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    for (const t of browser.targets()) {
      const u = t.url();
      if (u.startsWith("chrome-extension://")) return u.split("/")[2] ?? null;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
