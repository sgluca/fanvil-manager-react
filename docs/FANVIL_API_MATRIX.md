# Matrice Fanvil HTTP API

Fonte: collezione OpenCollection 1.0.0, 17 YAML (13 richieste, configurazione e 3 ambienti). Autenticazione HTTP Basic ereditata dalla collezione; gli ambienti risolvono baseUrl con prefisso /api. Nessuna richiesta eseguita sui dispositivi.

| File sorgente                        | Metodo e URL              | Auth            | Operazione                            | Risposta documentata | Stato modello/firmware              |
| ------------------------------------ | ------------------------- | --------------- | ------------------------------------- | -------------------- | ----------------------------------- |
| Import User List.yml                 | POST `/api/userlist`      | Basic ereditata | Scrittura / potenzialmente pericolosa | 200, body vuoto      | unknown su tutti i modelli/firmware |
| Get Person List Summary.yml          | GET `/api/persons`        | Basic ereditata | Lettura documentata, non verificata   | 200, body vuoto      | unknown su tutti i modelli/firmware |
| Get-Delete Face Recognition Log.yml  | POST `/api/access_log`    | Basic ereditata | Lettura documentata, non verificata   | 200, body vuoto      | unknown su tutti i modelli/firmware |
| Card Management.yml                  | POST `/api/card_info`     | Basic ereditata | Scrittura / potenzialmente pericolosa | 200, body vuoto      | unknown su tutti i modelli/firmware |
| Export User List.yml                 | GET `/api/userlist`       | Basic ereditata | Lettura documentata, non verificata   | 200, body vuoto      | unknown su tutti i modelli/firmware |
| Control Device.yml                   | POST `/api/device`        | Basic ereditata | Scrittura / potenzialmente pericolosa | 200, body vuoto      | unknown su tutti i modelli/firmware |
| Person Management.yml                | POST `/api/persons`       | Basic ereditata | Lettura documentata, non verificata   | 200, body vuoto      | unknown su tutti i modelli/firmware |
| Device Info & Status.yml             | POST `/api/device_info`   | Basic ereditata | Lettura documentata, non verificata   | 200, body vuoto      | unknown su tutti i modelli/firmware |
| Configuration Setting.yml            | POST `/api/config`        | Basic ereditata | Lettura documentata, non verificata   | 200, body vuoto      | unknown su tutti i modelli/firmware |
| Password Management.yml              | POST `/api/password_info` | Basic ereditata | Scrittura / potenzialmente pericolosa | 200, body vuoto      | unknown su tutti i modelli/firmware |
| Set Time.yml                         | POST `/api/time`          | Basic ereditata | Scrittura / potenzialmente pericolosa | 200, body vuoto      | unknown su tutti i modelli/firmware |
| Open Door Log.yml                    | POST `/api/device_log`    | Basic ereditata | Lettura documentata, non verificata   | 200, body vuoto      | unknown su tutti i modelli/firmware |
| Get Face Recognition Log Details.yml | GET `/api/access_log`     | Basic ereditata | Lettura documentata, non verificata   | 200, body vuoto      | unknown su tutti i modelli/firmware |

## Incertezze e blocchi

- Tutti i body di risposta sono vuoti: non costituiscono fixture reali, né prova di successo. Nessuna compatibilità i60K/i60/A10/i62 verificata.
- `Device Info & Status.yml`: body principale con nove campi `info.*`, esempio con `info: {}`. Il client usa il body principale; non attribuisce significati fisici ai campi DoorLook senza validazione firmware.
- `/card_info`: solo esempio `add`, `relay: all`, `status: period`, `times` stringa. Nessuna prova di indici relay, lettura, revoca, scadenze o idempotenza. Non abilitato.
- `/password_info`: array contenente oggetto vuoto. Schema insufficiente per leggere o scrivere PIN. Non abilitato.
- `/device`: combina `type.cmd: reboot` e `dooropen`. Potenziale riavvio: nessun invio né comando alternativo inventato. Apertura reale bloccata.
- `/config`: cmd get ma payload valorizzato. Escluso dall'inspector iniziale per cautela; nessun cambio SIP.
- `/time`: modifica l'orologio. Escluso.
- `/access_log`: funzionalità facciale non confermata per i modelli previsti; esclusa dall'inspector iniziale.
- `/persons`, `/userlist`, `/device_log`: letture documentate ma formato risposta e paginazione non specificati; diagnostica strutturale soltanto, import reale disabilitato finché manca parser verificato.
- La collezione permette timeout illimitato e redirect: il client impone invece timeout, limite dimensione, nessun redirect.
- Gli ambienti contengono segreti: non inclusi nel repository. Tutte le fixture applicative sono sintetiche e marcate demo.

