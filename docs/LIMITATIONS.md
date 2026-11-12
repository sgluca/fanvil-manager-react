# Compatibilità e limitazioni note

## Disponibile

App e API persistenti, sicurezza, inventario, persone/credenziali, gruppi e regole, relay distinti, staging/reconcile, preview/apply mock, eventi demo, audit e backup/ripristino. I dati demo sono sintetici. Il funzionamento offline dei citofoni non dipende dalla console, che non interviene sulla loro configurazione.

## Manuale e hardware

Il manuale HTTP API V0.8.7 chiarisce i payload ma non prova la compatibilità dei firmware installati. I parser sono testati su esempi sintetici, nessuna capability hardware è `verified`. Il campo Model può essere generico. Il numero relay deriva dal modello dichiarato, non da discovery certificata.

A10 non è elencato per card_info/password_info/persons/device_log; queste capacità sono unsupported sulla base del manuale. Per gli altri modelli restano unknown fino a test autorizzati. Il relay CGI A10 è documentato ma non implementato.

## Intenzionalmente bloccato o limitato

- Nessuna scrittura hardware, apertura porta, reboot, reset, modifica ora, import remoto o sincronizzazione automatica.
- Importazione ed acquisizione eventi reali non abilitate senza validazione per firmware e identità remote stabili. Inspector restituisce solo metadati sanitizzati; dispositivo info riconosciuto può aggiornare firmware e ultimo contatto.
- Letture card/PIN/persons/log limitate alla pagina 1–100; non rappresentano un inventario completo. userlist escluso perché non documentato per i modelli di questo progetto.
- Autenticazione Digest non implementata; Basic è quella della collezione, il manuale è contraddittorio.
- Revoche, scadenze, stato persona e permessi descrivono lo stato locale/desiderato; non promettono restrizioni sui citofoni. Finestre temporali disabilitate.
- Stato fisico porta sempre sconosciuto; nessun comando è presentato come misura dello stato porta.
- Export eventi della pagina filtrata, massimo 200 righe via parametro API limit. Audit UI mostra le ultime 100 righe; l’API è paginata.
- Nessun reset password via email, servizio cloud, multiistanza o rotazione automatica chiave.
- Retention audit e backup separata da quella eventi; audit applicativo immutabile, non storage WORM.

## Per validare in futuro

Usare un dispositivo di test e ottenere consenso per i comandi specifici. Acquisire risposte sanitizzate e firmware esatto; confrontare supporto e semantica relay, identità remota, paginazione, reason per elemento e timestamp. Solo dopo implementare un adapter versionato con rilettura e idempotenza, mantenendolo dietro flag disattivato e conferma esplicita. Non riutilizzare il payload ambiguo `reboot` dello ZIP.
