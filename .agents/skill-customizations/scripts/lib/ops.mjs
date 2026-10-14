// Operazioni con effetti locali: git in sola lettura o su cloni temporanei (mai commit/push), staging,
// sostituzione per singola cartella con backup e rollback, link .claude/skills, verifica di caricamento Pi, report.
// Documentazione: docs/agents/skill-customizations.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "./core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, "..", "..", "..", "..");
export const EXIT = { OK: 0, ERROR: 1, HUMAN: 2, USAGE: 3 };

export class StopError extends Error {
  constructor(message, code = EXIT.ERROR, details = []) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Utilita'
// ---------------------------------------------------------------------------

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const isLink = (p) => exists(p) && fs.lstatSync(p).isSymbolicLink();
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const realpath = (p) => fs.realpathSync.native(p);
export const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");

/** rename con ritentativi: su Windows antivirus o editor possono bloccare brevemente i file. */
export function renameRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= 8 || !["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(error.code)) throw error;
      sleep(150 * attempt);
    }
  }
}

function assertInside(base, target) {
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`percorso inatteso fuori da ${base}: ${target}`);
}

/** Rimozione ricorsiva consentita solo dentro la cartella di lavoro .tmp/skills. */
function removeWorkPath(ctx, target) {
  assertInside(ctx.workDir, target);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// ---------------------------------------------------------------------------
// Git: solo sottocomandi di lettura o su cloni temporanei. Mai commit, add, push, reset o checkout nel repository.
// ---------------------------------------------------------------------------

export const GIT_ALLOWED = Object.freeze(["clone", "worktree", "rev-parse", "log", "ls-files", "check-ignore", "cat-file"]);

export function git(args, { cwd, allowFail = false } = {}) {
  if (!GIT_ALLOWED.includes(args[0])) throw new Error(`sottocomando git non consentito agli script: ${args[0]}`);
  if (args[0] === "worktree" && args[1] !== "add") throw new Error(`git worktree ${args[1]} non consentito agli script`);
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")} fallito (${result.status}): ${(result.stderr || "").trim().slice(0, 400)}`);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function gitUpstream(ctx, args, cloneDir) {
  assertInside(ctx.workDir, cloneDir);
  return git(args, { cwd: cloneDir });
}

const isGitRepo = (root) => git(["rev-parse", "--is-inside-work-tree"], { cwd: root, allowFail: true }).stdout.trim() === "true";

// ---------------------------------------------------------------------------
// Contesto e report
// ---------------------------------------------------------------------------

export function createContext({ root = DEFAULT_ROOT, command, quiet = false } = {}) {
  root = path.resolve(root);
  const layerDir = path.join(root, ".agents", "skill-customizations");
  if (!fs.existsSync(path.join(layerDir, "manifest.json"))) throw new StopError(`manifest non trovato: ${path.join(layerDir, "manifest.json")}`, EXIT.USAGE);
  const layer = core.loadLayer(layerDir);
  const manifest = layer.manifest;
  const ctx = {
    root,
    command,
    layer,
    manifest,
    layerDir,
    skillsDir: path.join(root, ...manifest.paths.skills.split("/")),
    lockPath: path.join(root, ...manifest.paths.lock.split("/")),
    manifestPath: path.join(layerDir, "manifest.json"),
    workDir: path.join(root, ".tmp", "skills"),
    upstreamUrl: process.env.SKILLS_UPSTREAM_URL || manifest.upstream.url,
    report: new Report(command, quiet),
  };
  // Pensata per i test con fixture: in uso reale registrerebbe hash di un altro remote sotto la sorgente del lock.
  if (process.env.SKILLS_UPSTREAM_URL && command !== "verify") ctx.report.warn(`SKILLS_UPSTREAM_URL impostata: upstream sostituito da ${process.env.SKILLS_UPSTREAM_URL} (solo per test)`);
  return ctx;
}

/** .tmp/ deve essere ignorata da Git prima di scriverci file di servizio (run, backup, report). */
export function tmpIgnored(ctx) {
  return !isGitRepo(ctx.root) || git(["check-ignore", "-q", ".tmp/skills/x"], { cwd: ctx.root, allowFail: true }).status === 0;
}

export class Report {
  constructor(command, quiet) {
    this.command = command;
    this.quiet = quiet;
    this.lines = [];
    this.counts = { OK: 0, WARN: 0, FAIL: 0, INFO: 0 };
    this.sections = [];
  }
  add(level, message) {
    this.counts[level]++;
    this.lines.push({ level, message });
    if (!this.quiet) process.stdout.write(`  ${level.padEnd(4)} ${message}\n`);
  }
  ok(m) { this.add("OK", m); }
  warn(m) { this.add("WARN", m); }
  fail(m) { this.add("FAIL", m); }
  info(m) { this.add("INFO", m); }
  title(m) {
    this.lines.push({ level: "TITLE", message: m });
    if (!this.quiet) process.stdout.write(`\n${m}\n`);
  }
  section(title, body) {
    this.sections.push({ title, body });
  }
  toMarkdown(extra = {}) {
    const out = [`# Report skills:${this.command}`, "", `- Data: ${new Date().toISOString()}`];
    for (const [k, v] of Object.entries(extra)) out.push(`- ${k}: ${v}`);
    out.push(`- Esito: ${this.counts.FAIL ? "FALLITO" : "OK"} (OK ${this.counts.OK}, WARN ${this.counts.WARN}, FAIL ${this.counts.FAIL})`, "");
    for (const { level, message } of this.lines) out.push(level === "TITLE" ? `\n## ${message}\n` : `- **${level}** ${message}`);
    for (const { title, body } of this.sections) out.push("", `## ${title}`, "", body);
    return out.join("\n") + "\n";
  }
}

export function writeReport(ctx, extra) {
  const dir = path.join(ctx.workDir, "reports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${timestamp()}-${ctx.command}.md`);
  const text = ctx.report.toMarkdown(extra);
  fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(dir, `latest-${ctx.command}.md`), text);
  return file;
}

// ---------------------------------------------------------------------------
// Stato locale
// ---------------------------------------------------------------------------

export function readLock(ctx) {
  if (!fs.existsSync(ctx.lockPath)) throw new StopError("skills-lock.json non trovato", EXIT.ERROR);
  const raw = fs.readFileSync(ctx.lockPath, "utf8");
  const { lock, errors } = core.parseLock(raw);
  if (!lock) throw new StopError(errors.join("; "), EXIT.ERROR);
  return { lock, raw };
}

export function refOf(ctx, entry) {
  return entry.ref ?? ctx.manifest.upstream.validatedRef;
}

/** Classifica ogni skill del lock: ok | missing | uncustomized | stale | modified | malformed | link. */
export function inspectInstalled(ctx, lock) {
  const result = {};
  for (const [skill, entry] of Object.entries(lock.skills)) {
    const dir = path.join(ctx.skillsDir, skill);
    if (isLink(dir)) {
      result[skill] = { status: "link", target: (() => { try { return realpath(dir); } catch { return "(rotto)"; } })() };
      continue;
    }
    const skipped = core.skippedEntries(dir);
    if (skipped.length) {
      result[skill] = { status: "unsupported", errors: [`contiene ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", ..." : ""}`] };
      continue;
    }
    result[skill] = core.classifySkill(core.readTree(dir), entry, skill, ctx.layer);
  }
  return result;
}

export const STATUS_HINT = {
  missing: "manca: esegui `npm run skills:install`",
  uncustomized: "personalizzazioni assenti (ad esempio dopo `npx skills update` o `add`): esegui `npm run skills:install`",
  stale: "personalizzazioni non allineate al manifest: esegui `npm run skills:install`",
  modified: "contenuto diverso dal lock (modifiche manuali o aggiornamento parziale): salva le modifiche utili, poi `npm run skills:install -- --discard-local-changes`",
  malformed: "marcatori di personalizzazione danneggiati: `npm run skills:install -- --discard-local-changes`",
  link: "la cartella e' un link: gli script non la sostituiscono",
  unsupported: "contiene link, junction, .git o node_modules che il backup non conserverebbe: gli script non la sostituiscono; sposta quei contenuti e riesegui",
};

// ---------------------------------------------------------------------------
// Upstream (clone temporaneo in .tmp/skills/run-*)
// ---------------------------------------------------------------------------

export function cloneUpstream(ctx, runDir) {
  const cloneDir = path.join(runDir, "upstream");
  assertInside(ctx.workDir, cloneDir);
  git(["clone", "--quiet", "--filter=blob:none", "--no-checkout", ctx.upstreamUrl, cloneDir], { cwd: runDir });
  const head = gitUpstream(ctx, ["rev-parse", "HEAD"], cloneDir).stdout.trim();
  return { cloneDir, head };
}

export function resolveRef(ctx, cloneDir, ref) {
  for (const candidate of [ref, `origin/${ref}`]) {
    const r = git(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { cwd: cloneDir, allowFail: true });
    if (r.status === 0) return r.stdout.trim();
  }
  return null;
}

/** Checkout (worktree) di un commit upstream: stesse conversioni di fine riga dell'installazione della CLI. */
export function checkoutRef(ctx, cloneDir, sha, runDir, cache) {
  if (cache.has(sha)) return cache.get(sha);
  const dir = path.join(runDir, `wt-${sha.slice(0, 12)}`);
  gitUpstream(ctx, ["worktree", "add", "--detach", "--quiet", dir, sha], cloneDir);
  cache.set(sha, dir);
  return dir;
}

const INSTALL_EXCLUDED = (rel) => rel.split("/").some((seg, i, all) => (i === all.length - 1 ? seg === "metadata.json" : seg === "__pycache__" || seg === "__pypackages__"));

/** Cartella di una skill in un checkout upstream; se il percorso del lock non esiste cerca per nome (spostamenti). */
export function upstreamSkill(worktree, skill, skillPath) {
  const dir = path.join(worktree, ...path.posix.dirname(skillPath).split("/"));
  if (fs.existsSync(path.join(dir, "SKILL.md"))) {
    const source = core.readTree(dir);
    // La CLI calcola computedHash sul sorgente ma non copia questi file: con file esclusi l'hash del lock non
    // sarebbe mai verificabile sulla copia installata. Meglio fermarsi che accettare o produrre falsi `modified`.
    const excluded = [...source.keys()].filter(INSTALL_EXCLUDED);
    if (excluded.length) throw new StopError(`${skill}: la skill upstream contiene file che l'installazione esclude (${excluded.join(", ")}): l'hash del lock non sarebbe verificabile. Serve una decisione (vedi docs/agents/skill-customizations.md)`, EXIT.HUMAN);
    return { tree: source, source, sourceHash: core.treeHash(source), skillPath };
  }
  const candidates = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "SKILL.md") {
        const text = fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n");
        if (new RegExp(`^name:\\s*["']?${skill}["']?\\s*$`, "m").test(text.split("\n---")[0])) candidates.push(path.relative(worktree, full).split(path.sep).join("/"));
      }
    }
  };
  walk(worktree);
  return { tree: null, candidates };
}