## Schemi delle richieste

### Import User List.yml

Campi e struttura del body sanitizzato:

```json
{
  "type": {
    "cmd": "add"
  },
  "userList": [
    {
      "serverUrl": "http://IP:Port/filename"
    }
  ]
}
```

### Get Person List Summary.yml

Campi e struttura del body sanitizzato:

```json
null
```

### Get-Delete Face Recognition Log.yml

Campi e struttura del body sanitizzato:

```json
{
  "type": {
    "cmd": "get",
    "condition": "index",
    "subtype": "success"
  },
  "accessLog": {
    "index": "1-5"
  }
}
```

### Card Management.yml

Campi e struttura del body sanitizzato:

```json
{
  "type": {
    "cmd": "add",
    "condition": "cardNumber"
  },
  "card": [
    {
      "name": "Persona demo",
      "cardNumber": "DEMO-CARD-001",
      "status": "period",
      "relay": "all",
      "times": "5"
    }
  ]
}
```

### Export User List.yml

Campi e struttura del body sanitizzato:

```json
null
```

### Control Device.yml

Campi e struttura del body sanitizzato:

```json
{
  "type": {
    "cmd": "reboot"
  },
  "dooropen": {
    "relay": "1",
    "action": "on",
    "mode": "once"
  }
}
```

### Person Management.yml

Campi e struttura del body sanitizzato:

```json
{
  "type": {
    "cmd": "get",
    "condition": "index"
  },
  "persons": [{}]
}
```

### Device Info & Status.yml

Campi e struttura del body sanitizzato:

```json
{
  "type": {
    "item": "device info",
    "cmd": "get"
  },
  "info": {
    "info.dev.Model": "",
    "info.sys.FwVersion": "",
    "info.dev.Mac": "",
    "info.sys.UpTime": "",
    "info.sys.MemFree": "",
    "info.sip.line.1.registerCode": "",
    "info.sip.line.1.callStatus": "",
    "info.io.DoorLook.1.Status": "",
    "info.io.DoorLook.2.Status": ""
  }
}
```

### Configuration Setting.yml

Campi e struttura del body sanitizzato:

```json
{
  "type": {
    "cmd": "get"
  },
  "config": {
    "sip.line.1.RegEnabled": "1"
  }
}
```

### Password Management.yml

Campi e struttura del body sanitizzato:

```json
{
  "type": {
    "cmd": "add"
  },
  "password": [{}]
}
```

### Set Time.yml

Campi e struttura del body sanitizzato:

```json
{
  "type": {
    "cmd": "set"
  },
  "data": {
    "time": "2023-11-14 16:51:00",
    "timeZone": "UTC+8"
  }
}
```

### Open Door Log.yml

Campi e struttura del body sanitizzato:

```json
{
  "type": {
    "cmd": "get",
    "condition": "index"
  },
  "deviceLog": {
    "index": "1-100",
    "datetime": "2023.06.26 13:00:00-2023.06.29 16:30:00"
  }
}
```

### Get Face Recognition Log Details.yml

Campi e struttura del body sanitizzato:

```json
null
```

## Integrazione del manuale HTTP API V0.8.7 (2025-05-22)

Il PDF fornito successivamente è una seconda fonte: chiarisce gli schemi, ma non verifica l'hardware. Le incertezze dello ZIP sopra sono conservate come confronto tra fonti; i chiarimenti seguenti prevalgono nei parser documentati. Il PDF originale non viene pubblicato.

