// Tiny terminal UI helpers: colors, steps, spinner, prompts. No dependencies.
import readline from "node:readline";

const tty = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const wrap = (open, close) => (s) => (tty ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
};

export const sym = {
  ok: c.green("✔"),
  fail: c.red("✘"),
  warn: c.yellow("!"),
  info: c.cyan("›"),
};

process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); });
export const out = (s = "") => process.stdout.write(s + "\n");
export const info = (s) => out(`  ${sym.info} ${s}`);
export const ok = (s) => out(`  ${sym.ok} ${s}`);
export const warn = (s) => out(`  ${sym.warn} ${c.yellow(s)}`);
export const fail = (s) => out(`  ${sym.fail} ${c.red(s)}`);
export const hint = (s) => out(`    ${c.dim(s)}`);

export function banner(title, subtitle = "") {
  out();
  out(`  ${c.bold(c.cyan("▲ venice-opencode"))}  ${c.bold(title)}`);
  if (subtitle) out(`  ${c.dim(subtitle)}`);
  out();
}

export function step(n, total, title) {
  out();
  out(`${c.bold(c.blue(`[${n}/${total}]`))} ${c.bold(title)}`);
}

export function box(lines, { color = c.cyan } = {}) {
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const width = Math.max(...lines.map((l) => strip(l).length));
  const bar = "─".repeat(width + 2);
  out(color(`  ╭${bar}╮`));
  for (const l of lines) out(color("  │ ") + l + " ".repeat(width - strip(l).length) + color(" │"));
  out(color(`  ╰${bar}╯`));
}

export function table(rows) {
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) out(`  ${c.dim(k.padEnd(w))}  ${v}`);
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Runs fn() behind a spinner. fn may return a string to show as the success detail.
export async function spin(label, fn) {
  if (!tty) {
    out(`  … ${label}`);
    try {
      const detail = await fn();
      ok(detail ? `${label} ${c.dim(detail)}` : label);
      return detail;
    } catch (e) {
      fail(label);
      throw e;
    }
  }
  let i = 0;
  const draw = () => process.stdout.write(`\r  ${c.cyan(FRAMES[i++ % FRAMES.length])} ${label}\x1b[K`);
  draw();
  const timer = setInterval(draw, 80);
  try {
    const detail = await fn();
    clearInterval(timer);
    process.stdout.write(`\r  ${sym.ok} ${label}${detail ? " " + c.dim(detail) : ""}\x1b[K\n`);
    return detail;
  } catch (e) {
    clearInterval(timer);
    process.stdout.write(`\r  ${sym.fail} ${label}\x1b[K\n`);
    throw e;
  }
}

export class Cancelled extends Error {}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve, reject) => {
    const mute = hidden && process.stdin.isTTY;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: mute });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
      rl.close();
    };
    if (mute) {
      const write = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (s) => (rl.muted ? (s.includes("\n") ? write(s) : null) : write(s));
    }
    rl.question(question, (answer) => {
      if (mute) process.stdout.write("\n");
      rl.muted = false;
      finish(resolve, answer.trim());
    });
    rl.muted = mute;
    rl.on("close", () => finish(resolve, "")); // Ctrl-D / end of input
    rl.on("SIGINT", () => finish(reject, new Cancelled("cancelled")));
  });
}

export const prompt = (label, def = "") =>
  ask(`  ${c.cyan("?")} ${label}${def ? c.dim(` (${def})`) : ""} `).then((a) => a || def);
export const secret = (label) => ask(`  ${c.cyan("?")} ${label} ${c.dim("(hidden)")} `, { hidden: true });

export async function confirm(label, def = true) {
  const a = (await ask(`  ${c.cyan("?")} ${label} ${c.dim(def ? "[Y/n]" : "[y/N]")} `)).toLowerCase();
  return a ? a.startsWith("y") : def;
}

export async function choose(label, options) {
  out(`  ${c.cyan("?")} ${label}`);
  options.forEach((o, i) => out(`    ${c.bold(String(i + 1))}) ${o}`));
  for (;;) {
    const a = await ask(`    ${c.dim("choice [1]:")} `);
    const n = a ? Number(a) : 1;
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
  }
}
