# Verifica della consegna

Verifiche eseguite il 12 novembre 2026 nell’ambiente di sviluppo isolato, Node.js 24.22.1, Docker 29.9.2. Nessun citofono reale contattato, nessuna scansione LAN, nessuna modifica ai dispositivi.

| Controllo                              | Esito                                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`                         | Superato                                                                                                                                             |
| `npm run typecheck`                    | Superato                                                                                                                                             |
| `npm run test`                         | 34 test superati, 3 suite                                                                                                                            |
| `npm run build`                        | Build web e bundle API/CLI riuscita                                                                                                                  |
| `npm run test:e2e`                     | 2 scenari Chromium superati, desktop e mobile                                                                                                        |
| `npm run format:check`                 | Superato                                                                                                                                             |
| `npm audit` sul registry npm ufficiale | 0 vulnerabilità, incluse dipendenze di sviluppo                                                                                                      |
| Docker multi-stage                     | Build riuscita, dipendenze runtime senza dev tooling                                                                                                 |
| `npm run test:docker`                  | Avvio Compose, UID 1000, healthcheck, dati persistenti dopo SIGKILL, backup/ripristino offline                                                       |
| Controllo pubblicazione                | Nessun allegato originale o ambiente incluso; ricerca dei segreti/IP degli ambienti nei file e nei blob della cronologia locale senza corrispondenze |

## Copertura significativa

- Autenticazione, richieste anonime, CSRF, RBAC, invalidazione sessioni e protezione ultimo admin.
- Cifratura autenticata, fingerprint per tipo, mascheramento e audit senza valori sensibili.
- Parser da manuale: device info, PIN senza ID stabile, log con epoch e scarto dei payload sensibili; nessuna falsa identità o verifica firmware.
- Client HTTP su server mock locale: payload di lettura, Basic Auth, DNS/IP autorizzati, redirect negati, errori HTTP, limite dimensione, timeout e concorrenza.
- Inventario di quattro modelli, i62 con due relay, aggiornamenti parziali senza perdita di dati, vincolo relay/dispositivo e appartenenza ai gruppi.
- Anteprima non mutante, credenziali sconosciute preservate, apply confermato/idempotente, conflitti, rollback e retry dopo fallimento mock.
- Import ripetuto senza duplicati, nomi uguali con riconciliazione manuale, scadenze e revoche locali.
- Deduplicazione eventi, filtri, paginazione, CSV/JSON e OpenAPI.
- Audit immutabile tramite trigger, backup SQLite consistente, restore con controlli e lock esclusivo rilasciato anche dopo crash.
- Browser: login, CRUD persona, RFID simulata, autorizzazione sul relay 2, preview/apply demo, staging/reconcile e layout mobile con navigazione da tastiera.

## Limiti della prova

I parser sono verificati contro fixture sintetiche conformi al manuale, non contro risposte dei firmware installati. Import, acquisizione eventi e scritture reali restano bloccati. La pipeline GitHub è predisposta; i risultati sopra sono quelli locali. Nessun deployment su Coolify è stato eseguito.

Durante i controlli il primo Dockerfile ha esaurito lo spazio del runner VFS: è stato sostituito con una build a meno layer e la build è stata ripetuta con successo. I test del trasporto hanno inoltre individuato un limite dimensione non correttamente propagato; il difetto è corretto e coperto da regressione.

## Correzione build Coolify con NODE_ENV=production

Riprodotto il fallimento del Dockerfile precedente passando `NODE_ENV=production` come ARG di build: npm ometteva le devDependencies e `npm run build` terminava con `vite: not found`, exit 127.

Il Dockerfile ora usa `npm ci --include=dev --strict-ssl=true`, poi rimuove le dipendenze di sviluppo prima di creare il runtime. La build con ARG di produzione è stata completata con successo. La CI ripete esplicitamente questa configurazione.

Compose è analizzabile anche senza le tre variabili sensibili/obbligatorie nell'ambiente di build. Tre test aggiuntivi verificano che l'applicazione rifiuti comunque chiavi, segreto sessione e origine HTTPS mancanti o non validi al runtime. Su Coolify le variabili applicative vanno configurate come Runtime only, senza Available at Buildtime.

## Bootstrap amministratore dal container avviato

Il comando `node dist/cli.js admin:create amministratore` accetta input interattivo nascosto sul TTY e continua a supportare stdin per automazione. Verifica manuale su pseudo-terminale: prompt visibile, password sintetica non mostrata e account creato.

Quattro test aggiuntivi verificano lock condivisi/esclusivi, singola istanza, creazione account con app avviata da un processo separato, hash password, duplicati, input non valido e rollback in caso di errore audit. Totale aggiornato: 41 test in 5 suite. Il test Compose crea ora l'amministratore con `docker compose exec` mentre il servizio è già attivo, prima di verificare login, persistenza dopo crash e backup/ripristino.

## Diagnostica delle letture Fanvil

L’Inspector restituisce codici e messaggi specifici per i blocchi di configurazione e gli errori del trasporto. Anche i tentativi falliti producono uno storico diagnostico sanitizzato e audit con codice errore. Le risposte 401 con challenge Digest vengono segnalate come autenticazione non ancora supportata, senza salvare header o body del dispositivo. Gli spazi tra reti CIDR vengono normalizzati.

Quattro test aggiuntivi coprono flag, approvazione e LAN mancante senza rete, CIDR con spazi, Basic/Digest e risposte non JSON su server locale, propagazione del codice errore e assenza di segreti in audit/diagnostica. Totale aggiornato: 45 test in 5 suite. Nessuna richiesta eseguita sui citofoni reali.
