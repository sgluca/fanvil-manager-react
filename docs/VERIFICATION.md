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
