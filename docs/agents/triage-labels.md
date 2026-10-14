# Triage labels

Le skill Matt Pocock usano cinque ruoli canonici. Il repository adotta label omonime per evitare ambiguità tra stato della richiesta, tipo di lavoro e disponibilità di un agente.

| Ruolo in `mattpocock/skills` | Label locale | Significato |
|---|---|---|
| `needs-triage` | `needs-triage` | Serve una valutazione del maintainer |
| `needs-info` | `needs-info` | Mancano informazioni del reporter |
| `ready-for-agent` | `ready-for-agent` | Richiesta specificata e pronta per un agente |
| `ready-for-human` | `ready-for-human` | Richiesta specificata che richiede intervento umano |
| `wontfix` | `wontfix` | Non verrà realizzata |

`wontfix` è già presente nel tracker; le altre label canoniche devono essere create da un maintainer autorizzato prima del primo workflow di triage. Finché una label non esiste, non sostituirla con `question`, `enhancement` o `help wanted`: segnala la configurazione mancante senza modificare il tracker implicitamente.

Le label `wayfinder:*` appartengono invece al workflow delle mappe e possono essere create quando viene avviata una mappa autorizzata. Non applicare una label di prontezza a un decision ticket Wayfinder: finché il ticket appartiene a una mappa e porta `wayfinder:<tipo>`, deve essere risolto tramite Wayfinder.
