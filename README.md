# Codex Proxy

Private, portable backup of a local Codex proxy setup. It connects Codex's
Responses API to either a GitHub Copilot account or an OpenAI-compatible relay.
It includes the model picker, Responses/Chat Completions bridge, upload
serialization, request-size recovery, authentication helper, and regression tests.

Credentials, conversations, request dumps, logs, and installed binaries are
intentionally **not** included. Authenticate separately on each machine.

## Requirements

- macOS, Linux (including WSL), or native Windows with Windows PowerShell 5.1
  and an ACL-capable filesystem such as NTFS.
- Bun. The test baseline and CI use **1.3.14**; there are no npm dependencies.
- Codex. The local harness regression baseline is **0.153.4**.
- Your own Copilot account access, or an upstream relay endpoint and API key.
- Git or GitHub CLI to clone this private repository.

On Windows, install Bun and Codex for Windows and run the same `bun` commands
from PowerShell. The optional shell installer below is for macOS/Linux only.

Install Bun and Codex separately before starting the proxy. An optional,
upstream Codex installer is included:

```sh
sh tools/install-codex.sh --release 0.153.4
```

Review it before running. It downloads Codex, can replace CLI symlinks, and may
modify a shell profile. Proxy setup never runs it automatically. Its upstream
license, notice, and provenance are included under `tools/` and `PROVENANCE.md`.

## New Machine

Clone using your GitHub account:

```sh
gh repo clone imdigitalashish/codex-proxy
cd codex-proxy
bun run setup
cd "$HOME/.codex-proxy"
bun run auth
```

The authentication command prints a GitHub device code and waits for your login.
The OAuth token is stored privately on that machine. Do not commit or share it.

If this machine already has a working OMP GitHub Copilot sign-in, you can reuse
it without copying its token. Set `COPILOT_OMP_AUTH_DB` in the installed `.env`
to the absolute path of `.omp/agent/agent.db`. This explicitly selects the
newest enabled `github-copilot` credential from that read-only store and uses
Copilot's direct OAuth route. Do not also set `COPILOT_GITHUB_TOKEN_FILE`.
The default token-file/device-flow route remains unchanged when this option is
absent. No other credential stores are searched automatically.

OMP credentials are reread for requests, validated against Copilot at least
once per minute of use and on credential changes, and never copied to a second
token file. The endpoint must be an HTTPS GitHub Copilot API origin; redirects
are not followed during validation. If access is revoked, sign in again in OMP.
Reusing an existing authorization does not bypass GitHub's login or account
policies. `/healthz` reports `copilot.source: "omp"` for this mode, and does not
invent an expiration time for the long-lived OAuth token.

Start the proxy in one terminal:

```sh
cd "$HOME/.codex-proxy"
bun run start
```

In another terminal:

```sh
cd "$HOME/.codex-proxy"
curl --fail --silent --show-error http://127.0.0.1:4141/healthz
bun run refresh
bun run codex -- --cd /path/to/your/project
```

For Copilot, inspect `copilot.authenticated` in the health response, not just its
top-level `ok` field. `ok: true` alone does not prove upstream authentication.

The launcher applies per-process Codex settings. It does not edit
`~/.codex/config.toml`, change other providers, or copy old sessions. Its default
model and reasoning effort come from `PROXY_MODEL` and `PROXY_REASONING_EFFORT`.
Explicit Codex arguments are passed through after the defaults:

```sh
bun run codex -- --cd /path/to/project --model gpt-6-astra
```

The launcher uses a dedicated, stable provider ID, `portable-codex-proxy`, rather
than inheriting a different installation's `local-proxy` settings. Codex merges
configuration tables: settings deliberately placed under
`model_providers.portable-codex-proxy` still participate in that normal merge.
Review any such existing definition, especially auth and HTTP headers. Saved
sessions are associated with their provider ID; use their original provider
configuration when resuming sessions created outside this launcher.

To invoke the launcher from a project directory while loading the installed
proxy environment explicitly:

```sh
bun --env-file "$HOME/.codex-proxy/.env" "$HOME/.codex-proxy/codex.ts" --cd "$PWD"
```

Model names in the example configuration are preferences, not promises of
account access. The proxy reconciles the catalog against the upstream service.
Choose a model and reasoning level that your upstream actually supports.

## Configuration

Setup copies `.env.example` to `~/.codex-proxy/.env` only if no `.env` exists.
Edit that installed file for local settings. Bun loads it when commands run in
the installation directory. Shell environment variables take precedence at
runtime.

