# Sicurezza

## Confini

Nessuna chiamata hardware durante sviluppo o test. Nessun endpoint proxy, scansione di rete, reboot, reset o scrittura Fanvil nel trasporto disponibile. `FANVIL_WRITE_ENABLED` non aggira il blocco: questa release non contiene adapter di scrittura hardware abilitabili. I serializzatori puri conformi al manuale non hanno trasporto associato.

Basic Auth è la modalità del client confermata dallo ZIP. Il manuale 0.8.7 è contraddittorio su Basic/Digest; firmware Digest-only richiede implementazione successiva. HTTP non cifra credenziali o payload, HTTPS verifica certificati. Usare VLAN/ACL e HTTPS sul proxy Coolify.

## Autenticazione e autorizzazioni

Password Argon2id. Token sessione casuali a 256 bit, solo HMAC con SESSION_SECRET nel DB, scadenza 8 ore. Cookie HttpOnly/SameSite=Strict, Secure obbligatorio in produzione. CSRF per ogni mutazione autenticata, controllo Origin se presente, niente CORS. Login limitato a otto tentativi/minuto per IP; limite generale 600 richieste/minuto. Rate limiter in memoria: istanza singola.

Admin gestisce dispositivi reali/approvazioni/segreti, utenti, backup e audit. Operatore gestisce dati operativi, inventario demo, regole, staging e sync mock. Lettura consulta i dati operativi ed esporta la pagina eventi; logout consentito a tutti. Nessun ruolo legge valori completi di PIN, RFID o password via API.

## Dati e log

AES-256-GCM con nonce casuale a 96 bit; ENCRYPTION_KEY esterna, 32 byte hex. PIN e RFID reversibili sono cifrati; HMAC separato per tipo consente confronto senza plaintext. Valori mascherati nelle API; PIN completamente mascherato. Lo stato mock e le operazioni di sync sono cifrati. Snapshot di risposta diagnostici contengono struttura, non raw body. Il parser log scarta extra/extraJson, foto, numeri tessera e PIN.

Logger strutturato senza body né URL completo delle richieste, con redazione di Cookie e Authorization. Errori interni restituiscono messaggi generici. Audit contiene ID, azione e metadati minimi; immutabile a livello applicativo e tramite trigger, non protetto da un amministratore del filesystem/DB. Backup e chiavi devono essere protetti e custoditi separatamente.

## SSRF e rete

Registrazione manuale e approvazione admin. Lista operazioni fissa, rete autorizzata per CIDR, esclusione pubblici/loopback/link-local/multicast, tutti gli indirizzi DNS validati e singolo IP fissato alla connessione. Redirect disattivati, timeout DNS/HTTP, limite 1 MiB e due operazioni concorrenti. Nessuna URL di download remota ricavata da userlist viene seguita.

## Manutenzione

Processo applicativo e creazione utenti CLI acquisiscono un lock condiviso di manutenzione; un lock esclusivo separato impedisce una seconda istanza applicativa. Backup/ripristino CLI e seed richiedono il lock esclusivo di manutenzione e il servizio fermato. Il bootstrap utente funziona anche nel container avviato: password nascosta sul TTY oppure stdin per automazione, hash Argon2id e inserimento utente/audit nella stessa transazione. I duplicati non sovrascrivono account esistenti. Restore solo offline, integrity_check e foreign_key_check prima di sostituire il DB, copia preventiva, audit di ripristino. Per invalidare sessioni dopo restore ruotare SESSION_SECRET. ENCRYPTION_KEY non ha rotazione automatica: conservarla, non sostituirla su un DB esistente senza una migrazione di ricifratura.

## Dipendenze

Lockfile versionato. Audit npm completo: zero vulnerabilità al controllo di consegna. Override mirato di minimatch 11 per typescript-estree per correggere una vulnerabilità DoS del tool di lint; compatibilità verificata con lint e typecheck. Ripetere audit e test quando si aggiornano le dipendenze.