// ---------------------------------------------------------------------------
// Pi
// ---------------------------------------------------------------------------

function validPiPackage(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return pkg.name === "@earendil-works/pi-coding-agent" && fs.existsSync(path.join(dir, "dist", "index.js")) ? dir : null;
  } catch {
    return null;
  }
}

/** Trova l'SDK di Pi: PI_CODING_AGENT_PKG, poi lo shim `pi` nel PATH, poi le root globali di npm/pnpm. */
export function findPiPackage() {
  if (process.env.PI_CODING_AGENT_PKG) return validPiPackage(process.env.PI_CODING_AGENT_PKG);
  const marker = "@earendil-works/pi-coding-agent";
  const lookup = spawnSync(process.platform === "win32" ? "where" : "which", ["pi"], { encoding: "utf8", windowsHide: true });
  for (const shim of (lookup.stdout || "").split(/\r?\n/).filter(Boolean)) {
    let text = "";
    try {
      text = fs.readFileSync(shim, "utf8");
    } catch {
      continue;
    }
    const normalized = text.replace(/\\/g, "/");
    const abs = /cmd-shim-target=(.+)/.exec(normalized);
    const candidates = [];
    if (abs) candidates.push(abs[1].trim());
    for (const m of normalized.matchAll(/["']?([^"'\s]*@earendil-works\/pi-coding-agent)/g)) {
      candidates.push(m[1].replace(/^\$basedir(_abs|_win)?|^%~dp0|^%dp0%/, path.dirname(shim).replace(/\\/g, "/")));
    }
    for (const c of candidates) {
      const idx = c.indexOf(marker);
      if (idx < 0) continue;
      const dir = validPiPackage(path.resolve(path.dirname(shim), c.slice(0, idx + marker.length)));
      if (dir) return dir;
    }
  }
  for (const [cmd, args] of [["npm", ["root", "-g"]], ["pnpm", ["root", "-g"]]]) {
    const r = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32", windowsHide: true, timeout: 20000 });
    const groot = (r.stdout || "").trim();
    if (!groot) continue;
    const direct = validPiPackage(path.join(groot, marker));
    if (direct) return direct;
    try {
      for (const sub of fs.readdirSync(groot)) {
        const nested = validPiPackage(path.join(groot, sub, "node_modules", marker));
        if (nested) return nested;
      }
    } catch {}
  }
  return null;
}

export function runPiProbe(pkgDir, args) {
  const r = spawnSync(process.execPath, [path.join(HERE, "pi-probe.mjs"), pkgDir, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_OFFLINE: "1" },
  });
  if (r.status !== 0) throw new Error(`probe Pi fallito: ${(r.stderr || r.stdout || "").trim().slice(0, 400)}`);
  return JSON.parse(r.stdout);
}

/**
 * Verifica che Pi carichi ogni skill del lock dalla cartella di progetto, senza diagnostiche o collisioni.
 * mode 'project' = scoperta completa come all'avvio o dopo /reload; mode 'dir' = solo parsing (staging).
 */
export function checkPi(ctx, skills, { mode = "project", dir, agentDir } = {}) {
  if (process.env.SKILLS_NO_PI === "1") {
    ctx.report.warn("verifica Pi saltata (SKILLS_NO_PI=1)");
    return true;
  }
  const pkg = findPiPackage();
  if (!pkg) {
    ctx.report.warn("Pi non trovato (imposta PI_CODING_AGENT_PKG per indicarlo): verifica di caricamento Pi saltata");
    return true;
  }
  let data;
  try {
    data = mode === "dir" ? runPiProbe(pkg, ["dir", dir]) : runPiProbe(pkg, ["project", ctx.root, ...(agentDir ? [agentDir] : [])]);
  } catch (error) {
    ctx.report.fail(error.message);
    return false;
  }
  let ok = true;
  const base = mode === "dir" ? dir : ctx.skillsDir;
  for (const skill of skills) {
    const loaded = data.skills.filter((s) => s.name === skill);
    const expected = path.join(base, skill, "SKILL.md");
    const own = loaded.find((s) => {
      try {
        return samePath(realpath(s.filePath), realpath(expected));
      } catch {
        return false;
      }
    });
    if (!own) {
      ok = false;
      ctx.report.fail(`Pi: '${skill}' non caricata dalla cartella di progetto${loaded.length ? ` (usa ${loaded[0].filePath})` : ""}`);
    }
  }
  const relevant = data.diagnostics.filter((d) => skills.some((s) => (d.message || "").includes(`"${s}"`) || (d.path || "").includes(`${path.sep}${s}${path.sep}`) || (d.path || "").includes(`/${s}/`)));
  for (const d of relevant) {
    ok = false;
    ctx.report.fail(`Pi diagnostica ${d.type}: ${d.message} ${d.path ?? ""}`.trim());
  }
  if (ok) ctx.report.ok(`Pi ${data.version ?? ""}: ${skills.length} skill caricate dal progetto (${mode === "dir" ? "parsing staging" : "scoperta come all'avvio e dopo /reload"}), nessuna diagnostica`);
  return ok;
}

// ---------------------------------------------------------------------------
// Link (.claude/skills) e controlli Git/globali
// ---------------------------------------------------------------------------

export function ensureLinks(ctx, { create }) {
  let ok = true;
  for (const link of ctx.manifest.paths.links ?? []) {
    const p = path.join(ctx.root, ...link.path.split("/"));
    const target = path.join(ctx.root, ...link.target.split("/"));
    if (!exists(p)) {
      if (!create) {
        ctx.report.warn(`${link.path} assente (serve solo a Claude Code): \`npm run skills:install\` lo crea`);
        continue;
      }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (process.platform === "win32") fs.symlinkSync(target, p, "junction");
      else fs.symlinkSync(path.relative(path.dirname(p), target), p, "dir");
      ctx.report.ok(`${link.path} creato come link a ${link.target}`);
      continue;
    }
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) {
      let resolved = null;
      try {
        resolved = realpath(p);
      } catch {}
      if (resolved && samePath(resolved, realpath(target))) ctx.report.ok(`${link.path} -> ${link.target}`);
      else if (!resolved && create) {
        fs.unlinkSync(p);
        if (process.platform === "win32") fs.symlinkSync(target, p, "junction");
        else fs.symlinkSync(path.relative(path.dirname(p), target), p, "dir");
        ctx.report.ok(`${link.path}: link rotto ricreato`);
      } else {
        ok = false;
        ctx.report.fail(`${link.path} punta a ${resolved ?? "(destinazione inesistente)"} invece che a ${link.target}: non modificato`);
      }
    } else if (stat.isDirectory()) {
      if (create && fs.readdirSync(p).length === 0) {
        fs.rmdirSync(p);
        if (process.platform === "win32") fs.symlinkSync(target, p, "junction");
        else fs.symlinkSync(path.relative(path.dirname(p), target), p, "dir");
        ctx.report.ok(`${link.path}: cartella vuota sostituita da link`);
      } else {
        ctx.report.warn(`${link.path} e' una cartella reale, non un link: puo' divergere da ${link.target} (vedi docs/agents/skill-customizations.md)`);
      }
    } else {
      ok = false;
      ctx.report.fail(`${link.path} esiste ma non e' una cartella ne' un link`);
    }
  }
  return ok;
}

