import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { VeniceWebClient, decodeJwtPayload } from "./client.mjs";

const PORT = Number(process.env.PORT || 3456);
// HOST is a comma-separated list of addresses to listen on (0.0.0.0 / :: = every interface).
const HOSTS = [...new Set((process.env.HOST || "127.0.0.1").split(",").map(h => h.trim()).filter(Boolean))];
const AGENT_MODEL = process.env.AGENT_MODEL || "deepseek-v4-1-flash-free";
const TOOLS_MODE = process.env.TOOLS_MODE || "client";
const TOOLS_SHAPE = process.env.TOOLS_SHAPE || "mcp";
const ALL_MODELS = process.env.ALL_MODELS === "1";
const DEBUG = !!process.env.VENICE_DEBUG;

const client = new VeniceWebClient({});
let jwt = null;
let lastTools = [];

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const startedAt = Date.now();
const stats = { requests: 0, toolCalls: 0, errors: 0, retries: 0 };
const recent = [];
const log = (kind, msg) => process.stderr.write(`[${kind}] ${msg}\n`);
const remember = (entry) => { recent.unshift({ t: Date.now(), ...entry }); recent.length = Math.min(recent.length, 25); };
const fmtUptime = (ms) => {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : m ? `${m}m` : `${Math.floor(ms / 1000)}s`;
};
const MAX_BODY = 32 * 1024 * 1024;

async function statusInfo() {
  let session = { valid: false, error: null, expiresInMin: null };
  try {
    const t = await auth();
    const exp = decodeJwtPayload(t)?.exp;
    session = { valid: true, error: null, expiresInMin: exp ? Math.max(0, Math.round((exp * 1000 - Date.now()) / 60000)) : null };
  } catch (e) { session.error = String(e.message || e); }
  return { version: VERSION, uptime: fmtUptime(Date.now() - startedAt),
    model: AGENT_MODEL, mode: TOOLS_MODE, shape: TOOLS_SHAPE, allModels: ALL_MODELS,
    listen: HOSTS.map(h => `${h}:${PORT}`), session, stats, recent: recent.map(r => ({ ...r, ago: fmtUptime(Date.now() - r.t) })) };
}

const usable = (t) => {
  const exp = decodeJwtPayload(t)?.exp;
  return typeof exp === "number" && exp * 1000 > Date.now() + 30_000;
};

async function auth(force = false) {
  if (!force && jwt && usable(jwt)) return jwt;
  const r = await client.ensureAuthenticated();
  jwt = r?.login?.clerkJwt || client.clerkJwt;
  if (!jwt) throw new Error("no valid Venice session - run: venice-opencode login");
  return jwt;
}

const rid = () => crypto.randomBytes(9).toString("base64url");
const flat = (c) => typeof c === "string" ? c
  : Array.isArray(c) ? c.map(p => typeof p === "string" ? p : p?.text || "").filter(Boolean).join("\n") : "";
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// opencode's own tool ids, so a hallucinated variant still resolves.
const ALIASES = {
  shell: ["shell", "bash", "sh", "terminal", "run", "exec", "execute"],
  bash: ["bash", "shell", "sh", "terminal", "run"],
  read: ["read", "cat", "view", "open_file", "readfile"],
  write: ["write", "create", "save", "writefile"],
  edit: ["edit", "patch", "replace", "modify", "str_replace"],
  glob: ["glob", "find", "ls", "list", "list_dir", "listdir"],
  grep: ["grep", "search", "rg", "ripgrep", "context_grep"],
  webfetch: ["webfetch", "fetch", "web_fetch", "http", "curl"],
  websearch: ["websearch", "web_search", "search_web"],
};

function makeResolver(names) {
  const pool = [...new Set([...names, ...lastTools])];
  const exact = new Set(pool);
  const byNorm = new Map(pool.map(n => [norm(n), n]));
  const dist = (a, b) => {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 3) return 99;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++)
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  };
  return (raw) => {
    if (!raw) return raw;
    if (exact.has(raw)) return raw;
    const n = norm(raw);
    if (byNorm.has(n)) return byNorm.get(n);
    for (const [key, alts] of Object.entries(ALIASES)) {
      if (!alts.some(a => norm(a) === n)) continue;
      const hit = [key, ...alts].map(norm).map(x => byNorm.get(x)).find(Boolean);
      if (hit) return hit;
    }
    for (const cand of pool) if (n && (norm(cand).includes(n) || n.includes(norm(cand)))) return cand;
    let best = null, bestD = 3;
    for (const cand of pool) {
      const d = dist(n, norm(cand));
      if (d < bestD) { best = cand; bestD = d; }
    }
    return best || raw;
  };
}

