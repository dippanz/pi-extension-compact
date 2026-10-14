#!/usr/bin/env node
// Gestione delle skill upstream (mattpocock/skills) con personalizzazioni di progetto.
//   npm run skills:verify                 verifica in sola lettura (anche dopo un `npx skills update` diretto)
//   npm run skills:install                ripristina o ripara le skill al commit fissato nel lock
//   npm run skills:update                 aggiorna a upstream, riapplica le personalizzazioni, verifica, rollback su errore
//   npm run skills:restore                ripristina l'ultimo backup (o --backup <nome>)
// Nessun commit, push o PR: le modifiche restano nel working tree. Guida: docs/agents/skill-customizations.md
import fs from "node:fs";
import path from "node:path";
import * as core from "./lib/core.mjs";
import * as ops from "./lib/ops.mjs";

const { EXIT, StopError } = ops;

const USAGE = `Uso: node .agents/skill-customizations/scripts/skills.mjs <verify|install|update|restore> [opzioni]
  --ref <sha|branch|tag>      (update) commit upstream di destinazione; default: branch di default upstream
  --accept-policy-changes     (update) accetta righe upstream sensibili cambiate, dopo averle rivedute
  --discard-local-changes     (install/update) sovrascrive modifiche manuali alle copie installate (con backup)
  --dry-run                   (update) mostra il piano senza modificare file
  --backup <nome|latest>      (restore) backup da ripristinare (default: latest)
  --no-pi                     salta la verifica di caricamento con Pi
  --keep-temp                 conserva la cartella temporanea in .tmp/skills/
  --root <dir>                radice del progetto (default: questo repository; usato dai test)`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, ref: undefined, acceptPolicy: false, discardLocal: false, dryRun: false, backup: "latest", pi: true, keep: false, root: undefined };
  const value = (i, name) => {
    const v = rest[i];
    if (v === undefined || v.startsWith("--")) throw new StopError(`${name} richiede un valore\n${USAGE}`, EXIT.USAGE);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--ref") opts.ref = value(++i, a);
    else if (a === "--accept-policy-changes") opts.acceptPolicy = true;
    else if (a === "--discard-local-changes") opts.discardLocal = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--backup") opts.backup = value(++i, a);
    else if (a === "--no-pi") opts.pi = false;
    else if (a === "--keep-temp") opts.keep = true;
    else if (a === "--root") opts.root = value(++i, a);
    else throw new StopError(`opzione sconosciuta: ${a}\n${USAGE}`, EXIT.USAGE);
  }
  if (!["verify", "install", "update", "restore"].includes(command)) throw new StopError(USAGE, EXIT.USAGE);
  if (!opts.pi) process.env.SKILLS_NO_PI = "1";
  return opts;
}

/** Controlli iniziali comuni: manifest, lock, stato delle copie installate. */
function preflight(ctx, opts) {
  const r = ctx.report;
  r.title("Controllo iniziale");
  const manifestErrors = core.validateManifest(ctx.layer);
  if (manifestErrors.length) throw new StopError("manifest o file di personalizzazione non validi: nessun file modificato", EXIT.ERROR, manifestErrors);
  r.ok("manifest e file di personalizzazione integri");
  const { lock, raw } = ops.readLock(ctx);
  const lockCheck = core.validateLock(lock, ctx.manifest, raw);
  if (lockCheck.errors.length) throw new StopError("skills-lock.json non valido: nessun file modificato", EXIT.ERROR, lockCheck.errors);
  for (const w of lockCheck.warnings) r.warn(w);
  r.ok(`skills-lock.json valido (${Object.keys(lock.skills).length} skill)`);
  // Solo l'ultima operazione conta: se e' rimasta 'pending' (processo interrotto) o con rollback incompleto, lo stato
  // attuale puo' essere a meta'. Un restore successivo crea un backup piu' recente e l'avviso sparisce.
  const last = ops.listBackups(ctx).at(-1);
  if (last && ["pending", "rollback-incomplete"].includes(last.info.status)) r.warn(`l'ultima operazione non si e' conclusa (backup ${last.name}, stato '${last.info.status}'): se le skill risultano modificate esegui \`npm run skills:restore\``);
  const state = ops.inspectInstalled(ctx, lock);
  const blocked = [];
  for (const [skill, info] of Object.entries(state)) {
    if (info.status === "ok") continue;
    r.info(`${skill}: stato '${info.status}'`);
    if (["link", "unsupported"].includes(info.status)) blocked.push(`${skill}: ${ops.STATUS_HINT[info.status]}${info.errors?.length ? ` (${info.errors.join("; ")})` : ""}`);
    else if (["modified", "malformed"].includes(info.status) && !opts.discardLocal) blocked.push(`${skill}: ${ops.STATUS_HINT[info.status]}`);
  }
  if (blocked.length) throw new StopError("copie installate con modifiche non riconosciute: nessun file modificato", EXIT.HUMAN, blocked);
  const okCount = Object.values(state).filter((i) => i.status === "ok").length;
  r.ok(`${okCount}/${Object.keys(state).length} skill installate e personalizzate correttamente`);
  return { lock, state };
}