export function gitChecks(ctx, lock) {
  if (!isGitRepo(ctx.root)) {
    ctx.report.info("non e' un repository Git: controlli di versionamento saltati");
    return true;
  }
  let ok = true;
  const rel = (p) => path.relative(ctx.root, p).split(path.sep).join("/");
  if (git(["check-ignore", "-q", rel(ctx.manifestPath)], { cwd: ctx.root, allowFail: true }).status === 0) {
    ok = false;
    ctx.report.fail("il livello .agents/skill-customizations/ e' ignorato da Git: non sarebbe condiviso");
  }
  if (git(["ls-files", "--error-unmatch", rel(ctx.lockPath)], { cwd: ctx.root, allowFail: true }).status !== 0) ctx.report.warn("skills-lock.json non e' tracciato da Git");
  else ctx.report.ok("skills-lock.json tracciato da Git");
  const trackedCopies = git(["ls-files", "--", rel(ctx.skillsDir), ...(ctx.manifest.paths.links ?? []).map((l) => l.path)], { cwd: ctx.root }).stdout.split("\n").filter(Boolean);
  const lockSkills = new Set(Object.keys(lock.skills));
  const tracked = trackedCopies.filter((f) => lockSkills.has(f.split("/")[2]));
  if (tracked.length) ctx.report.info(`${tracked.length} file di copie scaricate ancora tracciati da Git (stato precedente alla migrazione)`);
  else {
    const notIgnored = [...lockSkills].filter((s) => git(["check-ignore", "-q", `${rel(ctx.skillsDir)}/${s}/SKILL.md`], { cwd: ctx.root, allowFail: true }).status !== 0);
    if (notIgnored.length) ctx.report.warn(`copie non tracciate e non ignorate (comparirebbero come untracked): ${notIgnored.join(", ")}`);
    else ctx.report.ok("copie scaricate non tracciate e ignorate da Git: si ricostruiscono dal lock");
  }
  return ok;
}

