// Shared plumbing for the venice-opencode CLI: paths, config, session, opencode, systemd.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version;
export const REPO = "zalo-alex/venice-opencode";

const home = os.homedir();
const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config");

export const CONFIG_DIR = process.env.VENICE_CONFIG_DIR || path.join(xdgConfig, "venice-opencode");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.env");
export const SESSION_FILE = path.join(CONFIG_DIR, "session.json");
export const MFA_FILE = path.join(CONFIG_DIR, "mfa-pending.json");
export const SERVICE = process.env.VENICE_OPENCODE_SERVICE || "venice-opencode";
export const UNIT_DIR = path.join(xdgConfig, "systemd", "user");
export const UNIT_FILE = path.join(UNIT_DIR, `${SERVICE}.service`);
export const LEGACY_DIR = path.join(home, ".venice-opencode");

export const DEFAULTS = {
  PORT: "3456",
  HOST: "127.0.0.1",
  AGENT_MODEL: "deepseek-v4-1-flash-free",
  TOOLS_MODE: "client",
  TOOLS_SHAPE: "mcp",
  ALL_MODELS: "0",
};

// ---------- config (systemd EnvironmentFile compatible) ----------

export function readConfig() {
  const cfg = { ...DEFAULTS, VENICE_SESSION_FILE: SESSION_FILE };
  let text = "";
  try {
    text = fs.readFileSync(CONFIG_FILE, "utf8");
  } catch {
    return cfg;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (m) cfg[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return cfg;
}

export function writeConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const q = (v) => (/\s/.test(String(v)) ? `"${v}"` : String(v));
  const body = Object.entries(cfg).map(([k, v]) => `${k}=${q(v)}`).join("\n");
  fs.writeFileSync(CONFIG_FILE, `# Managed by venice-opencode. Edit, then: venice-opencode restart\n${body}\n`, { mode: 0o600 });
}

export const baseUrl = (cfg) => `http://${cfg.HOST === "0.0.0.0" ? "127.0.0.1" : cfg.HOST}:${cfg.PORT}`;

// ---------- session ----------

// Turns a raw "Cookie:" header into the session file the client understands.
export function writeSessionFromCookieHeader(raw) {
  const header = raw.trim().replace(/^cookie:\s*/i, "").replace(/[\r\n]+/g, " ");
  const now = Date.now();
  const month = 30 * 24 * 3600 * 1000;
  const cookies = header
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.includes("="))
    .map((pair) => {
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const cf = name.startsWith("__cf");
      return {
        name,
        value: pair.slice(i + 1),
        domain: cf ? "venice.ai" : ".venice.ai",
        path: "/",
        secure: true,
        httpOnly: true,
        hostOnly: cf,
        expiresAt: name === "__session" ? now + 60_000 : now + month,
      };
    });
  if (!cookies.some((c) => c.name === "__client")) {
    throw new Error("No __client cookie found. Copy the Cookie header of a request to clerk.venice.ai.");
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ savedAt: now, cookies }, null, 2), { mode: 0o600 });
  return cookies.length;
}

export async function newClient() {
  process.env.VENICE_CONFIG_DIR = CONFIG_DIR;
  const { VeniceWebClient } = await import("../src/client.mjs");
  return new VeniceWebClient({ sessionFile: SESSION_FILE, email: "", password: "" });
}