| Setting | Purpose |
| --- | --- |
| `UPSTREAM_MODE` | `copilot` by default; use `relay` for another compatible endpoint |
| `PORT` | Loopback listener port, default `4141` |
| `COPILOT_ACCOUNT_TYPE` | Copilot account type, default `individual` |
| `COPILOT_OMP_AUTH_DB` | Explicit read-only OMP credential store; uses direct Copilot OAuth, without a token copy |
| `UPSTREAM_BASE_URL`, `UPSTREAM_API_KEY` | Required for relay mode; provide your own values |
| `PROXY_MODEL`, `PROXY_REASONING_EFFORT` | Launcher defaults, initially `claude-opus-5` and `max` |
| `MODEL_ALIASES` | JSON mapping of client model aliases to upstream IDs |
| `EXTRA_PICKER_MODELS` | Preferred model-picker order |
| `CODEX_MODELS_TEMPLATE` | Optional replacement model metadata template |
| `CODEX_BIN` | Optional shared executable override for the launcher and picker |
| `PICKER_GUARD_CLI_CODEX`, `PICKER_GUARD_APP_CODEX` | Explicit picker/launcher executable selection |
| `RECORD_ERROR_BODIES` | `0` by default; `1` explicitly enables private full-request error dumps |

Relay mode does not use the Copilot login. Set its endpoint and key in your local
`.env`, then start the proxy normally. The placeholder relay URL in the example
is not a functioning provider.

The picker and launcher share executable discovery. `CODEX_BIN` takes priority;
an invalid explicit value does not silently select another client. Otherwise,
an explicit app override is checked first, then an explicit CLI override.
Without overrides, the picker checks the bundled macOS app, the user-local CLI,
and `PATH`. On Windows it also checks
`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`, then
`~/.local/bin/codex.exe` and `PATH`. For one pinned CLI, set `CODEX_BIN` to its
absolute executable path. Spaces in executable and state paths are supported.

Export a custom `CODEX_HOME` before setup to target a nondefault Codex home.
Keep that environment consistent when running the launcher and refreshing the
picker. An explicit `setup --home DIR` is isolated to that target home by default.

Setup also writes `~/.codex-proxy/codex-provider.toml`. This is an optional
snippet for clients that cannot use the launcher. Merge it manually into the
appropriate Codex config, keeping root keys before TOML tables and avoiding
duplicate provider definitions. Setup never performs this merge for you.
Official configuration reference:
`https://developers.openai.com/codex/config-reference/`.

## Background Services

First authenticate and verify foreground operation. Do not run a second proxy
on the same port as an existing installation.

By default, setup only generates service definitions under
`~/.codex-proxy/services/`. The following additionally installs user-service
files, but still does not activate them:

```sh
bun run setup --services
```

Run setup from the checkout or the installation directory. Definitions use
absolute machine-local paths and Bun's current executable. Regenerate them if
you move Bun, change the installation location, or change `CODEX_HOME`.

### macOS

