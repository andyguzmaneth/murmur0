import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Chrome for Testing's bundle id, used as the pktap process filter. */
export const CHROME_BUNDLE_ID = "com.google.chrome.for.testing";

/**
 * Captures only Chrome's egress to a pcap using macOS's pktap pseudo-interface,
 * which tags packets by process. Requires sudo (libpcap on BPF) and tcpdump
 * (built into macOS). DNS and TLS SNI are readable because launch.ts disables
 * DnsOverHttps + EncryptedClientHello.
 *
 * This is the ground-truth backstop to the CDP capture: anything here that CDP
 * did not also report is flagged as potential out-of-band traffic.
 */
export class PcapCapturer {
  private proc: ChildProcess | null = null;

  constructor(private outFile: string) {}

  /** Returns true if started, false if the platform/tooling can't support it. */
  async start(): Promise<boolean> {
    if (!(await hasTcpdump())) return false;
    // -i pktap,<bundleid> = only this process. -k = include process metadata.
    // -n = no name resolution (so tcpdump itself emits no DNS).
    this.proc = spawn(
      "sudo",
      ["tcpdump", "-i", `pktap,${CHROME_BUNDLE_ID}`, "-k", "-n", "-w", this.outFile],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    return true;
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    // tcpdump runs under sudo; SIGINT to flush + close the pcap cleanly.
    try {
      await execFileP("sudo", ["kill", "-INT", String(this.proc.pid)]).catch(() => {});
    } catch {
      /* ignore */
    }
    this.proc.kill("SIGINT");
    this.proc = null;
    await new Promise((r) => setTimeout(r, 500)); // let the file flush
  }
}

export async function hasTcpdump(): Promise<boolean> {
  try {
    await execFileP("which", ["tcpdump"]);
    return true;
  } catch {
    return false;
  }
}
