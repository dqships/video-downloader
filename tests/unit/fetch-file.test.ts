import { describe, expect, it } from "vitest";
import { HttpError, backoffMs, totalFromContentRange } from "../../src/worker/fetch-file";

describe("fetch-file helpers", () => {
  it("backs off exponentially with jitter", () => {
    expect(backoffMs(0, () => 0.5)).toBe(250);
    expect(backoffMs(3, () => 0.5)).toBe(2000);
    expect(backoffMs(1, () => 0)).toBe(400);
    expect(backoffMs(1, () => 1)).toBe(600);
  });

  it("reads totals from Content-Range", () => {
    expect(totalFromContentRange("bytes 100-199/5000")).toBe(5000);
    expect(totalFromContentRange("bytes 0-0/*")).toBeUndefined();
    expect(totalFromContentRange(null)).toBeUndefined();
  });

  it("retries only server errors, timeouts and rate limits", () => {
    expect(new HttpError(503).retryable).toBe(true);
    expect(new HttpError(429).retryable).toBe(true);
    expect(new HttpError(403).retryable).toBe(false);
    expect(new HttpError(404).retryable).toBe(false);
  });
});
