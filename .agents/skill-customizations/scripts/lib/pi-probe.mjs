// Carica le skill con l'SDK di Pi e stampa un JSON. Sola lettura.
// Uso:
//   node pi-probe.mjs <cartellaPacchettoPi> project <cwdProgetto> [agentDir]
//     come Pi all'avvio o dopo /reload (DefaultResourceLoader): impostazioni in memoria (nessun pacchetto
//     installato), progetto trusted, estensioni/prompt/temi/file di contesto disattivati.
//   node pi-probe.mjs <cartellaPacchettoPi> dir <cartellaSkill>
//     solo parsing di una cartella (loadSkillsFromDir), senza scoperta nelle cartelle antenate.
import path from "node:path";
import { pathToFileURL } from "node:url";

const [pkgDir, mode, target, agentDirArg] = process.argv.slice(2);
const pi = await import(pathToFileURL(path.join(pkgDir, "dist", "index.js")).href);
let result;
let agentDir = null;
if (mode === "dir") {
  result = pi.loadSkillsFromDir({ dir: target, source: "project" });
} else {
  agentDir = agentDirArg || pi.getAgentDir();
  const settingsManager = pi.SettingsManager.inMemory({}, { projectTrusted: true });
  const loader = new pi.DefaultResourceLoader({
    cwd: target,
    agentDir,
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  result = loader.getSkills();
}
const prompt = pi.formatSkillsForPrompt ? pi.formatSkillsForPrompt(result.skills) : "";
process.stdout.write(
  JSON.stringify({
    version: pi.VERSION ?? null,
    agentDir,
    skills: result.skills.map((s) => ({
      name: s.name,
      filePath: s.filePath,
      scope: s.sourceInfo?.scope ?? null,
      disableModelInvocation: Boolean(s.disableModelInvocation),
      inPrompt: prompt.includes(`<name>${s.name}</name>`),
    })),
    diagnostics: (result.diagnostics ?? []).map((d) => ({ type: d.type, message: d.message, path: d.path ?? null })),
  }),
);
