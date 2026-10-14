**Regole specifiche di `implement-spec`:**
- Questa skill prevede branch di integrazione, worktree, commit, merge, PR e chiusura dei ticket. In questo repository ognuno di questi passi richiede un'autorizzazione esplicita dell'utente nella sessione corrente. Senza autorizzazione non avviare implementer o merger subagent che committano o fanno merge.
- Senza autorizzazione proponi il flusso standard: un ticket di implementazione per sessione con `/implement` (`docs/agents/guida-wayfinder.md` §7).
- Non chiudere le issue a mano: si chiudono al merge su `main` con la closing keyword decisa dall'utente.
- Le note dei subagent di esplorazione vanno in `.tmp/implement-spec/`, non in una cartella fuori dal repository. Il riallineamento di un worktree con `git reset` ("resets onto it") è un'operazione distruttiva: chiedi prima autorizzazione.
- Nei brief di exploration, implementer e merger subagent metti all'inizio le regole locali (gate umani e SEMPLIFICAZIONE LEGGERA).
