// Saved-file history, newest first, in chrome.storage.local so it outlives
// the browser session. Kept short: it's a "where did that go" list, not a log.

import { storageKeys } from "./messages";
import type { HistoryEntry } from "./types";

export const MAX_HISTORY = 300;

export function withEntry(list: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [entry, ...list.filter((e) => e.id !== entry.id)].slice(0, MAX_HISTORY);
}

export async function loadHistory(): Promise<HistoryEntry[]> {
  return ((await chrome.storage.local.get(storageKeys.history))[storageKeys.history] as HistoryEntry[] | undefined) ?? [];
}

/** Adds an entry. Writes are chained so two finishing downloads can't drop each other. */
let pending: Promise<unknown> = Promise.resolve();
export function addHistory(entry: HistoryEntry): Promise<void> {
  const next = pending.then(async () => {
    await chrome.storage.local.set({ [storageKeys.history]: withEntry(await loadHistory(), entry) });
  });
  pending = next.catch(() => {});
  return next;
}

export async function removeHistory(id?: string): Promise<void> {
  const list = id ? (await loadHistory()).filter((e) => e.id !== id) : [];
  await chrome.storage.local.set({ [storageKeys.history]: list });
}
