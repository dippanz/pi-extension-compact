// Test sul livello di personalizzazione reale: rendering delle 20 skill, policy protette, comportamento atteso
// leggibile nel testo risultante, documentazione e lock. Il testo upstream si ricava dalle copie installate
// (togliendo i blocchi): se le skill non sono installate i test di contenuto vengono saltati.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import * as core from "../scripts/lib/core.mjs";
import * as ops from "../scripts/lib/ops.mjs";
import { LAYER_DIR, REPO_ROOT } from "./helpers.mjs";

const layer = core.loadLayer(LAYER_DIR);
const lockRaw = fs.readFileSync(path.join(REPO_ROOT, "skills-lock.json"), "utf8");
const lock = JSON.parse(lockRaw);
const skillsDir = path.join(REPO_ROOT, ".agents", "skills");

const pristine = {};
const rendered = {};
for (const [skill, entry] of Object.entries(lock.skills)) {
  const info = core.classifySkill(core.readTree(path.join(skillsDir, skill)), entry, skill, layer);
  if (!info.pristine) continue;
  pristine[skill] = info.pristine;
  const r = core.renderSkill(info.pristine, skill, layer);
  if (r.tree) rendered[skill] = r.tree;
}
const available = Object.keys(pristine).length === Object.keys(lock.skills).length;
const skip = available ? false : "skill non installate o modificate: esegui npm run skills:install";
const text = (skill, file = "SKILL.md") => rendered[skill].get(file).toString("utf8").replace(/\r\n/g, "\n");
const outsideBlocks = (t) => t.replace(/<!-- skill-customization:begin[\s\S]*?<!-- skill-customization:end [^>]+-->/g, "");

describe("livello reale: struttura", () => {
  it("manifest valido e coerente con il lock", () => {
    assert.deepEqual(core.validateManifest(layer), []);
    const check = core.validateLock(lock, layer.manifest, lockRaw);
    assert.deepEqual(check.errors, []);
  });

  it("lock nel formato nativo della CLI e riproducibile (ref = SHA completo)", () => {
    assert.equal(core.serializeLock(lock), lockRaw.replace(/\r\n/g, "\n"), "serializzazione identica a writeLocalLock");
    for (const [name, e] of Object.entries(lock.skills)) {
      assert.match(e.ref ?? "", /^[0-9a-f]{40}$/, `${name}: ref fissato`);
      assert.deepEqual(Object.keys(e), ["source", "ref", "sourceType", "skillPath", "computedHash"], `${name}: solo campi nativi`);
    }
  });

  it("gli script non possono eseguire commit, push o altre scritture Git", () => {
    for (const forbidden of ["commit", "push", "add", "reset", "checkout", "merge", "rebase", "tag", "stash"]) {
      assert.ok(!ops.GIT_ALLOWED.includes(forbidden), forbidden);
      assert.throws(() => ops.git([forbidden]), /non consentito/);
    }
  });
});

