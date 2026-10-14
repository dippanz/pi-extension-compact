Regola locale (prevale su questo passo): se l'utente chiede di rivedere lavoro non ancora committato e non indica altro, il fixed point è `HEAD`. Il perimetro della review è l'unione di:

- commit: `git diff <fixed-point>...HEAD` e `git log <fixed-point>..HEAD --oneline`;
- modifiche staged: `git diff --cached`;
- modifiche unstaged: `git diff`;
- file untracked pertinenti: `git ls-files --others --exclude-standard` (leggili per intero; i file ignorati, come `.tmp/`, restano fuori).

Il controllo "diff non vuoto" vale per questa unione: fallisci solo se sono vuote tutte e quattro le parti.