function stageAndValidate(ctx, run, plan) {
  for (const { skill, tree } of plan) core.writeTree(path.join(run.stagedDir, skill), tree);
  ctx.report.title("Validazione dello staging");
  ctx.report.ok(`${plan.length} skill preparate in ${path.relative(ctx.root, run.stagedDir)}`);
  if (!ops.checkPi(ctx, plan.map((p) => p.skill), { mode: "dir", dir: run.stagedDir })) {
    throw new StopError("Pi non carica correttamente le skill preparate: nessun file modificato", EXIT.ERROR);
  }
}

async function cmdVerify(ctx, opts) {
  return ops.verifyAll(ctx, { pi: opts.pi }) ? EXIT.OK : EXIT.ERROR;
}

async function cmdInstall(ctx, opts) {
  const r = ctx.report;
  // Il lock di esecuzione si prende prima di leggere lo stato: nessun'altra esecuzione puo' cambiarlo nel frattempo.
  const run = ops.prepareRun(ctx);
  let keep = opts.keep;
  try {
    const { lock, state } = preflight(ctx, opts);
    const todo = Object.keys(state).filter((s) => state[s].status !== "ok");
    if (!todo.length) {
      r.ok("nulla da installare");
      ops.ensureLinks(ctx, { create: true });
      return ops.verifyAll(ctx, { pi: opts.pi, title: "Verifica finale" }) ? EXIT.OK : EXIT.ERROR;
    }
    r.title("Upstream ai commit fissati nel lock");
    const { cloneDir } = ops.cloneUpstream(ctx, run.runDir);
    const cache = new Map();
    const plan = [];
    const errors = [];
    for (const skill of todo) {
      const entry = lock.skills[skill];
      const ref = ops.refOf(ctx, entry);
      const sha = ops.resolveRef(ctx, cloneDir, ref);
      if (!sha) {
        errors.push(`${skill}: commit ${ref} non trovato upstream`);
        continue;
      }
      const up = ops.upstreamSkill(ops.checkoutRef(ctx, cloneDir, sha, run.runDir, cache), skill, entry.skillPath);
      if (!up.tree) {
        errors.push(`${skill}: ${entry.skillPath} non esiste upstream al commit ${sha.slice(0, 12)}`);
        continue;
      }
      if (!core.hashMatch(up.source, entry.computedHash)) {
        errors.push(`${skill}: il contenuto upstream @${sha.slice(0, 12)} non corrisponde a computedHash del lock (provenienza non verificata)`);
        continue;
      }
      const rendered = core.renderSkill(up.tree, skill, ctx.layer);
      if (!rendered.tree) {
        errors.push(...rendered.errors.map((e) => `patch incompatibile: ${e}`));
        continue;
      }
      const check = core.checkRenderedSkill(rendered.tree, skill, ctx.layer);
      if (check.length) {
        errors.push(...check);
        continue;
      }
      plan.push({ skill, tree: rendered.tree, status: state[skill].status });
    }
    if (errors.length) throw new StopError("impossibile preparare le skill: nessun file modificato", EXIT.HUMAN, errors);
    r.ok(`provenienza verificata (hash del lock) per: ${plan.map((p) => p.skill).join(", ")}`);
    stageAndValidate(ctx, run, plan);
    r.title("Installazione");
    keep = true;
    const { backupDir } = ops.applyStaged(ctx, run, { skills: plan.map((p) => p.skill), lockText: null, manifestText: null, label: "install" });
    keep = opts.keep;
    ctx.report.section("Skill installate o riparate", plan.map((p) => `- ${p.skill} (stato precedente: ${p.status})`).join("\n") + `\n\nBackup: ${path.relative(ctx.root, backupDir)}`);
    r.ok(`installate o riparate: ${plan.map((p) => `${p.skill} (${p.status})`).join(", ")}`);
    return EXIT.OK;
  } finally {
    ops.cleanupRun(ctx, run, { keep });
  }
}

