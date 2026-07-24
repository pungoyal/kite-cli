# Configuration reference

This is the exhaustive reference for every config key and environment
variable the CLI reads. The README's [Configuration](https://github.com/pungoyal/kite-cli#configuration) and
[Multiple accounts](https://github.com/pungoyal/kite-cli#multiple-accounts) sections are the
short version; this page is the superset: every key, every env var, and the
precedence between them.

Config lives at `~/.config/kite/config.json` (mode `0600`, directory
`0700`). Inspect and edit it with:

```bash
kite config show
kite config set <key> <value>
kite config unset <key>
kite config path
```

Source of truth: [`src/core/config.ts`](https://github.com/pungoyal/kite-cli/blob/main/src/core/config.ts) (schema) and
[`src/core/paths.ts`](https://github.com/pungoyal/kite-cli/blob/main/src/core/paths.ts) (file locations).

## Config keys (`kite config set/unset`)

| Key | Type | Default | Description |
|---|---|---|---|
| `apiKey` | string | — | Kite Connect API key for the `default` profile. Semi-public (it appears in login URLs). |
| `trading.enabled` | boolean | `true` | Master kill switch. `false` refuses every order-mutating command before any network call. |
| `trading.confirm` | boolean | `true` | Require an interactive confirmation before money-moving actions. |
| `trading.maxOrderValue` | number (rupees) | unset (no cap) | Refuse any single exposure-increasing order above this notional value. |
| `trading.strictConfirmAbove` | number (rupees) | `100000` | Above this value (or when the value is unknown), require typing the trading symbol instead of a single keystroke. |
| `output.color` | `auto` \| `always` \| `never` | `auto` | Also overridable per-invocation with `--color`. |
| `output.compact` | boolean | `false` | Render tables without borders. |
| `redirectPort` | number | `51101` | Loopback port for the OAuth login callback. Must match the redirect URL registered in your Kite Connect app. |
| `redirectPath` | string | `/callback` | Path component of the redirect URL. |

`defaultProfile` and `profiles` (the per-profile map) are set via
`kite profiles add/use/remove`, not `kite config set` — see
[Profiles](#profiles) below.

There is deliberately **no key that disables confirmations globally** — see
[safety.md](safety.md) for why `--yes` must always be a call-site flag.

### Per-profile overrides

`trading.*` and `apiKey` can be scoped to a single profile by adding
`--profile <name>` to `config set`:

```bash
kite --profile huf config set trading.maxOrderValue 50000
```

Per-profile trading overrides are **fail-closed by field**: a profile that
doesn't set a given `trading.*` key inherits the *global* value for that
key, never "no limit." Setting `trading.maxOrderValue` on one profile has no
effect on any other profile's cap. See `resolveTradingConfig` in
[`src/core/profiles.ts`](https://github.com/pungoyal/kite-cli/blob/main/src/core/profiles.ts).

## Environment variables

| Variable | Purpose | Persisted? |
|---|---|---|
| `KITE_ACCESS_TOKEN` | Supplies the access token directly, bypassing the keyring/file store entirely. | No — always read fresh, never written to disk. |
| `KITE_API_SECRET` | Supplies the API secret directly. | No |
| `KITE_API_KEY` | Overrides the resolved profile's API key. | No |
| `KITE_PROFILE` | Same as `--profile`; see [precedence](#profile-resolution) below. | No |
| `KITE_CONFIG_DIR` | Overrides `~/.config/kite` for `config.json`, `session*.json`, and `credentials.enc`. | — |
| `KITE_CACHE_DIR` | Overrides `~/.cache/kite` for the instrument master cache. | — |
| `KITE_CREDENTIALS_PASSPHRASE` | Passphrase for the encrypted-file credential store, used only when no OS keyring is available. | — |
| `KITE_DISABLE_KEYRING` | Set to `1` to skip the OS keyring probe entirely and go straight to the encrypted-file backend (useful in headless/CI environments where a keyring probe would be slow or noisy). | — |
| `KITE_DEBUG_STACK` | Set to `1` to print a full stack trace on unexpected errors instead of the redacted one-line message. | — |
| `NO_COLOR` | Disables colour whenever set and non-empty (`NO_COLOR=0` still disables it, per spec). Only consulted when `--color`/`output.color` is `auto` (the default) — `always`/`never` short-circuit before it. | — |
| `FORCE_COLOR` | Forces colour on even when stdout is not a TTY, unless `NO_COLOR` is also set. Any value other than empty or `0` counts as set. Same `auto`-only scope as `NO_COLOR`. | — |
| `COLUMNS` | Fallback table-rendering width when stdout isn't a TTY and reports no column count (default `80` otherwise). | — |
| `TERM=dumb` | Disables colour output specifically (checked in the same resolution order as `NO_COLOR`/`FORCE_COLOR` above). It does not itself gate spinners or `watch`'s live-repainting table — those follow whether stdin/stdout/stderr report as a TTY, independent of `TERM`. | — |

`XDG_CONFIG_HOME` / `XDG_CACHE_HOME` are also honoured as the fallback base
for `KITE_CONFIG_DIR`/`KITE_CACHE_DIR` when those are unset (see
[`src/core/paths.ts`](https://github.com/pungoyal/kite-cli/blob/main/src/core/paths.ts)).

## Credential storage precedence

For each secret (`api_secret`, `access_token`), lookup tries, in order:

1. **Environment variable** (`KITE_API_SECRET` / `KITE_ACCESS_TOKEN`) — always
   wins, never persisted. This is what makes CI and containers work without
   touching the keyring.
2. **OS keyring** — macOS Keychain, Windows Credential Manager, Linux Secret
   Service (via `@napi-rs/keyring`). Skipped entirely if
   `KITE_DISABLE_KEYRING=1`, or transparently on any platform/environment
   where the native module can't load (e.g. headless Linux with no D-Bus).
3. **Encrypted file** at `~/.config/kite/credentials.enc` (scrypt + AES-256-GCM,
   mode `0600`) — used only when the keyring is unavailable, and only if
   `KITE_CREDENTIALS_PASSPHRASE` is set (or a passphrase is supplied
   interactively where the caller supports it).

Secrets are namespaced per profile via a storage prefix — `''` for
`default`, `profile:<name>:` for everything else — so multiple accounts'
secrets never collide in the same keyring/file. See `storagePrefixFor` in
[`src/core/profiles.ts`](https://github.com/pungoyal/kite-cli/blob/main/src/core/profiles.ts).

## Profiles

A **profile** is a named Zerodha account: its own Kite Connect app (API key
and secret), its own session, and optional per-profile trading overrides.
One name is reserved and needs no entry in `config.profiles`:

- `default` — the original single-account setup; unprefixed secrets and
  `session.json`, so existing installs need no migration.

Manage profiles with `kite profiles add/list/remove/use/current` — see the
README's [Multiple accounts](https://github.com/pungoyal/kite-cli#multiple-accounts) section for
the walkthrough.

### Profile resolution

The account a command targets is resolved fresh on every invocation (there
is no sticky "active account"), in this order:

1. `--profile <name>` on the command line
2. `KITE_PROFILE` environment variable
3. `config.defaultProfile` (set by `kite profiles use <name>`)
4. otherwise the `default` profile

**Fail-closed guard:** if a profile was named *explicitly* (via `--profile`
or `KITE_PROFILE` — steps 1–2 above, not the configured default), and
`KITE_ACCESS_TOKEN` or `KITE_API_SECRET` is also set in the environment, the
command refuses rather than letting the environment variable silently
override the named profile's own stored credentials. This is the guard
against accidentally running a command against the wrong account because an
ambient env var meant for scripting was left set.

## See also

- [safety.md](safety.md) — how `trading.*` keys gate money-moving commands.
- [troubleshooting.md](troubleshooting.md) — symptom-first fixes for
  credential/session/config problems.
