// Vercel Routing Middleware: markdown content negotiation. A request whose
// Accept header asks for text/markdown gets the page's markdown twin at the
// same URL (or a markdown 404); everything else goes on to the static site.
import { rewrite } from "@vercel/functions";
import { notFoundMarkdown, pages } from "./site/pages.mjs";

export const config = {
  // Skip the asset folders and the API; other files are skipped below.
  matcher: ["/((?!design/|brand/|api/).*)"],
};

const byPath = new Map(pages.map((p) => [p.path, p.file]));

const MARKDOWN = { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept" };

export function wantsMarkdown(accept) {
  return /(^|,)\s*text\/markdown\s*(?!;\s*q=0(\.0*)?\s*(,|$))/i.test(accept ?? "");
}

export function pageFile(pathname) {
  const path = pathname.replace(/\.html$/, "").replace(/\/index$/, "/").replace(/(.)\/$/, "$1");
  return byPath.get(path);
}

export default function middleware(request) {
  if (!wantsMarkdown(request.headers.get("accept"))) return;
  const url = new URL(request.url);
  if (/\.(?!html$)[^/]*$/.test(url.pathname)) return;
  const file = pageFile(url.pathname);
  if (!file) return new Response(notFoundMarkdown, { status: 404, headers: { ...MARKDOWN, "X-Content-Type-Options": "nosniff" } });
  return rewrite(new URL(`/${file}.md`, url), { headers: MARKDOWN });
}
