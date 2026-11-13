# Compatibilità e limitazioni note

## Disponibile

App e API persistenti, sicurezza, inventario, persone/credenziali, gruppi e regole, relay distinti, staging/reconcile, preview/apply mock, eventi demo, audit e backup/ripristino. I dati demo sono sintetici. Il funzionamento offline dei citofoni non dipende dalla console, che non interviene sulla loro configurazione.

## Manuale e hardware

Il manuale HTTP API V0.8.7 chiarisce i payload ma non prova la compatibilità dei firmware installati. I parser sono testati su esempi sintetici, nessuna capability hardware è `verified`. Il campo Model può essere generico. Il numero relay deriva dal modello dichiarato, non da discovery certificata.

A10 non è elencato per card_info/password_info/persons/device_log; queste capacità sono unsupported sulla base del manuale. Per gli altri modelli restano unknown fino a test autorizzati. Il relay CGI A10 è documentato ma non implementato.

## Intenzionalmente bloccato o limitato

- Nessuna scrittura hardware, apertura porta, reboot, reset, modifica ora, import remoto o sincronizzazione automatica.
- Import (carte, PIN) ed eventi reali sono in sola lettura, solo admin e solo dispositivi approvati; i parser seguono il manuale e **non** sono verificati sul firmware: una risposta non conforme interrompe l’operazione senza importare nulla. Il numero carta non è mai esposto: l’identificativo remoto è un’impronta HMAC (cambiare `ENCRYPTION_KEY` rompe il collegamento con importazioni precedenti). Un PIN senza refid e senza valore non ha identità e viene ignorato; il conteggio è nel riepilogo.
- Letture complete a finestre da 100 (max 50 pagine); se il firmware ignora l’indice o si supera il limite la lettura è marcata incompleta. Inspector: una sola finestra. Persone e userlist: solo diagnostica strutturale, nessun import.
- Autenticazione Digest non implementata; Basic è quella della collezione, il manuale è contraddittorio.
- Revoche, scadenze, stato persona e permessi descrivono lo stato locale/desiderato; non promettono restrizioni sui citofoni. Finestre temporali disabilitate.
- Stato fisico porta sempre sconosciuto; nessun comando è presentato come misura dello stato porta.
- Export eventi della pagina filtrata, massimo 200 righe via parametro API limit. Audit UI mostra le ultime 100 righe; l’API è paginata.
- Nessun reset password via email, servizio cloud, multiistanza o rotazione automatica chiave.
- Retention audit e backup separata da quella eventi; audit applicativo immutabile, non storage WORM.

## Per validare in futuro

Usare un dispositivo di test e ottenere consenso per i comandi specifici. Acquisire risposte sanitizzate e firmware esatto; confrontare supporto e semantica relay, identità remota, paginazione, reason per elemento e timestamp. Solo dopo implementare un adapter versionato con rilettura e idempotenza, mantenendolo dietro flag disattivato e conferma esplicita. Non riutilizzare il payload ambiguo `reboot` dello ZIP.

## Elenco utenti CSV (i60K 2.12.55)

Su questo firmware `card_info` e `password_info` rispondono con liste vuote e codice diverso da 200; carte, PIN e nomi sono nell’export CSV di `GET /api/userlist` (osservato dall’utente, non nel manuale per questo modello). Se le letture JSON sono vuote, **Importa** legge il CSV: ignora righe disattivate o senza credenziali e il PIN segnaposto `*`; carta e PIN della stessa riga vanno alla stessa persona; righe senza nome ricevono un nome provvisorio. Stato (Period/Disable), numero di usi e relay del dispositivo **non** sono rappresentati nelle credenziali locali: le righe con limite sono segnalate nel riepilogo. Il CSV contiene carte e PIN in chiaro: transita nella LAN e viene cifrato nel database.

## Gruppo accessi rilevati

Dopo la riconciliazione di un import viene creato (o aggiornato) un gruppo locale «Accesso rilevato · <dispositivo>» con le persone le cui credenziali sono presenti sul dispositivo e un permesso su ogni relay. Il pulsante **Gruppo accessi** del dispositivo lo genera anche per import già riconciliati. L’elenco utenti e card_info non indicano un relay affidabile: sull’i62 vengono assegnati entrambi i relay, da correggere a mano se necessario. L’aggiornamento è solo additivo; eliminando il dispositivo il gruppo generato viene rimosso. Persone e credenziali mostrano nella colonna **Apre** i dispositivi/relay raggiungibili tramite permessi diretti o gruppi.

## Lettura nuova tessera

**Leggi nuova tessera** (solo admin per i dispositivi reali) non mette il citofono in modalità emissione e non scrive nulla: legge il log aperture (`device_log`), memorizza gli id presenti, e dopo il passaggio della tessera cerca i nuovi eventi con un numero tessera nei campi `extra`/`extraJson` (forme accettate: `C:<hex>`, solo cifre/hex, JSON con `cardNumber`; `P:` è un PIN e viene sempre ignorato). Il formato di `extra` per le tessere sconosciute non è documentato nel manuale né verificato sul firmware: se il numero non viene riconosciuto la UI mostra solo il prefisso e la lunghezza del campo, per adattare il parser. Il codice rilevato è mostrato all’amministratore e può essere salvato come credenziale RFID (cifrata). Il log è letto con il limite di 50 pagine: su log molto lunghi i nuovi eventi potrebbero non essere raggiunti. In alternativa: modalità emissione carte dall’interfaccia web del citofono, poi **Importa**.
