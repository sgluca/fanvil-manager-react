# Fanvil Manager

Console self-hosted in italiano per inventario Fanvil, persone, credenziali, gruppi, permessi desiderati, eventi e sincronizzazione simulata. React + Vite + TypeScript, Fastify e SQLite, unico container non-root per Coolify. Nessuna dipendenza da servizi cloud a runtime.

**Non è stata eseguita alcuna chiamata ai citofoni reali.** Le scritture reali sono bloccate nel backend. I mock sono funzionanti e persistenti, non semplici schermate statiche.

## Avvio locale

Richiede Node.js 24 e npm. Da Bash nella cartella del progetto:

```bash
npm ci
cp .env.example .env
```

Modifica `.env`: `NODE_ENV=development`, `DATABASE_PATH=data/fanvil.sqlite`, `PUBLIC_ORIGIN=http://localhost:3000`, `DEMO_MODE=true`. Genera due segreti distinti con `openssl rand -hex 32`: assegna il primo a `ENCRYPTION_KEY` e il secondo a `SESSION_SECRET`. Non commettere `.env`.

```bash
set -a
source .env
set +a
read -rs -p 'Password amministratore (almeno 12 caratteri): ' admin_password
printf '\n'
printf '%s' "$admin_password" | npm run admin:create -- amministratore
unset admin_password
npm run build
npm start
```

Apri `http://localhost:3000`. Non esiste una password predefinita. La prima esecuzione con `DEMO_MODE=true` aggiunge quattro dispositivi sintetici; i62 ha due relay. Disabilitare la variabile non cancella i dati demo: utilizzare un volume distinto per l'ambiente operativo.

Per lo sviluppo: `npm run dev` serve l’API e l’ultima build web sulla porta 3000; per HMR avvia anche `npx vite --config apps/web/vite.config.ts`. Il proxy Vite inoltra `/api`; il browser deve usare un’origine coerente con `PUBLIC_ORIGIN`.

## Funzionalità

- Login Argon2id, sessioni SQLite, ruoli admin/operatore/lettura, CSRF e rate limit.
- Inventario CRUD, nomi logici dei relay, diagnostica read-only con approvazione esplicita e controllo LAN.
- Persone, più RFID/PIN, credenziali illeggibili, revoca e scadenza locali, gruppi, membri e permessi persona/gruppo → relay.
- Import mock in staging e riconciliazione confermata. Nessuna fusione automatica per nome; reimport idempotente.
- Anteprime con confronto versionato, protezione da conflitti, applicazione idempotente e verifica successiva nel mock. Credenziali remote sconosciute preservate.
- Eventi con provenienza, paginazione, filtri e export CSV/JSON della pagina corrente. UTC nel database, Europe/Rome nella UI.
- Audit protetto da modifica/cancellazione tramite API e trigger SQL, backup consistente e ripristino offline.
- OpenAPI autenticata su `/api/docs` e `/api/docs/json`.

Le scadenze, le revoche e i permessi locali **non diventano vincoli del dispositivo** senza un'applicazione verificata. I contatti HTTP e lo stato del lock non certificano lo stato fisico della porta.

## Deployment su Coolify

1. Collega il repository `sgluca/fanvil-manager-react` a Coolify e crea una risorsa **Docker Compose** usando `compose.yaml`.
2. Configura `ENCRYPTION_KEY` (64 caratteri hex), `SESSION_SECRET` (almeno 32 caratteri casuali) e `PUBLIC_ORIGIN=https://tuo-dominio`. Imposta il dominio del servizio `app` sulla porta interna **3000**, con HTTPS tramite proxy Coolify. Non aggiungere porte pubblicate sul nodo.
   Imposta le variabili applicative, inclusi `NODE_ENV`, `ENCRYPTION_KEY` e `SESSION_SECRET`, come **Runtime only**: disattiva **Available at Buildtime**. Nessuna variabile applicativa è necessaria per compilare il frontend. La fase Docker di build installa comunque esplicitamente le devDependencies con `npm ci --include=dev`, anche se Coolify passa `NODE_ENV=production`; vengono rimosse prima di creare l'immagine runtime. Compose può essere analizzato per la build senza segreti; l'applicazione rifiuta invece l'avvio se chiave, segreto sessione o origine HTTPS mancano o non sono validi.
3. Lascia `FANVIL_READ_ENABLED=false`, `FANVIL_WRITE_ENABLED=false`, `DEMO_MODE=false` per la configurazione iniziale operativa. Per una demo separata usa `DEMO_MODE=true` con un volume distinto.
4. Avvia il deploy. Il volume nominato `fanvil_data` persiste `/app/data`; non eliminarlo durante gli aggiornamenti. Il primo avvio applica migrazioni transazionali.
5. Apri il terminale del container `app` in Coolify e crea l’amministratore con l’applicazione avviata:

```bash
cd /app
node dist/cli.js admin:create amministratore
```

Inserisci una password di 12–200 caratteri quando richiesta: l’input è nascosto. Dopo `Amministratore creato`, accedi al portale con utente `amministratore` e la password appena scelta. Non esiste una password predefinita. Un nome già presente viene rifiutato senza cambiare la password dell’account esistente.

