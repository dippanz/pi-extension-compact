// Scenari di install/update/verify/restore su fixture sintetiche (upstream Git locale, progetto temporaneo).
// Nessun accesso alla rete, nessuna modifica fuori dalle cartelle temporanee.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import * as core from "../scripts/lib/core.mjs";
import { fixtureGit, isolatedEnv, rmrf, runSkills, snapshot, tempDir, writeFiles } from "./helpers.mjs";

const SKILL = (name, body) => `---\nname: ${name}\ndescription: Fixture skill ${name} for the update engine tests.\n---\n\n# ${name}\n\n${body}\n`;
const UPSTREAM_A = {
  "skills/engineering/alpha/SKILL.md": SKILL("alpha", "Do the work step by step.\n\nCommit your work.\n\nReport back."),
  "skills/engineering/alpha/agents/openai.yaml": "policy:\n  allow_implicit_invocation: true\n",
  "skills/engineering/beta/SKILL.md": SKILL("beta", "## Steps\n\n1. Read the input.\n2. Write the output."),
  "skills/productivity/gamma/SKILL.md": SKILL("gamma", "Ask one question at a time."),
  "skills/engineering/unrelated/SKILL.md": SKILL("unrelated", "Not in the lock."),
};
const LAYER = {
  "manifest.json": null,
  "policies/regola.md": "**REGOLA COMUNE** di prova: nessun commit senza autorizzazione.\n",
  "overrides/alpha.md": "Regola specifica alpha.\n",
  "overrides/alpha.no-commit.md": "NON COMMITTARE (regola locale).\n",
};
const manifest = (validatedRef) => ({
  version: 1,
  description: "fixture",
  upstream: { source: "fixture/skills", sourceType: "github", url: "https://invalid.example/fixture.git", validatedRef },
  paths: { skills: ".agents/skills", lock: "skills-lock.json", links: [{ path: ".claude/skills", target: ".agents/skills" }] },
  policies: { regola: { file: "policies/regola.md", requiredText: ["REGOLA COMUNE"] } },
  sentinels: ["\\bcommit", "\\bpush"],
  commonParts: ["policy:regola"],
  skills: {
    alpha: {
      customizations: [
        { id: "top", op: "insert", after: "frontmatter", parts: ["common", "file:overrides/alpha.md"] },
        { id: "no-commit", op: "replace", line: "Commit your work.", parts: ["file:overrides/alpha.no-commit.md"] },
      ],
      protect: [{ policy: "no-auto-commit", requiredText: ["NON COMMITTARE"], forbiddenText: ["Commit your work."] }],
    },
    beta: { customizations: [{ id: "top", op: "insert", afterLine: "## Steps", parts: ["common"] }] },
    gamma: { customizations: [] },
  },
});

let base, home, upstream, proj, env, shaA;
const lockFile = () => path.join(proj, "skills-lock.json");
const readLock = () => JSON.parse(fs.readFileSync(lockFile(), "utf8"));
const skillText = (s) => fs.readFileSync(path.join(proj, ".agents", "skills", s, "SKILL.md"), "utf8");
const upstreamCommit = (files, message) => {
  writeFiles(upstream, files);
  fixtureGit(upstream, ["add", "-A"], env);
  fixtureGit(upstream, ["commit", "-q", "-m", message], env);
  return fixtureGit(upstream, ["rev-parse", "HEAD"], env);
};
const run = (...args) => runSkills([...args, "--root", proj, "--no-pi"], { env });

before(() => {
  base = tempDir("skills-engine-");
  home = path.join(base, "home");
  upstream = path.join(base, "upstream");
  proj = path.join(base, "proj");
  fs.mkdirSync(home);
  env = isolatedEnv(home, { SKILLS_UPSTREAM_URL: upstream });
  fs.mkdirSync(upstream);
  fixtureGit(upstream, ["init", "-q", "-b", "main"], env);
  shaA = upstreamCommit(UPSTREAM_A, "A");
  const files = { ...LAYER, "manifest.json": JSON.stringify(manifest(shaA), null, 2) + "\n" };
  writeFiles(path.join(proj, ".agents", "skill-customizations"), files);
  const lock = { version: 1, skills: {} };
  for (const [name, dir] of [["alpha", "engineering"], ["beta", "engineering"], ["gamma", "productivity"]]) {
    const tree = core.readTree(path.join(upstream, "skills", dir, name));
    lock.skills[name] = { source: "fixture/skills", ref: shaA, sourceType: "github", skillPath: `skills/${dir}/${name}/SKILL.md`, computedHash: core.treeHash(tree, "lf") };
  }
  fs.writeFileSync(lockFile(), core.serializeLock(lock));
});

