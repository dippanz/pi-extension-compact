**Regole specifiche di `domain-modeling`:**
- Le fonti canoniche del dominio sono elencate in `docs/agents/domain.md`. In questo repository `GLOSSARY.md`, `GLOSSARY-MAP.md`, `CONTEXT.md` e `docs/adr/` indicano quelle fonti: non creare documenti di dominio paralleli senza una decisione esplicita.
- Durante Wayfinder registra termini e decisioni nel tracker (resolution del ticket), non in file persistenti; il consolidamento nelle fonti canoniche avviene dopo, secondo `docs/agents/domain.md`.
- Fuori da Wayfinder modifica le fonti canoniche solo nel perimetro del task, preservando stato, motivazione, alternative, conseguenze e riferimenti alle evidenze.