// Resolves to { email } when the stored session works, rejects otherwise.
export async function verifySession() {
  if (!fs.existsSync(SESSION_FILE)) throw new Error("no session saved");
  const client = await newClient();
  try {
    const auth = await client.ensureAuthenticated();
    try { fs.chmodSync(SESSION_FILE, 0o600); } catch {}
    return { email: auth?.userSession?.email || "", jwt: auth?.login?.clerkJwt || client.clerkJwt };
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------- tool protocol detection ----------

const FALLBACK_MODELS = ["deepseek-v4-1-flash-free", "kimi-k2-5"];

// Tries the native client-tool shapes against Venice; returns {model, mode, shape}.
export async function detectToolProtocol(preferredModel) {
  const client = await newClient();
  try {
    const auth = await client.ensureAuthenticated();
    const jwt = auth?.login?.clerkJwt || client.clerkJwt;
    const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
    const d = "List files in a directory";
    const shapes = {
      mcp: [{ name: "list_dir", description: d, inputSchema: schema }],
      mcp_typed: [{ type: "function", name: "list_dir", description: d, inputSchema: schema }],
      flat: [{ type: "function", name: "list_dir", description: d, parameters: schema }],
    };
    const messages = [{ type: "message", role: "user", id: "m1", status: "completed",
      content: [{ type: "output_text", text: "[System]\nUse the provided tool and stop.\n\nList the files here.", annotations: [] }] }];
    const hasCall = (raw) => {
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        const it = ev?.item ?? ev?.response?.output?.[0];
        const t = String(it?.type || "");
        if (it?.name === "list_dir" || (t.includes("client") && t.includes("call"))) return true;
      }
      return false;
    };
    const models = [...new Set([preferredModel, ...FALLBACK_MODELS].filter(Boolean))];
    for (const model of models) {
      for (const [shape, clientTools] of Object.entries(shapes)) {
        try {
          const res = await client.request(
            `https://outerface.venice.ai/api/inference/chat/agents/venice?agentModelId=${encodeURIComponent(model)}`,
            { method: "POST",
              headers: client.outerfaceHeaders(jwt, { accept: "text/event-stream", "content-type": "application/json",
                "x-venice-middleface-version": client.middlefaceVersion }),
              body: JSON.stringify({ clientTools, input: { messages } }) });
          if (res.status === 200 && hasCall(await res.text())) return { model, mode: "client", shape };
        } catch {}
      }
    }
    return { model: preferredModel || DEFAULTS.AGENT_MODEL, mode: "json", shape: "mcp" };
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------- opencode config ----------

export function opencodeConfigPath() {
  const dir = path.join(xdgConfig, "opencode");
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(dir, "opencode.json");
}

// Removes // and /* */ comments and trailing commas, leaving strings untouched.
function stripJsonc(text, flags = {}) {
  let out = "", i = 0, inStr = false;
  while (i < text.length) {
    const ch = text[i], nx = text[i + 1];
    if (inStr) {
      out += ch;
      if (ch === "\\") { out += nx ?? ""; i += 2; continue; }
      if (ch === '"') inStr = false;
      i++;
    } else if (ch === '"') { inStr = true; out += ch; i++; }
    else if (ch === "/" && nx === "/") { flags.comments = true; while (i < text.length && text[i] !== "\n") i++; }
    else if (ch === "/" && nx === "*") { flags.comments = true; i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; }
    else { out += ch; i++; }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function opencodeSnippet(cfg, model) {
  return {
    provider: {
      "venice-web": {
        npm: "@ai-sdk/openai-compatible",
        name: "Venice (web session)",
        options: { baseURL: `${baseUrl(cfg)}/v1`, apiKey: "unused" },
        models: { [model]: { name: "Venice web (unmetered)", tool_call: true, attachment: false,
          limit: { context: 128000, output: 16384 } } },
      },
    },
    model: `venice-web/${model}`,
    small_model: `venice-web/${model}`,
  };
}

// Returns {status:"written"|"manual", file, snippet?, backup?}.
export function wireOpencode(cfg, model) {
  const file = opencodeConfigPath();
  const snippet = opencodeSnippet(cfg, model);
  let current = {};
  let backup = null;
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    const flags = {};
    try {
      current = JSON.parse(stripJsonc(text, flags));
    } catch {
      return { status: "manual", file, snippet, reason: "could not parse existing config" };
    }
    if (flags.comments) {
      return { status: "manual", file, snippet, reason: "existing config has comments that would be lost" };
    }
    backup = `${file}.bak.${Date.now()}`;
    fs.copyFileSync(file, backup);
  }
  current["$schema"] ||= "https://opencode.ai/config.json";
  current.provider = { ...current.provider, ...snippet.provider };
  current.model = snippet.model;
  current.small_model = snippet.small_model;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
  return { status: "written", file, backup };
}

export function unwireOpencode() {
  const file = opencodeConfigPath();
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8");
  const flags = {};
  let cfg;
  try { cfg = JSON.parse(stripJsonc(text, flags)); } catch { return false; }
  if (flags.comments || !cfg.provider?.["venice-web"]) return false;
  fs.copyFileSync(file, `${file}.bak.${Date.now()}`);
  delete cfg.provider["venice-web"];
  if (!Object.keys(cfg.provider).length) delete cfg.provider;
  for (const k of ["model", "small_model"]) if (String(cfg[k] || "").startsWith("venice-web/")) delete cfg[k];
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return true;
}

// ---------- systemd (user service) ----------

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
export const sysctl = (...args) => run("systemctl", ["--user", ...args]);

export function hasSystemd() {
  return process.platform === "linux" && run("systemctl", ["--user", "show-environment"]).status === 0;
}

export function writeUnit() {
  fs.mkdirSync(UNIT_DIR, { recursive: true });
  const unit = `[Unit]
Description=Venice web session proxy for opencode
Documentation=https://github.com/${REPO}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${CONFIG_FILE}
ExecStart=${process.execPath} ${path.join(APP_DIR, "src", "server.mjs")}
Restart=always
RestartSec=3
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(UNIT_FILE, unit);
  sysctl("daemon-reload");
}

export function removeUnit() {
  sysctl("disable", "--now", SERVICE);
  fs.rmSync(UNIT_FILE, { force: true });
  sysctl("daemon-reload");
}

export const serviceState = () => {
  const r = sysctl("is-active", SERVICE);
  return r.stdout.trim() || "unknown";
};
export const serviceEnabled = () => sysctl("is-enabled", SERVICE).stdout.trim() === "enabled";

// Whether the service keeps running after logout / starts at boot.
export function lingerEnabled() {
  const r = run("loginctl", ["show-user", os.userInfo().username, "-p", "Linger", "--value"]);
  return r.status === 0 && r.stdout.trim() === "yes";
}
export function enableLinger() {
  return run("loginctl", ["enable-linger", os.userInfo().username]).status === 0;
}

export async function fetchJson(url, ms = 3000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function waitForProxy(cfg, seconds = 30) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await fetchJson(`${baseUrl(cfg)}/api/status`, 1000)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