export function globalCollisions(ctx, lock) {
  const home = os.homedir();
  const dirs = [
    [path.join(home, ".codex", "skills"), "Codex"],
    [path.join(home, ".agents", "skills"), "agenti universali / Pi"],
    [path.join(home, ".claude", "skills"), "Claude Code"],
    [path.join(home, ".pi", "agent", "skills"), "Pi"],
  ];
  for (const [dir, agent] of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const clash = names.filter((n) => n in lock.skills);
    if (clash.length) ctx.report.warn(`skill globali omonime in ${dir} (${agent}): ${clash.join(", ")}. Possono prevalere sulle versioni personalizzate di progetto: non vengono modificate (vedi docs/agents/skill-customizations.md)`);
  }
}

// ---------------------------------------------------------------------------
// Verifica completa (sola lettura)
// ---------------------------------------------------------------------------

export function verifyAll(ctx, { pi = true, title = "Verifica" } = {}) {
  const r = ctx.report;
  r.title(title);
  let ok = true;
  const manifestErrors = core.validateManifest(ctx.layer);
  for (const e of manifestErrors) r.fail(`manifest: ${e}`);
  if (manifestErrors.length) ok = false;
  else r.ok("manifest e file di personalizzazione validi");
  let lockData;
  try {
    lockData = readLock(ctx);
  } catch (error) {
    r.fail(error.message);
    return false;
  }
  const { lock, raw } = lockData;
  const lockCheck = core.validateLock(lock, ctx.manifest, raw);
  for (const e of lockCheck.errors) r.fail(e);
  for (const w of lockCheck.warnings) r.warn(w);
  if (lockCheck.errors.length) ok = false;
  else r.ok(`skills-lock.json: ${Object.keys(lock.skills).length} skill, nessuna credenziale, solo voci di progetto da ${ctx.manifest.upstream.source}`);
  const refs = new Set(Object.values(lock.skills).map((e) => refOf(ctx, e)));
  if (refs.size > 1) r.warn(`il lock fissa piu' commit upstream: ${[...refs].map((x) => x.slice(0, 12)).join(", ")}`);
  if (ctx.manifest.upstream.validatedRef && !refs.has(ctx.manifest.upstream.validatedRef)) r.warn(`il lock non punta al commit su cui sono state verificate le personalizzazioni (${ctx.manifest.upstream.validatedRef.slice(0, 12)})`);
  if (isLink(ctx.skillsDir)) r.warn(`${ctx.manifest.paths.skills} e' un link: gli script sostituiscono solo le singole cartelle`);
  const state = inspectInstalled(ctx, lock);
  const okSkills = [];
  for (const [skill, info] of Object.entries(state)) {
    if (info.status !== "ok") {
      ok = false;
      r.fail(`${skill}: ${STATUS_HINT[info.status]}${info.errors?.length ? ` (${info.errors.join("; ")})` : ""}`);
      continue;
    }
    const errors = core.checkRenderedSkill(core.readTree(path.join(ctx.skillsDir, skill)), skill, ctx.layer);
    if (errors.length) {
      ok = false;
      for (const e of errors) r.fail(e);
    } else okSkills.push(skill);
  }
  if (okSkills.length) r.ok(`${okSkills.length}/${Object.keys(state).length} skill identiche a upstream@lock + personalizzazioni correnti, policy protette presenti`);
  try {
    const extra = fs.readdirSync(ctx.skillsDir).filter((n) => !(n in lock.skills));
    if (extra.length) r.info(`skill locali non gestite da questo meccanismo (lasciate invariate): ${extra.map((n) => (isLink(path.join(ctx.skillsDir, n)) ? `${n} (link)` : n)).join(", ")}`);
  } catch {}
  if (!ensureLinks(ctx, { create: false })) ok = false;
  if (!gitChecks(ctx, lock)) ok = false;
  globalCollisions(ctx, lock);
  if (pi && !checkPi(ctx, Object.keys(lock.skills))) ok = false;
  return ok;
}

