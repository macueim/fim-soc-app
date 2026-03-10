#!/usr/bin/env node
/**
 * File Integrity Monitoring (FIM) — Node.js
 * Zero external dependencies. Uses only Node built-ins.
 *
 * Usage:  node fim.js [pathToMonitor]
 *
 * Files produced (same directory as this script):
 *   baseline.txt   — SHA-256 hash|absolutePath per line
 *   monitoring.log — timestamped change events
 *  @author Macuei Mathiang
 *  @date 2026-03-09
 * 
 */

"use strict";

const fs       = require("fs");
const path     = require("path");
const crypto   = require("crypto");
const readline = require("readline");

// ── Config ───────────────────────────────────────────────────────────────────
const ROOT        = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, "CriticalFiles");
const BASELINE    = path.join(__dirname, "baseline_files/baseline.txt");
const MONITOR_LOG = path.join(__dirname, "monitor_logs/monitoring.log");

// ── ANSI colors (zero deps) ──────────────────────────────────────────────────
const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  cyan:    "\x1b[36m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  red:     "\x1b[31m",
  magenta: "\x1b[35m",
};
const color = (c, s) => `${c}${s}${C.reset}`;

// ── Helpers ──────────────────────────────────────────────────────────────────
function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function appendLog(msg) {
  fs.appendFileSync(MONITOR_LOG, msg + "\n");
}

function hashFile(filePath) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

/** Recursively collect all file paths under a directory */
function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    e.isDirectory() ? walk(full, out) : out.push(full);
  }
  return out;
}

// ── Option A — Collect new baseline ─────────────────────────────────────────
function collectBaseline() {
  if (!fs.existsSync(ROOT)) {
    console.error(color(C.red, `\n[ERROR] Folder not found: ${ROOT}`));
    process.exit(1);
  }

  console.log(color(C.cyan, `\nScanning: ${ROOT} …\n`));

  const files = walk(ROOT);
  if (!files.length) {
    console.log(color(C.yellow, "[WARN] No files found in target folder."));
  }

  const lines = [];
  for (const f of files) {
    const hash = hashFile(f);
    if (hash) {
      lines.push(`${hash}|${f}`);
      console.log(color(C.dim, `  + ${path.relative(ROOT, f)}`));
    }
  }

  fs.writeFileSync(BASELINE, lines.join("\n") + (lines.length ? "\n" : ""));

  console.log(color(C.green, `\n✔  Baseline saved  →  ${BASELINE}`));
  console.log(color(C.green, `   ${lines.length} file(s) recorded.\n`));
}

// ── Option B — Monitor using saved baseline ──────────────────────────────────
function startMonitoring() {
  if (!fs.existsSync(ROOT)) {
    console.error(color(C.red, `\n[ERROR] Folder not found: ${ROOT}`));
    process.exit(1);
  }
  if (!fs.existsSync(BASELINE)) {
    console.error(color(C.red, "\n[ERROR] baseline.txt not found — run option A first."));
    process.exit(1);
  }

  // Load baseline into Map  →  filePath: hash
  const baseline = new Map();
  for (const line of fs.readFileSync(BASELINE, "utf8").split("\n")) {
    const sep = line.indexOf("|");
    if (sep !== -1) baseline.set(line.slice(sep + 1), line.slice(0, sep));
  }

  console.log(color(C.cyan,  "\n──────────────────────────────────────────"));
  console.log(color(C.bold,  "  File Integrity Monitoring  ·  ACTIVE"));
  console.log(color(C.cyan,  "──────────────────────────────────────────"));
  console.log(` Target   : ${ROOT}`);
  console.log(` Tracking : ${baseline.size} file(s)`);
  console.log(` Log      : ${MONITOR_LOG}`);
  console.log(color(C.cyan,  " CTRL+C to stop"));
  console.log(color(C.cyan,  "──────────────────────────────────────────\n"));

  const watched = new Set();   // files we have an fs.watch handle on
  const timers  = new Map();   // debounce timers keyed by filePath

  function debounce(key, fn, ms = 200) {
    if (timers.has(key)) clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); fn(); }, ms));
  }

  // Per-file watcher — detects content changes via hash comparison
  function watchFile(filePath) {
    if (watched.has(filePath) || !fs.existsSync(filePath)) return;
    watched.add(filePath);
    try {
      fs.watch(filePath, () => {
        debounce(filePath, () => {
          const hash = hashFile(filePath);
          if (!hash) return;                          // disappeared, dir watcher handles it
          const saved = baseline.get(filePath);
          if (saved === undefined) return;            // brand-new file, already reported
          if (hash !== saved) {
            const msg = `[${now()}] CHANGED  : ${filePath}`;
            console.log(color(C.yellow, msg));
            appendLog(msg);
            baseline.set(filePath, hash);             // update in-memory baseline
          }
        });
      });
    } catch { /* file gone before watch attached */ }
  }

  // Directory watcher — detects create / delete / rename
  function watchDir(dir) {
    try {
      fs.watch(dir, { recursive: true }, (event, filename) => {
        if (!filename) return;
        const full = path.join(dir, filename);

        debounce("dir:" + full, () => {
          const exists = fs.existsSync(full);
          const isFile = exists && fs.statSync(full).isFile();

          if (isFile && !watched.has(full)) {
            // ── CREATED ────────────────────────────────────────────────
            const hash = hashFile(full);
            const msg  = `[${now()}] CREATED  : ${full}`;
            console.log(color(C.green, msg));
            appendLog(msg);
            if (hash) baseline.set(full, hash);
            watchFile(full);

          } else if (!exists && (watched.has(full) || baseline.has(full))) {
            // ── DELETED ────────────────────────────────────────────────
            const msg = `[${now()}] DELETED  : ${full}`;
            console.log(color(C.red, msg));
            appendLog(msg);
            baseline.delete(full);
            watched.delete(full);
          }
        });
      });
    } catch (err) {
      console.error(color(C.red, `[ERROR] Cannot watch: ${dir} — ${err.message}`));
    }
  }

  // Attach watchers
  for (const [filePath] of baseline) watchFile(filePath);
  watchDir(ROOT);

  // Graceful shutdown
  process.on("SIGINT", () => {
    const msg = `[${now()}] MONITORING STOPPED`;
    console.log("\n" + color(C.magenta, msg));
    appendLog(msg);
    process.exit(0);
  });
}

// ── Main menu ────────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log(color(C.bold, "\n╔═══════════════════════════════════════╗"));
console.log(color(C.bold, "║   File Integrity Monitor  —  Node.js  ║"));
console.log(color(C.bold, "╚═══════════════════════════════════════╝\n"));
console.log(`  ${color(C.green,  "A)")}  Collect a new baseline`);
console.log(`  ${color(C.cyan,   "B)")}  Start monitoring using saved baseline`);
console.log();

rl.question("  Select an option [A / B]: ", answer => {
  rl.close();
  switch (answer.trim().toUpperCase()) {
    case "A": collectBaseline();  break;
    case "B": startMonitoring();  break;
    default:
      console.log(color(C.red, "\n[ERROR] Invalid option — enter A or B.\n"));
      process.exit(1);
  }
});