| Argomento      | Evidenza manuale                                                                           | Decisione implementativa                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autenticazione | §2.1 p.9 parla di Digest; §1.3 mostra Authorization Basic; ZIP Basic                       | Basic configurato dalla collezione; Digest non implementato, nessun fallback automatico. Documentare il conflitto e diagnosticare 401 senza esporre header.                                                                                                           |
| Device info    | §3.2.1 pp.10–11: item `device_info`, `info` e `code: "200"`                                | Il manuale differisce dalla collezione. Dopo la prova Bruno riportata dall’utente su i60K 2.12.55, il client mantiene `device info` nella richiesta e `device_info` nella risposta. Modello può essere generico: non sovrascrivere automaticamente quello registrato. |
| Relay          | §3.2.3.3 p.14: cmd `relayCtrl`, relay `1`/`2`/`all`, action `on`/`off`, mode `once`/`long` | Serializzatore puro per `on/once`; nessun trasporto di scrittura abilitato. `reboot` dello ZIP escluso.                                                                                                                                                               |
| A10            | §3.1 p.10 e §3.2.3.4 p.14                                                                  | Device info documentato; card/password/persons/device_log esclusi dall'elenco A10. Relay CGI distinto, non implementato.                                                                                                                                              |
| RFID           | §3.7 pp.30–35: get per indice, `card` oggetto nella richiesta e array nella risposta       | Aggiunta lettura fissa 1–100 e parser; status e relay hanno tipi incoerenti tra esempi, nessuna conversione automatica dei permessi.                                                                                                                                  |
| PIN            | §3.8 pp.36–41: type, name, password, refid, status, relay; get per indice                  | Parser e serializzatore puro aggiunti; refid vuoto non è un'identità stabile. Import reale resta bloccato.                                                                                                                                                            |
| Persone        | §3.9 pp.42–59: GET è solo riepilogo; POST get indice usa `persons` oggetto                 | Aggiunta lettura dettagli documentata; incongruenze `person`/`persons`, mai usare nome come chiave.                                                                                                                                                                   |
| Firmware       | §3.9.2 p.50: comando persona aggregato da 2.12.47.x per i60/i60K/i61/i62/i63/i64           | Non dedurre supporto su firmware ignoto; scritture aggregate non implementate.                                                                                                                                                                                        |
| Eventi         | §3.10 pp.60–62: data array, openTime epoch secondi, openResult 0/1                         | Parser selettivo che scarta extra/extraJson, foto e identità non riconciliate; relay 0 ambiguo diventa sconosciuto.                                                                                                                                                   |
| User list      | §3.1 include A17/i66/i67/i68, §3.12 p.73 indica i66/i67/i68                                | Escluso dall'inspector per i modelli del progetto; export non è un elenco JSON persone garantito.                                                                                                                                                                     |

I parser sono verificati con fixture sintetiche conformi al manuale. Nessuna capability hardware è marcata `verified`. Le letture reali restano disattivate per default; import e sync reali richiedono ulteriore validazione del firmware. Finestre temporali documentate in §3.5 ma non abilitate.

## Riscontro utente: device info su i60K 2.12.55

La richiesta Bruno fornita dall’utente usa Basic Auth e `POST /api/device_info`, con `type.item: "device info"`, `cmd: "get"` e i nove campi della collezione. La risposta riportata usa invece `type.item: "device_info"`, `code: "200"`, modello `i60k` e firmware `2.12.55`. Il client è stato riallineato al body della collezione: richiesta e risposta non condividono lo stesso valore di item.

Un mock locale rifiuta con HTTP 500 la variante con underscore nella richiesta; il test richiede la variante con spazio. La fixture di risposta conserva solo il modello e il firmware utili alla compatibilità: MAC sostituito con un valore sintetico, uptime e memoria sintetici. Nessun comando eseguito dal nostro ambiente sul dispositivo reale e nessuna capability di scrittura verificata o abilitata. Il riscontro riguarda la lettura effettuata dall’utente tramite Bruno; il deploy aggiornato del portale deve ancora essere provato sul suo dispositivo.

Il trasporto JSON imposta anche `Content-Length` sui byte UTF-8 del body, evitando il trasferimento chunked. Il comportamento è verificato sul mock locale; il supporto chunked del firmware reale non è stato testato.
