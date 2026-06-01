# murmur0

![status: experimental](https://img.shields.io/badge/status-experimental-orange)

> *murmur*: the faint chatter a process makes on the wire. *0*: what its third-party egress should be.

**Experimental.** This is an early research tool. The methodology, the scoring, and the
code will change. Read a score as a place to start looking, not as a verdict.

murmur0 watches what a Chrome extension wallet talks to over the network and scores how much
of that traffic leaves its own infrastructure. The idea is simple: a wallet that only talks
to its own servers is easy to trust, and one that quietly pings a dozen analytics and
attribution services is not.

A score of 100 means the wallet contacted nothing but its own infrastructure. A score of 0
means it leaked to many third-party analytics, attribution, and crash-reporting services.

See [`PLAN.md`](./PLAN.md) for the design, the decisions behind it, and the milestones.

## How it works

1. It launches Puppeteer's bundled Chrome for Testing (plain vanilla, not Brave, whose shields
   would block trackers and hide what we are trying to measure). Fresh profile, the wallet
   extension loaded, and Chrome's own phone-home traffic suppressed.
2. It attaches a CDP `Network.*` listener to every target, including the extension's MV3
   service worker, which is where most wallet background traffic actually originates. Every
   outbound request is recorded with its full URL, above TLS, no decryption needed.
3. You drive the wallet through one phase: `cold`, `onboarding`, or `active`.
4. On `Ctrl-C` it classifies each host it saw as first-party, third-party SaaS, or Chrome's
   own infrastructure, scores the result, and writes a report.

If `tcpdump` is available, it also runs a pcap backstop on macOS's `pktap` interface, filtered
to Chrome's process, and cross-checks it against CDP. Anything the packet capture saw that CDP
did not gets flagged as possible out-of-band traffic. An opt-in `--decrypt` (via `SSLKEYLOGFILE`)
lets you inspect the payloads themselves.

## Usage

```bash
npm install

# One-time: capture what Chrome contacts on its own, so wallets aren't blamed for it.
npm run baseline

# Audit a wallet through a phase, then Ctrl-C when done.
./bin/audit metamask cold          # or: npm run audit -- metamask cold
./bin/audit metamask onboarding
./bin/audit metamask active
./bin/audit coinbase active --decrypt   # opt-in payload deep-dive

# Roll every run up into one ranked table.
npm run compare
```

Artifacts land in `reports/<wallet>/<phase>/<timestamp>/`: `events.jsonl` (raw requests),
`hosts.json` (classification), `score.json`, `report.md`, and `session.pcap` if the backstop ran.
`npm run compare` writes `reports/comparison.md`.

The pcap backstop needs `tshark` (`brew install wireshark`) to parse, and `sudo` to capture.
Without them the audit still runs CDP-only.

## Classification

Hosts are matched in order against a curated SaaS fingerprint list, then the Disconnect and
Exodus tracker databases (vendored in `fingerprints/`), then left as "unknown third party".
First-party domains come from each `wallets/<name>.json`. Chrome's own infrastructure and the
captured baseline are excluded from scoring.

## Adding a wallet

Drop a `wallets/<name>.json` with the Chrome Web Store ID and the domains you know to be
first-party. See `wallets/metamask.json` for the shape. Eleven wallets ship preconfigured.

## Limitation

This is an endpoint-only audit. It proves who a wallet contacts, not what it sends. A wallet
can score well here and still leak data inside an encrypted call to its own backend. Use
`--decrypt` when you need to see inside the payloads.
