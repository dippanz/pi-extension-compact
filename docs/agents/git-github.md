# GitHub e GitHub CLI

Coordinate comuni per le operazioni GitHub di questo repository.

- Repository: `dippanz/pi-extension-compact`.
- Host: `github.com`.
- Usa `gh` dalla root del clone e lascia che ricavi repository e host dal remote `origin`.
- Prima di operazioni remote verifica `gh auth status` e il repository con `gh repo view --json nameWithOwner,url`.
- Usa file UTF-8 con `--body-file` per body Markdown multilinea; evita quoting fragile inline.
- Nessun comando remoto con effetti collaterali senza autorizzazione esplicita, salvo le scritture sul tracker previste e autorizzate dal workflow Wayfinder.
- Per issue e workflow Wayfinder vedi `issue-tracker.md`.
- Per il mapping delle label di triage vedi `triage-labels.md`.
