# Wallet Egress Audit — Implementation Plan

> Proposed project: `~/projects/wallet-egress-audit` (name is a placeholder — easy to rename, e.g. `walletscope`).
> On approval: create the dir, drop this file in as `PLAN.md` + a short `README.md`, then create the GitHub repo and start the v1 slice.

## Context

Ranko X (@r4nk0X) published a "Crypto Wallet IP Exposure Scorecard 2026" — he scored mobile wallets 0–100 purely by **who they phone home to** (unique IPs + domains contacted on launch), classifying each endpoint against known third-party SaaS (AppsFlyer, Firebase, Sentry, Segment, Amplitude…). His method: clean Android device, APKs, all traffic through PCAPdroid, endpoint enumeration — no payload decryption needed to make the privacy argument.

We want to **port this methodology to Chrome browser-extension wallets**, run entirely on a local MacBook (residential wifi, no VPN), and produce a reproducible, scored privacy report per wallet plus a cross-wallet comparison.

**Why extensions are different (and in our favor):**
- Extension source is **plain JS on disk** + a `manifest.json` that **declares** allowed egress (`host_permissions`) — free static ground truth.
- We control the TLS trust store, so optional payload decryption needs no MITM CA.
- **Extensions can only egress over HTTP(S)/WebSocket** through Chrome's network stack — no raw/UDP sockets. This makes the **Chrome DevTools Protocol (CDP)** a first-class capture backend (full URLs + per-initiator attribution, above TLS).

**Intended outcome:** `audit <wallet> <phase>` → launches an isolated Chrome with the wallet, captures all egress (CDP + pcap), classifies endpoints, emits `score.json` + a human-readable `report.md`. Repeat across a wallet matrix → comparison table.

---

## Decisions locked (from planning Q&A)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Capture depth | **Endpoint-first; decrypt on demand** | Default run scores on *who* is contacted (DNS+SNI / CDP URLs). `SSLKEYLOGFILE` payload decryption is an opt-in per-wallet deep dive. Reproducible, low data-privacy risk. |
| 2 | Driving | **Manual-drive + harness** | You click through the wallet; the harness owns capture lifecycle, baseline subtraction, analysis. No flaky full automation in v1. |
| 3 | Interaction phases | **cold-open, onboarding, active** | Captured to separate artifacts so we can attribute calls to a phase (startup vs key-gen vs balance/swap). |
| 4 | Wallet matrix | **EVM majors + multi-chain/CEX-linked + privacy-leaning** | Broad first batch; privacy-leaning set validates the harness reproduces "known clean." |
| 5 | Capture backend | **Both, layered: CDP primary + pcap backstop** | CDP = full URLs + initiator, no decryption, manual-drive friendly. pcap (pktap, Chrome-only) = OS ground truth + enables SSLKEYLOGFILE deep dive. They cross-validate. |
| 6 | Stack | **TypeScript (Puppeteer)** | Puppeteer is the reference CDP/Chrome driver (clean profile, extension load, attach to MV3 service worker). pcap backstop = tcpdump/tshark subprocess. Same stack if a report UI is added. |

---

## The load-bearing technical facts (verified, June 2026)

These are the things that make-or-break the capture. Full citations in the research appendix.

1. **Disable BOTH secure DNS and ECH or the capture goes blind.** Current Chrome encrypts DNS (DoH) *and* SNI (Encrypted Client Hello) by default, and **ECH works even when DoH is off** (it reads ECH keys from the HTTPS DNS record). Launch flag: `--disable-features=DnsOverHttps,EncryptedClientHello`. With ECH disabled, TLS 1.3 SNI is cleartext.
   - *This only affects the pcap layer.* CDP capture is above TLS and is immune — which is exactly why CDP is our primary signal and pcap is the backstop.
2. **macOS `pktap` tags packets by process.** `sudo tcpdump -i 'pktap,com.google.Chrome' -k -w out.pcap` captures **only Chrome's** egress — OS-native process isolation, no VM needed. Combined with a clean profile, that's double isolation.
3. **`SSLKEYLOGFILE` works in 2026 Chrome** for the opt-in deep dive — but you must launch the `.app` binary **directly** (not `open -a`) with Chrome fully quit, and set the env var on that invocation. tshark reads it via `-o tls.keylog_file:...`.
4. **Chrome's own background noise must be suppressed + baselined.** Canonical isolation flags (from chrome-launcher): `--no-first-run --no-default-browser-check --disable-background-networking --disable-component-update --disable-sync --disable-domain-reliability --disable-breakpad --no-pings --metrics-recording-only --disable-default-apps --disable-client-side-phishing-detection` plus `--disable-features=DnsOverHttps,EncryptedClientHello,OptimizationHints,AutofillServerCommunication,MediaRouter,Translate,InterestFeedContentSuggestions`. Always a **fresh** `--user-data-dir`. We *also* run a no-extension baseline capture and subtract Chrome's residual domains.
5. **SNI field for tshark:** `tls.handshake.extensions_server_name`; DNS: `dns.qry.name`; dest IP: `ip.dst`.