async function cmdUpdate(ctx, opts) {
  const r = ctx.report;
  const run = ops.prepareRun(ctx);
  let keep = opts.keep;
  try {
    const { lock, state } = preflight(ctx, opts);
    r.title("Upstream");
    const { cloneDir, head } = ops.cloneUpstream(ctx, run.runDir);
    const target = opts.ref ? ops.resolveRef(ctx, cloneDir, opts.ref) : head;
    if (!target) throw new StopError(`ref '${opts.ref}' non trovato upstream`, EXIT.USAGE);
    const pinned = [...new Set(Object.values(lock.skills).map((e) => ops.refOf(ctx, e)))];
    r.info(`commit fissato nel lock: ${pinned.map((s) => s.slice(0, 12)).join(", ")}; destinazione (${opts.ref ? `--ref ${opts.ref}` : "branch di default"}): ${target.slice(0, 12)}`);
    const cache = new Map();
    const targetWt = ops.checkoutRef(ctx, cloneDir, target, run.runDir, cache);
    const items = [];
    const errors = [];
    const policyChanges = [];
    const relocations = [];
    for (const [skill, entry] of Object.entries(lock.skills)) {
      const pinnedRef = ops.refOf(ctx, entry);
      const oldSha = ops.resolveRef(ctx, cloneDir, pinnedRef);
      if (!oldSha) {
        errors.push(`${skill}: commit fissato ${pinnedRef} non trovato upstream`);
        continue;
      }
      const oldUp = ops.upstreamSkill(ops.checkoutRef(ctx, cloneDir, oldSha, run.runDir, cache), skill, entry.skillPath);
      if (!oldUp.tree || !core.hashMatch(oldUp.source, entry.computedHash)) {
        errors.push(`${skill}: il lock non corrisponde a upstream@${oldSha.slice(0, 12)} (provenienza non verificata)`);
        continue;
      }
      let skillPath = entry.skillPath;
      let newUp = ops.upstreamSkill(targetWt, skill, skillPath);
      if (!newUp.tree) {
        const candidates = (newUp.candidates ?? []).filter((p) => !p.includes("/deprecated/"));
        if (candidates.length === 1) {
          skillPath = candidates[0];
          newUp = ops.upstreamSkill(targetWt, skill, skillPath);
          relocations.push(`${skill}: ${entry.skillPath} -> ${skillPath}`);
        } else {
          errors.push(`${skill}: non piu' presente upstream in ${entry.skillPath}${newUp.candidates?.length ? ` (candidati: ${newUp.candidates.join(", ")})` : " (rimossa o deprecata)"}: decisione umana necessaria`);
          continue;
        }
      }
      const changed = skillPath !== entry.skillPath || !core.treesEquivalent(oldUp.source, newUp.source);
      if (changed) policyChanges.push(...core.diffPolicyLines(oldUp.tree, newUp.tree, ctx.manifest.sentinels).map((c) => ({ skill, ...c })));
      items.push({ skill, entry, oldSha, skillPath, changed, newUp, status: state[skill].status });
    }
    const changedItems = items.filter((i) => i.changed);
    r.info(changedItems.length ? `skill cambiate upstream: ${changedItems.map((i) => i.skill).join(", ")}` : "nessuna skill del lock e' cambiata upstream");
    if (pinned.length === 1 && pinned[0] !== target) {
      const dirs = Object.values(lock.skills).map((e) => path.posix.dirname(e.skillPath));
      const log = ops.git(["log", "--oneline", "--no-decorate", "-n", "60", `${pinned[0]}..${target}`, "--", ...dirs], { cwd: cloneDir, allowFail: true }).stdout.trim();
      if (log) ctx.report.section("Commit upstream che toccano le skill del lock", "```\n" + log + "\n```");
    }
    const plan = [];
    for (const item of items) {
      if (!item.changed && item.status === "ok") continue;
      const rendered = core.renderSkill(item.newUp.tree, item.skill, ctx.layer);
      if (!rendered.tree) {
        errors.push(...rendered.errors.map((e) => `patch incompatibile: ${e}`));
        continue;
      }
      const check = core.checkRenderedSkill(rendered.tree, item.skill, ctx.layer);
      if (check.length) {
        errors.push(...check);
        continue;
      }
      plan.push({ skill: item.skill, tree: rendered.tree, changed: item.changed, status: item.status });
    }
    if (policyChanges.length || relocations.length) {
      const body = [
        ...relocations.map((x) => `- spostamento: ${x}`),
        ...policyChanges.map((c) => `- ${c.skill}/${c.file} (${c.change}): ${c.line}`),
      ].join("\n");
      ctx.report.section("Righe upstream sensibili cambiate (commit, push, PR, merge, subagent, chiusure, ...)", body);
    }
    if (errors.length) throw new StopError("conflitto con le personalizzazioni o le policy: nessun file modificato. Aggiorna gli override in .agents/skill-customizations/ o decidi come procedere", EXIT.HUMAN, errors);
    if ((policyChanges.length || relocations.length) && !opts.acceptPolicy) {
      throw new StopError(
        "upstream ha cambiato righe sensibili per le policy del progetto: nessun file modificato. Rivedi l'elenco nel report; se sono compatibili riesegui con `npm run skills:update -- --accept-policy-changes`, altrimenti aggiorna gli override",
        EXIT.HUMAN,
        [...relocations, ...policyChanges.slice(0, 40).map((c) => `${c.skill}/${c.file} (${c.change}): ${c.line.slice(0, 160)}`)],
      );
    }
    if (policyChanges.length || relocations.length) r.warn(`righe sensibili cambiate accettate esplicitamente (${policyChanges.length + relocations.length}): vedi il report`);
    const bump = changedItems.length > 0;
    const newLock = { version: lock.version, skills: {} };
    for (const item of items) {
      newLock.skills[item.skill] = {
        ...item.entry,
        ref: bump ? target : item.entry.ref ?? item.oldSha,
        skillPath: item.skillPath,
        computedHash: item.changed ? item.newUp.sourceHash : item.entry.computedHash,
      };
    }
    const lockText = core.serializeLock(newLock);
    const currentLockText = fs.readFileSync(ctx.lockPath, "utf8");
    const lockChanged = lockText !== currentLockText.replace(/\r\n/g, "\n");
    const manifestText = bump ? ops.manifestWithValidatedRef(ctx, target) : null;
    if (!plan.length && !lockChanged) {
      r.ok(pinned.length === 1 && pinned[0] === target ? "nessuna novita' upstream: niente da aggiornare" : "upstream e' avanzato ma le skill del lock non sono cambiate: lock invariato");
      ops.ensureLinks(ctx, { create: true });
      return ops.verifyAll(ctx, { pi: opts.pi, title: "Verifica finale" }) ? EXIT.OK : EXIT.ERROR;
    }
    const summary = plan.map((p) => `- ${p.skill}: ${p.changed ? "aggiornata da upstream" : `riparata (stato '${p.status}')`}`).join("\n") || "- nessuna cartella da sostituire";
    ctx.report.section("Piano", `${summary}\n- lock: ${lockChanged ? "aggiornato" : "invariato"}${bump ? ` (ref -> ${target})` : ""}`);
    if (opts.dryRun) {
      r.ok(`dry-run: ${plan.length} skill da sostituire, lock ${lockChanged ? "da aggiornare" : "invariato"}; nessun file modificato`);
      return EXIT.OK;
    }
    if (plan.length) stageAndValidate(ctx, run, plan);
    r.title("Applicazione");
    keep = true;
    const { backupDir } = ops.applyStaged(ctx, run, { skills: plan.map((p) => p.skill), lockText: lockChanged ? lockText : null, manifestText, label: "update" });
    keep = opts.keep;
    ctx.report.section("Backup", path.relative(ctx.root, backupDir));
    r.ok(`aggiornamento completato: ${plan.length} skill sostituite, lock ${lockChanged ? "aggiornato" : "invariato"}. Riavvia gli agenti o usa /reload in Pi`);
    return EXIT.OK;
  } finally {
    ops.cleanupRun(ctx, run, { keep });
  }
}