// ---------------------------------------------------------------------------
// Esecuzione con staging, backup, swap per cartella e rollback
// ---------------------------------------------------------------------------

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/**
 * Un solo run per volta. Il lock contiene il PID: se il processo non esiste piu' (crash) o il lock ha piu' di 2 ore,
 * viene rimosso. La rimozione passa da un rename atomico e da un controllo del contenuto, cosi' due esecuzioni che
 * trovano lo stesso lock scaduto non partono entrambe.
 */
function acquireRunLock(ctx) {
  fs.mkdirSync(ctx.workDir, { recursive: true });
  const lockFile = path.join(ctx.workDir, "run.lock");
  let content = null;
  try {
    content = fs.readFileSync(lockFile, "utf8");
  } catch {}
  if (content !== null) {
    let age = 0;
    try {
      age = Date.now() - fs.statSync(lockFile).mtimeMs;
    } catch {}
    if (!pidAlive(Number(content.trim())) || age > 2 * 3600 * 1000) {
      const aside = `${lockFile}.stale-${process.pid}-${Date.now()}`;
      try {
        fs.renameSync(lockFile, aside);
        if (fs.readFileSync(aside, "utf8") === content) {
          fs.rmSync(aside, { force: true });
          ctx.report.warn(`rimosso run.lock di un'esecuzione terminata (PID ${content.trim() || "?"})`);
        } else if (!exists(lockFile)) renameRetry(aside, lockFile);
        else fs.rmSync(aside, { force: true });
      } catch {}
    }
  }
  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" });
  } catch {
    throw new StopError(`un'altra esecuzione e' in corso (${lockFile}, PID ${(() => { try { return fs.readFileSync(lockFile, "utf8").trim(); } catch { return "?"; } })()})`, EXIT.ERROR);
  }
  return () => fs.rmSync(lockFile, { force: true });
}

