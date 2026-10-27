// Runs the X post matcher against logged-out and logged-in X markup in a
// plain browser page (no extension needed).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import * as esbuild from "esbuild";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");
const source = readFileSync(new URL("../../src/sw/x-post.ts", import.meta.url), "utf8");
const { code } = await esbuild.transform(source.replace("export function", "function"), { loader: "ts" });

let browser, page;
before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
after(() => browser?.close());

const find = (key, statusId) => page.evaluate(`(() => { ${code}; return findXPost; })()(${JSON.stringify(key)}, ${JSON.stringify(statusId)})`);

// Logged-out X: no data-testid, no time element, no tabindex.
const loggedOut = `
  <article class="flex flex-col">
    <a href="/SpaceX"><div>SpaceX</div></a><span>@SpaceX</span>
    <a href="/SpaceX/status/111">7:49 PM · Oct 25, 2026</a>
    <div dir="auto"><span>Deployment of 27 Starlink satellites confirmed</span></div>
    <video poster="https://pbs.twimg.com/amplify_video_thumb/901/img/a.jpg"></video>
    <video poster="https://pbs.twimg.com/amplify_video_thumb/902/img/b.jpg"></video>
    <a href="/compose/post?in_reply_to=111">Reply</a>
  </article>
  <article class="flex flex-col">
    <a href="/fan_1"><div>Rocket Fan</div></a><span>@fan_1</span>
    <a href="/fan_1/status/222">8:01 PM</a>
    <div dir="auto"><span>Look at this</span></div>
    <video poster="https://pbs.twimg.com/ext_tw_video_thumb/903/pu/img/c.jpg"></video>
  </article>`;

test("logged out: names each video after its post and ranks the page's post first", async () => {
  await page.setContent(loggedOut);
  assert.deepEqual(await find("901", "111"), {
    title: "SpaceX: Deployment of 27 Starlink satellites confirmed",
    thumbnail: "https://pbs.twimg.com/amplify_video_thumb/901/img/a.jpg",
    rank: 0,
  });
  assert.equal((await find("902", "111")).rank, 0);
  assert.deepEqual(await find("903", "111"), {
    title: "Rocket Fan: Look at this",
    thumbnail: "https://pbs.twimg.com/ext_tw_video_thumb/903/pu/img/c.jpg",
    rank: 2,
  });
  assert.equal(await find("999", "111"), null);
});

test("logged in: reads the tagged author and text", async () => {
  await page.setContent(`
    <article tabindex="-1">
      <div data-testid="User-Name"><a href="/nasa"><span>NASA</span></a></div>
      <div data-testid="tweetText">Liftoff!</div>
      <video poster="https://pbs.twimg.com/amplify_video_thumb/5/img/x.jpg"></video>
    </article>`);
  assert.deepEqual(await find("5", null), { title: "NASA: Liftoff!", thumbnail: "https://pbs.twimg.com/amplify_video_thumb/5/img/x.jpg", rank: 0 });
});