/**
 * Ripristina cartelle delle skill e lock da un backup; del manifest ripristina solo upstream.validatedRef, l'unico
 * campo che install/update modificano: le altre modifiche al manifest, versionato, restano intatte. Policy e override
 * non sono nel backup (sono versionati: si ripristinano con Git).
 */
async function cmdRestore(ctx, opts) {
  const r = ctx.report;
  const run = ops.prepareRun(ctx);
  let keep = opts.keep;
  try {
    const all = ops.listBackups(ctx);
    if (!all.length) throw new StopError("nessun backup disponibile in .tmp/skills/backups", EXIT.USAGE);
    // Esclusi solo i backup di operazioni annullate con rollback riuscito: coincidono con lo stato attuale.
    // 'pending' (esecuzione interrotta) e 'rollback-incomplete' sono proprio i casi in cui serve ripristinare.
    const usable = all.filter((b) => b.info.status !== "rolled-back");
    const chosen = opts.backup === "latest" ? usable[usable.length - 1] : all.find((b) => b.name === opts.backup);
    if (!chosen) throw new StopError(opts.backup === "latest" ? "nessun backup utilizzabile: indica --backup <nome>" : `backup '${opts.backup}' non trovato. Disponibili: ${all.map((b) => b.name).join(", ")}`, EXIT.USAGE);
    r.title(`Ripristino del backup ${chosen.name}`);
    const skillsDir = path.join(chosen.dir, "skills");
    const skills = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : [];
    // Come install/update: non sovrascrive modifiche manuali non riconosciute senza --discard-local-changes.
    try {
      const { lock } = ops.readLock(ctx);
      const state = ops.inspectInstalled(ctx, lock);
      const blocked = skills.filter((s) => ["modified", "malformed"].includes(state[s]?.status));
      if (blocked.length && !opts.discardLocal) throw new StopError("copie installate con modifiche non riconosciute: nessun file modificato", EXIT.HUMAN, blocked.map((s) => `${s}: ${ops.STATUS_HINT[state[s].status]}`));
    } catch (error) {
      if (error instanceof StopError && error.code === EXIT.HUMAN) throw error;
      if (!opts.discardLocal) throw new StopError(`stato attuale non leggibile (${error.message}): riesegui con --discard-local-changes per ripristinare comunque`, EXIT.HUMAN);
    }
    for (const skill of skills) core.writeTree(path.join(run.stagedDir, skill), core.readTree(path.join(skillsDir, skill)));
    const lockFile = path.join(chosen.dir, "skills-lock.json");
    const backupManifest = JSON.parse(fs.readFileSync(path.join(chosen.dir, "manifest.json"), "utf8"));
    const manifestText = backupManifest.upstream?.validatedRef ? ops.manifestWithValidatedRef(ctx, backupManifest.upstream.validatedRef) : null;
    keep = true;
    const { verified } = ops.applyStaged(ctx, run, {
      skills,
      lockText: fs.existsSync(lockFile) ? fs.readFileSync(lockFile, "utf8") : null,
      manifestText,
      label: "pre-restore",
      finalCheck: "report",
      protectBackups: [chosen.dir],
    });
    keep = opts.keep;
    if (!verified) {
      r.fail(`ripristinate ${skills.length} cartelle e lock dal backup ${chosen.name}, ma la verifica finale segnala problemi (vedi sopra): se gli override sono cambiati dopo il backup esegui \`npm run skills:install\``);
      return EXIT.ERROR;
    }
    r.ok(`ripristinate ${skills.length} cartelle e lock dal backup ${chosen.name}`);
    return EXIT.OK;
  } finally {
    ops.cleanupRun(ctx, run, { keep });
  }
}