export function prepareRun(ctx) {
  if (!tmpIgnored(ctx)) throw new StopError(".tmp/ non risulta ignorata da Git: interrompo per non creare file di servizio versionabili", EXIT.ERROR);
  if (exists(ctx.skillsDir)) {
    // Se .agents/skills fosse un link, rename e scritture finirebbero fuori dal repository (ad esempio nel fork).
    const real = realpath(ctx.skillsDir);
    const rel = path.relative(realpath(ctx.root), real);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new StopError(`${ctx.manifest.paths.skills} punta fuori dal repository (${real}): interrompo senza modificare file`, EXIT.HUMAN);
  }
  const release = acquireRunLock(ctx);
  try {
    const runDir = path.join(ctx.workDir, `run-${timestamp()}-${process.pid}`);
    fs.mkdirSync(path.join(runDir, "project", ".agents", "skills"), { recursive: true });
    return { runDir, release, stagedDir: path.join(runDir, "project", ".agents", "skills") };
  } catch (error) {
    release();
    throw error;
  }
}

export function cleanupRun(ctx, run, { keep = false } = {}) {
  run.release();
  if (keep || !fs.existsSync(run.runDir)) return;
  try {
    removeWorkPath(ctx, run.runDir);
  } catch (error) {
    ctx.report.warn(`cartella temporanea non rimossa (${run.runDir}): ${error.message}`);
  }
}

