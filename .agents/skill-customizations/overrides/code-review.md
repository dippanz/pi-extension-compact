**Regole specifiche di `code-review`:**
- Perimetro: rivedi i commit dal fixed point e anche le modifiche staged, unstaged e i file untracked pertinenti. Non creare commit, stash o branch per ottenere un diff.
- Se il chiamante ti ha già dato ticket o specifica (URL, numero o testo), usali per l'asse Spec e salta la ricerca della specifica.
- Se non hai un tool per avviare subagent (o sei già un subagent), esegui le due analisi in sequenza nello stesso contesto: prima Standards, poi Spec.
- In ogni caso tieni separati i report `## Standards` e `## Spec`, senza unire né riordinare i risultati tra i due assi.
- La review è in sola lettura: non modificare file.
