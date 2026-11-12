# Modello dati e flussi

SQLite in WAL, foreign key attive e migrazioni transazionali nella tabella `migrations`. Identità centrali UUID; identificatori remoti separati per dispositivo. Migrazione iniziale: `packages/database/src/index.ts`, costante `migration`.

- **Inventario**: devices, device_capabilities e relays. Modello e modalità fissati alla creazione. Firmware osservato distinto dal modello dichiarato; host e credenziali non esportati in audit.
- **Identità e autorizzazioni**: people, credentials, access_groups, group_memberships, access_rules. Una regola ha persona oppure gruppo e un relay appartenente al dispositivo. Disattivare una persona non elimina le sue credenziali.
- **Osservazione**: device_credentials conserva remote_id, collegamento opzionale alla credenziale e stato observed/synced. Le differenze e le operazioni pending/conflict/failed sono rappresentate da sync_jobs/sync_operations. La UI distingue l’assenza di sincronizzazione dal successo.
- **Staging**: staging_batches, staging_items e imported_people preservano provenienza, valori cifrati e mapping confermati. Nome uguale richiede scelta manuale; fingerprint uguale identifica la stessa credenziale e segnala eventuali conflitti di persona. Identità remote già mappate non sono riassegnate implicitamente.
- **Eventi**: access_events conserva UTC, origine, relay opzionale e persona opzionale. Una chiave di deduplicazione per dispositivo/evento evita doppioni. Identità assenti restano sconosciute.
- **Operazioni**: diagnostics conserva solo metadati allowlisted; audit_logs impedisce UPDATE/DELETE con trigger. admin_users e sessions gestiscono hash Argon2id e token HMAC, nessun token sessione in chiaro nel DB.
- **Demo**: mock_remote conserva uno stato remoto cifrato e versionato. Import e apply lavorano sullo stesso mock persistente; la rilettura verifica le modifiche. Nessun trasporto di rete.

La preview calcola un hash dello stato locale, delle regole e dello stato remoto mock. Apply rifiuta una preview obsoleta, richiede conferma e opera in transazione. Rimuove solo elementi noti e già gestiti, o esplicitamente revocati; non elimina credenziali remote sconosciute. Una seconda applicazione della stessa preview completata restituisce lo stesso esito senza ripetere le operazioni.

Backup tramite `node:sqlite.backup`, non copia del file WAL. Il ripristino offline usa lo stesso lock del processo applicativo, verifica la compatibilità e conserva un backup precedente alla sostituzione.