function backup(ctx, skills, label) {
  let dir = path.join(ctx.workDir, "backups", `${timestamp()}-${label}`);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(ctx.workDir, "backups", `${timestamp()}-${label}-${n}`);
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
  for (const skill of skills) {
    const src = path.join(ctx.skillsDir, skill);
    if (exists(src) && !isLink(src)) core.writeTree(path.join(dir, "skills", skill), core.readTree(src));
  }
  if (fs.existsSync(ctx.lockPath)) fs.copyFileSync(ctx.lockPath, path.join(dir, "skills-lock.json"));
  fs.copyFileSync(ctx.manifestPath, path.join(dir, "manifest.json"));
  writeBackupInfo(dir, { created: new Date().toISOString(), command: ctx.command, skills, status: "pending" });
  return dir;
}

function writeBackupInfo(dir, info) {
  fs.writeFileSync(path.join(dir, "info.json"), JSON.stringify(info, null, 2) + "\n");
}

export function readBackupInfo(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "info.json"), "utf8"));
  } catch {
    return {};
  }
}

/** Backup utili per il ripristino: quelli di operazioni applicate (i vecchi senza stato contano come applicati). */
export function listBackups(ctx) {
  const base = path.join(ctx.workDir, "backups");
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .sort()
    .map((name) => ({ name, dir: path.join(base, name), info: readBackupInfo(path.join(base, name)) }));
}

/** Dopo un'operazione riuscita: tiene gli ultimi 10 backup, senza mai togliere quelli indicati in `protect`. */
function pruneBackups(ctx, protect) {
  const all = listBackups(ctx);
  const removable = all.filter((b) => !protect.some((p) => samePath(path.resolve(p), path.resolve(b.dir))));
  for (const old of removable.slice(0, Math.max(0, all.length - 10))) {
    try {
      removeWorkPath(ctx, old.dir);
    } catch (error) {
      ctx.report.warn(`backup non rimosso (${old.name}): ${error.message}`);
    }
  }
}

function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  renameRetry(tmp, file);
}

function testFault(point) {
  if (process.env.SKILLS_TEST_FAIL_AT === point) throw new Error(`errore simulato (SKILLS_TEST_FAIL_AT=${point})`);
}

/**
 * Sostituisce solo le cartelle delle skill indicate, poi lock e manifest. Qualsiasi errore, anche nella verifica
 * finale, ripristina cartelle, lock e manifest precedenti: non restano skill aggiornate a meta'.
 */