The installed LaunchAgents are `com.codex-proxy.server` and
`com.codex-proxy.picker-guard`.

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.codex-proxy.server.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.codex-proxy.picker-guard.plist"
```

Stop them with the corresponding `launchctl bootout` commands:

```sh
launchctl bootout "gui/$(id -u)/com.codex-proxy.picker-guard"
launchctl bootout "gui/$(id -u)/com.codex-proxy.server"
```

Service output is under `~/.codex-proxy/logs/`. Bootstrap is for services that
are not already loaded; use `launchctl kickstart -k` to restart a loaded service
after an intentional update.

### Windows

No Linux platform override or WSL is needed. From the checkout:

```powershell
bun run setup
Set-Location (Join-Path $env:USERPROFILE '.codex-proxy')
bun run auth
bun run start
```

In another PowerShell session, verify `/healthz` reports
`copilot.authenticated: true`, run `bun run refresh`, and try `bun run codex`.
Set `PORT` in the installed `.env` first if `4141` is already in use. Stop the
foreground proxy before starting its task; setup does not claim occupied ports.

`bun run setup --services` generates and registers `CodexProxy` and
`CodexProxyPickerGuard` as **disabled**, current-user Scheduled Tasks. It never
starts them or changes an existing task. Matching tasks are left alone; a
conflicting task is an error, not silently overwritten. Definitions are also
saved under `~/.codex-proxy/services/` and contain paths, not credentials.

After successful foreground verification, explicitly activate them:

```powershell
Enable-ScheduledTask -TaskName CodexProxy
Enable-ScheduledTask -TaskName CodexProxyPickerGuard
Start-ScheduledTask -TaskName CodexProxy
Start-ScheduledTask -TaskName CodexProxyPickerGuard
```

The server starts hidden at logon and retries failures once per minute. The
picker refreshes every two minutes after logon. Tasks use the current user's
interactive token without a stored password, elevation, or execution-policy
changes; they run only while that user is logged in. Logs are under
`~/.codex-proxy/logs/`. To stop and prevent automatic startup:

```powershell
Disable-ScheduledTask -TaskName CodexProxyPickerGuard
Disable-ScheduledTask -TaskName CodexProxy
Stop-ScheduledTask -TaskName CodexProxyPickerGuard
Stop-ScheduledTask -TaskName CodexProxy
```

If paths change, stop and unregister these two tasks, rerun setup with
`--services`, verify the new configuration, and activate them again. Ordinary
source updates at the same paths do not require re-registering tasks.

Windows setup protects the installation directory and any existing `.env` with
a DACL allowing only the current user and SYSTEM. New credential/status files
and picker caches get
their own protected DACL **before** private bytes are written. Existing parent
directories outside the installation are not re-permissioned. ACL failures stop
the write rather than falling back to ineffective POSIX mode bits.

### Linux

With a working systemd user session:

```sh
systemctl --user daemon-reload
systemctl --user enable --now codex-proxy.service codex-proxy-picker-guard.timer
journalctl --user -u codex-proxy.service -f
```

Stop and disable:

```sh
systemctl --user disable --now codex-proxy-picker-guard.timer codex-proxy.service
```

The picker refreshes about every 120 seconds and preserves its last valid cache
on upstream failure. It intentionally rejects catalogs with fewer than ten
models. A small relay catalog may therefore require adjusting that safety
threshold before it can seed the picker.

## Request-Size Recovery

The proxy measures the final serialized UTF-8 body after request translation.
`UPSTREAM_MAX_BODY_BYTES` defaults to **32 MiB** in Copilot mode and is disabled
by default in relay mode. Set it explicitly for a relay with a known byte limit.
The guard applies only to generation routes.

For Codex streaming `/responses` calls, a local size rejection or an upstream
413 is translated into one `response.failed` event with
`context_length_exceeded`. This allows the harness to compact and continue.
Non-Codex clients retain the normal HTTP error contract.

This does not remove the upstream limit or silently delete images. A very large
existing conversation may still need `/compact` once. If compaction itself
cannot fit, shorten the input or start a new conversation.

## Slow Uplink

Large uploads are serialized by default (`UPLOAD_CONCURRENCY=1`) so concurrent
requests do not compete for the same uplink. The existing transient retry path
is controlled by `UPSTREAM_RETRIES`.

`TRIM_REASONING_ON_408` defaults to `0`. Explicitly setting it to `1` can discard
older encrypted reasoning after an upload timeout. This is **lossy**, separate
from the 413 recovery mechanism. `TRIM_REASONING_KB` also defaults to `0`; a
positive value opts into pre-emptive trimming. Upgrades preserve existing `.env`
values, so set both to `0` there to disable earlier opt-ins.

## Tests And Updates

```sh
bun test
CODEX_TEST_BIN="$HOME/.local/bin/codex" bun test
```

Tests use mock upstreams and disposable home directories, not your Copilot
credentials. Real Codex harness tests are skipped unless `CODEX_TEST_BIN` is set.
CI covers Ubuntu, macOS, and native Windows without installing Codex or performing
paid inference. Windows launcher/picker fixtures are real compiled executables;
the permission tests inspect DACLs, not Unix mode bits. Windows task definitions
are validated by Task Scheduler without registration; macOS plists are linted on
macOS. Definition validation is not a logon/reboot test of service activation.

On Windows, explicitly setting `CODEX_TEST_WINDOWS_TASKS=1` also runs a live,
disposable task-lifecycle test. It registers randomly named disabled tasks,
checks reinstallation, starts loopback-only fixtures, verifies shutdown, and
removes the tasks afterward. No Copilot credentials are used. Windows symlink
tests require Developer Mode or a session permitted to create symlinks.

To update the installed copy later:

```sh
cd /path/to/your/codex-proxy-checkout
git pull --ff-only
bun test
bun run setup
```

Setup copies only the explicit package manifest. It preserves existing `.env`,
credentials, logs, and unrelated files, and never restarts the running proxy.
Restart your service deliberately after reviewing an update.

## Security And Provenance

The downstream listener is **loopback-only and unauthenticated**. Do not expose
port 4141 through a public interface, reverse proxy, or tunnel without a separate
authentication and access-control layer.

Full failed-request dumps are off by default. `RECORD_ERROR_BODIES=1` explicitly
enables them for diagnosis; they can include credentials, tool results, and
images. Dumps are written atomically with private permissions. Upstream error
text is also redacted from logs by default because it can echo inputs. Status,
sizes, and request correlation metadata remain available. Inspect diagnostic
logs before sharing them, especially when recording was enabled.
`errors/`, logs, credentials, environment files, generated caches, and backups
are excluded from Git. Do not override those exclusions to publish diagnostics.

The bundled model template is an upstream-derived metadata snapshot retained
for this private setup backup. It is not a separately authored or relicensed
model catalog. Keep the repository private and review `PROVENANCE.md` before
redistributing upstream assets.
