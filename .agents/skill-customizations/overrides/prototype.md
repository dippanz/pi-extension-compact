**Regole specifiche di `prototype`:**
- Durante Wayfinder il prototipo è sempre temporaneo e scartabile; fuori da Wayfinder lo è salvo richiesta esplicita. Mettilo in `.tmp/prototypes/<slug>/` e non integrarlo mai automaticamente nel codice di produzione.
- Non aggiungere route, script in `package.json`, dati, servizi o configurazioni persistenti nel codice versionato senza autorizzazione esplicita. Usa solo stato in memoria o file locali in `.tmp/`.
