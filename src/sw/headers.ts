// Remembers the request headers the page sent, so a download can replay the
// same Cookie, Referer and Origin later. Kept in memory: if the service worker
// restarts we lose only headers for responses that have not arrived yet.

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 5000;

/** Headers that describe the transport, not the request's identity. */
const NOT_REPLAYED = new Set([
  "range", "host", "connection", "content-length", "user-agent", "accept-encoding",
  "if-range", "if-none-match", "if-modified-since", "upgrade-insecure-requests",
  "proxy-authorization", "proxy-connection", "keep-alive", "te", "trailer", "transfer-encoding",
]);

export function replayableHeaders(headers: { name: string; value?: string }[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    const name = h.name.toLowerCase();
    if (h.value === undefined || NOT_REPLAYED.has(name) || name.startsWith("sec-ch-") || name.startsWith("proxy-")) {
      continue;
    }
    out[name] = h.value;
  }
  return out;
}

export class HeaderCache {
  private entries = new Map<string, { headers: Record<string, string>; at: number }>();

  constructor(private now: () => number = Date.now) {}

  put(requestId: string, headers: Record<string, string>): void {
    if (this.entries.size >= MAX_ENTRIES) this.prune();
    this.entries.set(requestId, { headers, at: this.now() });
  }

  get(requestId: string): Record<string, string> | undefined {
    const e = this.entries.get(requestId);
    if (!e) return undefined;
    if (this.now() - e.at > TTL_MS) {
      this.entries.delete(requestId);
      return undefined;
    }
    return e.headers;
  }

  private prune(): void {
    const cutoff = this.now() - TTL_MS;
    for (const [id, e] of this.entries) if (e.at < cutoff) this.entries.delete(id);
    // Still full: drop the oldest half (Map keeps insertion order).
    if (this.entries.size >= MAX_ENTRIES) {
      let drop = Math.floor(this.entries.size / 2);
      for (const id of this.entries.keys()) {
        if (drop-- <= 0) break;
        this.entries.delete(id);
      }
    }
  }
}