// Venice's validator rejects unknown schema keywords; strip them.
function cleanSchema(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return node;
  if (Array.isArray(node)) return node.map(n => cleanSchema(n, depth + 1));
  const drop = new Set(["$schema", "$id", "definitions", "$defs", "examples", "title"]);
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (drop.has(k)) continue;
    out[k] = cleanSchema(v, depth + 1);
  }
  return out;
}

const validArgs = (a) => {
  if (a && typeof a === "object") return JSON.stringify(a);
  if (typeof a === "string") {
    try { JSON.parse(a); return a; } catch { return "{}"; }
  }
  return "{}";
};

function toClientTools(tools) {
  return (tools || []).filter(t => t?.function?.name).map(t => {
    const base = { name: t.function.name, description: t.function.description || "",
      inputSchema: cleanSchema(t.function.parameters || { type: "object", properties: {} }) };
    if (TOOLS_SHAPE === "mcp_typed") return { type: "function", ...base };
    if (TOOLS_SHAPE === "flat") return { type: "function", name: base.name,
      description: base.description, parameters: base.inputSchema };
    return base;
  });
}

const JSON_RULES = [
  "TOOL PROTOCOL: first write ONE short line saying what you are about to do,",
  "then on its own line a single JSON object and nothing else:",
  '{"tool_calls":[{"name":"<tool>","arguments":{...}}]}',
  "Use the EXACT tool names listed below. One tool per turn. No code fences.",
  "If no tool is needed, reply with normal text only.",
].join("\n");

function toolPreamble(tools) {
  if (!tools?.length) return "";
  const sig = tools.filter(t => t?.function?.name).map(t => JSON.stringify({
    name: t.function.name, description: t.function.description || "",
    parameters: t.function.parameters || {} })).join("\n");
  if (TOOLS_MODE === "json")
    return `[System]\n${JSON_RULES}\n\nAvailable tools:\n${sig}\n\n`;
  return `[System]\nState in one short line what you intend to do, then call the tool by its exact name. One tool at a time.\n\n`;
}

function toItems(messages, tools) {
  const out = [];
  const pre = toolPreamble(tools);
  const known = new Set();
  for (const m of messages || [])
    for (const c of m?.tool_calls || []) if (c?.id) known.add(c.id);

  // Native function_call items in the history make the model switch to native tool
  // calling, which Venice then tries (and fails) to run server-side. In json mode keep
  // the whole transcript in the text protocol instead.
  const asText = TOOLS_MODE === "json";
  const nameOf = new Map();
  for (const m of messages || [])
    for (const c of m?.tool_calls || []) if (c?.id) nameOf.set(c.id, c.function?.name || "tool");
  const lastIdx = (messages || []).length - 1;

  let preUsed = false;
  for (const [i, m] of (messages || []).entries()) {
    const text = flat(m.content);
    if (asText && m.role === "tool") {
      if (!text) continue;
      const tail = i === lastIdx
        ? "\n\n[System]\nContinue with the next step of the original task using the TOOL PROTOCOL. Reply with plain text only once EVERY step is done.\n"
        : "";
      out.push({ type: "message", role: "user", id: rid(), status: "completed",
        content: [{ type: "output_text", annotations: [],
          text: `[Tool result: ${nameOf.get(m.tool_call_id) || "tool"}]\n${text}${tail}` }] });
      continue;
    }
    if (asText && m.role === "assistant") {
      const calls = (m.tool_calls || []).map(c => {
        let a; try { a = JSON.parse(validArgs(c.function?.arguments)); } catch { a = {}; }
        return { name: c.function?.name || "", arguments: a };
      });
      const said = [text, calls.length ? JSON.stringify({ tool_calls: calls }) : ""].filter(Boolean).join("\n\n");
      if (said) out.push({ type: "message", role: "assistant", id: rid(), status: "completed",
        content: [{ type: "output_text", text: said, annotations: [] }] });
      continue;
    }
    if (m.role === "tool") {
      // Orphaned result after compaction: upstream rejects unknown call_ids.
      if (text && m.tool_call_id && known.has(m.tool_call_id))
        out.push({ type: "function_call_output", id: m.tool_call_id,
          call_id: m.tool_call_id, output: text, status: "completed" });
      continue;
    }
    if (m.role === "assistant") {
      if (text) out.push({ type: "message", role: "assistant", id: rid(), status: "completed",
        content: [{ type: "output_text", text, annotations: [] }] });
      for (const c of m.tool_calls || []) {
        const args = validArgs(c.function?.arguments);
        const id = c.id || rid();
        let parsed; try { parsed = JSON.parse(args); } catch { parsed = {}; }
        out.push({ type: "function_call", id, call_id: id, name: c.function?.name || "",
          arguments: args, input: parsed, status: "completed" });
      }
      continue;
    }
    if (!text) continue;
    const bodyText = m.role === "system" ? `[System]\n${text}\n\n` : text;
    out.push({ type: "message", role: "user", id: rid(), status: "completed",
      content: [{ type: "output_text", text: preUsed ? bodyText : pre + bodyText, annotations: [] }] });
    preUsed = true;
  }
  if (!preUsed && pre) out.unshift({ type: "message", role: "user", id: rid(), status: "completed",
    content: [{ type: "output_text", text: pre, annotations: [] }] });
  return out;
}

