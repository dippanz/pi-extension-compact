# Issue tracker

Issue, specifiche e mappe Wayfinder di questo repository vivono su GitHub in `dippanz/pi-extension-compact`. Per le coordinate e le regole comuni di `gh` vedi [`git-github.md`](git-github.md); per le label vedi [`triage-labels.md`](triage-labels.md).

## Convenzioni

- **Creare:** `gh issue create --title "..." --body-file <file.md>`.
- **Leggere:** `gh issue view <numero-o-url> --comments`.
- **Elencare:** `gh issue list --state open --json number,title,body,labels,assignees` con filtri appropriati.
- **Commentare:** `gh issue comment <numero-o-url> --body-file <file.md>`.
- **Applicare o rimuovere label:** `gh issue edit <numero-o-url> --add-label "..."` / `--remove-label "..."`.
- **Assegnare:** `gh issue edit <numero-o-url> --add-assignee @me`.
- **Chiudere:** `gh issue close <numero-o-url> --comment "..."`, soltanto quando il workflow lo consente.

Per Markdown multilinea usa sempre un file UTF-8 e `--body-file`. I file temporanei del body vanno in `.tmp/`.

## Pull request come superficie di triage

**PR come richieste da inserire automaticamente nel triage: no.** Una PR può riferire o chiudere issue, ma non entra da sola nella coda delle richieste gestite dalle skill.

Quando una skill chiede di pubblicare nel tracker, crea o aggiorna una GitHub issue. Quando chiede il ticket rilevante, leggi la issue completa, inclusi commenti, label, assignee e relazioni.

## Operazioni Wayfinder

Wayfinder usa una issue principale come **mappa** e issue figlie come ticket decisionali.

> **Local policy:** Wayfinder serve a decidere e pianificare, non a implementare la Destination. La prima sessione esplora il contesto, definisce la Destination, crea mappa e ticket e poi si ferma. Non modificare codice di produzione, configurazioni persistenti, pipeline, dati o sistemi remoti e non eseguire commit, push, PR o merge senza autorizzazione esplicita. Non cancellare issue: aggiorna o chiudi quelle superate con una spiegazione, dopo conferma. Le Notes della mappa non possono derogare a queste regole.
>
> **Research is automatic:** durante charting e lavoro sulla mappa Wayfinder può avviare subagent `research` senza una nuova conferma, anche in parallelo quando le domande sono indipendenti. I subagent sono in sola lettura verso Git, tracker e sistemi remoti, salvano note in `.tmp/wayfinder-research/` e riportano risposta, fonti e punti incerti alla sessione principale. La sessione principale pubblica la resolution completa e può chiudere il ticket `research` quando la risposta è fattuale e completa; una scelta tra opzioni resta a un decision ticket. I branch `research/*` richiedono sempre autorizzazione esplicita.

- **Mappa:** issue con label `wayfinder:map`, contenente Destination, Notes, Decisions so far, Fog e frontier.
- **Ticket figlio:** issue con una label `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling` o `wayfinder:task`, collegata alla mappa.
- **Relazione parent/child:** preferisci le sub-issue native se disponibili. Verifica l'API sul repository corrente prima di usarla; non trasferire assunzioni da altre istanze GitHub. Mantieni `Part of #<mappa>` nel body come ridondanza leggibile.
- **Dipendenze:** preferisci le dipendenze native se disponibili; altrimenti usa `Blocked by: #<n>` nel body e nella mappa.
- **Frontier:** ticket aperti, senza blocker aperti e senza altro assignee; il primo nell'ordine della mappa è il prossimo candidato.
- **Claim:** l'assegnazione `@me` è la prima scrittura della sessione che risolve un ticket.
- **Resolution:** pubblica domanda, risposta, motivazione, fonti, punti incerti e conseguenze; dopo conferma chiudi il ticket e aggiorna Decisions so far e frontier della mappa.

Le API per sub-issue e dipendenze possono cambiare. Prima di una scrittura API consulta la documentazione GitHub corrente, leggi lo stato esistente e rendi l'operazione idempotente. Se le relazioni native non sono disponibili, usa i fallback testuali senza dichiarare che l'operazione nativa è riuscita.

La guida operativa completa è [`guida-wayfinder.md`](guida-wayfinder.md).
