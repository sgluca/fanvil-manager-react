# Fanvil Manager — Specifica di sviluppo per Codex

## Mandato
Implementa una piattaforma web self-hosted per amministrare centralmente i citofoni IP Fanvil della parrocchia. Lavora in autonomia sul repository, creando codice funzionante, migrazioni, test, documentazione e deployment. Non limitarti a un mockup. Mantieni le funzioni non supportate o non verificate esplicitamente disabilitate.

**Input obbligatorio:** `Fanvil HTTP API.zip`, fornito dall'utente. Prima di implementare gli adapter, estrai e analizza tutti i file YAML della collezione (formato OpenCollection/Bruno), inclusi body, auth, esempi e ambienti. La collezione è la fonte primaria per la sintassi delle richieste, **non** una garanzia che tutti gli endpoint funzionino su ogni firmware. Non assumere che gli esempi HTTP 200 con body vuoto rappresentino risposte reali. Non copiare password, token, indirizzi sensibili o credenziali degli ambienti nel repository, nei test snapshot o nei log. Usa i file di ambiente esclusivamente come riferimento locale e produci esempi sanitizzati.

## Contesto e vincoli
- Dispositivi: Fanvil i60K (1 relay), i60 (1 relay), A10 (1 relay), i62 (2 relay). Versioni firmware ignote; identificarle tramite API dove possibile.
- I dispositivi sono raggiungibili nella LAN; Coolify gira nella stessa rete.
- Accesso amministrativo attuale tramite interfaccia web dei citofoni.
- RFID e PIN sono già configurati: **non cancellarli, non sovrascriverli, non resettare i dispositivi**.
- I citofoni devono continuare ad aprire autonomamente le porte quando Fanvil Manager è offline.
- Interfaccia in italiano, responsive, moderna, con stati di errore e di sincronizzazione chiari.
- Stack: React + Vite + TypeScript; backend Node.js + Fastify + TypeScript; SQLite; Docker Compose per Coolify. Nessun ASP.NET Core. Preferire un solo container applicativo per il deploy iniziale e un volume SQLite persistente.

## Funzioni di prodotto
1. **Dashboard:** dispositivi configurati, stato ultima connessione, firmware, numero relay, ultimi eventi, sync in attesa e anomalie. Non confondere raggiungibilità HTTP con reale stato della porta.
2. **Dispositivi:** CRUD, nome, modello, IP/hostname, credenziali cifrate, firmware, relay e nomi logici, profilo capacità per firmware, test connessione, diagnostica read-only, stato supporto API.
3. **Persone:** anagrafica unica, note, gruppi, stato attivo/inattivo, credenziali associate. Evitare di creare doppioni durante l'import; proporre riconciliazione manuale.
4. **Credenziali:** più RFID per persona, PIN, data di scadenza, revoca, origine e stato di sincronizzazione. Mascherare i valori sensibili nell'interfaccia e negli audit. Non memorizzare PIN in chiaro; se è indispensabile rispedirli ai citofoni, usare cifratura autenticata e chiave fuori dal DB. Distinguere credenziali esistenti ma non leggibili.
5. **Autorizzazioni:** gruppi, regole persona/gruppo → dispositivo/relay, eventuali finestre temporali soltanto se realmente supportate dal firmware. Non simulare restrizioni non applicate sul dispositivo.
6. **Relay:** trattare ogni relay come entità distinta; i62 ne ha due dichiarati. Distinguere stato comando da stato fisico porta. Apertura remota inizialmente disabilitata; richiede API validata, permesso elevato, conferma esplicita e audit.
7. **Log:** acquisizione eventi dove supportata, paginazione, filtri per dispositivo/persona/relay/periodo/esito, esportazione CSV/JSON, deduplicazione e provenienza dell'evento. Gestire timestamp e fuso Europe/Rome; non inventare identità RFID mancanti.
8. **Sincronizzazione:** stato desiderato vs stato rilevato, import iniziale non distruttivo, anteprima differenze (dry-run), conflitti, applicazione esplicitamente confermata, verifica post-scrittura, retry sicuro, log di esito per dispositivo. Nessuna eliminazione implicita di credenziali sconosciute.
9. **Amministrazione:** login, ruoli (admin/operatore/lettura), audit immutabile a livello applicativo, backup/ripristino SQLite, esportazioni e diagnostica.

