// Downloads one URL into an OPFS file, resuming with Range after network
// errors. Runs inside the download worker (sync access handles are worker-only).

export interface FetchFileOptions {
  url: string;
  file: FileSystemFileHandle;
  expectedBytes?: number;
  supportsRanges: boolean;
  signal: AbortSignal;
  onProgress: (bytes: number, totalBytes?: number) => void;
}

export const MAX_ATTEMPTS = 6;
const RESPONSE_TIMEOUT_MS = 20_000;
const READ_STALL_MS = 30_000;
const PROGRESS_EVERY_MS = 500;

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`The server answered ${status}`);
  }
  /** 408 and 429 are worth retrying; other 4xx are final. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 408 || this.status === 429;
  }
}

/** 250 ms, 500 ms, 1 s, 2 s, ... with ±20 % jitter. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = 250 * 2 ** attempt;
  return Math.round(base * (0.8 + 0.4 * random()));
}

/** Total length from "bytes 100-199/5000", or undefined for "*". */
export function totalFromContentRange(value: string | null): number | undefined {
  const m = value && /\/(\d+)\s*$/.exec(value);
  return m ? Number(m[1]) : undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}

async function fetchWithTimeout(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(RESPONSE_TIMEOUT_MS);
  return fetch(url, { ...init, signal: AbortSignal.any([signal, timeout]) });
}

async function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The download stalled")), READ_STALL_MS);
  });
  try {
    return await Promise.race([reader.read(), stall]);
  } finally {
    clearTimeout(timer);
  }
}

/** Returns the number of bytes written. Throws on failure or abort. */
export async function fetchFile(opts: FetchFileOptions): Promise<number> {
  const access = await opts.file.createSyncAccessHandle();
  let written = 0;
  let total = opts.expectedBytes;
  let lastProgress = 0;
  try {
    access.truncate(0);
    for (let attempt = 0; ; attempt++) {
      try {
        const resume = written > 0;
        const res = await fetchWithTimeout(
          opts.url,
          { headers: resume ? { Range: `bytes=${written}-` } : {}, cache: "no-store" },
          opts.signal,
        );
        if (!res.ok) throw new HttpError(res.status);
        if (resume && res.status !== 206) {
          // The server ignored Range: start over.
          written = 0;
          access.truncate(0);
        }
        total =
          totalFromContentRange(res.headers.get("content-range")) ??
          (res.status === 200 ? Number(res.headers.get("content-length")) || total : total);

        const reader = res.body!.getReader();
        for (;;) {
          const { done, value } = await readWithTimeout(reader);
          if (done) break;
          access.write(value, { at: written });
          written += value.byteLength;
          const now = Date.now();
          if (now - lastProgress >= PROGRESS_EVERY_MS) {
            lastProgress = now;
            opts.onProgress(written, total);
          }
        }
        if (total !== undefined && written < total) throw new Error(`Connection closed at ${written} of ${total} bytes`);
        opts.onProgress(written, total ?? written);
        return written;
      } catch (err) {
        if (opts.signal.aborted) throw opts.signal.reason;
        if (err instanceof HttpError && !err.retryable) throw err;
        if (attempt + 1 >= MAX_ATTEMPTS) throw err;
        if (!opts.supportsRanges) {
          written = 0;
          access.truncate(0);
        }
        await sleep(backoffMs(attempt), opts.signal);
      }
    }
  } finally {
    access.flush();
    access.close();
  }
}