---

## Reuse, don't rebuild — fingerprint DB

| Source | Role | URL |
|--------|------|-----|
| **DuckDuckGo Tracker Radar** | Canonical `domain → entity → category` table + `prevalence`/`fingerprinting` scores (feed scoring directly) | github.com/duckduckgo/tracker-radar (`domains/US/*.json`, `entities/*.json`) |
| **Exodus Privacy `network_signature`** | Regex layer for mobile-overlap SaaS + per-tenant subdomains (AppsFlyer `jl6zc7-*`, Crashlytics, self-hosted Sentry) | reports.exodus-privacy.eu.org/api/trackers |
| **Disconnect `services.json`** | Reconciliation/merge for gaps | github.com/disconnectme/disconnect-tracking-protection |

Curated SaaS hostname patterns we hard-code on top (the high-signal ones): `firebaseinstallations.googleapis.com`, `firebaseremoteconfig.googleapis.com`, GA4 `/g/collect`, `api.segment.io`, `api2.amplitude.com`, `*.appsflyer.com`, `o*.ingest.*.sentry.io` + `/envelope/` path, `notify.bugsnag.com`, `browser-intake-*.datadoghq.com`, `api.mixpanel.com`, `*.crashlytics.com`. (Full table in research appendix.)

**First-party detection:** a contacted eTLD+1 owned by the wallet vendor (seeded per wallet + cross-checked: matches `host_permissions`, brand name, or Tracker Radar non-tracker classification) is *counted but not penalized*.

---

## Architecture

```
wallet-egress-audit/
├── PLAN.md                 # this file
├── README.md
├── package.json            # TS + puppeteer, tsx for run
├── bin/audit               # CLI entry: audit <wallet> <phase> [--decrypt]
├── src/
│   ├── launch.ts           # Puppeteer: clean profile + load extension + isolation flags (+ optional SSLKEYLOGFILE)
│   ├── capture-cdp.ts      # attach to all targets incl. MV3 SW; stream Network.requestWillBeSent/responseReceived → events.jsonl
│   ├── capture-pcap.ts     # spawn `tcpdump -i pktap,com.google.Chrome` → session.pcap; teardown on stop
│   ├── parse-pcap.ts       # tshark subprocess → {ts, ip.dst, sni, dns} rows
│   ├── classify.ts         # merge CDP+pcap hosts; join Tracker Radar + Exodus regex + curated SaaS; first-party tagging
│   ├── score.ts            # rubric → score.json
│   ├── report.ts           # score.json → report.md (per wallet) + comparison.md (across wallets)
│   ├── static-analysis.ts  # download CRX by store ID → unzip → parse manifest host_permissions + grep JS for URL literals
│   └── baseline.ts         # no-extension capture → denylist of Chrome's own domains
├── fingerprints/           # vendored snapshots: tracker-radar/, exodus-trackers.json, disconnect-services.json, saas-patterns.json
├── wallets/                # per-wallet config: store ID, known first-party domains, onboarding notes
│   └── metamask.json
└── reports/<wallet>/<phase>/<timestamp>/   # events.jsonl, session.pcap, hosts.json, score.json, report.md
```

### Capture flow (per `audit <wallet> <phase>`)
1. `launch.ts` — Puppeteer launches Chrome with a **fresh** `--user-data-dir`, the extension loaded (`--load-extension` for unpacked, or pre-installed CRX in the profile), full isolation flag set, remote debugging on. `--decrypt` adds `SSLKEYLOGFILE`.
2. `capture-pcap.ts` starts `tcpdump -i pktap,com.google.Chrome -k -w session.pcap` (sudo; preflight checks ChmodBPF/sudo).
3. `capture-cdp.ts` attaches to **all** targets (page + extension background **service worker** — critical for MV3) and streams `Network.*` to `events.jsonl`.
4. Console prints the **phase script** to follow (e.g. cold: "leave it 60s"; onboarding: "create a new wallet"; active: "view balances, switch network, open a swap quote — do NOT send"). You perform it, then Ctrl-C.
5. On stop: teardown, then `parse-pcap → classify → score → report`. Cross-check: any host in pcap **not** seen in CDP gets flagged (potential out-of-band / something CDP missed).