## Analisi API obbligatoria
Costruisci `docs/FANVIL_API_MATRIX.md` estraendo dalla collezione, per ogni richiesta: file sorgente, metodo, URL, schema del body, auth, tipo di operazione (lettura/scrittura/potenzialmente pericolosa), campi noti, risposta documentata, dubbi e stato di verifica per modello/firmware. La collezione contiene, fra gli altri:
- `POST /api/device_info` (informazioni modello/firmware/stato);
- `POST /api/config` (configurazione);
- `POST /api/card_info` (esempio `cmd: add`, campo `relay: all`);
- `POST /api/password_info` (gestione PIN, schema da chiarire);
- `GET/POST /api/persons` (persone);
- `GET/POST /api/userlist` (import/export utenti);
- `POST /api/device_log` (log aperture);
- `GET/POST /api/access_log` (eventi riconoscimento facciale, se pertinenti);
- `POST /api/device` (controllo dispositivo).

**ATTENZIONE:** nell'esempio di `/api/device` compare `type.cmd: reboot` insieme a `dooropen`. Non eseguire questa richiesta sui dispositivi reali: potrebbe riavviarli. Non dedurre un comando alternativo di apertura senza evidenza. Non assumere che `relay: all` implichi valori numerici supportati. Non usare operazioni `add`, `delete`, `import`, `reboot`, apertura relay o modifica dell'ora in discovery.

Realizza un `FanvilHttpClient` con HTTP Basic Auth se confermata dalla collezione, timeout, gestione degli errori, redazione dei segreti, logging strutturato, limiti di concorrenza e allowlist dei dispositivi configurati. Non consentire richieste arbitrarie a URL scelti dall'utente tramite un endpoint proxy. Crea adapter basati su capacità (`supported`, `unsupported`, `unknown`, `verified`) per modello e firmware. La funzione non supportata deve fallire in modo esplicito, mai inventare un risultato.

## Discovery e importazione sicura
Implementa un **API Inspector** read-only:
- registrazione manuale di un IP e credenziali;
- probe modello/firmware/MAC/uptime tramite `/api/device_info`;
- diagnostica degli endpoint di sola lettura e salvataggio di metadati delle risposte sanitizzati;
- visualizzazione stato di ogni capability con motivo e provenienza;
- importazione in staging delle persone, RFID, PIN e log soltanto se leggibili;
- anteprima e conferma della riconciliazione dei dati in SQLite.

I test con citofoni reali non sono eseguibili da Codex salvo che l'utente abbia esplicitamente fornito un ambiente di test e autorizzato i comandi specifici. Non effettuare scansioni di rete non richieste. La prima release deve funzionare in modalità demo con adapter mock realistici.

## Architettura del repository
```text
fanvil-manager/
  apps/web/                 # React, Vite, TypeScript
  apps/api/                 # Fastify, TypeScript
  packages/shared/         # DTO, Zod schema, tipi
  packages/fanvil-core/    # client HTTP, adapter, capability matrix
  packages/database/       # SQLite, migrazioni, repository
  docs/                    # analisi API, modello dati, sicurezza, deploy
  tests/                   # fixture sanitizzate e test integrazione
  Dockerfile
  compose.yaml
  .env.example
  README.md
  SPEC.md
```

Servire la build React e le API tramite Fastify nello stesso origin per evitare CORS superfluo. Usare validazione Zod per input/output, migrazioni SQLite, transazioni, foreign key e indici per eventi/sync. Implementare endpoint REST per dispositivi, diagnostica, persone, credenziali, gruppi, regole, relay, eventi, sync preview/apply e audit; documentarli con OpenAPI. Nessun endpoint di scrittura Fanvil deve essere abilitato per default.

## Modello dati minimo
`devices`, `device_capabilities`, `relays`, `people`, `credentials`, `access_groups`, `group_memberships`, `access_rules`, `device_credentials`, `access_events`, `sync_jobs`, `sync_operations`, `audit_logs`, `admin_users`, `sessions`.

Usa UUID per le entità centrali e conserva identificativi remoti separati. Per `device_credentials` prevedi stato `observed`, `desired`, `pending`, `synced`, `conflict`, `failed` o equivalente. Non associare automaticamente due persone solo perché condividono un nome. Le credenziali non recuperabili devono avere uno stato esplicito.

