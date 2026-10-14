# Fonti del dominio

Questo documento indica come le skill di engineering devono leggere e aggiornare la conoscenza di dominio di `pi-extension-compact`.

## Fonti canoniche attuali

Il progetto è ancora nella fase iniziale di ricerca e progettazione. Le fonti canoniche sono:

- `docs/Progetto_Pi_Context_Compaction_Pipeline_SPEC(1).md`: requisiti, termini, decisioni condivise, ipotesi, architettura candidata, roadmap e fonti tecniche;
- `AGENTS.md`: invarianti operative e architetturali del repository;
- `README.md`: introduzione pubblica, da ampliare quando esisterà un'implementazione utilizzabile;
- documentazione e contratti futuri esplicitamente aggiunti alla mappa di `AGENTS.md`.

La specifica distingue fatti verificati, scelte progettuali, ipotesi da testare e aspetti da verificare in locale. Mantieni questa distinzione in ogni aggiornamento.

## Prima di esplorare

Leggi soltanto le sezioni della specifica pertinenti al task. Per affermazioni su Pi o su progetti upstream verifica anche codice, documentazione, licenza e versione effettivamente fissata: la specifica non sostituisce l'audit dell'ambiente corrente.

## Quando emerge una decisione

Durante Wayfinder registra la decisione nella resolution del ticket e nella mappa; non modificare automaticamente documenti persistenti durante la sessione decisionale. Nel successivo task di recepimento aggiorna la fonte canonica pertinente, preservando motivazione, alternative, conseguenze, stato e riferimenti alle evidenze.

Fuori da Wayfinder modifica le fonti canoniche soltanto nel perimetro autorizzato. Se una decisione contraddice la specifica, segnala il conflitto invece di sovrascriverlo silenziosamente.

## Glossario e ADR

Non creare automaticamente `GLOSSARY.md`, `GLOSSARY-MAP.md`, `CONTEXT.md` o `docs/adr/`. Finché non viene approvata una struttura dedicata, aggiorna la terminologia e le decisioni nella specifica o nel documento canonico indicato da `AGENTS.md`. Un nuovo documento persistente richiede una decisione esplicita e deve sostituire o referenziare chiaramente la fonte precedente, senza creare fonti concorrenti.

Usa il vocabolario già presente nella specifica: compaction, checkpoint, archive, evidence reference, observation, reflection, classifier, summarizer, fast path, hybrid path e safe fallback hanno responsabilità distinte. Se manca un termine, trattalo come un gap da chiarire tramite `domain-modeling`, non come autorizzazione a inventare sinonimi incompatibili.