after(() => rmrf(base));

describe("motore di aggiornamento (fixture)", () => {
  it("verify su installazione vuota fallisce e indica install", () => {
    const r = run("verify");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /alpha: manca: esegui `npm run skills:install`/);
  });

  it("installazione pulita dal lock: ripristina le skill mancanti senza toccare il lock", () => {
    const lockBefore = fs.readFileSync(lockFile(), "utf8");
    const r = run("install");
    assert.equal(r.code, 0, r.out);
    assert.equal(fs.readFileSync(lockFile(), "utf8"), lockBefore, "il lock non deve cambiare durante install");
    assert.match(skillText("alpha"), /REGOLA COMUNE/);
    assert.match(skillText("alpha"), /NON COMMITTARE/);
    assert.doesNotMatch(skillText("alpha"), /^Commit your work\.$/m);
    assert.equal(skillText("gamma").replace(/\r\n/g, "\n"), UPSTREAM_A["skills/productivity/gamma/SKILL.md"], "skill senza personalizzazioni identica a upstream");
    assert.ok(!fs.existsSync(path.join(proj, ".agents", "skills", "unrelated")), "solo le skill del lock");
    const link = path.join(proj, ".claude", "skills");
    assert.ok(fs.lstatSync(link).isSymbolicLink(), ".claude/skills deve essere un link (junction su Windows)");
    assert.equal(fs.realpathSync.native(link).toLowerCase(), fs.realpathSync.native(path.join(proj, ".agents", "skills")).toLowerCase());
    assert.equal(run("verify").code, 0);
  });

  it("Pi carica le skill installate (scoperta come all'avvio e dopo /reload)", () => {
    const r = runSkills(["verify", "--root", proj], { env });
    if (/Pi non trovato/.test(r.out)) return void console.log("# Pi non installato: controllo saltato");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /OK {3}Pi [^\n]*: 3 skill caricate dal progetto/);
  });

  it("seconda esecuzione idempotente: nessuna duplicazione dei blocchi", () => {
    const before = snapshot(proj);
    const r = run("install");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /nulla da installare/);
    assert.deepEqual(snapshot(proj), before);
    assert.equal(skillText("alpha").split("skill-customization:begin alpha/top").length - 1, 1);
  });

  it("patch gia' applicata: il rendering di un testo gia' personalizzato si rifiuta invece di duplicare", () => {
    const layer = core.loadLayer(path.join(proj, ".agents", "skill-customizations"));
    const installed = core.readTree(path.join(proj, ".agents", "skills", "alpha"));
    const again = core.renderSkill(installed, "alpha", layer);
    assert.equal(again.tree, null);
    assert.match(again.errors.join("\n"), /contiene gia' marcatori/);
    const lock = readLock();
    assert.equal(core.classifySkill(installed, lock.skills.alpha, "alpha", layer).status, "ok");
  });

  it("nessuna novita' upstream: update non modifica nulla", () => {
    const before = snapshot(proj);
    const r = run("update");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /nessuna novita' upstream/);
    assert.deepEqual(snapshot(proj), before);
  });

  it("modifiche upstream compatibili: aggiorna, riapplica e fissa il nuovo commit", () => {
    const hashAlpha = readLock().skills.alpha.computedHash;
    const shaB = upstreamCommit({ "skills/engineering/beta/SKILL.md": SKILL("beta", "## Steps\n\n1. Read the input carefully.\n2. Write the output.\n3. Re-read it.") }, "B: beta wording");
    const r = run("update");
    assert.equal(r.code, 0, r.out);
    const lock = readLock();
    assert.ok(Object.values(lock.skills).every((e) => e.ref === shaB), "tutte le voci fissate al nuovo commit");
    assert.equal(lock.skills.alpha.computedHash, hashAlpha, "hash invariato per skill non cambiate");
    assert.match(skillText("beta"), /Re-read it\./);
    assert.match(skillText("beta"), /REGOLA COMUNE/);
    const m = JSON.parse(fs.readFileSync(path.join(proj, ".agents", "skill-customizations", "manifest.json"), "utf8"));
    assert.equal(m.upstream.validatedRef, shaB);
    assert.equal(run("verify").code, 0);
    const second = run("update");
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /nessuna novita' upstream/, "seconda esecuzione idempotente");
  });

  it("aggiornamento in conflitto con una policy: stop sicuro, poi accettazione esplicita", () => {
    upstreamCommit({ "skills/productivity/gamma/SKILL.md": SKILL("gamma", "Ask one question at a time.\n\nWhen done, push the branch.") }, "C: gamma push");
    const before = snapshot(proj);
    const r = run("update");
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /righe sensibili/);
    assert.match(r.out, /gamma\/SKILL\.md \(aggiunta\): When done, push the branch\./);
    assert.deepEqual(snapshot(proj), before, "nessun file modificato");
    const accepted = run("update", "--accept-policy-changes");
    assert.equal(accepted.code, 0, accepted.out);
    assert.match(skillText("gamma"), /push the branch/);
  });

  it("patch incompatibile: la riga sostituita cambia upstream e l'update si ferma", () => {
    upstreamCommit({ "skills/engineering/alpha/SKILL.md": SKILL("alpha", "Do the work step by step.\n\nCommit your work and push it.\n\nReport back.") }, "D: alpha commit+push");
    const before = snapshot(proj);
    const r = run("update", "--accept-policy-changes");
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /patch incompatibile: alpha\/no-commit: riga da sostituire non trovata/);
    assert.deepEqual(snapshot(proj), before, "nessun file modificato anche con --accept-policy-changes");
    upstreamCommit({ "skills/engineering/alpha/SKILL.md": UPSTREAM_A["skills/engineering/alpha/SKILL.md"] }, "D2: revert alpha");
  });

  for (const point of ["mid-swap", "after-swap", "post-verify"]) {
    it(`rollback dopo errore durante l'aggiornamento (${point})`, () => {
      upstreamCommit({ "skills/engineering/beta/SKILL.md": SKILL("beta", `## Steps\n\n1. Read the input.\n2. Write the output (${point}).`) }, `E: beta ${point}`);
      const before = snapshot(proj);
      const r = runSkills(["update", "--root", proj, "--no-pi"], { env: { ...env, SKILLS_TEST_FAIL_AT: point } });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /rollback completato/);
      assert.deepEqual(snapshot(proj), before, "stato identico a prima dell'aggiornamento");
      assert.equal(run("verify").code, 0);
    });
  }

  it("verify rileva copie senza personalizzazioni (es. dopo `npx skills update`) e install le ripara", () => {
    assert.equal(run("update").code, 0);
    const layer = core.loadLayer(path.join(proj, ".agents", "skill-customizations"));
    const dir = path.join(proj, ".agents", "skills", "alpha");
    const pristine = core.stripSkill(core.readTree(dir), "alpha", layer).tree;
    rmrf(dir);
    core.writeTree(dir, pristine);
    const v = run("verify");
    assert.equal(v.code, 1);
    assert.match(v.out, /alpha: personalizzazioni assenti/);
    const r = run("install");
    assert.equal(r.code, 0, r.out);
    assert.match(skillText("alpha"), /NON COMMITTARE/);
  });

  it("modifiche manuali alle copie: install si ferma, poi le scarta solo su richiesta con backup", () => {
    const file = path.join(proj, ".agents", "skills", "beta", "SKILL.md");
    fs.appendFileSync(file, "\nNota aggiunta a mano.\n");
    const v = run("verify");
    assert.equal(v.code, 1);
    assert.match(v.out, /beta: contenuto diverso dal lock/);
    const before = snapshot(proj);
    const r = run("install");
    assert.equal(r.code, 2, r.out);
    assert.deepEqual(snapshot(proj), before);
    const forced = run("install", "--discard-local-changes");
    assert.equal(forced.code, 0, forced.out);
    assert.doesNotMatch(skillText("beta"), /Nota aggiunta a mano/);
    const backups = fs.readdirSync(path.join(proj, ".tmp", "skills", "backups")).sort();
    const last = path.join(proj, ".tmp", "skills", "backups", backups[backups.length - 1], "skills", "beta", "SKILL.md");
    assert.match(fs.readFileSync(last, "utf8"), /Nota aggiunta a mano/);
  });

  it("restore ripristina l'ultimo backup (cartelle, lock e manifest)", () => {
    const lockBefore = fs.readFileSync(lockFile(), "utf8");
    upstreamCommit({ "skills/engineering/beta/SKILL.md": SKILL("beta", "## Steps\n\n1. Read.\n2. Write.\n3. Restore test.") }, "F: beta restore");
    assert.equal(run("update").code, 0);
    assert.notEqual(fs.readFileSync(lockFile(), "utf8"), lockBefore);
    const r = run("restore");
    assert.equal(r.code, 0, r.out);
    assert.equal(fs.readFileSync(lockFile(), "utf8"), lockBefore);
    assert.doesNotMatch(skillText("beta"), /Restore test/);
  });

  it("lock non valido: credenziali o voci estranee bloccano install", () => {
    const original = fs.readFileSync(lockFile(), "utf8");
    try {
      const lock = JSON.parse(original);
      const fakeCredential = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
      lock.skills.alpha.sourceUrl = `https://user:${fakeCredential}@github.com/x/y.git`;
      fs.writeFileSync(lockFile(), core.serializeLock(lock));
      const r = run("install");
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /credenziale/);
      delete lock.skills.alpha.sourceUrl;
      lock.skills.extra = { ...lock.skills.alpha, skillPath: "skills/engineering/unrelated/SKILL.md" };
      fs.writeFileSync(lockFile(), core.serializeLock(lock));
      const r2 = run("verify");
      assert.equal(r2.code, 1);
      assert.match(r2.out, /'extra' presente nel lock ma non nel manifest/);
    } finally {
      fs.writeFileSync(lockFile(), original);
    }
  });
});

