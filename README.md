# murmur0

> *murmur* — the faint chatter a process makes on the wire · *0* — what its third-party egress should be.

Local privacy audit of **Chrome browser-extension crypto wallets** by their network egress.
Ports the [@r4nk0X "IP Exposure Scorecard"](https://www.theopensourcepress.com/crypto-wallet-ip-exposure-scorecard-2026/)
methodology — score a wallet 0–100 purely by *who it phones home to* — from mobile APKs to browser extensions.

**100 = good** (contacts only its own infra). **0 = bad** (leaks to many third-party analytics/attribution/crash SaaS).

See [`PLAN.md`](./PLAN.md) for the full design, decisions, and milestones.

## How it works

1. Launches **Puppeteer's bundled Chrome for Testing** (vanilla — *not* Brave, whose shields would skew results) with a **fresh profile**, the wallet extension loaded, and Chrome's own phone-home suppressed.
2. Attaches a **CDP** `Network.*` listener to every target — including the extension's **MV3 service worker** — and records every outbound request (full URLs, above TLS, no decryption).
3. You drive the wallet through a phase (`cold` / `onboarding` / `active`).
4. On `Ctrl-C`: classifies each contacted host as first-party / third-party SaaS / Chrome-infra, scores it, and writes a report.

A **pcap backstop** (`tcpdump -i pktap,Chrome` + tshark) and an opt-in `--decrypt` (SSLKEYLOGFILE) payload deep-dive are Milestone 2+ (see PLAN.md).

## Usage

```bash
npm install
./bin/audit metamask cold          # or: npm run audit -- metamask cold
./bin/audit metamask onboarding
./bin/audit metamask active
```

Artifacts land in `reports/<wallet>/<phase>/<timestamp>/`:
`events.jsonl` (raw requests), `hosts.json` (classification), `score.json`, `report.md`.

## Adding a wallet

Drop a `wallets/<name>.json` (Chrome Web Store ID + known first-party domains). See `wallets/metamask.json`.

## Limitation

Endpoint-only. Proves IP/SaaS exposure, **not** payload cleanliness — a wallet can score high and still
leak data *inside* an encrypted first-party call. Use `--decrypt` for payload inspection.
