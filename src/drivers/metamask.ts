import type { Browser, Page } from "puppeteer";

export interface DriveResult {
  steps: string[];
  completed: boolean;
}

const PASSWORD = "murmur0-test-passw0rd";

/**
 * Drives MetaMask through new-wallet onboarding so the extension does its real
 * setup work. MetaMask spawns its own onboarding tab(s), so we never hold a
 * single page handle: every step re-acquires the live onboarding page from the
 * browser. metrics chooses the MetaMetrics opt-in branch.
 */
export async function driveMetaMask(browser: Browser, extId: string, opts: { metrics: boolean }): Promise<DriveResult> {
  const steps: string[] = [];
  const log = (m: string) => {
    steps.push(m);
    console.log(`   · ${m}`);
  };

  /** The live MetaMask onboarding page (last home.html tab MetaMask has open). */
  async function mmPage(): Promise<Page | null> {
    const pages = await browser.pages();
    const mm = pages.filter((p) => {
      try {
        return p.url().includes(`${extId}/home.html`);
      } catch {
        return false;
      }
    });
    return mm[mm.length - 1] ?? null;
  }

  await settle(2500);
  const start = await mmPage();
  log(`onboarding tab: ${start ? start.url().split("#")[1] ?? start.url() : "(not found)"}`);

  await clickAny(mmPage, ["onboarding-create-wallet"], ["Create a new wallet"], log);
  await settle(2500);

  if (opts.metrics) {
    await clickAny(mmPage, ["metametrics-i-agree", "onboarding-metametrics-agree"], ["I agree", "Agree"], log);
  } else {
    await clickAny(mmPage, ["metametrics-no-thanks", "onboarding-metametrics-no-thanks"], ["No thanks", "Not right now"], log);
  }
  await settle(2000);

  const typed = await typeInto(mmPage, ["create-password-new"], PASSWORD, log);
  await typeInto(mmPage, ["create-password-confirm"], PASSWORD, log);
  await check(mmPage, ["create-password-terms"], log);
  if (typed) {
    await clickAny(mmPage, ["create-password-wallet"], ["Create a new wallet", "Create password", "Confirm"], log);
    await settle(2500);
  }

  await clickAny(mmPage, ["secure-wallet-later"], ["Remind me later"], log);
  await check(mmPage, ["skip-srp-backup-popover-checkbox"], log);
  await clickAny(mmPage, ["skip-srp-backup"], ["Skip"], log);
  await settle(2000);

  await clickAny(mmPage, ["onboarding-complete-done", "onboarding-complete-done-button"], ["Done", "Got it"], log);
  await settle(1200);
  await clickAny(mmPage, ["pin-extension-next"], ["Next"], log);
  await clickAny(mmPage, ["pin-extension-done"], ["Done"], log);
  await settle(2000);

  const page = await mmPage();
  let completed = false;
  if (page) {
    completed = await page
      .$(`[data-testid="account-options-menu-button"], [data-testid="eth-overview__primary-currency"], [data-testid="app-header-logo"]`)
      .then((e) => !!e)
      .catch(() => false);
  }
  log(completed ? "reached wallet home ✓" : "did not confirm wallet home (selectors may have drifted)");
  return { steps, completed };
}

function settle(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Bound any page op so a navigation-in-flight can never hang the driver. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

type GetPage = () => Promise<Page | null>;

async function clickAny(getPage: GetPage, testids: string[], texts: string[], log: (m: string) => void): Promise<boolean> {
  const page = await getPage();
  if (!page) {
    log("(skip) no onboarding page");
    return false;
  }
  for (const tid of testids) {
    const el = await withTimeout(page.$(`[data-testid="${tid}"]`).catch(() => null), 4000, null);
    if (el) {
      await withTimeout(el.click().catch(() => {}), 4000, undefined);
      log(`click [data-testid=${tid}]`);
      return true;
    }
  }
  for (const t of texts) {
    const clicked = await withTimeout(
      page
        .evaluate((txt) => {
          const btns = Array.from(document.querySelectorAll("button, [role=button]"));
          const b = btns.find((x) => (x.textContent || "").trim().toLowerCase().includes(txt.toLowerCase()));
          if (b) {
            (b as HTMLElement).click();
            return true;
          }
          return false;
        }, t)
        .catch(() => false),
      4000,
      false,
    );
    if (clicked) {
      log(`click button "${t}"`);
      return true;
    }
  }
  log(`(skip) none of [${testids.join(", ")}]`);
  return false;
}

async function check(getPage: GetPage, testids: string[], log: (m: string) => void): Promise<boolean> {
  const page = await getPage();
  if (!page) return false;
  for (const tid of testids) {
    const el = await withTimeout(page.$(`[data-testid="${tid}"]`).catch(() => null), 4000, null);
    if (el) {
      await withTimeout(el.click().catch(() => {}), 4000, undefined);
      log(`check [data-testid=${tid}]`);
      return true;
    }
  }
  return false;
}

async function typeInto(getPage: GetPage, testids: string[], value: string, log: (m: string) => void): Promise<boolean> {
  const page = await getPage();
  if (!page) return false;
  for (const tid of testids) {
    const el = await withTimeout(page.$(`[data-testid="${tid}"]`).catch(() => null), 4000, null);
    if (el) {
      await withTimeout(el.type(value, { delay: 10 }).catch(() => {}), 6000, undefined);
      log(`type into [data-testid=${tid}]`);
      return true;
    }
  }
  log(`(skip) input none of [${testids.join(", ")}]`);
  return false;
}