export function applyStaged(ctx, run, { skills, lockText, manifestText, label, finalCheck = "rollback", protectBackups = [] }) {
  const r = ctx.report;
  for (const skill of skills) {
    const active = path.join(ctx.skillsDir, skill);
    if (isLink(active)) throw new StopError(`${skill}: la cartella attiva e' un link, non la sostituisco: nessun file modificato`, EXIT.HUMAN);
    const skipped = core.skippedEntries(active);
    if (skipped.length) throw new StopError(`${skill}: ${STATUS_HINT.unsupported} (${skipped.slice(0, 5).join(", ")}): nessun file modificato`, EXIT.HUMAN);
  }
  const backupDir = backup(ctx, skills, label);
  r.info(`backup: ${path.relative(ctx.root, backupDir)}`);
  const oldDir = path.join(run.runDir, "old");
  const failedDir = path.join(run.runDir, "failed");
  fs.mkdirSync(oldDir, { recursive: true });
  // Ogni passo viene registrato prima di eseguirlo: il rollback sa sempre cosa annullare, anche dopo un doppio errore.
  const moves = [];
  const prevLock = fs.existsSync(ctx.lockPath) ? fs.readFileSync(ctx.lockPath) : null;
  const prevManifest = fs.readFileSync(ctx.manifestPath);
  const rollback = () => {
    const errors = [];
    for (const move of [...moves].reverse()) {
      const active = path.join(ctx.skillsDir, move.skill);
      const old = path.join(oldDir, move.skill);
      try {
        if (move.newIn && exists(active)) {
          fs.mkdirSync(failedDir, { recursive: true });
          renameRetry(active, path.join(failedDir, move.skill));
        }
        if (move.oldOut && exists(old) && !exists(active)) renameRetry(old, active);
        if (move.oldOut && !exists(active)) errors.push(`${move.skill}: cartella originale non ripristinata (resta in ${old})`);
      } catch (error) {
        errors.push(`${move.skill}: ${error.message}`);
      }
    }
    try {
      if (prevLock) writeFileAtomic(ctx.lockPath, prevLock);
    } catch (error) {
      errors.push(`lock: ${error.message}`);
    }
    try {
      writeFileAtomic(ctx.manifestPath, prevManifest);
    } catch (error) {
      errors.push(`manifest: ${error.message}`);
    }
    return errors;
  };
  let verified = false;
  try {
    fs.mkdirSync(ctx.skillsDir, { recursive: true });
    for (const skill of skills) {
      const active = path.join(ctx.skillsDir, skill);
      const staged = path.join(run.stagedDir, skill);
      const move = { skill, oldOut: false, newIn: false };
      moves.push(move);
      if (exists(active)) {
        renameRetry(active, path.join(oldDir, skill));
        move.oldOut = true;
      }
      testFault(`swap-${skill}`);
      renameRetry(staged, active);
      move.newIn = true;
      testFault("mid-swap");
    }
    testFault("after-swap");
    if (lockText !== null && lockText !== undefined) writeFileAtomic(ctx.lockPath, lockText);
    if (manifestText !== null && manifestText !== undefined) writeFileAtomic(ctx.manifestPath, manifestText);
    ctx.layer = core.loadLayer(ctx.layerDir);
    ctx.manifest = ctx.layer.manifest;
    ensureLinks(ctx, { create: true });
    testFault("post-verify");
    verified = verifyAll(ctx, { title: "Verifica finale" });
    if (!verified && finalCheck === "rollback") throw new Error("verifica finale non superata");
  } catch (error) {
    r.fail(`errore: ${error.message}. Rollback in corso`);
    const rbErrors = rollback();
    try {
      ctx.layer = core.loadLayer(ctx.layerDir);
      ctx.manifest = ctx.layer.manifest;
    } catch {}
    writeBackupInfo(backupDir, { ...readBackupInfo(backupDir), status: rbErrors.length ? "rollback-incomplete" : "rolled-back" });
    if (rbErrors.length) {
      for (const e of rbErrors) r.fail(`ROLLBACK INCOMPLETO: ${e}`);
      r.fail(`ripristina con \`npm run skills:restore -- --backup ${path.basename(backupDir)}\`; la cartella ${path.relative(ctx.root, run.runDir)} viene conservata`);
    } else {
      r.info(`rollback completato: ripristinate ${moves.filter((m) => m.oldOut || m.newIn).length} cartelle, lock e manifest (backup: ${path.relative(ctx.root, backupDir)})`);
    }
    throw new StopError(`operazione annullata: ${error.message}`, EXIT.ERROR);
  }
  writeBackupInfo(backupDir, { ...readBackupInfo(backupDir), status: "applied", verified });
  pruneBackups(ctx, [backupDir, ...protectBackups]);
  return { backupDir, verified };
}

/** Sostituisce il solo valore upstream.validatedRef senza riformattare il manifest. */
export function manifestWithValidatedRef(ctx, sha) {
  const text = fs.readFileSync(ctx.manifestPath, "utf8");
  const next = text.replace(/("validatedRef"\s*:\s*")[0-9a-f]*(")/, `$1${sha}$2`);
  if (next === text && ctx.manifest.upstream.validatedRef !== sha) throw new Error("campo upstream.validatedRef non trovato nel manifest");
  return next === text ? null : next;
}