### Scoring rubric (start 100, subtract; mirrors Ranko, weighted by Tracker Radar)
- **0** for first-party + benign CDN/price-feed/RPC.
- **Stable-ID install pings** (Firebase Installations): medium.
- **Analytics/attribution** (Segment, Amplitude, Mixpanel, AppsFlyer, GA4): high (weighted by Tracker Radar `prevalence` × `fingerprinting`).
- **Crash/monitoring** (Sentry, Bugsnag, Crashlytics, Datadog): low–medium.
- **Exposure surface**: small penalty per unique third-party IP + domain (Ranko's core signal).
- **Static axis (separate, reported alongside):** `host_permissions` breadth — `<all_urls>` / `*://*/*` is a major flag (can read every site you visit), independent of observed egress.
- Output: numeric score + a breakdown table (endpoint → entity → category → penalty) so the number is auditable, not a black box.

---

## Wallet test matrix (first batch)

| Tier | Wallets |
|------|---------|
| EVM majors | MetaMask, Rabby, Rainbow, Frame, Zerion |
| Multi-chain / CEX-linked | Coinbase Wallet, OKX, Phantom, Backpack, Trust |
| Privacy-leaning (validation) | Keplr, Taho |

Each gets a `wallets/<name>.json`: Chrome Web Store ID, known first-party domains, onboarding quirks.

---

## Build milestones

**Milestone 0 — preflight (today, ~30 min):** repo scaffold, `package.json` (puppeteer + tsx + typescript), vendor the three fingerprint lists into `fingerprints/`, write `saas-patterns.json`, verify `brew install wireshark` (tshark) + ChmodBPF + sudo tcpdump pktap works.

**Milestone 1 — end-to-end slice on MetaMask (today):**
- `launch.ts` + `capture-cdp.ts` → produce `events.jsonl` for a manual cold-open. (pcap can come right after.)
- Minimal `classify.ts` (curated SaaS patterns only) + `score.ts` + `report.ts`.
- Goal: one real `report.md` for MetaMask cold-open. Validate the pipeline before scaling. (Matches the "trace the full pipeline on a minimal case first" principle.)

**Milestone 2 — full capture + classify:** add `capture-pcap.ts` + `parse-pcap.ts` + baseline subtraction + Tracker Radar/Exodus join + CDP↔pcap cross-check. Add onboarding + active phases.

**Milestone 3 — scale + compare:** run the wallet matrix, generate `comparison.md`. Tune the rubric against Ranko's published numbers as a sanity check.

**Milestone 4 (optional/later):** `--decrypt` deep-dive (SSLKEYLOGFILE → tshark payloads) for any wallet that scores suspiciously; optional report-viewer UI; consider Playwright full-automation only if manual drive proves too slow.

---

## Verification

- **Pipeline smoke test:** point the harness at a trivial extension (or a plain page that loads GA + a Firebase call) → confirm those endpoints appear, are classified correctly, and dent the score.
- **Baseline correctness:** no-extension run → its domain set must be fully subtracted (a clean run should approach 100).
- **Cross-validation:** CDP host set ≈ pcap SNI/DNS host set; investigate any delta (this is itself a finding).
- **Decryption path:** with `--decrypt`, confirm tshark decrypts at least one HTTPS body using the keylog.
- **Sanity vs ground truth:** a privacy-leaning wallet (Keplr/Taho) should score high; a CEX-linked one lower — directionally matching Ranko.

---

## Risks & limitations (be honest in the README)

- **Manual drive = coverage varies by operator.** A scripted phase checklist mitigates; full Playwright automation is the eventual fix.
- **Endpoint-only ≠ payload-clean.** A wallet can score 97 on egress and still leak addresses *inside* an encrypted first-party call. The `--decrypt` deep dive exists for exactly this; the report must state the limitation.
- **Conditional calls** (KYC, push registration, specific swap partners) only fire if the phase triggers them — documented per phase.
- **Tracker Radar is web-crawl-based** and under-represents some mobile-origin SaaS → that's why the Exodus regex layer is layered on.
- **CDP trust:** CDP reports what Chrome's stack did; pcap backstop is what guards against trusting it blindly.
- **Sudo for pktap capture** — local only, documented.

---

## Open questions / things to confirm during build (not blockers)

1. **Extension install method** for a clean profile — `--load-extension` (unpacked, simplest, requires fetching+unzipping the CRX first) vs seeding a CRX into the profile's `Extensions/` and pinning. v1 will use unpacked via the CRX download + unzip path; revisit if a wallet refuses to run unpacked.
2. **MV3 service-worker lifecycle** — SWs sleep; we may need to keep them alive / re-attach on wake during long captures. Will handle in `capture-cdp.ts`.
3. **Final project name** — `wallet-egress-audit` placeholder; open to `walletscope`/other.

---

## After approval (next steps, not part of this plan's edits)
1. Create `~/projects/wallet-egress-audit/`, write `PLAN.md` (this file) + `README.md`.
2. `gh repo create` (private to start).
3. Execute Milestone 0 → 1 today.
