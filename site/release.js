// What the site says about the release. Edit this file as milestones ship;
// nothing else on the site needs to change.

export const release = {
  // The Chrome Web Store listing. Every "Add to Chrome" button uses it.
  // TODO: replace with the listing URL once Vidzilla is published.
  storeUrl: "https://chromewebstore.google.com/",

  // Format support, shown on the formats reel and in the demo.
  // "ready" | "next" | "coming". Set a format to "ready" when it ships.
  formats: {
    direct: "ready",
    hls: "ready",
    dash: "ready",
    audio: "ready",
    subtitles: "ready",
    live: "ready",
  },
};

export const statusLabel = { ready: "Ready", next: "Next", coming: "Coming", never: "Never" };
