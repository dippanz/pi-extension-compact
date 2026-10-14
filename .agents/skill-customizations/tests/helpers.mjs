// Utilita' per i test: fixture upstream Git locale, progetto temporaneo isolato, esecuzione degli script.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LAYER_DIR = path.resolve(HERE, "..");
export const REPO_ROOT = path.resolve(LAYER_DIR, "..", "..");
export const SCRIPT = path.join(LAYER_DIR, "scripts", "skills.mjs");

export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Ambiente isolato: HOME temporanea, telemetria disattivata, nessun prompt Git. */
export function isolatedEnv(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    ...extra,
  };
}

/** git per le sole fixture (cartelle temporanee): qui i commit sono ammessi perche' simulano l'upstream. */
export function fixtureGit(cwd, args, env) {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

export function writeFiles(base, files) {
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(base, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
}

/** Esegue skills.mjs su un progetto fixture. stdin chiuso. */
export function runSkills(args, { env, cwd } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: cwd ?? REPO_ROOT, env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 300000 });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

/** Impronta di tutti i file del progetto (esclusa .tmp/): per verificare che nulla sia cambiato. */
export function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (rel === ".tmp") continue;
      if (entry.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(full)}`;
      else if (entry.isDirectory()) walk(full);
      else out[rel] = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    }
  };
  walk(root);
  return out;
}

export function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
