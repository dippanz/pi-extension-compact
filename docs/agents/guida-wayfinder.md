# Guida operativa a Wayfinder

Questa guida descrive il workflow locale per usare la skill `wayfinder` in `pi-extension-compact`. La configurazione del tracker è in [`issue-tracker.md`](issue-tracker.md), le fonti di dominio in [`domain.md`](domain.md), le label in [`triage-labels.md`](triage-labels.md) e la manutenzione delle skill in [`skill-customizations.md`](skill-customizations.md).

> **Ricerca automatica.** Durante charting e lavoro sulla mappa Wayfinder può avviare subagent `research` senza chiedere di nuovo, anche in parallelo quando le domande sono indipendenti. I subagent leggono repository, documentazione e fonti esterne, ma non scrivono su Git, tracker o sistemi remoti. Salvano note in `.tmp/wayfinder-research/` e restituiscono risposta, fonti e punti incerti alla sessione principale, che pubblica la resolution completa. I branch `research/*` restano sotto gate umano e non vengono creati, committati o pubblicati senza autorizzazione.

## 1. Che cosa fa Wayfinder

Wayfinder trasforma un problema ancora ambiguo in una mappa di decisioni verificabili. Non implementa la Destination: chiarisce ciò che bisogna sapere o decidere prima che l'implementazione possa essere scomposta in ticket eseguibili.

Una mappa contiene:

- **Destination:** stato finale osservabile;
- **Notes:** vincoli e contesto che non possono derogare alle policy locali;
- **Decisions so far:** decisioni confermate e riferimenti alle resolution;
- **Fog:** incertezze ancora non trasformate in ticket;
- **Frontier:** ticket risolvibili ora, senza blocker aperti;
- **Out of scope:** aspetti esplicitamente esclusi.

La mappa è una issue con label `wayfinder:map`. Ogni domanda autonoma diventa una issue figlia con una sola label `wayfinder:<tipo>`:

| Tipo | Quando usarlo | Risultato |
|---|---|---|
| `research` | manca un fatto verificabile | risposta con fonti e punti incerti |
| `grilling` | servono preferenze o decisioni umane | decisione motivata e confermata |
| `prototype` | una prova scartabile riduce l'incertezza | verdetto, non codice da integrare |
| `task` | attività decisionale meccanica o verifica circoscritta | esito verificabile |

Le label classificano il ticket; non lo risolvono e non sostituiscono parent, blocker o assignee.

## 2. Gate e modalità operative

Wayfinder resta decision-only. Durante una sessione Wayfinder non:

- implementa il prodotto o modifica automaticamente codice di produzione;
- modifica configurazioni persistenti, pipeline, dati o sistemi remoti fuori dal workflow tracker autorizzato;
- esegue commit, push, PR, merge, tag o release senza autorizzazione esplicita;
- cancella issue o accetta una scelta non banale senza conferma;
- lascia che le Notes della mappa disattivino questi gate.

La sessione può lavorare in modalità interattiva oppure autonomamente entro un perimetro già autorizzato. L'autonomia consente esplorazioni e ricerche in sola lettura, non effetti collaterali aggiuntivi.

## 3. Preparazione del repository

Dalla root verifica la configurazione:

```powershell
Test-Path .\docs\agents\issue-tracker.md
Test-Path .\docs\agents\domain.md
Test-Path .\skills-lock.json
npm run skills:verify
```

Dopo un clone o se la verifica segnala copie mancanti:

```powershell
npm run skills:install
npm run skills:verify
```

Per aggiornare upstream usa soltanto `npm run skills:update`; per annullare l'ultima operazione usa `npm run skills:restore`. I dettagli sono in [`skill-customizations.md`](skill-customizations.md). Dopo una rigenerazione usa `/reload` in Pi o apri una nuova sessione nell'agente utilizzato.

Verifica anche GitHub CLI:

```powershell
gh auth status
gh repo view --json nameWithOwner,url
```

Il repository atteso è `dippanz/pi-extension-compact` su `github.com`. Nessuna autenticazione o scrittura remota va eseguita implicitamente.

