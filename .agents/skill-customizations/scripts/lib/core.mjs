// Funzioni pure per la gestione delle skill upstream e delle personalizzazioni di progetto.
// Nessun accesso alla rete; l'unico I/O e' la lettura/scrittura di alberi di file locali.
// Compatibilita': hash e formato del lock replicano skills CLI 1.7.x (computeSkillFolderHash, writeLocalLock).
// Documentazione: docs/agents/skill-customizations.md
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Alberi di file
// ---------------------------------------------------------------------------

/** Legge una cartella come Map<percorsoRelativo('/'), Buffer>. Come la CLI: salta .git e node_modules, ignora i link. */
export function readTree(dir) {
  const tree = new Map();
  if (!fs.existsSync(dir)) return tree;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.isFile()) {
        tree.set(path.relative(dir, full).split(path.sep).join("/"), fs.readFileSync(full));
      }
    }
  };
  walk(dir);
  return tree;
}

/**
 * Voci che readTree non legge (link e junction, .git, node_modules, file speciali): un backup fatto con readTree le
 * perderebbe, quindi le cartelle che le contengono non vengono sostituite dagli script.
 */
export function skippedEntries(dir) {
  const skipped = [];
  if (!fs.existsSync(dir)) return skipped;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") skipped.push(rel);
        else walk(full);
      } else if (!entry.isFile()) skipped.push(rel);
    }
  };
  walk(dir);
  return skipped;
}

/** Scrive un albero in una cartella nuova (che non deve esistere). */
export function writeTree(dir, tree) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, buf] of tree) {
    const full = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
  }
}

export function isBinary(buf) {
  return buf.includes(0);
}

function convertEol(buf, variant) {
  if (variant === "raw" || isBinary(buf)) return buf;
  const lf = buf.toString("utf8").replace(/\r\n/g, "\n");
  return Buffer.from(variant === "lf" ? lf : lf.replace(/\n/g, "\r\n"), "utf8");
}

/** Hash di cartella identico a computeSkillFolderHash della CLI (variant raw); lf/crlf normalizzano i fine riga. */
export function treeHash(tree, variant = "raw") {
  const files = [...tree.keys()].sort((a, b) => a.localeCompare(b));
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update(convertEol(tree.get(rel), variant));
  }
  return hash.digest("hex");
}

/** Restituisce la variante (raw|lf|crlf) con cui l'albero corrisponde all'hash atteso, oppure null. */
export function hashMatch(tree, expected) {
  if (!expected || tree.size === 0) return null;
  for (const variant of ["raw", "lf", "crlf"]) {
    if (treeHash(tree, variant) === expected) return variant;
  }
  return null;
}

/** Confronto indipendente dai fine riga (LF/CRLF). */
export function treesEquivalent(a, b) {
  return a.size === b.size && treeHash(a, "lf") === treeHash(b, "lf");
}

