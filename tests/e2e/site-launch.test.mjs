// End-to-end: the website's launch checklist (SEO, agent readiness, headers).
// Builds the site and serves it the way Vercel will (scripts/serve-site.mjs:
// vercel.json headers, clean URLs, the markdown middleware, real 404s), then
// checks every page's head, the root files, markdown negotiation and that
// pages load in Chrome with no console errors under the real CSP.
// Run with `pnpm test:e2e` (needs Playwright with Chromium).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { wantsMarkdown } from "../../middleware.js";
import { serveSite } from "../../scripts/serve-site.mjs";
import { origin as siteOrigin, pages } from "../../site/pages.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

let dist, site, browser;
const get = (path, headers = {}) => fetch(site.origin + path, { headers, redirect: "manual" });
const local = (url) => url.replace(siteOrigin, site.origin);
const attr = (html, re) => html.match(re)?.[1];

before(async () => {
  // Each test file builds its own copy, so files running in parallel don't clear each other's.
  dist = mkdtempSync(join(tmpdir(), "vz-site-"));
  execFileSync("node", [fileURLToPath(new URL("../../scripts/build-site.mjs", import.meta.url)), dist]);
  site = await serveSite(0, dist);
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  site?.server.close();
  if (dist) rmSync(dist, { recursive: true, force: true });
});

test("every page has a complete head", async () => {
  for (const page of pages) {
    const res = await get(page.path);
    assert.equal(res.status, 200, page.path);
    const html = await res.text();
    const title = attr(html, /<title>([^<]*)<\/title>/);
    const description = attr(html, /<meta\s+name="description"\s+content="([^"]*)"/);
    assert.ok(title.length >= 30 && title.length <= 60, `${page.path} title length ${title.length}`);
    assert.ok(description.length >= 120 && description.length <= 160, `${page.path} description length ${description.length}`);
    assert.match(html, /^<!doctype html>\s*<html lang="en">/i);
    assert.match(html, /<meta charset="utf-8" \/>/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
    assert.equal(attr(html, /<link rel="canonical" href="([^"]*)"/), siteOrigin + page.path);
    assert.match(html, /<link rel="icon" href="[^"]+"/);
    for (const p of ["og:title", "og:description", "og:image", "og:url", "og:type"]) assert.match(html, new RegExp(`property="${p}" content="[^"]+"`), `${page.path} ${p}`);
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    for (const p of ["twitter:title", "twitter:description", "twitter:image"]) assert.match(html, new RegExp(`name="${p}" content="[^"]+"`));
    assert.match(html, /<meta name="is-agentic-site-type" content="app" \/>/);
    assert.doesNotMatch(html, /noindex|user-scalable|maximum-scale/);
    assert.equal(html.match(/<h1[\s>]/g).length, 1, `${page.path} one h1`);
    assert.match(html, /<main[\s>]/);

    const graph = JSON.parse(attr(html, /<script type="application\/ld\+json">(.*?)<\/script>/))["@graph"];
    const org = graph.find((n) => n["@type"] === "Organization");
    assert.ok(org.contactPoint?.email && org.address && org.sameAs.length, "Organization with contactPoint, address and sameAs");
    assert.ok(graph.find((n) => n["@type"] === "WebApplication").offers);

    // Server-rendered: at least 500 characters of text in the raw HTML.
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<template[\s\S]*?<\/template>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    assert.ok(text.length >= 500, `${page.path} has ${text.length} characters of text`);
  }
});

test("the social image is a 1200×630 PNG", async () => {
  const res = await get("/brand/og-image.png");
  assert.equal(res.status, 200);
  const png = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
});

test("security headers on every response", async () => {
  for (const path of ["/", "/about", "/design/tokens.css", "/no-such-page"]) {
    const h = (await get(path)).headers;
    assert.equal(h.get("strict-transport-security"), "max-age=31536000; includeSubDomains", path);
    assert.match(h.get("content-security-policy"), /default-src 'self'/, path);
    assert.equal(h.get("x-frame-options"), "SAMEORIGIN", path);
    assert.equal(h.get("x-content-type-options"), "nosniff", path);
    assert.equal(h.get("x-robots-tag"), null, path);
  }
});

