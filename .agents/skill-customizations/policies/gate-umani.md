**Gate umani e ambiente:**
- Nessun `git commit`, `git push`, pull request, merge, tag o release senza autorizzazione esplicita dell'utente nella sessione corrente. Non creare commit preliminari solo per ottenere un diff. Nessun `git reset`, checkout o altra operazione distruttiva senza richiesta esplicita.
- Nessuna modifica persistente a dati, servizi remoti, configurazioni condivise o pipeline fuori dal perimetro autorizzato. Non cancellare issue, branch o dati remoti: chiudi o segnala, dopo conferma.
- Tracker: GitHub `dippanz/pi-extension-compact`, con le operazioni descritte in `docs/agents/issue-tracker.md` (label: `docs/agents/triage-labels.md`; fonti di dominio: `docs/agents/domain.md`). La configurazione esiste già: non rieseguire `/setup-matt-pocock-skills`.
- Lascia che `gh` ricavi host e repository dal remote corrente e verificali prima di ogni scrittura. Nessun test o comando remoto con effetti collaterali senza autorizzazione.
- Note, report, prototipi e script temporanei dell'agente vanno solo in `.tmp/`.
- Se lavori come subagent valgono gli stessi gate: se un passo li richiede, fermati e riporta il blocco alla sessione principale.
- Quando avvii un subagent, metti all'inizio del brief queste regole locali (gate umani e SEMPLIFICAZIONE LEGGERA, in breve) oppure chiedigli di leggere prima `.agents/skill-customizations/policies/`: molti subagent non caricano `AGENTS.md` né la skill che li ha avviati.