## 4. Prima sessione: charting

La prima sessione deve:

1. leggere `AGENTS.md`, la specifica e soltanto il contesto pertinente;
2. cercare nel repository i fatti già verificabili;
3. formulare una Destination osservabile;
4. raccogliere vincoli, decisioni esistenti e fog residua;
5. trasformare domande precise in ticket;
6. creare la issue mappa e le issue figlie autorizzate;
7. collegare parent e blocker con relazioni native quando disponibili, altrimenti con fallback testuali;
8. avviare le ricerche indipendenti consentite;
9. restituire URL della mappa, frontier iniziale, fog residua e ricerche avviate;
10. fermarsi senza risolvere decision ticket nella stessa sessione.

Prompt di avvio suggerito:

```text
/skill:wayfinder

Leggi AGENTS.md e la configurazione in docs/agents/. Esplora il repository e la specifica per definire una Destination verificabile. Crea una mappa Wayfinder con ticket decisionali piccoli, parent e blocker espliciti. Puoi avviare automaticamente i ticket research con subagent in sola lettura e pubblicarne la resolution completa; non implementare la Destination, non creare branch research/* e non eseguire commit, push, PR o merge. Dopo il charting restituisci mappa, frontier, fog e ricerche avviate, poi fermati.
```

Prima di ogni scrittura mostra, quando utile, il piano delle issue da creare. Evita ticket duplicati: cerca issue aperte e chiuse pertinenti e collega ciò che esiste già.

## 5. Sessioni successive: un ticket alla volta

Ogni nuova sessione:

1. apre la mappa e legge Decisions so far, Fog, figli, blocker e assignee;
2. calcola la frontier con lo stato attuale del tracker;
3. sceglie il primo ticket non assegnato e senza blocker aperti;
4. esegue il claim assegnandolo a `@me`;
5. svolge soltanto il lavoro decisionale del ticket;
6. presenta la decisione e attende conferma quando non è banale o già presa;
7. pubblica una resolution completa;
8. chiude il ticket, se autorizzato dal workflow;
9. aggiorna Decisions so far, Fog e frontier della mappa;
10. si ferma: non risolve più di un decision ticket per sessione.

Prompt di continuazione:

```text
/skill:wayfinder

Riprendi la mappa <URL>. Verifica lo stato reale di figli, blocker e assignee, scegli il primo ticket della frontier e assegnalo a me come prima scrittura. Risolvi un solo ticket. Prima di chiudere una decisione non banale mostrami il verdetto; poi pubblica una resolution autosufficiente e aggiorna la mappa. Non implementare la Destination e non eseguire operazioni Git remote senza autorizzazione.
```

Una resolution autosufficiente contiene almeno:

- domanda o obiettivo;
- risposta o decisione;
- evidenze e fonti;
- alternative considerate;
- conseguenze e vincoli;
- punti ancora incerti;
- impatto sugli altri ticket e sulla Destination.

## 6. Ricerca, grilling e prototipi

### Ricerca

Il subagent `research` è in sola lettura. La sessione principale fa il claim, prepara un brief delimitato, riceve il report e pubblica sul tracker risposta, fonti e incertezze. Le note locali in `.tmp/wayfinder-research/` non sono una fonte condivisa e non sostituiscono la resolution. Se la ricerca presenta opzioni senza una risposta fattuale unica, il ticket research documenta i fatti e lascia la scelta a un ticket `grilling` o `task`.

### Grilling

Usa grilling per preferenze, trade-off o criteri che richiedono il proprietario del progetto. Non trasformare una preferenza in fatto tecnico e non chiudere il ticket finché la decisione non è stata confermata.

### Prototipi

Un prototipo serve a rispondere a una domanda specifica. Vive in `.tmp/prototypes/<slug>/`, è scartabile e non viene integrato automaticamente. La resolution conserva domanda, esperimento, limiti, risultato e decisione; il codice del prototipo non diventa produzione senza un task separato e autorizzato.

## 7. Dalla mappa all'implementazione

La mappa è pronta per l'handoff quando:

