import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "vo-cfg-"));
process.env.VENICE_CONFIG_DIR = cfg;              // no venice-login.json here
delete process.env.VENICE_EMAIL; delete process.env.VENICE_PASSWORD;
const { VeniceWebClient } = await import("../src/client.mjs");

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (expInSec = 3600) => `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + expInSec })}.sig`;
const sessionText = (tag = "good") => JSON.stringify({ clerkJwt: jwt(), sessionId: "sess_" + tag, cookies: [], tag });

function setup({ withCreds = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vo-sess-"));
  const file = path.join(dir, "session.json");
  fs.writeFileSync(file, sessionText("good"), { mode: 0o600 });
  const c = new VeniceWebClient({ sessionFile: file });
  if (withCreds) { c.email = "a@b.c"; c.password = "pw"; }
  return { dir, file, c };
}
const backups = (dir) => fs.readdirSync(dir).filter(n => n.startsWith("session.json.bak"));
const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8);

test("transient transport errors keep the session (SendRequest, network unreachable, codes, 5xx)", async () => {
  const errs = [
    Object.assign(new Error("POST https://x: client error (SendRequest): client error (SendRequest)"), { name: "RequestError" }),
    new Error("network unreachable"),
    Object.assign(new Error("boom"), { code: "ECONNRESET" }),
    Object.assign(new Error("boom"), { cause: { code: "UND_ERR_SOCKET" } }),
    new Error("HTTP 503: upstream"), new Error("HTTP 429: slow down"),
    Object.assign(new Error("x"), { name: "AbortError" }),
  ];
  for (const e of errs) {
    const { file, c } = setup();
    const before = fs.readFileSync(file, "utf8");
    c.getUserSession = async () => { throw e; };
    await assert.rejects(c.ensureAuthenticated(), (x) => x === e);
    assert.equal(fs.readFileSync(file, "utf8"), before, `session changed on ${e.message}`);
    assert.equal(c.isAuthInvalid(e), false);
  }
});

test("unknown errors keep the session too", async () => {
  const { file, c } = setup();
  const e = new Error("something nobody has seen before");
  c.getUserSession = async () => { throw e; };
  await assert.rejects(c.ensureAuthenticated(), (x) => x === e);
  assert.ok(fs.existsSync(file));
});

test("401 with credentials: old session is backed up and replaced atomically by a fresh login", async () => {
  const { dir, file, c } = setup({ withCreds: true });
  const old = fs.readFileSync(file, "utf8");
  const fresh = jwt(7200);
  c.getUserSession = async (j) => { if (j !== fresh) throw new Error('HTTP 401: {"error":"Expired Clerk session"}'); return { ok: true }; };
  c.restoreSessionFromCookies = async () => { throw new Error("No active Clerk session found in saved browser cookies."); };
  c.login = async () => { c.clerkJwt = fresh; c.sessionId = "sess_new"; return { clerkJwt: fresh, sessionId: "sess_new" }; };
  const r = await c.ensureAuthenticated();
  assert.equal(r.source, "login");
  const now = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(now.sessionId, "sess_new");
  assert.ok(backups(dir).some(n => fs.readFileSync(path.join(dir, n), "utf8") === old), "old session not backed up");
  assert.equal(mode(file), "600");
  assert.ok(!fs.readdirSync(dir).some(n => n.includes(".tmp-")), "temp file left behind");
});

test("401 without credentials: file kept, one clear error, then no more network calls", async () => {
  const { file, c } = setup();
  const before = fs.readFileSync(file, "utf8");
  let calls = 0;
  c.getUserSession = async () => { calls++; throw new Error('HTTP 401: {"error":"Expired Clerk session"}'); };
  c.restoreSessionFromCookies = async () => { calls++; throw new Error("No active Clerk session found in saved browser cookies."); };
  await assert.rejects(c.ensureAuthenticated(), (e) => e.authInvalid && /run: venice-opencode login/.test(e.message) && !/Missing required credential/.test(e.message));
  assert.equal(fs.readFileSync(file, "utf8"), before);
  const seen = calls;
  await assert.rejects(c.ensureAuthenticated(), (e) => e.authInvalid && /run: venice-opencode login/.test(e.message));
  assert.equal(calls, seen, "backed-off call must not hit the network");
});

test("a second failure does not clobber the good backup", async () => {
  const { dir, file, c } = setup();
  const first = c.backupSession();
  assert.ok(first);
  const goodBackup = fs.readFileSync(first, "utf8");
  fs.writeFileSync(file, "{ not json");            // corrupt / bad state
  assert.equal(c.backupSession(), null);            // junk is never backed up
  fs.writeFileSync(file, JSON.stringify({ clerkJwt: "" }));
  assert.equal(c.backupSession(), null);
  assert.ok(backups(dir).some(n => fs.readFileSync(path.join(dir, n), "utf8") === goodBackup));
});

test("backups are timestamped, deduplicated, private and pruned to the newest 5", async () => {
  const { dir, file, c } = setup();
  const made = new Set();
  for (let i = 0; i < 8; i++) {
    fs.writeFileSync(file, sessionText("v" + i));
    const b = c.backupSession(); made.add(b);
    assert.equal(c.backupSession(), b, "identical content must not create another backup");
    await new Promise(r => setTimeout(r, 3));
  }
  const left = backups(dir);
  assert.equal(left.length, 5);
  for (const n of left) { assert.match(n, /^session\.json\.bak\.\d+$/); assert.equal(mode(path.join(dir, n)), "600"); }
  assert.ok(left.some(n => fs.readFileSync(path.join(dir, n), "utf8").includes('"v7"')));
});

test("missing session.json is restored from the newest valid backup on read", async () => {
  const { dir, file, c } = setup();
  c.backupSession();
  fs.unlinkSync(file);
  const snap = c.readSavedSession();
  assert.equal(snap.tag, "good");
  assert.ok(fs.existsSync(file));
  assert.equal(mode(file), "600");
  // legacy single-slot backup name is honoured as well
  fs.unlinkSync(file); for (const n of backups(dir)) fs.unlinkSync(path.join(dir, n));
  fs.writeFileSync(path.join(dir, "session.json.bak"), sessionText("legacy"));
  assert.equal(c.readSavedSession().tag, "legacy");
});

test("acceptance: transient failure with no credentials leaves session and backup intact, next call works", async () => {
  const { dir, file, c } = setup();
  c.backupSession();
  const before = fs.readFileSync(file, "utf8"), nb = backups(dir).length;
  let up = false;
  c.getUserSession = async () => { if (!up) throw Object.assign(new Error("client error (SendRequest)"), { name: "RequestError" }); return { ok: true }; };
  await assert.rejects(c.ensureAuthenticated(), /SendRequest/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(backups(dir).length, nb);
  up = true;
  const r = await c.ensureAuthenticated();
  assert.equal(r.source, "session");                // no re-login needed
});

test("no session and no credentials gives the single actionable error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vo-none-"));
  const c = new VeniceWebClient({ sessionFile: path.join(dir, "session.json") });
  await assert.rejects(c.ensureAuthenticated(), (e) => e.authInvalid && /run: venice-opencode login/.test(e.message) && !/Missing required credential/.test(e.message));
});