describe("livello reale: rendering", { skip }, () => {
  it("tutte le skill si personalizzano, si ripuliscono e si rigenerano in modo identico", () => {
    for (const skill of Object.keys(lock.skills)) {
      assert.ok(rendered[skill], `${skill}: rendering fallito`);
      assert.deepEqual(core.checkRenderedSkill(rendered[skill], skill, layer), [], skill);
      const back = core.stripSkill(rendered[skill], skill, layer).tree;
      assert.ok(core.treesIdentical(back, pristine[skill]), `${skill}: strip(render) != upstream`);
      const again = core.renderSkill(back, skill, layer).tree;
      assert.ok(core.treesIdentical(again, rendered[skill]), `${skill}: non idempotente`);
    }
  });

  it("SEMPLIFICAZIONE LEGGERA e gate umani raggiungono tutte le skill tranne grilling", () => {
    for (const skill of Object.keys(lock.skills)) {
      const t = text(skill);
      if (skill === "grilling") {
        assert.ok(core.treesIdentical(rendered[skill], pristine[skill]), "grilling resta upstream");
        continue;
      }
      assert.match(t, /SEMPLIFICAZIONE LEGGERA/, skill);
      assert.match(t, /non riduce la profondità del ragionamento/, skill);
      assert.match(t, /dippanz\/pi-extension-compact/, skill);
      assert.match(t, /Se lavori come subagent valgono gli stessi gate/, skill);
      assert.ok(t.indexOf("skill-customization:begin") < t.indexOf("\n# ") || !t.includes("\n# "), `${skill}: regole prima del corpo upstream`);
    }
  });

  it("implement: nessun commit automatico", () => {
    const t = text("implement");
    assert.doesNotMatch(outsideBlocks(t), /Commit your work/);
    assert.match(t, /Non eseguire commit, push, PR o merge/);
    assert.match(t, /Do not commit \(regola locale\)/);
    assert.match(t, /fetch it from the issue tracker and state its title/, "miglioramento upstream conservato");
  });

  it("implement-spec: branch, merge e PR solo con autorizzazione", () => {
    assert.match(text("implement-spec"), /richiede un'autorizzazione esplicita dell'utente nella sessione corrente/);
  });

  it("code-review: rivede commit, staged, unstaged e untracked senza commit preliminari", () => {
    const t = text("code-review");
    for (const s of ["git diff <fixed-point>...HEAD", "git diff --cached", "`git diff`", "git ls-files --others --exclude-standard", "Non creare commit, stash o branch per ottenere un diff"]) assert.ok(t.includes(s), s);
    assert.ok(t.indexOf("code-review/perimetro") > t.indexOf("### 1. Pin the fixed point"), "regola nel passo del fixed point");
  });

  it("code-review: senza subagent in sequenza, Standards e Spec separati", () => {
    const t = text("code-review");
    assert.match(t, /esegui le due analisi in sequenza nello stesso contesto: prima Standards, poi Spec/);
    assert.match(t, /tieni separati i report `## Standards` e `## Spec`/);
    assert.ok(t.indexOf("code-review/sequenziale") > t.indexOf("### 4. Spawn both sub-agents in parallel"));
    assert.ok(t.includes("Present the two reports under `## Standards` and `## Spec` headings"), "istruzione upstream conservata");
    assert.ok(t.includes("Do **not** merge or rerank findings"), "istruzione upstream conservata");
  });

  it("wayfinder: ricerca automatica consentita, con i gate su Git, tracker e remoto", () => {
    const t = text("wayfinder");
    assert.match(t, /Ricerca automatica consentita/);
    assert.match(t, /senza chiedere di nuovo, anche in parallelo quando le domande sono indipendenti/);
    assert.match(t, /non scrivono su Git, sul tracker o su sistemi remoti/);
    assert.match(t, /I branch `research\/\*` dell'upstream si creano, committano o pushano solo con autorizzazione esplicita/);
    assert.doesNotMatch(t, /Push the branch but open no PR/);
    assert.doesNotMatch(t, /chiedermi prima conferma|without explicit user approval/i, "nessun residuo del vecchio divieto");
  });

  it("wayfinder: decide e pianifica, non implementa; le Notes non derogano", () => {
    const t = text("wayfinder");
    assert.match(t, /Wayfinder resta una skill di decisione e pianificazione/);
    assert.match(t, /Le \*\*Notes\*\* della mappa non possono derogare a queste regole/);
    assert.doesNotMatch(t, /An effort can override this in its \*\*Notes\*\*/);
    for (const kept of ["`wayfinder:` labels are the only labels a map and its tickets carry", "**Claim it**", "wire blocking edges", "child issues of the map", "**never resolve more than one ticket per session**"]) assert.ok(t.includes(kept), kept);
  });

  it("prototype e domain-modeling: nessuna modifica persistente non autorizzata", () => {
    const p = text("prototype");
    assert.match(p, /non integrarlo mai automaticamente nel codice di produzione/);
    assert.match(p, /`\.tmp\/prototypes\/<slug>\/`/);
    assert.doesNotMatch(p, /commit it to a throwaway branch/);
    const d = text("domain-modeling");
    assert.match(d, /non creare documenti di dominio paralleli senza una decisione esplicita/);
    assert.match(d, /Durante Wayfinder registra termini e decisioni nel tracker/);
    assert.doesNotMatch(d, /Create files lazily/);
  });

  it("prototype e domain-modeling: anche i file collegati (LOGIC, UI, formati) rispettano le regole locali", { skip }, () => {
    const logic = text("prototype", "LOGIC.md");
    const ui = text("prototype", "UI.md");
    const skillP = outsideBlocks(text("prototype"));
    for (const [name, t] of [["LOGIC.md", logic], ["UI.md", ui]]) {
      // Restano ammessi i consigli di progetto ("could be lifted out and dropped into the real codebase later"): non sono istruzioni di integrazione.
      assert.doesNotMatch(outsideBlocks(t), /throwaway branch|Fold the winner into the real code|fold the winner into the existing page|promote the winning variant to a real route|lifts into the real module \(the decision/, `${name}: istruzioni upstream di integrazione o branch rimaste fuori dai blocchi`);
      assert.match(t, /\.tmp\/prototypes\/<slug>\//, name);
    }
    assert.match(ui, /le sub-shape A \(varianti sulla route esistente\) e B \(route throwaway nell'app\) modificano codice versionato/);
    assert.doesNotMatch(skillP, /Locate the prototype code close to where|`pnpm <name>`/);
    const adr = text("domain-modeling", "ADR-FORMAT.md");
    const glossary = text("domain-modeling", "GLOSSARY-FORMAT.md");
    assert.doesNotMatch(outsideBlocks(adr), /lazily/);
    assert.doesNotMatch(outsideBlocks(glossary), /create a root `GLOSSARY\.md` lazily/);
    assert.match(adr, /non creare automaticamente `docs\/adr\/`/);
    assert.match(text("domain-modeling"), /registra la proposta nella fonte canonica/);
  });

  it("i subagent avviati con un brief ricevono le regole locali", { skip }, () => {
    for (const skill of Object.keys(rendered).filter((s) => s !== "grilling")) assert.match(text(skill), /metti all'inizio del brief queste regole locali/, skill);
    assert.match(text("code-review"), /metti all'inizio le regole locali: sola lettura/);
    assert.match(text("implement-spec"), /Nei brief di exploration, implementer e merger subagent/);
    assert.match(text("wayfinder"), /nel brief metti le regole locali/);
  });

  it("wayfinder: resolution dei ticket research complete sul tracker, nessuna issue cancellata, scritture persistenti vietate", { skip }, () => {
    const w = text("wayfinder");
    assert.match(w, /I ticket `research` sono l'eccezione prevista dall'upstream/);
    assert.match(w, /risposta, fonti e punti incerti per intero/);
    assert.match(w, /Non cancellare issue/);
    assert.match(w, /modificare dati, servizi, configurazioni persistenti o pipeline; eseguire release;/);
  });

  it("marcatori replace: la riga upstream originale e' codificata (non leggibile) e ricostruibile", { skip }, () => {
    const t = text("implement");
    const m = /<!-- skill-customization:begin implement\/no-commit op=replace orig=([A-Za-z0-9_-]+) -->/.exec(t);
    assert.ok(m, "marcatore con orig");
    assert.equal(Buffer.from(m[1], "base64url").toString("utf8"), "Commit your work to the current branch.");
    assert.ok(!t.includes("Commit your work to the current branch."), "la riga originale non compare in chiaro");
  });

  it("ticket piu' chiari ma completi: template upstream intatti, In pratica / Come funzionerà", () => {
    for (const skill of ["wayfinder", "to-tickets"]) {
      const t = text(skill);
      assert.match(t, /\*\*In pratica:\*\*/);
      assert.match(t, /\*\*Come funzionerà:\*\*/);
      assert.match(t, /Non usarla nei decision ticket Wayfinder/);
      assert.match(t, /Non modificare identificativi, riferimenti/);
      assert.match(t, /Question ↔ Obiettivo; What to build ↔ Implementazione attesa; Acceptance criteria ↔ Criteri di accettazione; Parent e Blocked by ↔ Dipendenze e riferimenti/, `${skill}: corrispondenze tra sezioni`);
      assert.match(t, /la decisione non va nel corpo ma nella resolution/);
    }
    assert.match(text("wayfinder"), /^## Question$/m);
    const tt = text("to-tickets");
    for (const s of ["<issue-template>", "## Parent", "## What to build", "## Acceptance criteria", "## Blocked by", "<local-ticket-template>"]) assert.ok(tt.includes(s), s);
    assert.match(tt, /conserva nel corpo del ticket la sezione Dipendenze e riferimenti/);
  });

  it("research: sola lettura e note in .tmp/", () => {
    const t = text("research");
    assert.match(t, /Sola lettura: nessuna scrittura su tracker, Git o sistemi remoti/);
    assert.match(t, /\.tmp\/research\//);
  });
});

describe("documentazione", () => {
  const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, ...rel.split("/")), "utf8");
  it("guida Wayfinder e issue tracker: ricerca automatica al posto del vecchio divieto", () => {
    for (const rel of ["docs/agents/guida-wayfinder.md", "docs/agents/issue-tracker.md"]) {
      const t = read(rel);
      assert.doesNotMatch(t, /non avvia automaticamente subagent di ricerca|senza chiedermi prima conferma|without explicit user approval/i, rel);
      assert.match(t, /research\/\*/, rel);
      assert.match(t, /\.tmp\/wayfinder-research\//, rel);
    }
    assert.match(read("docs/agents/guida-wayfinder.md"), /\*\*Ricerca automatica\.\*\*/);
    assert.match(read("docs/agents/issue-tracker.md"), /\*\*Research is automatic:\*\*/);
    assert.match(read("docs/agents/guida-wayfinder.md"), /skill-customizations\.md/);
  });

  it("guida operativa delle personalizzazioni presente e collegata", () => {
    const t = read("docs/agents/skill-customizations.md");
    for (const s of ["npm run skills:update", "npm run skills:verify", "npm run skills:install", "npm run skills:restore", "skills-lock.json", "--accept-policy-changes", "/reload"]) assert.ok(t.includes(s), s);
  });
});