- la Destination è chiara e verificabile;
- non restano decisioni necessarie nella Fog;
- tutti i decision ticket richiesti sono risolti;
- vincoli, rischi e out of scope sono espliciti;
- le fonti canoniche da aggiornare sono identificate.

Il passaggio ordinario è:

1. usare `to-spec` per produrre una specifica implementabile dalle decisioni confermate;
2. usare `to-tickets` per scomporre la specifica in slice con criteri di accettazione e dipendenze;
3. usare `implement` o `implement-spec` in sessioni separate;
4. recepire le decisioni nelle fonti canoniche indicate da [`domain.md`](domain.md).

I ticket di implementazione non sono decision ticket Wayfinder. Devono indicare parent/spec, dipendenze, scope, implementazione attesa, criteri verificabili e test richiesti. Commit e PR restano sotto gate umano; quando richiesti usano le convenzioni di `AGENTS.md`.

## 8. Relazioni e fallback nel tracker

Prima di usare API per sub-issue o dipendenze native, verifica che gli endpoint siano disponibili su `github.com` per il repository corrente. Leggi prima lo stato per rendere le operazioni idempotenti.

Se una relazione nativa non è disponibile:

- mantieni una task list dei figli nel body della mappa;
- inserisci `Part of #<mappa>` nel ticket;
- inserisci `Blocked by: #<n>` per ogni blocker;
- calcola la frontier rileggendo ticket e blocker, senza presumere sincronizzazione automatica.

Non dichiarare mai creata una relazione che non è stata verificata. Le label `wayfinder:*` possono essere create al primo utilizzo autorizzato con descrizioni coerenti, senza modificare le label di triage esistenti.

## 9. Troubleshooting

**Il comando skill non appare.** Esegui `npm run skills:verify`; se mancano copie o personalizzazioni usa `npm run skills:install`, poi `/reload` in Pi o una nuova sessione.

**La verifica trova una skill globale omonima.** La copia globale può prevalere su quella di progetto. Valuta manualmente se disabilitarla; gli script non modificano configurazioni utente.

**Un aggiornamento upstream si ferma sulle policy.** Leggi report e diff. Aggiorna override e test; usa `--accept-policy-changes` solo dopo aver verificato che le nuove istruzioni rispettino i gate.

**La frontier sembra vuota.** Controlla ticket chiusi, assignee, blocker e fallback testuali. Una mappa può essere completa oppure avere Fog non ancora trasformata in ticket.

**Una ricerca ha prodotto una scelta.** Pubblica i fatti e crea o aggiorna un ticket decisionale; non far scegliere al subagent.

**Un ticket è stato superato.** Non cancellarlo. Dopo conferma chiudilo con un commento che spiega quale decisione o ticket lo sostituisce.

## 10. Checklist

### Prima del charting

- [ ] `AGENTS.md` e fonti pertinenti letti.
- [ ] `npm run skills:verify` riuscito.
- [ ] `gh repo view` punta a `dippanz/pi-extension-compact`.
- [ ] Destination e perimetro della sessione compresi.

### Dopo il charting

- [ ] Una sola mappa canonica creata.
- [ ] Ticket piccoli, con tipo, parent e blocker espliciti.
- [ ] Frontier e Fog visibili.
- [ ] Ricerche automatiche limitate al perimetro e in sola lettura.
- [ ] Nessuna implementazione o operazione Git non autorizzata.

### Dopo una resolution

- [ ] Un solo ticket decisionale risolto nella sessione.
- [ ] Resolution autosufficiente pubblicata.
- [ ] Decisione confermata quando necessario.
- [ ] Mappa e frontier aggiornate.
- [ ] Nessuna evidenza rimasta soltanto in `.tmp/`.

## Riferimenti

- [Wayfinder di Matt Pocock, commit validato](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/docs/engineering/wayfinder.md)
- [Sorgente della skill Wayfinder, commit validato](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/wayfinder/SKILL.md)
- [`issue-tracker.md`](issue-tracker.md)
- [`domain.md`](domain.md)
- [`skill-customizations.md`](skill-customizations.md)
