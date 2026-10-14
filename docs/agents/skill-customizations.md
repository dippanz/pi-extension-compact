# Skill degli agenti: installazione, personalizzazioni e aggiornamento

Questo repository gestisce le skill upstream di [`mattpocock/skills`](https://github.com/mattpocock/skills) elencate in `skills-lock.json`. Il contenuto upstream resta separato dalle regole locali: le regole vivono in `.agents/skill-customizations/` e vengono applicate alle copie generate in `.agents/skills/`.

Le skill locali non presenti nel lock non vengono aggiornate da questo meccanismo. Le skill globali dell'utente in `~/.agents/skills/`, `~/.pi/agent/`, `~/.codex/skills/` o directory equivalenti non vengono modificate.

## Requisiti e comandi

Servono Node.js 20 o superiore e Git. Gli script non richiedono dipendenze npm; `install` e `update` scaricano upstream da GitHub.

| Comando | Uso | Effetto |
|---|---|---|
| `npm run skills:install` | dopo clone, modifiche a lock/personalizzazioni o copie alterate | ricostruisce le skill al commit fissato e applica le personalizzazioni; non aggiorna il lock |
| `npm run skills:verify` | in qualsiasi momento | verifica lock, copie, personalizzazioni, policy, Git, link e discovery Pi senza modificare file |
| `npm run skills:update` | per valutare novità upstream | aggiorna in modo transazionale, applica le personalizzazioni e fa rollback in caso di errore |
| `npm run skills:restore` | per annullare l'ultima operazione | ripristina skill, lock e `validatedRef` da un backup; accetta `-- --backup <nome>` |
| `npm run skills:test` | dopo modifiche a script, manifest, policy o override | esegue i test offline e del livello reale; con `SKILLS_TEST_NETWORK=1` include la reinstallazione da GitHub |

Codici di uscita: `0` successo; `1` errore; `2` stop che richiede una decisione umana; `3` uso non valido. Gli script non eseguono commit, push, PR o merge.

## Struttura

`.agents/skill-customizations/` è versionata e contiene:

- `manifest.json`: sorgente upstream, commit validato, percorsi, operazioni di personalizzazione, sentinel e policy protette;
- `policies/`: regole comuni inserite nelle skill;
- `overrides/`: modifiche specifiche per skill;
- `scripts/`: motore di installazione, verifica, update, rollback e probe Pi;
- `tests/`: test `node --test` del motore e della configurazione reale.

Ogni personalizzazione è delimitata da marcatori `skill-customization:begin` e `skill-customization:end`. Il rendering è reversibile e idempotente: rimuovendo i blocchi si deve ottenere il contenuto upstream il cui hash è registrato nel lock. Non modificare direttamente un blocco generato dentro `.agents/skills/`; modifica policy, override o manifest e rigenera.

Le operazioni supportate sono `insert` dopo il frontmatter, `insert` dopo una riga esatta (`afterLine`) e `replace` di una riga esatta (`line`). `file` consente di intervenire sui file collegati alla skill. Le ancore devono essere univoche. Per i replace, il marcatore conserva la riga upstream codificata per permettere lo strip esatto senza mostrarla come istruzione al modello.

## Policy locali

Le skill gestite ricevono, salvo eccezioni dichiarate nel manifest:

- SEMPLIFICAZIONE LEGGERA, che migliora la chiarezza senza ridurre la profondità del ragionamento;
- gate umani per commit, push, PR, merge, release, operazioni distruttive e scritture remote;
- riferimenti al tracker GitHub, alle label e alle fonti di dominio di `docs/agents/`;
- propagazione delle regole locali nei brief dei subagent;
- template di ticket più chiari senza perdere sezioni, criteri o dipendenze upstream.

`grilling` resta invariata per scelta e riceve le regole dalla skill chiamante. `wayfinder` decide e pianifica senza implementare; `research` resta in sola lettura; `prototype` usa `.tmp/prototypes/`; `domain-modeling` rispetta le fonti di [`domain.md`](domain.md); `implement` non committa automaticamente.

La guida operativa di Wayfinder è [`guida-wayfinder.md`](guida-wayfinder.md).

## Installazione dopo un clone

```powershell
npm run skills:install
npm run skills:verify
```

`install` scarica upstream ai commit del lock, verifica gli hash, applica le personalizzazioni, valida il risultato e crea `.claude/skills` come link verso `.agents/skills`. Le copie generate e il link sono ignorati da Git.

Dopo `install` o `update`, usa `/reload` in Pi; per altri agenti apri una nuova sessione. Pi carica le skill di progetto soltanto se il progetto è considerato attendibile.

## Aggiornamento upstream

```powershell
npm run skills:update
```

Il comando:

1. acquisisce `.tmp/skills/run.lock` e valida manifest, lock e copie;
2. clona upstream in `.tmp/skills/run-*` e verifica provenienza e hash;
3. individua soltanto le skill del lock che sono cambiate;
4. segnala modifiche a righe sensibili relative a Git, subagent, tracker, label e invocazione;
5. applica override e controlla policy protette;
6. prepara staging e validazione Pi prima di sostituire le copie;
7. salva un backup, aggiorna lock e `validatedRef` e verifica il risultato;
8. esegue rollback in caso di errore;
9. scrive il report in `.tmp/skills/reports/latest-update.md`.

Se upstream non cambia le skill del lock, il comando non modifica nulla. Le opzioni principali sono `--dry-run`, `--ref <sha|branch|tag>`, `--accept-policy-changes`, `--discard-local-changes`, `--no-pi` e `--keep-temp`; con npm vanno dopo `--`, per esempio `npm run skills:update -- --dry-run`.

Dopo un update rileggi `git diff -- skills-lock.json .agents/skill-customizations/manifest.json`, il report e le skill cambiate. `--accept-policy-changes` autorizza soltanto il controllo dei sentinel: non sostituisce la revisione umana delle nuove istruzioni upstream.

## Verifica e conflitti

`npm run skills:verify` controlla:

- validità e formato canonico di manifest e lock;
- commit upstream fissati e assenza di valori simili a credenziali;
- corrispondenza tra copie, lock e personalizzazioni;
- presenza delle policy protette;
- link `.claude/skills`, regole Git e skill globali omonime;
- caricamento tramite la discovery Pi, se Pi è disponibile.

Rimedi comuni:

| Problema | Rimedio |
|---|---|
| skill mancante o personalizzazioni assenti | `npm run skills:install` |
| copia diversa dal lock | salva eventuali modifiche necessarie, poi `npm run skills:install -- --discard-local-changes` |
| ancora upstream sparita o duplicata | aggiorna `line`/`afterLine`, override e protezioni, poi rigenera |
| righe sensibili cambiate | leggi report e diff; usa `--accept-policy-changes` solo dopo approvazione |
| skill globale omonima | valuta manualmente la precedenza; gli script non modificano directory globali |
| skill spostata o rimossa upstream | decidi se mantenere il commit, aggiornare percorso o rimuoverla da lock e manifest |

Un conflitto semantico incerto va sottoposto a una persona. Le verifiche testuali dimostrano la presenza delle policy, non che un modello le seguirà sempre.

## Ripristino

- Per ricostruire copie mancanti o alterate: `npm run skills:install`.
- Per annullare l'ultima operazione: `npm run skills:restore`.
- Per scegliere un backup: `npm run skills:restore -- --backup <nome>`.
- Lock, manifest, policy e override sono versionati e possono essere ripristinati anche tramite Git su richiesta esplicita.

I backup vivono in `.tmp/skills/backups/` e non vengono versionati. Se un processo si interrompe durante lo swap, il comando successivo segnala il journal e il backup recuperabile.

## Modificare una personalizzazione

1. Modifica il testo in `overrides/` o `policies/`.
2. Aggiorna l'operazione corrispondente in `manifest.json`; usa un `id` univoco e un'ancora upstream esatta.
3. Per una regola essenziale aggiorna `protect.requiredText` e, se necessario, `forbiddenText`.
4. Aggiorna i test del livello reale.
5. Esegui `npm run skills:install`, `npm run skills:verify` e `npm run skills:test`.
6. Rileggi la skill generata e il diff dei file versionati.

Per aggiungere una skill upstream, esegui `npx skills add mattpocock/skills --skill <nome>` per far generare alla CLI la voce di lock e la copia iniziale, aggiungi la skill a `manifest.json` (anche con `customizations: []`), quindi esegui `npm run skills:update` per fissare commit e hash e applicare le regole locali. Rileggi il diff prima di accettarlo. Non usare `npx skills update` come workflow ordinario: può sostituire le copie con versioni upstream prive delle regole locali.

## Versionamento

Sono versionati `skills-lock.json`, `package.json`, `.agents/skill-customizations/` e questa documentazione. Sono locali e ignorati `.agents/skills/`, `.claude/skills/`, `.tmp/skills/` e gli altri artefatti runtime.

`skills-lock.json` resta nel formato della CLI e contiene per ogni skill `source`, SHA `ref`, `sourceType`, `skillPath` e `computedHash`. Il commit sul quale le personalizzazioni sono state validate è `upstream.validatedRef` nel manifest.

Su sistemi con regole CRLF diverse la CLI esterna può calcolare hash differenti; il motore locale normalizza il confronto. Se una copia viene sostituita, `skills:verify` lo rileva e `skills:install` la ricostruisce.
