// Header replay. An extension's own requests cannot set Cookie, Referer or
// Origin directly, so before a job we add declarativeNetRequest session rules
// that set them, scoped to the media URL's directory and to requests that do
// not come from a tab (our downloads and fetches). Rules go away after the job.

type Rule = chrome.declarativeNetRequest.Rule;

/** Headers worth replaying: identity and auth, never transport details. */
const REPLAYED = new Set(["cookie", "referer", "origin", "authorization"]);
const MAX_RULES_PER_JOB = 500;

export function headersToReplay(sent: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(sent)) {
    if (REPLAYED.has(name) || name.startsWith("x-")) out[name] = value;
  }
  return out;
}

/** "https://cdn.example/v/1/clip.mp4?t=1" -> "https://cdn.example/v/1/". */
export function urlDirectory(url: string): string {
  const u = new URL(url);
  const dir = u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1);
  return `${u.origin}${dir}`;
}

/** urlFilter treats * ^ | specially; percent-encode them in literal URLs. */
function escapeUrlFilter(s: string): string {
  return s.replace(/\*/g, "%2A").replace(/\^/g, "%5E").replace(/\|/g, "%7C");
}

export function buildReplayRules(urls: string[], sent: Record<string, string>, firstId: number): Rule[] {
  const headers = headersToReplay(sent);
  const names = Object.keys(headers);
  if (names.length === 0) return [];
  const dirs = [...new Set(urls.map(urlDirectory))].slice(0, MAX_RULES_PER_JOB);
  return dirs.map((dir, i) => ({
    id: firstId + i,
    priority: 1,
    action: {
      type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: names.map((header) => ({
        header,
        operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
        value: headers[header]!,
      })),
    },
    condition: {
      urlFilter: `|${escapeUrlFilter(dir)}`,
      // -1 is chrome.tabs.TAB_ID_NONE: requests made by the extension itself.
      tabIds: [-1],
      resourceTypes: ["xmlhttprequest", "media", "other"] as chrome.declarativeNetRequest.ResourceType[],
    },
  }));
}

/** Drop rules left by a previous browser session or extension version. */
export async function clearStaleRules(): Promise<void> {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) });
}

// Session rules outlive a service-worker restart, so ids continue after the
// highest one in use. Installs are chained so two jobs never pick the same ids.
let queue: Promise<unknown> = Promise.resolve();

/** Installs rules for a job and returns their ids, for removeReplay(). */
export function installReplay(urls: string[], sent: Record<string, string>): Promise<number[]> {
  const run = queue.then(async () => {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const firstId = existing.reduce((max, r) => Math.max(max, r.id), 0) + 1;
    const rules = buildReplayRules(urls, sent, firstId);
    if (rules.length) await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });
    return rules.map((r) => r.id);
  });
  queue = run.catch(() => {});
  return run;
}

export async function removeReplay(ids: number[]): Promise<void> {
  if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
}