// Scenari aggiunti dopo la review indipendente: ognuno riporta fixture e progetto allo stato iniziale.
const manifestFile = () => path.join(proj, ".agents", "skill-customizations", "manifest.json");
const backupsDir = () => path.join(proj, ".tmp", "skills", "backups");
const listBackupNames = () => (fs.existsSync(backupsDir()) ? fs.readdirSync(backupsDir()).sort() : []);

describe("motore di aggiornamento: casi limite (fixture)", () => {
  it("patch incompatibile corretta nel manifest: l'update riparte senza --discard-local-changes", () => {
    const originalManifest = fs.readFileSync(manifestFile(), "utf8");
    assert.equal(run("update", "--accept-policy-changes").code, 0);
    upstreamCommit({ "skills/engineering/alpha/SKILL.md": SKILL("alpha", "Do the work step by step.\n\nCommit your work and push it.\n\nReport back.") }, "G: alpha riga cambiata");
    const stop = run("update", "--accept-policy-changes");
    assert.equal(stop.code, 2, stop.out);
    assert.match(stop.out, /riga da sostituire non trovata/);
    try {
      fs.writeFileSync(manifestFile(), originalManifest.replace('"line": "Commit your work."', '"line": "Commit your work and push it."'));
      const fixed = run("update", "--accept-policy-changes");
      assert.equal(fixed.code, 0, fixed.out);
      assert.doesNotMatch(fixed.out, /contenuto diverso dal lock/);
      assert.match(skillText("alpha"), /NON COMMITTARE/);
      assert.equal(run("verify").code, 0);
    } finally {
      upstreamCommit({ "skills/engineering/alpha/SKILL.md": UPSTREAM_A["skills/engineering/alpha/SKILL.md"] }, "G2: revert alpha");
      fs.writeFileSync(manifestFile(), originalManifest.replace(/("validatedRef"\s*:\s*")[0-9a-f]*/, `$1${JSON.parse(fs.readFileSync(manifestFile(), "utf8")).upstream.validatedRef}`));
    }
    const back = run("update", "--accept-policy-changes");
    assert.equal(back.code, 0, back.out);
    assert.equal(run("verify").code, 0);
  });

  it("errore tra l'uscita della vecchia cartella e l'ingresso della nuova: rollback completo", () => {
    upstreamCommit({ "skills/engineering/beta/SKILL.md": SKILL("beta", "## Steps\n\n1. Read the input.\n2. Write the output (swap).") }, "H: beta swap");
    const before = snapshot(proj);
    const r = runSkills(["update", "--root", proj, "--no-pi"], { env: { ...env, SKILLS_TEST_FAIL_AT: "swap-beta" } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /rollback completato/);
    assert.doesNotMatch(r.out, /INCOMPLETO/);
    assert.deepEqual(snapshot(proj), before);
    const info = JSON.parse(fs.readFileSync(path.join(backupsDir(), listBackupNames().at(-1), "info.json"), "utf8"));
    assert.equal(info.status, "rolled-back", "il backup di un'operazione annullata non viene scelto da restore latest");
  });

  it("restore: esce con errore se la verifica finale fallisce", () => {
    assert.equal(run("update").code, 0);
    const policy = path.join(proj, ".agents", "skill-customizations", "policies", "regola.md");
    const original = fs.readFileSync(policy, "utf8");
    try {
      fs.writeFileSync(policy, original.replace("di prova", "di prova modificata"));
      const r = run("restore");
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /verifica finale segnala problemi/);
    } finally {
      fs.writeFileSync(policy, original);
    }
    assert.equal(run("verify").code, 0);
  });

  it("restore: non sovrascrive modifiche manuali senza --discard-local-changes; il manifest cambia solo in validatedRef", () => {
    assert.equal(run("update").code, 0);
    const file = path.join(proj, ".agents", "skills", "beta", "SKILL.md");
    fs.appendFileSync(file, "\nNota manuale prima del restore.\n");
    const before = snapshot(proj);
    const r = run("restore");
    assert.equal(r.code, 2, r.out);
    assert.deepEqual(snapshot(proj), before);
    const manifestNow = JSON.parse(fs.readFileSync(manifestFile(), "utf8"));
    manifestNow.description = "fixture con modifica non legata all'update";
    fs.writeFileSync(manifestFile(), JSON.stringify(manifestNow, null, 2) + "\n");
    const forced = run("restore", "--discard-local-changes");
    assert.equal(forced.code, 0, forced.out);
    assert.equal(JSON.parse(fs.readFileSync(manifestFile(), "utf8")).description, "fixture con modifica non legata all'update");
    assert.equal(run("verify").code, 0);
    assert.equal(run("update").code, 0);
  });

  it("backup: tiene gli ultimi 10 dopo un successo e non elimina il backup che si sta ripristinando", () => {
    const template = path.join(backupsDir(), listBackupNames().filter((n) => !n.startsWith("2000")).at(-1));
    for (let i = 1; i <= 11; i++) fs.cpSync(template, path.join(backupsDir(), `2000-01-${String(i).padStart(2, "0")}_00-00-00-000-update`), { recursive: true });
    const oldest = "2000-01-01_00-00-00-000-update";
    const r = run("restore", "--backup", oldest, "--discard-local-changes");
    assert.equal(r.code, 0, r.out);
    assert.ok(listBackupNames().includes(oldest), "il backup ripristinato resta disponibile");
    assert.ok(listBackupNames().length <= 11, `al massimo 10 piu' quello protetto (${listBackupNames().length})`);
    assert.equal(run("update").code, 0);
    assert.equal(run("verify").code, 0);
  });

  it("skill fuori dal lock (link al fork) intatte; cartella gestita con un link interno: stop senza modifiche", () => {
    const fork = path.join(base, "fork", "locale");
    writeFiles(fork, { "SKILL.md": SKILL("locale", "Skill del fork.") });
    const forkHash = core.treeHash(core.readTree(fork));
    const localLink = path.join(proj, ".agents", "skills", "locale");
    const inner = path.join(proj, ".agents", "skills", "gamma", "collegata");
    fs.symlinkSync(fork, localLink, process.platform === "win32" ? "junction" : "dir");
    try {
      const v = run("verify");
      assert.equal(v.code, 0, v.out);
      assert.match(v.out, /locale \(link\)/);
      fs.symlinkSync(fork, inner, process.platform === "win32" ? "junction" : "dir");
      const v2 = run("verify");
      assert.equal(v2.code, 1);
      assert.match(v2.out, /gamma: contiene link/);
      const before = snapshot(proj);
      const r = run("install", "--discard-local-changes");
      assert.equal(r.code, 2, r.out);
      assert.deepEqual(snapshot(proj), before);
      assert.equal(core.treeHash(core.readTree(fork)), forkHash, "il contenuto del fork non cambia");
    } finally {
      if (fs.existsSync(inner)) fs.unlinkSync(inner);
      fs.unlinkSync(localLink);
    }
    assert.equal(core.treeHash(core.readTree(fork)), forkHash);
    assert.equal(run("verify").code, 0);
  });

  it("file che l'installazione esclude (metadata.json) upstream: stop con decisione umana", () => {
    upstreamCommit({ "skills/productivity/gamma/metadata.json": "{}\n" }, "I: gamma metadata");
    const before = snapshot(proj);
    const r = run("update", "--accept-policy-changes");
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /file che l'installazione esclude \(metadata\.json\)/);
    assert.deepEqual(snapshot(proj), before);
    fixtureGit(upstream, ["rm", "-q", "skills/productivity/gamma/metadata.json"], env);
    fixtureGit(upstream, ["commit", "-q", "-m", "I2: via metadata"], env);
    assert.equal(run("update").code, 0);
  });

  it("run.lock: rimosso se il processo e' terminato, blocca se l'esecuzione e' attiva", () => {
    const lockPath = path.join(proj, ".tmp", "skills", "run.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "2147483646");
    const stale = run("install");
    assert.equal(stale.code, 0, stale.out);
    assert.match(stale.out, /rimosso run\.lock/);
    fs.writeFileSync(lockPath, String(process.pid));
    try {
      const busy = run("install");
      assert.equal(busy.code, 1, busy.out);
      assert.match(busy.out, /un'altra esecuzione e' in corso/);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });

  it("esecuzione interrotta durante lo swap: il controllo iniziale la segnala e restore latest usa quel backup", () => {
    upstreamCommit({ "skills/engineering/beta/SKILL.md": SKILL("beta", "## Steps\n\n1. Read the input.\n2. Write the output (crash).") }, "J: beta crash");
    const lockBefore = fs.readFileSync(lockFile(), "utf8");
    const betaBefore = skillText("beta");
    // Simula un processo terminato a meta': backup 'pending' piu' recente e copia nuova senza lock aggiornato.
    assert.equal(run("update").code, 0);
    const last = listBackupNames().at(-1);
    const info = JSON.parse(fs.readFileSync(path.join(backupsDir(), last, "info.json"), "utf8"));
    fs.writeFileSync(path.join(backupsDir(), last, "info.json"), JSON.stringify({ ...info, status: "pending" }));
    fs.writeFileSync(lockFile(), lockBefore);
    const warned = run("install");
    assert.equal(warned.code, 2, warned.out);
    assert.match(warned.out, /l'ultima operazione non si e' conclusa/);
    const restored = run("restore", "--discard-local-changes");
    assert.equal(restored.code, 0, restored.out);
    assert.match(restored.out, new RegExp(`Ripristino del backup ${last}`));
    assert.equal(skillText("beta"), betaBefore);
    assert.equal(run("verify").code, 0);
    const after = run("install");
    assert.doesNotMatch(after.out, /l'ultima operazione non si e' conclusa/);
    assert.equal(run("update").code, 0);
  });

  it("opzioni senza valore: uso non valido", () => {
    for (const opt of ["--ref", "--backup"]) {
      const r = runSkills(["update", opt, "--root", proj], { env });
      assert.equal(r.code, 3, r.out);
      assert.match(r.out, /richiede un valore/);
    }
  });
});
