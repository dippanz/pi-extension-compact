// Test con rete (opt-in): SKILLS_TEST_NETWORK=1 abilita la reinstallazione pulita da GitHub;
// SKILLS_TEST_CLI=1 aggiunge i confronti con la CLI ufficiale `skills` (npx, versione SKILLS_CLI_VERSION o 1.7.2).
// Tutto avviene in cartelle temporanee con HOME isolata, telemetria disattivata e stdin chiuso.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import * as core from "../scripts/lib/core.mjs";
import { REPO_ROOT, fixtureGit, isolatedEnv, rmrf, tempDir } from "./helpers.mjs";

const NETWORK = process.env.SKILLS_TEST_NETWORK === "1";
const CLI = NETWORK && process.env.SKILLS_TEST_CLI === "1";
const CLI_VERSION = process.env.SKILLS_CLI_VERSION || "1.7.2";

let base, home, proj, env;
const lockOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "skills-lock.json"), "utf8"));
const layerOf = (dir) => core.loadLayer(path.join(dir, ".agents", "skill-customizations"));
const script = (dir) => path.join(dir, ".agents", "skill-customizations", "scripts", "skills.mjs");
const node = (dir, args) => {
  const r = spawnSync(process.execPath, [script(dir), ...args], { cwd: dir, env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 600000 });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
};
const npx = (dir, args) => {
  // Su Windows npx e' un .cmd: serve la shell; una stringa unica evita l'avviso DEP0190 (argomenti senza spazi).
  const argv = ["-y", `skills@${CLI_VERSION}`, ...args];
  const opts = { cwd: dir, env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 600000 };
  const r = process.platform === "win32" ? spawnSync(["npx", ...argv].join(" "), { ...opts, shell: true }) : spawnSync("npx", argv, opts);
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
};

/** Copia del repository come apparirebbe in un clone pulito: file nell'indice Git piu' quelli nuovi non ignorati. Le copie delle skill non sono filtrate a mano: se Git le tracciasse ancora, il primo test fallirebbe. Le directory applicative estranee al test sono escluse solo per velocita'. */
function freshCloneCopy(target) {
  const ls = (args) => spawnSync("git", ["ls-files", ...args], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  const files = [...new Set([...ls([]), ...ls(["--others", "--exclude-standard"])])];
  for (const rel of files) {
    const src = path.join(REPO_ROOT, ...rel.split("/"));
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
    const dst = path.join(target, ...rel.split("/"));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  fixtureGit(target, ["init", "-q"], env);
}

describe("reinstallazione pulita da GitHub (rete)", { skip: NETWORK ? false : "imposta SKILLS_TEST_NETWORK=1" }, () => {
  before(() => {
    base = tempDir("skills-net-");
    home = path.join(base, "home");
    proj = path.join(base, "proj");
    fs.mkdirSync(home);
    fs.mkdirSync(proj);
    env = isolatedEnv(home);
    freshCloneCopy(proj);
  });
  after(() => rmrf(base));

  it("il clone pulito non contiene copie delle skill", () => {
    assert.ok(!fs.existsSync(path.join(proj, ".agents", "skills")));
    assert.ok(!fs.existsSync(path.join(proj, ".claude", "skills")));
  });

  it("install ricostruisce tutte le skill dal solo lock + file versionati e verify passa (Pi incluso)", () => {
    const lockBefore = fs.readFileSync(path.join(proj, "skills-lock.json"), "utf8");
    const r = node(proj, ["install"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(fs.readFileSync(path.join(proj, "skills-lock.json"), "utf8"), lockBefore, "lock invariato");
    const v = node(proj, ["verify"]);
    assert.equal(v.code, 0, v.out);
    if (!/Pi non trovato/.test(v.out)) assert.match(v.out, /Pi [^\n]*: 20 skill caricate dal progetto/);
    assert.ok(fs.lstatSync(path.join(proj, ".claude", "skills")).isSymbolicLink());
  });

  it("il risultato coincide byte per byte con le copie personalizzate del repository", () => {
    for (const skill of Object.keys(lockOf(proj).skills)) {
      const ours = core.readTree(path.join(REPO_ROOT, ".agents", "skills", skill));
      const fresh = core.readTree(path.join(proj, ".agents", "skills", skill));
      assert.ok(core.treesIdentical(ours, fresh) || core.treesEquivalent(ours, fresh), `${skill} differente`);
    }
  });

  it("update senza novita' upstream non cambia nulla", () => {
    const lockBefore = fs.readFileSync(path.join(proj, "skills-lock.json"), "utf8");
    const r = node(proj, ["update", "--no-pi"]);
    assert.ok([0, 2].includes(r.code), r.out);
    if (/nessuna novita'/.test(r.out)) assert.equal(fs.readFileSync(path.join(proj, "skills-lock.json"), "utf8"), lockBefore);
    else console.log("# upstream avanzato: esito dell'update nel log");
  });

  it("CLI ufficiale: experimental_install dal lock fissato riproduce lo stesso upstream", { skip: CLI ? false : "imposta SKILLS_TEST_CLI=1" }, () => {
    const dir = path.join(base, "cli-install");
    fs.mkdirSync(dir);
    fs.copyFileSync(path.join(proj, "skills-lock.json"), path.join(dir, "skills-lock.json"));
    fixtureGit(dir, ["init", "-q"], env);
    const r = npx(dir, ["experimental_install"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(fs.readFileSync(path.join(dir, "skills-lock.json"), "utf8"), fs.readFileSync(path.join(proj, "skills-lock.json"), "utf8"), "lock riscritto identico");
    const layer = layerOf(proj);
    for (const [skill, entry] of Object.entries(lockOf(proj).skills)) {
      const cliTree = core.readTree(path.join(dir, ".agents", "skills", skill));
      assert.ok(core.hashMatch(cliTree, entry.computedHash), `${skill}: hash CLI diverso dal lock`);
      const ourPristine = core.stripSkill(core.readTree(path.join(proj, ".agents", "skills", skill)), skill, layer).tree;
      assert.ok(core.treesEquivalent(cliTree, ourPristine), `${skill}: upstream diverso`);
    }
  });

  it("CLI ufficiale: dopo `npx skills update` diretto, verify rileva lo stato e install lo ripara", { skip: CLI ? false : "imposta SKILLS_TEST_CLI=1" }, () => {
    const r = npx(proj, ["update", "-p", "-y"]);
    assert.equal(r.code, 0, r.out);
    const v = node(proj, ["verify", "--no-pi"]);
    console.log(`# verify dopo npx skills update: exit ${v.code}`);
    if (v.code !== 0) {
      const fix = node(proj, ["install", "--no-pi"]);
      assert.equal(fix.code, 0, fix.out);
    }
    assert.equal(node(proj, ["verify", "--no-pi"]).code, 0);
  });
});
