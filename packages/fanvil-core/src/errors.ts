export class FanvilReadError extends Error {
  readonly statusCode = 409;
  constructor(
    public readonly code: string,
    message: string,
    public readonly remoteStatus?: number,
  ) {
    super(message);
    this.name = "FanvilReadError";
  }
}
export function safeReadError(error: unknown) {
  return error instanceof FanvilReadError
    ? error
    : new FanvilReadError(
        "FANVIL_CONNECTION",
        "Connessione Fanvil fallita: verificare raggiungibilità dalla rete del container, protocollo e porta",
      );
}
export function httpReadError(status: number, challenge: string = "") {
  if (status === 401 || status === 403)
    return new FanvilReadError(
      "FANVIL_AUTH",
      challenge.toLowerCase().includes("digest")
        ? "HTTP " +
            status +
            ": il dispositivo richiede autenticazione Digest, non ancora supportata dal client Basic"
        : "HTTP " +
            status +
            ": accesso API rifiutato; controllare utente/password HTTP API e autenticazione del dispositivo",
      status,
    );
  if (status >= 300 && status < 400)
    return new FanvilReadError(
      "FANVIL_REDIRECT",
      "HTTP " +
        status +
        ": redirect bloccato; verificare protocollo HTTP/HTTPS e porta configurati",
      status,
    );
  return new FanvilReadError(
    "FANVIL_HTTP",
    "Risposta HTTP non valida: " +
      status +
      "; verificare endpoint e supporto del firmware",
    status,
  );
}
