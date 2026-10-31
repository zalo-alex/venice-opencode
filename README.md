# venice-opencode

Use your **Venice.ai web account** as an unmetered backend for [opencode](https://opencode.ai), with working tool calling. One command installs it, wires opencode, and keeps it running as a systemd service.

> **Unofficial.** Not affiliated with Venice.ai. It drives the Venice web app with your own account session, can break whenever Venice changes its site, and may violate Venice's terms. Use at your own risk.

## Install / update

```bash
curl -fsSL https://raw.githubusercontent.com/zalo-alex/venice-opencode/main/install.sh | bash
```

Run the same command again to update (or `venice-opencode update`). The installer:

1. downloads the latest release and its dependencies (needs **Node.js 22+**, `curl`, `tar`),
2. signs you in to Venice (email + password with 2FA, or pasted browser cookies),
3. detects the best tool-calling protocol Venice currently accepts,
4. adds a `venice-web` provider to your opencode config (a backup is kept),
5. installs and starts a **systemd user service** that survives logout and reboots,
6. runs a live tool-call self-test.

Then just run `opencode` and use the model `venice-web/deepseek-v4-1-flash-free`.

## Commands

| Command | What it does |
|---|---|
| `venice-opencode status` | Service, session, model and request counters |
| `venice-opencode logs [-f]` | Service logs (journald) |
| `venice-opencode restart` / `stop` / `start` | Control the service |
| `venice-opencode listen [ADDR,...]` | Change which interfaces the proxy listens on (`--all`, `--local`, or pick interactively) |
| `venice-opencode login` | Sign in again when the session expires |
| `venice-opencode update` | Install the latest version and restart |
| `venice-opencode setup --reconfigure` | Re-detect the tool protocol |
| `venice-opencode run` | Run in the foreground (no systemd) |
| `venice-opencode uninstall` | Remove the service, opencode entry and files |

Setup options (also accepted by the installer: `... | bash -s -- --port 4000`):
`--port N`, `--host A,B`, `--model ID`, `--json-mode`, `--all-models`, `--cookies FILE`, `--no-opencode`, `--no-service`, `-y/--yes`.

## Dashboard

Open `http://127.0.0.1:3456/` for a live status page: session validity, active model, request / tool-call / retry / error counters and recent activity. JSON is at `/api/status`.

## Listening on other interfaces

By default the proxy only listens on `127.0.0.1`. To reach it from another machine or container:

```bash
venice-opencode listen                         # interactive picker (lists your interfaces)
venice-opencode listen 127.0.0.1,192.168.1.20  # specific addresses
venice-opencode listen --all                   # every interface (0.0.0.0)
venice-opencode listen --local                 # back to loopback only
```

The setting is `HOST` in `config.env` (comma-separated); the service restarts automatically. **The proxy has no authentication**, so anyone who can reach it can use your Venice session. Only expose it on a trusted network or behind a firewall/VPN.

## Files

| Path | Purpose |
|---|---|
| `~/.local/share/venice-opencode` | The program (replaced on update) |
| `~/.config/venice-opencode/config.env` | Settings (`PORT`, `AGENT_MODEL`, ...). Edit, then `venice-opencode restart` |
| `~/.config/venice-opencode/session.json` | Your Venice session cookies (mode 600, never share) |
| `~/.config/systemd/user/venice-opencode.service` | The service unit |
| `~/.local/bin/venice-opencode` | The CLI |

## Signing in

- **Email + password** works for accounts with a password, including 2FA (code is asked inline).
- **Cookies** is for Google/Apple sign-ins: log in at venice.ai, open DevTools → Network, pick a request to `clerk.venice.ai`, copy the `Cookie` request header and paste it (or save it to a file and use `--cookies FILE`).

## How it works

opencode speaks OpenAI chat-completions to `127.0.0.1:3456`. The proxy turns each request into a Venice web agent call, using your session, and translates the reply (including tool calls) back. Venice's agent sometimes swallows or mangles tool calls, so the proxy retries, repairs malformed JSON and maps near-miss tool names onto the ones opencode registered.

## Unattended runs

Venice's agent often swallows or garbles a tool call. The proxy never hands that back to opencode as a final answer (which would stop the run): it retries the turn with backoff, alternating native and text tool protocols and reminding the model of the valid tool names, until it gets a real tool call or answer. It also repairs common malformed calls (missing `"name"`, leaked `</｜DSML｜>` markup) and keeps the stream alive with SSE heartbeats during long retries. It only gives up if the Venice session is dead (`venice-opencode login`). Set `MAX_TRIES=N` in `config.env` for a hard limit (default `0` = unlimited).

## Troubleshooting

- **`status` shows the session expired** → `venice-opencode login`.
- **Port already in use** → `venice-opencode setup --port 4000`.
- **Service stops when you log out** → `sudo loginctl enable-linger $USER`.
- **opencode says the model has no tools** → run `venice-opencode logs` and look for `request carried no tools`; keep `ALL_MODELS=0`.
- **No systemd** (macOS, containers) → `venice-opencode run`, and point opencode at `http://127.0.0.1:3456/v1`.

## Development

```bash
git clone https://github.com/zalo-alex/venice-opencode && cd venice-opencode
npm ci
node bin/venice-opencode.mjs setup          # or: VENICE_OPENCODE_SRC=$PWD bash install.sh
```

The Venice auth client in `src/client.mjs` and the login flow in `src/login.mjs` originate from [despin/venice-ai-chat-proxy](https://github.com/despin/venice-ai-chat-proxy).

## License

MIT, see [LICENSE](LICENSE).