## Sicurezza
- Accesso autenticato con password hashate Argon2id (o equivalente robusto), cookie HttpOnly/Secure/SameSite, protezione CSRF dove necessaria, rate limit, RBAC lato API.
- Chiave `ENCRYPTION_KEY` e segreto sessione da variabili d'ambiente Coolify, mai nel repository; cifratura autenticata dei segreti dei dispositivi e dei PIN reversibili se necessari.
- Log senza password, PIN, numeri completi delle tessere, header Authorization o payload di configurazione sensibili.
- Bloccare SSRF: dispositivi registrati e approvati, IP/hostname validati, nessun redirect automatico verso host sconosciuti; accesso limitato alla LAN autorizzata.
- Se i Fanvil supportano solo HTTP, documentare il rischio delle credenziali Basic in transito e suggerire segmentazione di rete; non dichiarare cifrata la comunicazione LAN.
- Audit di modifiche ai permessi, operazioni di sync, tentativi di apertura e amministrazione.
- Policy configurabile di conservazione log personali; non registrare più dati del necessario.

## Coolify e Docker
- `compose.yaml` con un servizio applicativo, healthcheck, restart policy e volume persistente per `/app/data`.
- `Dockerfile` multi-stage: build web/api, runtime Node non-root, immagine snella.
- Configurazione dominio tramite proxy Coolify e HTTPS, senza esporre direttamente porte API pubbliche.
- `.env.example` con `NODE_ENV`, `PORT`, `DATABASE_PATH`, `ENCRYPTION_KEY`, `SESSION_SECRET`, `TZ=Europe/Rome`, eventuali parametri di timeout e retention.
- Documentare backup consistenti SQLite (non semplice copia del DB mentre WAL è attivo), ripristino, migrazioni e upgrade.
- Nessuna dipendenza da servizi cloud esterni.

## UI richiesta
Layout con navigazione laterale: Dashboard, Dispositivi, Persone, Credenziali, Gruppi e Permessi, Eventi, Sincronizzazioni, Impostazioni. Per ogni dispositivo mostra modello, firmware, relay, ultimo contatto, capacità verificate, diagnostica e import. Form con validazioni, filtri, ricerca, empty state, skeleton/loading, errori e conferme per azioni pericolose. Accessibilità tastiera e layout mobile. Dati demo chiaramente contrassegnati.

## Test e qualità
- Unit test per normalizzazione risposte, gestione errori, capability detection, differenze di sync, deduplicazione log e permessi.
- Integration test Fastify + SQLite temporaneo e mock HTTP Fanvil; fixture derivate dalla collezione ma sanitizzate.
- Test end-to-end per login, CRUD persona, aggiunta RFID simulata, preview sync, import senza cancellazioni e gestione relay multipli.
- Test negativo: nessun comando pericoloso durante probe; `reboot` mai invocato; PIN e segreti mai nei log; nessuna sincronizzazione automatica distruttiva.
- `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build` e build Docker devono riuscire.

## Sequenza di implementazione
1. Ispeziona ZIP, documenta matrice API e incertezze. Non fare chiamate reali.
2. Crea monorepo, schema DB, autenticazione, Fastify, React, Docker/Coolify e dati demo.
3. Implementa inventario dispositivi e API Inspector read-only con adapter mock e client reale configurabile.
4. Implementa persone, credenziali, gruppi, permessi e relay multipli.
5. Implementa import in staging, riconciliazione e sync preview/dry-run.
6. Implementa log, audit, backup, test e documentazione.
7. Implementa adapter di scrittura solo per operazioni con schema verificato; mantenerli dietro feature flag disattivato. Non attivare su dispositivi reali senza test e consenso.

## Definition of Done
- Applicazione funzionante localmente e deployabile su Coolify con `docker compose up --build -d`.
- UI e API reali, DB persistente, autenticazione, anagrafica, gruppi, permessi, inventario e demo funzionanti.
- Inspector read-only, matrice compatibilità, import non distruttivo e anteprima sync.
- Test automatici verdi e README con avvio, credenziali iniziali sicure, configurazione Coolify, backup e limitazioni note.
- Nessun comando Fanvil non verificato presentato come operativo; nessuna modifica ai dispositivi senza consenso esplicito.

## Istruzioni operative per Codex
Inizia esaminando il repository e lo ZIP. Crea un piano breve, poi implementa in modo incrementale. Non fermarti a chiedere dettagli non bloccanti: usa configurazioni sicure e documenta le assunzioni. Non inventare risposte o endpoint Fanvil; se manca uno schema, crea interfaccia e mock, segna la capability come `unknown` e documenta cosa serve verificare. Alla fine riporta file creati, test eseguiti, funzioni disponibili, limiti delle API e istruzioni precise di deploy Coolify.