const COMMANDS = { verify: cmdVerify, install: cmdInstall, update: cmdUpdate, restore: cmdRestore };

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return EXIT.USAGE;
  }
  let ctx;
  try {
    ctx = ops.createContext({ root: opts.root, command: opts.command });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return error.code ?? EXIT.ERROR;
  }
  process.stdout.write(`skills:${opts.command} - ${ctx.root}\n`);
  let code;
  try {
    code = await COMMANDS[opts.command](ctx, opts);
  } catch (error) {
    if (error instanceof StopError) {
      ctx.report.title(error.code === EXIT.HUMAN ? "STOP: serve una decisione umana" : "ERRORE");
      ctx.report.fail(error.message);
      for (const d of error.details) ctx.report.fail(d);
      code = error.code;
    } else {
      ctx.report.fail(`errore inatteso: ${error.stack || error.message}`);
      code = EXIT.ERROR;
    }
  }
  if (opts.command !== "verify" && ops.tmpIgnored(ctx)) {
    try {
      const file = ops.writeReport(ctx, { Comando: opts.command, Radice: ctx.root, Upstream: ctx.upstreamUrl, "Codice di uscita": code });
      process.stdout.write(`\nReport: ${path.relative(ctx.root, file)}\n`);
    } catch (error) {
      process.stdout.write(`\nReport non scritto: ${error.message}\n`);
    }
  }
  const meaning = { 0: "OK", 1: "ERRORE (nessuna modifica parziale lasciata attiva)", 2: "STOP: decisione umana necessaria, nessun file modificato", 3: "uso non valido" }[code];
  process.stdout.write(`Esito: ${meaning} [exit ${code}]\n`);
  return code;
}

process.exitCode = await main();