test("robots.txt, sitemap.xml and llms.txt", async () => {
  const robots = await (await get("/robots.txt")).text();
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.match(robots, new RegExp(`^Sitemap: ${siteOrigin}/sitemap.xml$`, "m"));
  assert.doesNotMatch(robots, /Disallow: \/\s*$/m);

  const sitemap = await (await get("/sitemap.xml")).text();
  const entries = [...sitemap.matchAll(/<url><loc>([^<]+)<\/loc><lastmod>(\d{4}-\d\d-\d\d)<\/lastmod><\/url>/g)];
  assert.deepEqual(entries.map((e) => e[1]), pages.map((p) => siteOrigin + p.path));
  for (const [, loc] of entries) assert.equal((await fetch(local(loc), { redirect: "manual" })).status, 200, loc);

  const llms = await (await get("/llms.txt")).text();
  assert.match(llms, /^# Vidzilla\n\n> /);
  const links = [...llms.matchAll(/\]\((https?:[^)]+)\)/g)].map((m) => m[1]).filter((u) => u.startsWith(siteOrigin));
  assert.equal(links.length, pages.length);
  for (const link of links) {
    const res = await fetch(local(link));
    assert.equal(res.status, 200, link);
    assert.match(res.headers.get("content-type"), /^text\/markdown/, link);
  }
});

test("markdown content negotiation", async () => {
  assert.ok(wantsMarkdown("text/markdown"));
  assert.ok(wantsMarkdown("text/markdown, text/html;q=0.9"));
  assert.ok(!wantsMarkdown("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"));
  assert.ok(!wantsMarkdown("text/markdown;q=0"));

  for (const page of pages) {
    const html = await get(page.path);
    assert.match(html.headers.get("content-type"), /^text\/html/);
    assert.match(html.headers.get("vary"), /Accept/);
    const res = await get(page.path, { Accept: "text/markdown" });
    assert.equal(res.status, 200, page.path);
    assert.match(res.headers.get("content-type"), /^text\/markdown/);
    assert.match(res.headers.get("vary"), /Accept/);
    const md = await res.text();
    const h1 = attr(await html.text(), /<h1[^>]*>([^<]*)<\/h1>/).replaceAll("&#39;", "'");
    assert.ok(md.startsWith(`# ${h1}`), `${page.path} markdown starts with its h1`);
    assert.doesNotMatch(md, /\{\{|<\w/, `${page.path} markdown has no placeholders or HTML`);
  }
});

test("missing pages are real 404s, in markdown for agents", async () => {
  const html = await get("/no/such/page");
  assert.equal(html.status, 404);
  assert.match(html.headers.get("content-type"), /^text\/html/);
  assert.match(await html.text(), /This frame is missing/);

  const md = await get("/no/such/page", { Accept: "text/markdown" });
  assert.equal(md.status, 404);
  assert.match(md.headers.get("content-type"), /^text\/markdown/);
  const body = await md.text();
  assert.match(body, /^# Page not found/);
  assert.match(body, new RegExp(`\\(${siteOrigin}/about\\)`));
});

test("old .html addresses redirect on the same site", async () => {
  const res = await get("/privacy.html");
  assert.equal(res.status, 308);
  assert.equal(res.headers.get("location"), "/privacy");
});

test("pages load with no console errors or CSP violations", async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(`${page.url()}: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
  for (const p of pages) {
    await page.goto(site.origin + p.path);
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator("[data-theme-toggle]").count(), 1, p.path);
  }
  // The 404 page's own status is reported as a console error; its assets must load from any depth.
  await page.goto(`${site.origin}/deep/missing/page`);
  await page.waitForLoadState("networkidle");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).fontFamily.includes("Archivo")), true);
  assert.deepEqual(errors.filter((e) => !e.includes("/deep/missing/page: Failed to load resource")), []);
  await page.close();
});