Da una shell del server puoi eseguire lo stesso comando con `docker compose exec app node dist/cli.js admin:create amministratore`. Per automazione rimane supportato l’input della password tramite stdin con `-T`, senza inserirla negli argomenti del comando.

La creazione utente e il relativo audit avvengono nella stessa transazione SQLite. Il lock condiviso permette questa operazione mentre il portale è attivo; il lock esclusivo continua a richiedere il servizio fermato per backup/ripristino CLI e seed demo. Un lock separato impedisce l’avvio di una seconda istanza applicativa sullo stesso database.

Su un host Docker configurato, dopo aver preparato `.env`, l’avvio standard è `docker compose up --build -d`. Il container è non-root, filesystem principale read-only, `/tmp` temporaneo, healthcheck `/api/health`, restart `unless-stopped`. Il volume nuovo riceve la proprietà dell’utente Node. Volumi importati devono essere leggibili/scrivibili dall’UID 1000.

### Letture reali, solo in un ambiente autorizzato

La release non effettua discovery automatica né scansioni. Il client è configurabile, ma non è stato provato sui tuoi dispositivi.

- `FANVIL_READ_ENABLED=true` abilita solo le letture esplicite dell’Inspector.
- `FANVIL_ALLOWED_CIDRS` è una lista di reti LAN autorizzate separata da virgole. Lasciarla vuota blocca tutte le destinazioni reali. La registrazione deve essere approvata da un admin.
- Sono esclusi loopback, link-local/metadata, multicast e IP pubblici. Tutti gli IP risolti devono essere autorizzati; la connessione usa un indirizzo già validato per evitare DNS rebinding. Redirect sempre bloccati.
- `FANVIL_TIMEOUT_MS` (100–60000, default 5000); massimo due richieste concorrenti e 1 MiB per risposta. Letture per indice limitate alla prima pagina 1–100, non un inventario completo.
- Autenticazione **Basic** confermata dalla collezione; il manuale menziona anche Digest. Digest non è implementata: una risposta 401 richiede diagnosi e non provoca fallback automatici.
- TLS verificato per HTTPS. Se il dispositivo usa solo HTTP, Basic e payload attraversano la LAN in chiaro: segmentare la rete e limitarne l’accesso.

## Backup, ripristino e upgrade

Il pulsante in Impostazioni scarica un backup SQLite consistente tramite API nativa di backup (schema versione 1 nell’header `X-Fanvil-Schema-Version` e nella tabella migrations). Conservare i backup protetti insieme a una copia separata della chiave: senza la **ENCRYPTION_KEY originale** i segreti non sono recuperabili.

CLI a servizio fermato (stessa immagine, volume e variabili):

```bash
docker compose stop app
docker compose run --rm -T app node dist/cli.js backup /app/data/backups/prima-upgrade.sqlite
docker compose run --rm -T app node dist/cli.js restore /app/data/backups/prima-upgrade.sqlite
docker compose up -d
```

Il comando backup genera anche un sidecar JSON con metadati; copiare entrambi fuori dall’host. Non fare una semplice copia del file SQLite mentre WAL è attivo. Il restore acquisisce un lock, controlla integrità, versione e foreign key, salva una copia preventiva del DB corrente e sostituisce il database offline. Le sessioni contenute nel backup tornano con esso: ruotare `SESSION_SECRET` dopo un ripristino per invalidarle.

Prima di un upgrade: fermare app, creare backup, distribuire nuova immagine, riavviare e verificare healthcheck/login/inventario. Per rollback ripristinare immagine e backup compatibili. Non avviare più repliche sullo stesso SQLite.

`EVENT_RETENTION_DAYS` (1–3650, default 90) elimina periodicamente eventi vecchi e diagnostica; lo staging applicato perde i valori cifrati oltre la retention. Gli audit, privi di valori delle credenziali, restano conservati. Gestire separatamente la retention dei backup.

## Qualità

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npx playwright install chromium
npm run test:e2e
docker build -t fanvil-manager:local .
npm run test:docker
```

I test HTTP avviano un server mock sull’interfaccia privata **locale** del runner; non contattano dispositivi. E2E usa SQLite temporaneo e un account sintetico creato solo dal test. I file di ambiente originali e le credenziali non entrano nelle fixture.

In ambienti con proxy TLS ispettivo la build accetta opzionalmente `--secret id=proxy_ca,src=/percorso/ca.pem`; Coolify con accesso normale a Internet non richiede questo secret.

Documentazione: [matrice API](docs/FANVIL_API_MATRIX.md), [modello dati](docs/DATA_MODEL.md), [sicurezza](docs/SECURITY.md), [limitazioni](docs/LIMITATIONS.md), [verifica](docs/VERIFICATION.md).

Il test Docker usa un progetto Compose e un volume temporanei distinti; verifica UID 1000, healthcheck, persistenza dopo SIGKILL e backup/ripristino, poi elimina solo le proprie risorse.