// Models often write shell/regex escapes (\|, \., \s) or raw newlines inside JSON strings.
// Keep the intended characters instead of rejecting the whole call.
function repairJson(s) {
  let out = "", inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inStr) { if (ch === '"') inStr = true; out += ch; continue; }
    if (ch === '"') {
      // A quote only closes the string if JSON structure follows; otherwise it is a stray
      // unescaped quote inside the value (e.g. curl --data "a=$b").
      if (/^\s*([}\]:]|,\s*["{\[\dtfn-])/.test(s.slice(i + 1, i + 40)) || i === s.length - 1) { inStr = false; out += ch; }
      else out += '\\"';
      continue;
    }
    if (ch === "\\") {
      const n = s[i + 1];
      const valid = (n !== undefined && '"\\/bfnrt'.includes(n)) || (n === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6)));
      if (valid) { out += ch + n; i++; } else out += "\\\\";
      continue;
    }
    out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : ch;
  }
  return out;
}

function jsonObjects(text) {
  const s = String(text || "");
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { out.push(s.slice(i, j + 1)); i = j; break; } }
    }
  }
  return out;
}

// The model sometimes drops the "name" key; the argument shape still says which tool it meant.
function guessName(c) {
  const a = c.arguments ?? c.parameters;
  if (typeof a !== "object" || !a) return "shell_arguments" in c ? "shell" : "";
  if (typeof a.command === "string" || "shell_arguments" in c) return "shell";
  if ("filePath" in a && "content" in a) return "write";
  if ("filePath" in a && ("oldString" in a || "old_string" in a)) return "edit";
  if ("filePath" in a || "file_path" in a) return "read";
  if ("pattern" in a) return "grep";
  if ("url" in a) return "webfetch";
  return "";
}

function parseJsonCalls(text, resolve) {
  // Code fences are left alone here: they may legitimately sit inside string arguments.
  const s = String(text || "");
  let first = null, rest = s;
  const chunks = jsonObjects(s);
  // Stray quotes can throw off brace matching; fall back to the whole span of the call.
  const i0 = s.indexOf('{"tool_calls"'), j0 = s.lastIndexOf("}");
  if (i0 >= 0 && j0 > i0) chunks.push(s.slice(i0, j0 + 1));
  for (const chunk of chunks) {
    let obj;
    try { obj = JSON.parse(chunk); }
    catch { try { obj = JSON.parse(repairJson(chunk)); } catch { continue; } }
    const list = Array.isArray(obj?.tool_calls) ? obj.tool_calls : obj?.name ? [obj] : null;
    if (!list?.length) continue;
    const calls = list.filter(c => c && (c.name || guessName(c))).map(c => ({
      call_id: rid(), name: resolve(c.name || guessName(c)),
      arguments: validArgs(c.arguments ?? c.parameters ?? {}) }));
    if (!calls.length) continue;
    // Drop every call object from the visible text; models sometimes repeat the call.
    rest = rest.replace(chunk, " ");
    first ||= calls;
  }
  return first && { calls: first, rest: rest.replace(/```(?:json)?\s*```/gi, "").replace(/\n{3,}/g, "\n\n") };
}

