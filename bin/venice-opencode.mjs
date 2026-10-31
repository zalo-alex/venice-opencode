#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import * as ui from "../lib/ui.mjs";
import * as core from "../lib/core.mjs";

const { c } = ui;
const BIN_LINK = path.join(os.homedir(), ".local", "bin", "venice-opencode");

const HELP = `
${c.bold("venice-opencode")} ${c.dim("v" + core.VERSION)} - use your Venice web session as an unmetered opencode backend

${c.bold("Usage")}  venice-opencode <command> [options]

${c.bold("Commands")}
  setup        Install / repair everything (login, opencode config, systemd service)
  login        Sign in to Venice again (email + password, or paste cookies)
  listen [ADDR,...]   Change the interfaces the proxy listens on (--all, --local)
  status       Show service, session and model status
  start | stop | restart   Control the background service
  logs [-f]    Show service logs (-f to follow)
  run          Run the proxy in the foreground (no systemd)
  update       Download the latest version and restart
  uninstall    Remove the service, opencode entry and files

${c.bold("Setup options")}
  --port N          Proxy port (default 3456)
  --host A[,B,...]  Addresses to listen on (default 127.0.0.1; 0.0.0.0 = all)
  --model ID        Force the Venice agent model (skips detection)
  --json-mode       Force the JSON tool-call fallback
  --all-models      Advertise every free Venice model
  --cookies FILE    Read a Cookie header from FILE instead of asking
  --no-opencode     Do not edit the opencode config
  --no-service      Do not install a systemd service
  --reconfigure     Redo tool-protocol detection even if already configured
  -y, --yes         Never ask questions (needs a valid session or --cookies)
`;

// ---------- small helpers ----------

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-y" || a === "--yes") o.yes = true;
    else if (a === "--json-mode") o.jsonMode = true;
    else if (a === "--all-models") o.allModels = true;
    else if (a === "--no-opencode") o.noOpencode = true;
    else if (a === "--no-service") o.noService = true;
    else if (a === "--reconfigure") o.reconfigure = true;
    else if (a === "--port") o.port = argv[++i];
    else if (a === "--host") o.host = argv[++i];
    else if (a === "--all") o.all = true;
    else if (a === "--local") o.local = true;
    else if (a === "--model") o.model = argv[++i];
    else if (a === "--cookies") o.cookies = argv[++i];
    else if (a === "-f" || a === "--follow") o.follow = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else o._.push(a);
  }
  return o;
}

const interactive = (o) => !o.yes && process.stdin.isTTY;

const allPortsFree = async (cfg) => {
  for (const h of core.hostList(cfg)) if (!(await portFree(h, Number(cfg.PORT)))) return false;
  return true;
};

function checkHosts(value) {
  const list = [...new Set(String(value).split(",").map((h) => h.trim()).filter(Boolean))];
  if (!list.length) throw new Error("no address given");
  const bad = list.find((h) => !core.validHost(h));
  if (bad) throw new Error(`"${bad}" is not an IP address (use e.g. 127.0.0.1, 192.168.1.20, 0.0.0.0)`);
  return list;
}

