import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm, readdir, access } from "node:fs/promises";
import path from "node:path";

const execFileP = promisify(execFile);
const EXT_ROOT = path.resolve("extensions");

/**
 * Downloads a Chrome Web Store extension by ID as a CRX, strips the CRX2/CRX3
 * header to recover the embedded ZIP, and unpacks it to extensions/<id>/.
 * Returns the absolute path to the unpacked extension (suitable for
 * --load-extension). Idempotent: re-unpacks unless already present.
 */
export async function fetchExtension(storeId: string, force = false): Promise<string> {
  const dest = path.join(EXT_ROOT, storeId);
  if (!force && (await exists(path.join(dest, "manifest.json")))) {
    return dest;
  }

  await mkdir(EXT_ROOT, { recursive: true });
  const crxUrl =
    `https://clients2.google.com/service/update2/crx?response=redirect` +
    `&acceptformat=crx2,crx3&prodversion=120.0` +
    `&x=id%3D${storeId}%26installsource%3Dondemand%26uc`;

  const res = await fetch(crxUrl, { redirect: "follow" });
  if (!res.ok) throw new Error(`CRX download failed: ${res.status} ${res.statusText}`);
  const crx = Buffer.from(await res.arrayBuffer());

  const zip = stripCrxHeader(crx);
  const zipPath = path.join(EXT_ROOT, `${storeId}.zip`);
  await writeFile(zipPath, zip);

  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await execFileP("unzip", ["-o", "-qq", zipPath, "-d", dest]);
  await rm(zipPath, { force: true });

  if (!(await exists(path.join(dest, "manifest.json")))) {
    throw new Error(`Unpacked extension has no manifest.json at ${dest}`);
  }
  return dest;
}

/** CRX3 = "Cr24" + u32 version(3) + u32 headerLen + header + ZIP. CRX2 differs. */
function stripCrxHeader(buf: Buffer): Buffer {
  if (buf.subarray(0, 4).toString("latin1") !== "Cr24") {
    return buf; // already a plain zip
  }
  const version = buf.readUInt32LE(4);
  if (version === 3) {
    const headerLen = buf.readUInt32LE(8);
    return buf.subarray(12 + headerLen);
  }
  if (version === 2) {
    const pubKeyLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    return buf.subarray(16 + pubKeyLen + sigLen);
  }
  throw new Error(`Unsupported CRX version ${version}`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** CLI: tsx src/fetch-extension.ts <storeId> */
if (import.meta.url === `file://${process.argv[1]}`) {
  const id = process.argv[2];
  if (!id) {
    console.error("usage: tsx src/fetch-extension.ts <storeId>");
    process.exit(1);
  }
  const out = await fetchExtension(id, true);
  console.log("unpacked ->", out);
  const files = await readdir(out);
  console.log("contents:", files.join(", "));
}