const DASHBOARD = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>venice-opencode</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--line:#262b36;--fg:#e6e8ee;--dim:#8a93a6;--ok:#3ecf8e;--bad:#ff6b6b;--acc:#7c9cff}
@media(prefers-color-scheme:light){:root{--bg:#f5f6f9;--card:#fff;--line:#e3e6ee;--fg:#1a1d26;--dim:#667085;--ok:#12a46a;--bad:#d64545;--acc:#4a63d8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px}
h1{font-size:20px;margin:0 0 4px}h1 span{color:var(--acc)}p.sub{color:var(--dim);margin:0 0 24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card b{display:block;font-size:22px}.card small{color:var(--dim)}
.pill{display:inline-flex;align-items:center;gap:6px}.dot{width:9px;height:9px;border-radius:50%;background:var(--dim)}
.ok .dot{background:var(--ok)}.bad .dot{background:var(--bad)}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:24px 0 8px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
td{padding:9px 14px;border-bottom:1px solid var(--line)}tr:last-child td{border:0}td:last-child{text-align:right;color:var(--dim)}
code{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:2px 6px;font-size:13px}
.empty{padding:16px;color:var(--dim)}
</style></head><body><main>
<h1><span>▲</span> venice-opencode</h1><p class="sub">Venice web session as an opencode backend</p>
<div class="grid">
 <div class="card"><small>Proxy</small><b class="pill ok" id="up"><i class="dot"></i><span>up</span></b><small id="uptime"></small></div>
 <div class="card"><small>Venice session</small><b class="pill" id="sess"><i class="dot"></i><span>…</span></b><small id="exp"></small></div>
 <div class="card"><small>Model</small><b style="font-size:15px;word-break:break-all" id="model">…</b><small id="mode"></small></div>
</div>
<div class="grid">
 <div class="card"><small>Requests</small><b id="req">0</b></div>
 <div class="card"><small>Tool calls</small><b id="tc">0</b></div>
 <div class="card"><small>Retries</small><b id="rt">0</b></div>
 <div class="card"><small>Errors</small><b id="er">0</b></div>
</div>
<h2>Recent activity</h2><div id="recent"></div>
<h2>Connect</h2><p class="sub">Base URL <code id="base"></code> · run <code>venice-opencode status</code> in a terminal</p>
</main>
<script>
const $=i=>document.getElementById(i);$("base").textContent=location.origin+"/v1";
const esc=s=>String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
async function tick(){
 try{
  const d=await (await fetch("/api/status")).json();
  $("up").className="pill ok";$("up").lastChild.textContent="up";$("uptime").textContent="for "+d.uptime;
  $("sess").className="pill "+(d.session.valid?"ok":"bad");
  $("sess").lastChild.textContent=d.session.valid?"valid":"expired";
  $("exp").textContent=d.session.valid?(d.session.expiresInMin!=null?"token renews in "+d.session.expiresInMin+" min":""):"run: venice-opencode login";
  $("model").textContent=d.model;$("mode").textContent=d.mode+" / "+d.shape;
  $("req").textContent=d.stats.requests;$("tc").textContent=d.stats.toolCalls;$("rt").textContent=d.stats.retries;$("er").textContent=d.stats.errors;
  $("recent").innerHTML=d.recent.length?"<table>"+d.recent.map(r=>"<tr><td>"+(r.ok?"✔":"✘")+" "+esc(r.what)+"</td><td>"+esc(r.secs)+"s · "+esc(r.ago)+" ago</td></tr>").join("")+"</table>":'<div class="card empty">No requests yet. Start opencode and pick the Venice model.</div>';
 }catch{$("up").className="pill bad";$("up").lastChild.textContent="down"}
}
tick();setInterval(tick,3000);
</script></body></html>`;

const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
};

const NUDGE = '[System]\nYour previous reply did not contain a usable tool call. Reply again: one short line, then on its own line the JSON object {"tool_calls":[{"name":"<tool>","arguments":{...}}]} and nothing else. Inside JSON strings escape every double quote as \\" and every backslash as \\.';

const CONTINUE = '[System]\ncontinue - now emit the tool call for the step you just announced: one short line, then on its own line the JSON object {"tool_calls":[{"name":"<tool>","arguments":{...}}]} and nothing else. Inside JSON strings escape every double quote as \\" and every backslash as \\.';

// `retry` > 0 marks a re-attempt after a swallowed/missing call and adds a nudge. `native`
// registers the tools with Venice so it hands native calls back instead of swallowing them.
const openStream = async (body, force = false, retry = 0, prior = "", native = false) => {
  const items = toItems(body.messages, body.tools);
  const say = (role, text) => items.push({ type: "message", role, id: rid(), status: "completed",
    content: [{ type: "output_text", text, annotations: [] }] });
  if (retry && TOOLS_MODE === "json" && body.tools?.length) {
    // Same thing a manual "continue" does: show the model its own announcement and ask again.
    if (prior) say("assistant", prior);
    say("user", prior ? CONTINUE : NUDGE);
  }
  return client.openAgentChatStream(await auth(force), items,
    { agentModelId: body.model && body.model !== "default" ? body.model : AGENT_MODEL,
      clientTools: TOOLS_MODE === "client" || native ? toClientTools(body.tools) : [] });
};

// Share of recent tool turns that only worked with native tools registered. When Venice keeps
// swallowing the text-protocol call, start with native tools instead of paying for a retry.
let nativeScore = 0, turnCount = 0;

const IDLE_MS = Number(process.env.IDLE_MS || 90_000);

const handler = async (req, res) => {
  let clientGone = false;
  res.on("close", () => { clientGone = true; });
  try {
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      let data = [];
      try {
        data = ((await client.getTextModels(await auth())) || [])
          .filter(m => m?.type === "text" && m?.usesCredits === false && m?.active !== false)
          .map(m => ({ id: m.apiModelId || m.id, object: "model", owned_by: "venice-web" }));
      } catch {}
      if (!data.some(m => m.id === AGENT_MODEL))
        data.unshift({ id: AGENT_MODEL, object: "model", owned_by: "venice-web" });
      // Unknown ids carry no models.dev metadata, so opencode strips tools when
      // one is picked. Advertise only the configured model by default.
      if (!ALL_MODELS) data = data.filter(m => m.id === AGENT_MODEL);
      return send(res, 200, { object: "list", data });
    }

    const pathname = req.url.split("?")[0];
    if (req.method === "GET" && pathname === "/api/status") return send(res, 200, await statusInfo());
    if (req.method === "GET" && pathname === "/health") return send(res, 200, { ok: true });
    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(DASHBOARD);
    }

    if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions"))
      return send(res, 404, { error: { message: "not found" } });

    let raw = "", size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) return send(res, 413, { error: { message: "request body too large" } });
      raw += c;
    }
    let body;
    try { body = JSON.parse(raw || "{}"); }
    catch { return send(res, 400, { error: { message: "invalid JSON body" } }); }
    stats.requests++;
    const began = Date.now();
    const model = body.model || AGENT_MODEL;
    const created = Math.floor(Date.now() / 1000);
    const id = "chatcmpl-" + rid();

    if (Array.isArray(body.tools) && body.tools.length) lastTools = body.tools.map(t => t?.function?.name).filter(Boolean);
    const names = (body.tools || []).map(t => t?.function?.name).filter(Boolean);
    const resolve = makeResolver(names);
    if (DEBUG) process.stderr.write(`[tools] sent=${names.length} cached=${lastTools.length}\n`);
    if (!names.length) log("warn", "request carried no tools - opencode may have stripped them");

    const isCall = (it) => {
      if (!it) return false;
      const t = String(it.type || "");
      if (t.includes("output")) return false;
      if (it.name && names.length) return true;
      return t.includes("client") && t.includes("call");
    };

    const openUp = async (retry = 0, prior = "", native = false) => {
      try { return await openStream(body, false, retry, prior, native); }
      catch (e) {
        if (String(e).startsWith("HTTP 401")) return openStream(body, true, retry, prior, native);
        process.stderr.write(`[upstream] ${String(e).slice(0, 300)}\n`);
        throw e;
      }
    };

    const emitCall = (it, index) => {
      const name = resolve(it.name);
      if (DEBUG) process.stderr.write(`[call] ${it.name} -> ${name}\n`);
      return { index, id: it.call_id || rid(), type: "function",
        function: { name, arguments: validArgs(it.arguments ?? it.input) } };
    };

    // Reads one turn from upstream. Venice's agent runs its own loop (agent-node:llm:0, :1, ...):
    // it tries to execute tool calls it spots in the text, fails with "Tool not found", and keeps
    // generating until it writes a final answer. Only the first node is the turn opencode should see.
    const readTurn = async (up, onReasoning) => {
      const t = { text: "", thinking: "", calls: [], error: null, trace: [], raw: [] };
      const types = new Map();
      let firstNode = null;
      const it = up.events[Symbol.asyncIterator]();
      try {
        while (!clientGone) {
          let timer;
          const next = await Promise.race([it.next(),
            new Promise(r => { timer = setTimeout(() => r(null), IDLE_MS); })]);
          clearTimeout(timer);
          if (next === null) { t.error = `no upstream data for ${IDLE_MS / 1000}s`; break; }
          if (next.done) break;
          const { event, data } = next.value;
          if (DEBUG && event && (event.includes("tool_call") || event === "response.output_text.done" || /tcg_/.test(data?.item_id || ""))) t.raw.push(`${event} ${JSON.stringify(data).slice(0, 500)}`);
          if (event && !event.endsWith("delta")) t.trace.push(event.replace(/^response\./, "") + (data?.item?.type ? ":" + data.item.type : ""));
          // Venice parsed a tool call out of the model output and tried to run it server-side.
          if (event === "veniceai:tool_call_generation.in_progress")
            t.swallowed = (data?.detected_tools || []).map(d => d.name || d.tool).join(",") || "?";
          if (event === "response.failed" || data?.response?.status === "failed")
            t.error = data?.response?.error?.message || "upstream failed";
          if (event === "response.output_item.added" && data?.item?.id) {
            const node = String(data.item.id).replace(/^(rs_|tcg_)/, "");
            if (firstNode === null) firstNode = node;
            if (node !== firstNode) break;
            types.set(data.item.id, String(data.item.type || ""));
          }
          if (event === "response.output_text.delta" && typeof data?.delta === "string") {
            if (types.get(data.item_id) === "reasoning") { t.thinking += data.delta; onReasoning(data.delta); }
            else t.text += data.delta;
          }
          if (event === "response.output_item.done" && isCall(data?.item)) t.calls.push(data.item);
          if (event === "response.completed")
            for (const it of data?.response?.output || []) if (isCall(it)) t.calls.push(it);
        }
      } catch (e) { t.error = String(e).slice(0, 200); }
      finally { it.return?.()?.catch?.(() => {}); }

      t.rest = t.text;
      if (TOOLS_MODE === "json") {
        const parsed = parseJsonCalls(t.text, resolve);
        if (parsed) { t.calls = parsed.calls; t.rest = parsed.rest; }
        else if (/"tool_calls"|"name"\s*:/.test(t.text)) {
          t.badCall = true;
          process.stderr.write(`[parse-fail] ${JSON.stringify(t.text).slice(0, 1500)}\n`);
        }
      }
      return t;
    };

    // Venice sometimes fails the LLM stream ("Request error") or swallows the model's tool call
    // server-side, leaving nothing to forward. Both are transient, so retry before giving up.
    const MAX_TRIES = Number(process.env.MAX_TRIES || 6);
    // A reply that only announces the next step ("I'll write the file.") with no call would end
    // opencode's loop with the task unfinished, so that is retried too.
    const announcesOnly = (t) => names.length && !t.calls.length && t.rest.trim().length < 300
      && (/^(i'?ll|i will|i'm going to|let me|now|next|first|continuing|checking|pulling|trying|testing)\b/i.test(t.rest.trim())
        || /:\s*$/.test(t.rest.trim()));
    const getTurn = async (onReasoning) => {
      let t = null, soft = null;
      // Alternate between the two styles, starting with the one that has been working; every
      // 10th turn starts with text anyway so a recovered Venice is noticed.
      const preferNative = names.length > 0 && nativeScore > 0.5 && ++turnCount % 10 !== 0;
      const nativeFor = (attempt) => names.length > 0 && (attempt % 2 === 1) === preferNative;
      for (let attempt = 1; attempt <= MAX_TRIES && !clientGone; attempt++) {
        try { t = await readTurn(await openUp(attempt - 1, soft?.rest?.trim() || "", nativeFor(attempt)), onReasoning); }
        catch (e) { t = { text: "", rest: "", thinking: "", calls: [], error: String(e).slice(0, 200), trace: [], raw: [] }; }
        if (t.calls.length) {
          if (names.length) nativeScore = nativeScore * 0.7 + (nativeFor(attempt) ? 0.3 : 0);
          if (attempt > 1) process.stderr.write(`[recovered] attempt ${attempt}, ${nativeFor(attempt) ? "native tools" : "text protocol"}, call=${t.calls[0].name}\n`);
          return t;
        }
        if (t.rest.trim()) {
          if (!t.swallowed && !t.badCall && !announcesOnly(t)) return t;
          soft = t;
          stats.retries++;
          process.stderr.write(`[retry ${attempt}/${MAX_TRIES}] ${t.swallowed ? `Venice swallowed a ${t.swallowed} call` : t.badCall ? "tool call was not valid JSON" : "announced a step without a call"}: ${JSON.stringify(t.rest.trim().slice(0, 160))}\n`);
        } else {
          stats.retries++;
          process.stderr.write(`[retry ${attempt}/${MAX_TRIES}] ${t.error || "no text/call"} :: ${t.trace.join(" > ")}\n`);
          for (const r of t.raw || []) process.stderr.write(`    ${r}\n`);
        }
        if (attempt < MAX_TRIES) await new Promise(r => setTimeout(r, 400 * attempt));
      }
      if (soft) return soft;
      t.rest = `[venice upstream error: ${t.error || "empty response"} (after ${MAX_TRIES} attempts) - please retry]`;
      return t;
    };

    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    const done = (t) => {
      stats.toolCalls += t.calls.length;
      const failed = /^\[venice upstream error/.test(t.rest);
      if (failed) stats.errors++;
      const what = t.calls.length ? `tool ${t.calls.map(c => resolve(c.name)).join(", ")}` : "text reply";
      const secs = ((Date.now() - began) / 1000).toFixed(1);
      remember({ model, what, secs, ok: !failed });
      log("req", `${model} tools=${names.length} -> ${what} (${secs}s)`);
    };

    if (!body.stream) {
      const t = await getTurn(() => {});
      done(t);
      const msg = { role: "assistant", content: t.rest.trim() || null };
      if (t.thinking.trim()) msg.reasoning_content = t.thinking.trim();
      if (t.calls.length) msg.tool_calls = t.calls.map((c, i) => emitCall(c, i));
      return send(res, 200, { id, object: "chat.completion", created, model, usage,
        choices: [{ index: 0, message: msg, finish_reason: t.calls.length ? "tool_calls" : "stop" }] });
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const chunk = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);

    chunk({ role: "assistant", content: "" });
    const t = await getTurn((d) => chunk({ reasoning_content: d }));
    done(t);
    if (t.rest.trim()) chunk({ content: t.rest.trim() });
    t.calls.forEach((c, i) => chunk({ tool_calls: [emitCall(c, i)] }));
    chunk({}, t.calls.length ? "tool_calls" : "stop", { usage });
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    stats.errors++;
    remember({ model: AGENT_MODEL, what: String(e.message || e).slice(0, 80), secs: "-", ok: false });
    process.stderr.write(`[error] ${String(e).slice(0, 300)}\n`);
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-err", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
        model: AGENT_MODEL, choices: [{ index: 0, delta: { content: `\n[proxy error: ${String(e).slice(0, 200)}]` }, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    send(res, 500, { error: { message: String(e) } });
  }
};
const servers = HOSTS.map((host) => {
  const server = http.createServer(handler);
  // Agent turns are separated by tool runs and approvals that easily outlast Node's 5s default
  // keep-alive; a client reusing the socket at that moment gets a reset ("fetch failed").
  server.keepAliveTimeout = 10 * 60_000;
  server.headersTimeout = 10 * 60_000 + 5_000;
  server.on("error", (e) => {
    log("fatal", e.code === "EADDRINUSE" ? `${host}:${PORT} is already in use`
      : e.code === "EADDRNOTAVAIL" ? `${host} is not an address of this machine` : `${host}: ${e}`);
    process.exit(1);
  });
  server.listen(PORT, host, () => log("start", `listening on http://${host.includes(":") ? `[${host}]` : host}:${PORT}/v1 (agent ${AGENT_MODEL}, mode ${TOOLS_MODE}/${TOOLS_SHAPE})`));
  return server;
});
if (HOSTS.some(h => !/^(127\.|localhost$|::1$)/.test(h)))
  log("warn", "listening beyond loopback: anyone who can reach this port can use your Venice session");

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log("stop", `${sig} received, shutting down`);
    for (const server of servers) server.close();
    client.close().catch(() => {}).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
