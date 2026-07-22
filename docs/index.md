---
layout: home

hero:
  name: kite-cli
  text: The Kite Connect API, from your terminal
  tagline: An unofficial, secure, scriptable CLI for the Zerodha Kite Connect v3 API — credentials in your OS keyring, confirmations on anything that moves money, clean JSON for piping into jq.
  actions:
    - theme: brand
      text: Command reference
      link: /commands
    - theme: alt
      text: Safety model
      link: /safety
    - theme: alt
      text: View on GitHub
      link: https://github.com/pungoyal/kite-cli

features:
  - title: Safety first
    details: Real orders, real money — so the defaults are conservative. A layered kill switch, per-order value cap, resolved-order confirmation, and unique-tag reconciliation for ambiguous writes.
    link: /safety
    linkText: Read the safety model
  - title: Secrets stay secret
    details: Your API secret lives in the OS keyring (or an encrypted file), never in argv or shell history. Access tokens are scrubbed from every log line, error, and stack trace.
    link: /configuration#credential-storage-precedence
    linkText: Credential storage
  - title: Built for scripting
    details: Every command speaks --json, writes data to stdout and everything else to stderr, and returns a meaningful exit code. Rate limits are paced and quotes batched for you.
    link: /commands
    linkText: Every command and flag
  - title: A library too
    details: The same client, rate limiting, response validation, redaction, and error taxonomy are exported for programmatic use, without the CLI.
    link: /api
    linkText: Library API reference
---

> **Unofficial, independent project.** Not affiliated with, endorsed by, or sponsored by
> Zerodha. "Kite" and "Kite Connect" are trademarks of Zerodha Broking Ltd., referenced here
> only to describe the third-party API this tool works with.

## Install

```bash
npm install -g @pungoyal/kite-cli
```

Requires **Node 22.12 or newer**. Full installation and everyday-usage walkthrough lives in the
[README on GitHub](https://github.com/pungoyal/kite-cli#readme); these pages are the deeper
reference behind it.

## Try it before you trust it

It moves real money, so convince yourself first. Zerodha runs a public sandbox with
fake money and no subscription:

```bash
kite login --env sandbox
kite --env sandbox holdings
kite --env sandbox orders place NSE:INFY --side BUY --quantity 1 --dry-run
```

Every command behaves exactly as it does against a real account. And because the
package is published only from CI via [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/),
you can verify the build provenance yourself with `npm audit signatures`.