export function treesIdentical(a, b) {
  if (a.size !== b.size) return false;
  for (const [rel, buf] of a) {
    const other = b.get(rel);
    if (!other || !other.equals(buf)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Lock (formato nativo skills CLI)
// ---------------------------------------------------------------------------

export const LOCK_KEY_ORDER = ["source", "sourceUrl", "ref", "sourceType", "skillPath", "computedHash"];
const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /:\/\/[^/\s:@]+:[^/\s@]+@/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function parseLock(text) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch (error) {
    return { lock: null, errors: [`skills-lock.json non e' JSON valido: ${error.message}`] };
  }
  const errors = [];
  if (typeof lock !== "object" || lock === null) errors.push("skills-lock.json: oggetto atteso");
  else {
    if (typeof lock.version !== "number" || lock.version < 1) errors.push("skills-lock.json: campo version mancante o < 1 (la CLI lo tratterebbe come lock vuoto)");
    if (typeof lock.skills !== "object" || lock.skills === null) errors.push("skills-lock.json: campo skills mancante");
  }
  return { lock: errors.length ? null : lock, errors };
}

/** Serializza come writeLocalLock della CLI: skill ordinate, chiavi della voce nell'ordine della CLI, 2 spazi, newline finale. */
export function serializeLock(lock) {
  const skills = {};
  for (const name of Object.keys(lock.skills).sort()) {
    const entry = lock.skills[name];
    const ordered = {};
    for (const key of LOCK_KEY_ORDER) if (entry[key] !== undefined) ordered[key] = entry[key];
    for (const key of Object.keys(entry)) if (!(key in ordered) && entry[key] !== undefined) ordered[key] = entry[key];
    skills[name] = ordered;
  }
  return JSON.stringify({ version: lock.version, skills }, null, 2) + "\n";
}

/** Controlli di sicurezza e coerenza del lock rispetto al manifest. */
export function validateLock(lock, manifest, rawText = "") {
  const errors = [];
  const warnings = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(rawText)) errors.push(`skills-lock.json contiene un valore simile a una credenziale (${pattern})`);
  }
  if (rawText && serializeLock(lock) !== rawText.replace(/\r\n/g, "\n")) {
    warnings.push("skills-lock.json non e' nel formato canonico della CLI (ordinamento/indentazione): verra' riscritto al prossimo aggiornamento");
  }
  const managed = new Set(Object.keys(manifest.skills));
  for (const [name, entry] of Object.entries(lock.skills)) {
    if (!managed.has(name)) errors.push(`skill '${name}' presente nel lock ma non nel manifest: aggiungila a manifest.json o rimuovila dal lock`);
    for (const key of Object.keys(entry)) {
      if (!LOCK_KEY_ORDER.includes(key)) warnings.push(`lock '${name}': campo non standard '${key}'`);
    }
    if (entry.source !== manifest.upstream.source) errors.push(`lock '${name}': source '${entry.source}' diverso da '${manifest.upstream.source}'`);
    if (entry.sourceType !== manifest.upstream.sourceType) errors.push(`lock '${name}': sourceType '${entry.sourceType}' non previsto`);
    if (typeof entry.skillPath !== "string" || !/^[\w./-]+\/SKILL\.md$/.test(entry.skillPath) || entry.skillPath.includes("..")) errors.push(`lock '${name}': skillPath non valido`);
    if (typeof entry.computedHash !== "string" || !/^[0-9a-f]{64}$/.test(entry.computedHash)) errors.push(`lock '${name}': computedHash non valido`);
    if (entry.ref !== undefined && !/^[0-9a-f]{40}$/.test(entry.ref)) warnings.push(`lock '${name}': ref '${entry.ref}' non e' uno SHA completo (installazione non riproducibile)`);
    if (entry.ref === undefined) warnings.push(`lock '${name}': nessun ref (installazione dal branch di default, non riproducibile)`);
  }
  for (const name of managed) {
    if (!(name in lock.skills)) errors.push(`skill '${name}' nel manifest ma non nel lock`);
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Manifest e livello di personalizzazione
// ---------------------------------------------------------------------------

export function loadLayer(layerDir) {
  const manifestPath = path.join(layerDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const readPart = (rel) => {
    const base = path.resolve(layerDir);
    const full = path.resolve(base, ...rel.split("/"));
    if (!full.startsWith(base + path.sep)) throw new Error(`percorso fuori dal livello di personalizzazione: ${rel}`);
    return fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n").replace(/^\n+/, "").trimEnd();
  };
  return { dir: layerDir, manifest, readPart };
}

/** Espande le parti di un blocco in nomi canonici (policy:x | file:y). */
export function expandParts(parts, manifest) {
  const out = [];
  for (const part of parts) {
    if (part === "common") out.push(...manifest.commonParts);
    else out.push(part);
  }
  return out;
}

export function resolveParts(parts, layer) {
  const texts = [];
  for (const part of expandParts(parts, layer.manifest)) {
    if (part.startsWith("policy:")) {
      const policy = layer.manifest.policies[part.slice(7)];
      if (!policy) throw new Error(`policy sconosciuta: ${part}`);
      texts.push(layer.readPart(policy.file));
    } else if (part.startsWith("file:")) {
      texts.push(layer.readPart(part.slice(5)));
    } else {
      throw new Error(`parte non valida: ${part}`);
    }
  }
  return texts.join("\n\n");
}

/** Validazione strutturale del manifest (non verifica i testi upstream). */
export function validateManifest(layer) {
  const errors = [];
  const { manifest } = layer;
  if (manifest.version !== 1) errors.push("manifest.json: version deve essere 1");
  for (const key of ["source", "sourceType", "url"]) if (!manifest.upstream?.[key]) errors.push(`manifest.json: upstream.${key} mancante`);
  for (const [name, policy] of Object.entries(manifest.policies ?? {})) {
    try {
      layer.readPart(policy.file);
    } catch (error) {
      errors.push(`policy '${name}': ${error.message}`);
    }
  }
  for (const regex of manifest.sentinels ?? []) {
    try {
      new RegExp(regex, "i");
    } catch (error) {
      errors.push(`sentinel non valida '${regex}': ${error.message}`);
    }
  }
  for (const [skill, def] of Object.entries(manifest.skills ?? {})) {
    if (!/^[a-z0-9-]+$/.test(skill)) errors.push(`nome skill non valido: ${skill}`);
    const ids = new Set();
    for (const op of def.customizations ?? []) {
      if (!op.id || ids.has(op.id)) errors.push(`${skill}: id personalizzazione mancante o duplicato (${op.id})`);
      ids.add(op.id);
      if (!["insert", "replace"].includes(op.op)) errors.push(`${skill}/${op.id}: op deve essere insert o replace`);
      if (op.op === "insert" && !op.after && !op.afterLine) errors.push(`${skill}/${op.id}: insert richiede after:'frontmatter' o afterLine`);
      if (op.op === "insert" && op.after && op.after !== "frontmatter") errors.push(`${skill}/${op.id}: after supporta solo 'frontmatter'`);
      if (op.op === "replace" && !op.line) errors.push(`${skill}/${op.id}: replace richiede line`);
      if (!Array.isArray(op.parts) || op.parts.length === 0) errors.push(`${skill}/${op.id}: parts mancanti`);
      else {
        try {
          const text = resolveParts(op.parts, layer);
          if (/skill-customization:/.test(text)) errors.push(`${skill}/${op.id}: il testo non puo' contenere marcatori`);
        } catch (error) {
          errors.push(`${skill}/${op.id}: ${error.message}`);
        }
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Rendering e rimozione dei blocchi (idempotenti e reversibili)
// ---------------------------------------------------------------------------

// I blocchi replace portano la riga upstream originale in base64url (orig=...): opaca per il modello, che non deve
// seguirla, e indipendente dal manifest, cosi' la rimozione resta corretta anche dopo aver cambiato `line` o tolto
// l'operazione. I marcatori senza orig (formato precedente) ricadono su op.line del manifest.
const BEGIN_RE = /^<!-- skill-customization:begin (\S+) op=(insert|replace)(?: orig=([A-Za-z0-9_-]+))? -->$/;
const END_RE = /^<!-- skill-customization:end (\S+) -->$/;
const beginMarker = (id, kind, orig) => `<!-- skill-customization:begin ${id} op=${kind}${orig === undefined ? "" : ` orig=${Buffer.from(orig, "utf8").toString("base64url")}`} -->`;
const endMarker = (id) => `<!-- skill-customization:end ${id} -->`;

export function splitText(text) {
  const hasCrlf = text.includes("\r\n");
  const mixed = hasCrlf && /(^|[^\r])\n/.test(text);
  const lf = text.replace(/\r\n/g, "\n");
  const trailingNewline = lf.endsWith("\n");
  const lines = (trailingNewline ? lf.slice(0, -1) : lf).split("\n");
  return { lines, eol: hasCrlf ? "\r\n" : "\n", trailingNewline, mixed };
}

export function joinText(doc, lines = doc.lines) {
  return lines.join(doc.eol) + (doc.trailingNewline ? doc.eol : "");
}

function frontmatterEnd(lines) {
  if (lines[0] !== "---") return -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === "---") return i;
  return -1;
}

function opsForFile(def, file) {
  return (def.customizations ?? []).filter((op) => (op.file ?? "SKILL.md") === file);
}

export function customizedFiles(def) {
  return [...new Set((def.customizations ?? []).map((op) => op.file ?? "SKILL.md"))];
}

/** Applica i blocchi a un testo upstream pulito. Errori = patch incompatibile (ancora mancante o ambigua). */
export function renderText(pristine, skill, ops, layer) {
  const errors = [];
  const doc = splitText(pristine);
  if (doc.mixed) errors.push(`${skill}: fine riga misti (LF/CRLF) nel testo upstream`);
  if (doc.lines.some((line) => line.includes("skill-customization:"))) errors.push(`${skill}: il testo upstream contiene gia' marcatori di personalizzazione`);
  const placements = [];
  for (const op of ops) {
    const id = `${skill}/${op.id}`;
    let content;
    try {
      content = resolveParts(op.parts, layer).split("\n");
    } catch (error) {
      errors.push(`${id}: ${error.message}`);
      continue;
    }
    if (op.op === "insert") {
      let at = -1;
      if (op.after === "frontmatter") {
        at = frontmatterEnd(doc.lines);
        if (at < 0) errors.push(`${id}: frontmatter YAML non trovato`);
      } else {
        const hits = doc.lines.flatMap((line, i) => (line === op.afterLine ? [i] : []));
        if (hits.length !== 1) errors.push(`${id}: riga di ancoraggio ${hits.length === 0 ? "non trovata" : "ambigua (" + hits.length + " occorrenze)"}: "${op.afterLine}"`);
        else at = hits[0];
      }
      if (at >= 0) placements.push({ id, at, kind: "insert", lines: ["", beginMarker(id, "insert"), ...content, endMarker(id)] });
    } else {
      const hits = doc.lines.flatMap((line, i) => (line === op.line ? [i] : []));
      if (hits.length !== 1) errors.push(`${id}: riga da sostituire ${hits.length === 0 ? "non trovata (upstream l'ha cambiata)" : "ambigua (" + hits.length + " occorrenze)"}: "${op.line.slice(0, 120)}"`);
      else placements.push({ id, at: hits[0], kind: "replace", lines: [beginMarker(id, "replace", doc.lines[hits[0]]), ...content, endMarker(id)] });
    }
  }
  const positions = new Map();
  for (const p of placements) {
    if (positions.has(p.at)) errors.push(`${p.id}: stessa riga di ${positions.get(p.at)}`);
    positions.set(p.at, p.id);
  }
  if (errors.length) return { text: null, errors };
  const lines = [...doc.lines];
  for (const p of [...placements].sort((a, b) => b.at - a.at)) {
    if (p.kind === "insert") lines.splice(p.at + 1, 0, ...p.lines);
    else lines.splice(p.at, 1, ...p.lines);
  }
  return { text: joinText(doc, lines), errors: [] };
}

/** Rimuove i blocchi di personalizzazione e ricostruisce il testo upstream. */
export function stripText(text, skill, ops) {
  const errors = [];
  const found = [];
  const doc = splitText(text);
  const byId = new Map(ops.map((op) => [`${skill}/${op.id}`, op]));
  const out = [];
  for (let i = 0; i < doc.lines.length; i++) {
    const line = doc.lines[i];
    const begin = BEGIN_RE.exec(line);
    if (!begin) {
      if (END_RE.test(line)) errors.push(`${skill}: marcatore di fine senza inizio alla riga ${i + 1}`);
      out.push(line);
      continue;
    }
    const [, id, kind, orig] = begin;
    let j = i + 1;
    while (j < doc.lines.length && END_RE.exec(doc.lines[j])?.[1] !== id) {
      if (BEGIN_RE.test(doc.lines[j])) {
        errors.push(`${skill}: blocchi annidati o non chiusi (${id})`);
        break;
      }
      j++;
    }
    if (j >= doc.lines.length || BEGIN_RE.test(doc.lines[j])) {
      errors.push(`${skill}: blocco ${id} senza marcatore di fine`);
      return { text: null, errors, found };
    }
    found.push({ id, kind, content: doc.lines.slice(i + 1, j).join("\n") });
    if (kind === "insert") {
      if (out.length && out[out.length - 1] === "") out.pop();
    } else if (orig !== undefined) {
      out.push(Buffer.from(orig, "base64url").toString("utf8"));
    } else {
      const op = byId.get(id);
      if (!op || op.op !== "replace") {
        errors.push(`${skill}: blocco replace '${id}' sconosciuto al manifest: impossibile ricostruire il testo upstream`);
        return { text: null, errors, found };
      }
      out.push(op.line);
    }
    i = j;
  }
  return { text: errors.length ? null : joinText(doc, out), errors, found };
}

const textFile = (rel) => /\.(md|ya?ml|sh|txt)$/i.test(rel);

/** Albero upstream -> albero personalizzato. */
export function renderSkill(pristineTree, skill, layer) {
  const def = layer.manifest.skills[skill];
  const errors = [];
  const tree = new Map(pristineTree);
  for (const [rel, buf] of pristineTree) {
    if (textFile(rel) && buf.toString("utf8").includes("skill-customization:")) errors.push(`${skill}/${rel}: il testo upstream contiene marcatori di personalizzazione`);
  }
  for (const file of customizedFiles(def ?? {})) {
    const buf = pristineTree.get(file);
    if (!buf) {
      errors.push(`${skill}: file ${file} assente upstream`);
      continue;
    }
    const result = renderText(buf.toString("utf8"), skill, opsForFile(def, file), layer);
    errors.push(...result.errors);
    if (result.text !== null) tree.set(file, Buffer.from(result.text, "utf8"));
  }
  return { tree: errors.length ? null : tree, errors };
}

/** Albero installato -> albero upstream ricostruito (rimuovendo i blocchi). */
export function stripSkill(activeTree, skill, layer) {
  const def = layer.manifest.skills[skill] ?? { customizations: [] };
  const errors = [];
  const found = [];
  const tree = new Map(activeTree);
  for (const [rel, buf] of activeTree) {
    if (!textFile(rel)) continue;
    const text = buf.toString("utf8");
    if (!text.includes("skill-customization:")) continue;
    const result = stripText(text, skill, opsForFile(def, rel));
    errors.push(...result.errors.map((e) => `${rel}: ${e}`));
    found.push(...result.found.map((f) => ({ ...f, file: rel })));
    if (result.text !== null) tree.set(rel, Buffer.from(result.text, "utf8"));
  }
  return { tree: errors.length ? null : tree, errors, found };
}

// ---------------------------------------------------------------------------
// Controlli di contenuto e conflitti di policy
// ---------------------------------------------------------------------------

function parseFrontmatter(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  const data = {};
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2].trim();
    if (/^[>|][-+]?$/.test(value)) {
      const parts = [];
      while (i + 1 < end && /^\s+/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(" ");
    }
    data[m[1]] = value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return data;
}

/** Controlli sul risultato: frontmatter, blocchi presenti, testi obbligatori e vietati (policy protette). */
export function checkRenderedSkill(tree, skill, layer) {
  const errors = [];
  const def = layer.manifest.skills[skill] ?? {};
  const skillMd = tree.get("SKILL.md");
  if (!skillMd) return [`${skill}: SKILL.md mancante`];
  const fm = parseFrontmatter(skillMd.toString("utf8"));
  if (!fm) errors.push(`${skill}: frontmatter mancante o non valido`);
  else {
    if (fm.name !== skill) errors.push(`${skill}: name nel frontmatter ('${fm.name}') diverso dal nome della cartella`);
    if (!fm.description) errors.push(`${skill}: description mancante nel frontmatter`);
    else if (fm.description.length > 1024) errors.push(`${skill}: description oltre 1024 caratteri`);
  }
  const allText = [...tree].filter(([rel]) => textFile(rel)).map(([, buf]) => buf.toString("utf8").replace(/\r\n/g, "\n")).join("\n");
  const beginIds = allText.split("\n").flatMap((line) => {
    const m = BEGIN_RE.exec(line);
    return m ? [`${m[1]} ${m[2]}`] : [];
  });
  for (const op of def.customizations ?? []) {
    const id = `${skill}/${op.id}`;
    const count = beginIds.filter((x) => x === `${id} ${op.op}`).length;
    if (count !== 1) errors.push(`${id}: blocco presente ${count} volte (atteso 1)`);
  }
  const required = new Set();
  for (const op of def.customizations ?? []) {
    for (const part of expandParts(op.parts, layer.manifest)) {
      if (part.startsWith("policy:")) for (const t of layer.manifest.policies[part.slice(7)]?.requiredText ?? []) required.add(t);
    }
  }
  for (const rule of def.protect ?? []) for (const t of rule.requiredText ?? []) required.add(t);
  for (const t of required) if (!allText.includes(t)) errors.push(`${skill}: policy essenziale persa, testo obbligatorio assente: "${t}"`);
  for (const rule of def.protect ?? []) {
    for (const t of rule.forbiddenText ?? []) if (allText.includes(t)) errors.push(`${skill}: policy '${rule.policy}' violata, testo upstream vietato ancora presente: "${t}"`);
  }
  return errors;
}

/** Righe "sensibili" (commit, push, PR, merge, subagent, ...) per file. */
export function policyLines(tree, sentinels) {
  const regexes = sentinels.map((s) => new RegExp(s, "i"));
  const out = new Map();
  for (const [rel, buf] of tree) {
    if (!textFile(rel)) continue;
    const set = new Set();
    for (const raw of buf.toString("utf8").replace(/\r\n/g, "\n").split("\n")) {
      const line = raw.trim();
      if (line && regexes.some((re) => re.test(line))) set.add(line);
    }
    out.set(rel, set);
  }
  return out;
}

/** Differenze nelle righe sensibili tra due versioni upstream della stessa skill. */
export function diffPolicyLines(oldTree, newTree, sentinels) {
  const before = policyLines(oldTree, sentinels);
  const after = policyLines(newTree, sentinels);
  const changes = [];
  for (const file of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(file) ?? new Set();
    const b = after.get(file) ?? new Set();
    for (const line of b) if (!a.has(line)) changes.push({ file, change: "aggiunta", line });
    for (const line of a) if (!b.has(line)) changes.push({ file, change: "rimossa", line });
  }
  return changes;
}

/**
 * Stato di una skill installata rispetto al lock e al manifest:
 * ok | missing | uncustomized | stale | modified | malformed.
 */
export function classifySkill(activeTree, lockEntry, skill, layer) {
  if (activeTree.size === 0) return { status: "missing" };
  const stripped = stripSkill(activeTree, skill, layer);
  if (!stripped.tree) return { status: "malformed", errors: stripped.errors };
  const variant = hashMatch(stripped.tree, lockEntry?.computedHash);
  if (!variant) return { status: "modified", pristine: stripped.tree, found: stripped.found };
  const rendered = renderSkill(stripped.tree, skill, layer);
  if (!rendered.tree) return { status: "stale", pristine: stripped.tree, variant, errors: rendered.errors };
  if (treesIdentical(rendered.tree, activeTree)) return { status: "ok", pristine: stripped.tree, variant };
  if (stripped.found.length === 0) return { status: "uncustomized", pristine: stripped.tree, variant };
  return { status: "stale", pristine: stripped.tree, variant };
}
