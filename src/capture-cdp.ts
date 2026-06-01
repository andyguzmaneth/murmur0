import type { Browser, Target, CDPSession } from "puppeteer";
import type { CapturedRequest } from "./types.js";

const CAPTURABLE_TYPES = new Set([
  "page",
  "background_page",
  "service_worker",
  "shared_worker",
  "webview",
  "other",
]);

/**
 * Attaches a CDP Network listener to every current and future target in the
 * browser (pages AND the extension's MV3 service worker, which is where most
 * wallet background egress originates). Records each outbound request.
 */
export class CdpCapturer {
  private requests: CapturedRequest[] = [];
  private sessions = new Set<CDPSession>();
  private attached = false;

  constructor(private browser: Browser) {}

  async start(): Promise<void> {
    this.attached = true;
    this.browser.on("targetcreated", this.onTarget);
    // Attach to anything already open.
    for (const target of this.browser.targets()) {
      await this.attach(target);
    }
  }

  private onTarget = async (target: Target): Promise<void> => {
    if (!this.attached) return;
    await this.attach(target);
  };

  private async attach(target: Target): Promise<void> {
    if (!CAPTURABLE_TYPES.has(target.type())) return;
    let client: CDPSession;
    try {
      client = await target.createCDPSession();
    } catch {
      return; // some targets reject CDP sessions; skip quietly
    }
    try {
      await client.send("Network.enable");
    } catch {
      return;
    }
    this.sessions.add(client);

    const targetType = target.type();
    // service_worker / background_page / other belong to the extension in a
    // single-extension profile. page targets are classified per-request below.
    const targetIsExtension =
      targetType === "service_worker" || targetType === "background_page" || targetType === "other";

    client.on("Network.requestWillBeSent", (params: any) => {
      const url: string = params?.request?.url ?? "";
      if (!url.startsWith("http") && !url.startsWith("ws")) return; // skip data:, chrome-extension:, blob:
      let host = "";
      try {
        host = new URL(url).host;
      } catch {
        return;
      }
      // Wallet egress if the target is the extension, or the document is an
      // extension page (chrome-extension://). Anything else is a web page open
      // in the same browser and must not count against the wallet.
      const docUrl: string = params?.documentURL ?? "";
      const scope: "extension" | "web" =
        targetIsExtension || docUrl.startsWith("chrome-extension://") ? "extension" : "web";
      this.requests.push({
        ts: typeof params.wallTime === "number" ? params.wallTime * 1000 : Date.now(),
        url,
        host,
        method: params?.request?.method ?? "GET",
        resourceType: params?.type,
        initiator: params?.initiator?.url || params?.initiator?.type,
        targetType,
        scope,
        source: "cdp",
      });
    });
  }

  stop(): CapturedRequest[] {
    this.attached = false;
    this.browser.off("targetcreated", this.onTarget);
    for (const s of this.sessions) {
      s.detach().catch(() => {});
    }
    this.sessions.clear();
    return this.requests;
  }

  get count(): number {
    return this.requests.length;
  }
}
