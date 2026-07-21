# Security Policy

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/pungoyal/kite-cli/security/advisories/new) rather than opening a public issue.

Include what the issue is, how to reproduce it, and what an attacker could achieve. You'll get an acknowledgement within 72 hours and an assessment within a week.

**Never include real credentials in a report.** If you believe your API secret or access token has been exposed, rotate it immediately at [developers.kite.trade](https://developers.kite.trade) and run `kite logout --all`.

## Scope

In scope:

- Credential disclosure — secrets reaching logs, error messages, stack traces, the filesystem outside the intended stores, or the network
- Bypasses of the confirmation, kill switch, dry-run, or order value cap
- Flaws that could cause an unintended, duplicated, or incorrect order
- Weaknesses in the encrypted credential file (KDF parameters, AEAD usage, file permissions)
- CSRF or token interception in the loopback login callback
- Supply chain issues in the release pipeline

Out of scope:

- Vulnerabilities in the Kite Connect API itself — report those to Zerodha
- Losses from your own trading decisions
- Attacks requiring an already-compromised machine or an attacker who already holds your credentials

## Threat model

What this tool defends against:

- **Credentials at rest.** Secrets go to the OS keyring, or an AES-256-GCM file encrypted with scrypt (N=2¹⁷, r=8, p=1) at mode `0600`. The KDF header is bound as additional authenticated data, so parameters cannot be downgraded without failing decryption.
- **Credential leakage in output.** Every log line, error, and stack trace passes through a redactor. The two paths that carry an access token — the `Authorization` header and the WebSocket URL query string — are handled explicitly and covered by tests.
- **Secrets in process listings.** The API secret is never accepted as a command-line argument, since argv is world-readable via `ps` and persists in shell history.
- **Login interception.** The callback server binds to `127.0.0.1` only, and the request token is validated against a random CSRF state compared in constant time.
- **Accidental, duplicated, and wrong-account orders.** Confirmation with a resolved-order preview — which names the *verified* account (the user id Kite returned, not just the chosen label) — escalation to typed confirmation above a threshold, an explicit kill switch, a per-profile order value cap, and dry-run. No mutating HTTP verb is ever retried automatically. With multiple accounts, an explicitly named profile is never silently overridden by an ambient `KITE_ACCESS_TOKEN` / `KITE_API_SECRET`, and each account's secrets are stored under a separate namespace.
- **Supply chain.** Trusted Publishing via OIDC with no long-lived token, provenance attestation, SHA-pinned CI actions, `ignore-scripts`, a dependency release cooldown, and a deliberately small dependency tree.

What it does not defend against:

- A compromised machine. If an attacker can run code as you, they can read your keyring and place orders.
- A malicious dependency you install. The controls above shrink the window and blast radius; only dependency minimisation removes the risk, which is why the tree is kept small.
- Anyone who already holds your API secret or access token.

## Deliberate omissions

**TOTP handling.** This CLI will never prompt for, store, or generate TOTP codes. Doing so means holding your 2FA seed next to your API secret, collapsing two authentication factors into one — precisely what the SEBI mandate requiring TOTP for order placement exists to prevent. Login stays in the browser.

**The `enctoken` path.** Some third-party tools scrape a Kite *web* session to bypass the Kite Connect subscription. It is undocumented, unsupported, breaks without notice, and is a plausible terms-of-service violation with a real trading account at stake. It is not implemented and will not be.

## Supported versions

Security fixes are released for the latest minor version. During `0.x`, that means the latest published release only.