function portFree(host, port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

// The pre-service layout started a bare node process from ~/.venice-opencode.
function stopLegacyProxy(port) {
  if (String(port) !== "3456") return false; // only when it would hold our port
  try {
    const pid = Number(fs.readFileSync(path.join(core.LEGACY_DIR, "proxy.pid"), "utf8"));
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (pid > 1 && cmd.includes("venice-tools-proxy")) {
      process.kill(pid, "SIGTERM");
      return true;
    }
  } catch {}
  return false;
}

function ensureBinLink() {
  try {
    fs.mkdirSync(path.dirname(BIN_LINK), { recursive: true });
    const target = path.join(core.APP_DIR, "bin", "venice-opencode.mjs");
    fs.rmSync(BIN_LINK, { force: true });
    fs.symlinkSync(target, BIN_LINK);
    fs.chmodSync(target, 0o755);
  } catch {}
}

// ---------- login ----------

async function loginWithCookies(file) {
  let raw;
  if (file) {
    raw = fs.readFileSync(file, "utf8");
  } else {
    ui.out();
    ui.info("Sign in at https://venice.ai, then open DevTools (F12) → Network.");
    ui.info("Pick any request to clerk.venice.ai and copy the " + c.bold("Cookie") + " request header value.");
    raw = await ui.secret("Paste the Cookie header:");
    if (raw.length > 3800) ui.warn("Long paste - if login fails, save it to a file and use: venice-opencode login --cookies FILE");
  }
  if (!raw.trim()) throw new Error("empty cookie header");
  const n = core.writeSessionFromCookieHeader(raw);
  ui.ok(`Stored ${n} cookies`);
}

async function loginWithPassword() {
  process.env.VENICE_MFA_STATE_FILE = core.MFA_FILE;
  const { loginWithWreq, completeWreqMfaLogin } = await import("../src/login.mjs");
  const email = await ui.prompt("Venice email:");
  const password = await ui.secret("Venice password:");
  if (!email || !password) throw new Error("email and password are required");
  fs.mkdirSync(core.CONFIG_DIR, { recursive: true, mode: 0o700 });
  let res = await ui.spin("Signing in", () => loginWithWreq({ email, password, sessionFile: core.SESSION_FILE }));
  if (res?.status === "needs_second_factor") {
    ui.info(res.message.replace(/Re-run with --mfa-code <code>\.?/, "Enter it below.").replace(/Re-run with.*$/, ""));
    const code = await ui.prompt("Two-factor code:");
    res = await ui.spin("Verifying code", () => completeWreqMfaLogin({ code, sessionFile: core.SESSION_FILE }));
    fs.rmSync(core.MFA_FILE, { force: true });
  }
  if (!res?.ok) throw new Error("login failed");
}

async function doLogin(o = {}) {
  if (o.cookies) {
    await loginWithCookies(o.cookies);
  } else if (!interactive(o)) {
    throw new Error("No valid session. Run `venice-opencode login` interactively, or pass --cookies FILE.");
  } else {
    const method = await ui.choose("How do you want to sign in?", [
      "Email + password " + c.dim("(supports 2FA)"),
      "Paste browser cookies " + c.dim("(if you use Google/Apple sign-in)"),
    ]);
    if (method === 0) await loginWithPassword();
    else await loginWithCookies();
  }
  try { fs.chmodSync(core.SESSION_FILE, 0o600); } catch {}
  const who = await ui.spin("Verifying session", async () => {
    const r = await core.verifySession();
    return r.email;
  }).catch((e) => {
    fs.rmSync(core.SESSION_FILE, { force: true });
    throw new Error(`Venice rejected the session (${e.message}). Check the credentials / cookies and try again.`);
  });
  return who;
}

async function cmdLogin(o) {
  ui.banner("Login");
  await doLogin(o);
  if (core.hasSystemd() && core.serviceEnabled()) {
    await ui.spin("Restarting service", async () => core.sysctl("restart", core.SERVICE));
  }
  ui.out();
}

// ---------- setup ----------

async function cmdSetup(o) {
  const T = 5;
  ui.banner("Setup", core.hasSystemd() || o.noService ? "Login → detect → opencode → service" : "systemd not available: will not install a service");

  // 1. Node + deps are already handled by install.sh; verify the essentials.
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) throw new Error(`Node.js 22+ required, found ${process.version}`);

  let cfg = core.readConfig();
  const configured = fs.existsSync(core.CONFIG_FILE);

  // 1. Account
  ui.step(1, T, "Venice account");
  if (!fs.existsSync(core.SESSION_FILE)) {
    const legacy = path.join(core.LEGACY_DIR, ".venice-web-session.json");
    if (!o.cookies && fs.existsSync(legacy)) {
      fs.mkdirSync(core.CONFIG_DIR, { recursive: true, mode: 0o700 });
      fs.copyFileSync(legacy, core.SESSION_FILE);
      fs.chmodSync(core.SESSION_FILE, 0o600);
      ui.info("Imported the session from the previous install");
    }
  }
  try {
    if (o.cookies) throw new Error("cookies supplied");
    await ui.spin("Checking saved session", async () => (await core.verifySession()).email);
  } catch {
    if (fs.existsSync(core.SESSION_FILE) && !o.cookies) ui.warn("Saved session expired - signing in again");
    await doLogin(o);
  }

  // 2. Tool protocol
  ui.step(2, T, "Tool calling");
  if (o.port) cfg.PORT = String(o.port);
  if (o.host) cfg.HOST = checkHosts(o.host).join(",");
  if (o.allModels) cfg.ALL_MODELS = "1";
  if (o.model) {
    cfg.AGENT_MODEL = o.model;
    cfg.TOOLS_MODE = o.jsonMode ? "json" : "client";
    cfg.TOOLS_SHAPE = "mcp";
    ui.ok(`Using forced model ${c.bold(o.model)}`);
  } else if (o.jsonMode) {
    cfg.TOOLS_MODE = "json";
    cfg.TOOLS_SHAPE = "mcp";
    ui.ok("JSON tool-call mode (forced)");
  } else if (configured && !o.reconfigure) {
    ui.ok(`Keeping ${c.bold(cfg.AGENT_MODEL)} ${c.dim(`(${cfg.TOOLS_MODE}/${cfg.TOOLS_SHAPE}) - use --reconfigure to re-detect`)}`);
  } else {
    let found;
    await ui.spin("Probing Venice for native tool support", async () => {
      found = await core.detectToolProtocol(cfg.AGENT_MODEL);
      return found.mode === "client" ? "supported" : "not supported";
    });
    cfg.AGENT_MODEL = found.model;
    cfg.TOOLS_MODE = found.mode;
    cfg.TOOLS_SHAPE = found.shape;
    if (found.mode === "client") ui.hint(`native tools via ${found.model} (${found.shape})`);
    else ui.warn("No native tool call returned - using the JSON fallback (slower, still works)");
  }
  cfg.VENICE_SESSION_FILE = core.SESSION_FILE;
  core.writeConfig(cfg);
  ui.ok(`Config saved ${c.dim(core.CONFIG_FILE)}`);

  // 3. opencode
  ui.step(3, T, "opencode");
  let wired = null;
  if (o.noOpencode) {
    ui.info("Skipped (--no-opencode)");
  } else {
    const hasOpencode = spawnSync("sh", ["-c", "command -v opencode"]).status === 0;
    if (!hasOpencode) ui.warn("opencode not found in PATH - config is written anyway (https://opencode.ai)");
    const go = !interactive(o) || (await ui.confirm("Set Venice as the default model in opencode?", true));
    if (go) {
      wired = core.wireOpencode(cfg, cfg.AGENT_MODEL);
      if (wired.status === "written") {
        ui.ok(`Updated ${c.dim(wired.file)}`);
        if (wired.backup) ui.hint(`backup: ${wired.backup}`);
      } else {
        ui.warn(`Left ${wired.file} untouched (${wired.reason}). Merge this by hand:`);
        ui.out(JSON.stringify(core.opencodeSnippet(cfg, cfg.AGENT_MODEL), null, 2).replace(/^/gm, "      "));
      }
    } else ui.info("Skipped");
  }

  // 4. Service
  ui.step(4, T, "Background service");
  ensureBinLink();
  let managed = false;
  if (o.noService || !core.hasSystemd()) {
    ui.info(o.noService ? "Skipped (--no-service)" : "No systemd user session - start it with: venice-opencode run");
  } else {
    if (stopLegacyProxy(cfg.PORT)) ui.info("Stopped the old standalone proxy");
    const running = core.serviceState() === "active";
    if (!running && !(await allPortsFree(cfg))) {
      throw new Error(`Port ${cfg.PORT} is already in use. Re-run with --port <other>.`);
    }
    await ui.spin("Installing systemd user service", async () => {
      core.writeUnit();
      core.sysctl("enable", core.SERVICE);
      const r = core.sysctl("restart", core.SERVICE);
      if (r.status !== 0) throw new Error(r.stderr.trim() || "systemctl restart failed");
    });
    managed = true;
    if (!core.lingerEnabled()) {
      if (core.enableLinger()) ui.ok("Enabled lingering: starts at boot, survives logout");
      else ui.hint("To start at boot without logging in: sudo loginctl enable-linger " + os.userInfo().username);
    }
  }

  // 5. Verify
  ui.step(5, T, "Self-test");
  let healthy = false;
  if (managed) {
    healthy = await ui.spin("Waiting for the proxy", async () => {
      if (!(await core.waitForProxy(cfg))) throw new Error("proxy did not come up - see: venice-opencode logs");
      return "";
    }).then(() => true, (e) => { ui.fail(e.message); return false; });
    if (healthy) {
      await ui.spin("Asking the model to call a tool", async () => {
        const res = await fetch(`${core.baseUrl(cfg)}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: cfg.AGENT_MODEL,
            messages: [{ role: "user", content: "List the files in the current directory. Use the tool." }],
            tools: [{ type: "function", function: { name: "list_dir", description: "List files in a directory",
              parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }],
          }),
          signal: AbortSignal.timeout(120_000),
        });
        const body = await res.text();
        if (!body.includes('"tool_calls"')) throw new Error("no tool call returned (see: venice-opencode logs)");
        return `${cfg.TOOLS_MODE}/${cfg.TOOLS_SHAPE}`;
      }).catch((e) => ui.warn(e.message));
    }
  } else ui.info("Skipped (no managed service)");

  ui.out();
  if (managed && !healthy) {
    ui.box([c.bold(c.red("Setup finished, but the proxy is not responding")), "", `See the logs:  ${c.bold("venice-opencode logs")}`], { color: c.red });
    process.exitCode = 1;
    return;
  }
  ui.box([
    c.bold(c.green("venice-opencode is ready")),
    "",
    `Proxy      ${core.baseUrl(cfg)}/v1`,
    `Dashboard  ${core.baseUrl(cfg)}/`,
    `Model      ${cfg.AGENT_MODEL}`,
    "",
    `Start      ${c.bold("opencode")}   ${c.dim("(model: venice-web/" + cfg.AGENT_MODEL + ")")}`,
    `Manage     ${c.bold("venice-opencode status | logs -f | restart | update")}`,
  ], { color: healthy || !managed ? c.green : c.yellow });
  if (!process.env.PATH.split(":").includes(path.dirname(BIN_LINK))) {
    ui.out();
    ui.warn(`${path.dirname(BIN_LINK)} is not in your PATH. Add it to your shell profile to use "venice-opencode".`);
  }
  ui.out();
}

// ---------- other commands ----------

async function cmdListen(o) {
  const cfg = core.readConfig();
  ui.banner("Listen addresses");
  ui.table([["current", core.hostList(cfg).join(", ") + c.dim(`  port ${cfg.PORT}`)]]);
  ui.out();

  let hosts;
  if (o.all) hosts = ["0.0.0.0"];
  else if (o.local) hosts = ["127.0.0.1"];
  else if (o._[1]) hosts = checkHosts(o._.slice(1).join(","));
  else if (!interactive(o)) return;
  else {
    const choice = await ui.choose("Where should the proxy listen?", [
      "This machine only " + c.dim("(127.0.0.1, safest)"),
      "Every network interface " + c.dim("(0.0.0.0)"),
      "Pick specific addresses",
    ]);
    if (choice === 0) hosts = ["127.0.0.1"];
    else if (choice === 1) hosts = ["0.0.0.0"];
    else {
      const ifaces = core.listInterfaces();
      ui.out();
      ifaces.forEach((i, n) => ui.out(`    ${c.bold(String(n + 1).padStart(2))}) ${i.address.padEnd(40)} ${c.dim(i.name + (i.internal ? " (loopback)" : ""))}`));
      const picked = await ui.prompt("Numbers or addresses, comma-separated:");
      hosts = checkHosts(picked.split(",").map((t) => {
        const n = Number(t.trim());
        return Number.isInteger(n) && ifaces[n - 1] ? ifaces[n - 1].address : t.trim();
      }).join(","));
    }
  }

  const exposed = hosts.filter((h) => !core.isLoopback(h));
  if (exposed.length) {
    ui.out();
    ui.warn("The proxy has NO authentication. Anyone who can reach " + exposed.join(", ") + " can spend your Venice session.");
    ui.hint("Only do this on a trusted network or behind a firewall / VPN.");
    if (interactive(o) && !(await ui.confirm("Listen on these addresses anyway?", false))) {
      ui.info("Nothing changed");
      return;
    }
  }

  const before = core.baseUrl(cfg);
  cfg.HOST = hosts.join(",");
  if (!(core.serviceState() === "active") && !(await allPortsFree(cfg))) throw new Error(`Port ${cfg.PORT} is already in use on one of these addresses.`);
  core.writeConfig(cfg);
  ui.ok(`Listening on ${c.bold(cfg.HOST)} ${c.dim(`port ${cfg.PORT}`)}`);
  if (core.baseUrl(cfg) !== before && core.updateOpencodeBaseUrl(cfg)) ui.ok(`Pointed opencode at ${core.baseUrl(cfg)}/v1`);
  if (core.hasSystemd() && core.serviceState() === "active") {
    await ui.spin("Restarting service", async () => {
      const r = core.sysctl("restart", core.SERVICE);
      if (r.status !== 0) throw new Error(r.stderr.trim());
      if (!(await core.waitForProxy(cfg))) throw new Error("proxy did not come back - see: venice-opencode logs");
      return "";
    });
  } else ui.hint("Applies the next time the service starts.");
  ui.out();
}


async function cmdStatus() {
  const cfg = core.readConfig();
  ui.banner("Status", `v${core.VERSION}`);
  const state = core.hasSystemd() ? core.serviceState() : "no systemd";
  const live = await core.fetchJson(`${core.baseUrl(cfg)}/api/status`);
  const dot = (good) => (good ? ui.sym.ok : ui.sym.fail);
  let session = c.dim("not checked (proxy down)");
  if (live) session = live.session.valid ? c.green("valid") + c.dim(live.session.expiresInMin != null ? ` (token renews in ${live.session.expiresInMin} min)` : "") : c.red(live.session.error || "invalid");
  else if (!fs.existsSync(core.SESSION_FILE)) session = c.red("missing - run: venice-opencode login");
  ui.table([
    ["service", `${dot(state === "active")} ${state}${core.hasSystemd() && core.serviceEnabled() ? c.dim(" (enabled at login)") : ""}`],
    ["proxy", live ? `${ui.sym.ok} ${core.baseUrl(cfg)}/v1 ${c.dim(`up ${live.uptime}`)}` : `${ui.sym.fail} not responding on ${core.baseUrl(cfg)}`],
    ["session", session],
    ["listen", core.hostList(cfg).map((h) => (core.isLoopback(h) ? h : c.yellow(h))).join(", ") + c.dim(`  port ${cfg.PORT}`)],
    ["model", `${cfg.AGENT_MODEL} ${c.dim(`(${cfg.TOOLS_MODE}/${cfg.TOOLS_SHAPE})`)}`],
    ["requests", live ? `${live.stats.requests} total, ${live.stats.toolCalls} tool calls, ${live.stats.errors} errors, ${live.stats.retries} retries` : c.dim("-")],
    ["config", c.dim(core.CONFIG_FILE)],
  ]);
  if (!live) ui.hint("\nTry: venice-opencode restart   or   venice-opencode logs");
  ui.out();
}

function cmdService(action) {
  if (!core.hasSystemd()) throw new Error("systemd user session not available - use: venice-opencode run");
  const r = core.sysctl(action, core.SERVICE);
  if (r.status !== 0) throw new Error(r.stderr.trim() || `systemctl ${action} failed`);
  ui.ok(`Service ${action === "stop" ? "stopped" : action === "start" ? "started" : "restarted"}`);
}

function cmdLogs(o) {
  const args = ["--user", "-u", core.SERVICE, "-o", "short-iso", "--no-hostname",
    ...(o.follow ? ["-f"] : ["-n", "200", "--no-pager"])];
  spawnSync("journalctl", args, { stdio: "inherit" });
}

function cmdRun() {
  const cfg = core.readConfig();
  const child = spawn(process.execPath, [path.join(core.APP_DIR, "src", "server.mjs")], {
    stdio: "inherit",
    env: { ...process.env, ...cfg },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
}

function cmdUpdate() {
  const installer = path.join(core.APP_DIR, "install.sh");
  if (!fs.existsSync(path.join(core.APP_DIR, ".installed")) || !fs.existsSync(installer)) {
    throw new Error("This is a development checkout, not an installed copy. Use git pull instead.");
  }
  // Copy first: the installer replaces the directory it lives in.
  const tmp = path.join(os.tmpdir(), `venice-opencode-install-${process.pid}.sh`);
  fs.copyFileSync(installer, tmp);
  const r = spawnSync("bash", [tmp], { stdio: "inherit", env: { ...process.env, VENICE_OPENCODE_DIR: core.APP_DIR } });
  fs.rmSync(tmp, { force: true });
  process.exit(r.status ?? 1);
}

async function cmdUninstall(o) {
  ui.banner("Uninstall");
  if (interactive(o) && !(await ui.confirm("Remove venice-opencode (service, opencode entry, program files)?", false))) {
    ui.info("Nothing changed");
    return;
  }
  if (core.hasSystemd()) {
    core.removeUnit();
    ui.ok("Removed the systemd service");
  }
  if (core.unwireOpencode(core.readConfig())) ui.ok("Removed the Venice provider from the opencode config");
  fs.rmSync(BIN_LINK, { force: true });
  const wipe = !interactive(o) || (await ui.confirm("Also delete your saved session and config?", true));
  if (wipe) {
    fs.rmSync(core.CONFIG_DIR, { recursive: true, force: true });
    ui.ok("Deleted session and config");
  } else ui.info(`Kept ${core.CONFIG_DIR}`);
  if (fs.existsSync(path.join(core.APP_DIR, ".installed"))) {
    fs.rmSync(core.APP_DIR, { recursive: true, force: true });
    ui.ok("Deleted program files");
  }
  ui.out();
}

// ---------- main ----------

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cmd = o._[0] || (o.help ? "help" : "help");
  if (o.help && cmd !== "help") return ui.out(HELP);
  switch (cmd) {
    case "setup": case "install": return cmdSetup(o);
    case "login": return cmdLogin(o);
    case "listen": return cmdListen(o);
    case "status": return cmdStatus();
    case "start": case "stop": case "restart": return cmdService(cmd);
    case "logs": return cmdLogs(o);
    case "run": return cmdRun();
    case "update": case "upgrade": return cmdUpdate();
    case "uninstall": return cmdUninstall(o);
    case "version": case "--version": return ui.out(core.VERSION);
    case "help": return ui.out(HELP);
    default:
      ui.fail(`Unknown command: ${cmd}`);
      ui.out(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  if (e instanceof ui.Cancelled) {
    ui.out("\n  Cancelled.");
    process.exit(130);
  }
  ui.out();
  ui.fail(e.message || String(e));
  process.exit(1);
});
