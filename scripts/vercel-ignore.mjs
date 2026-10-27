// Vercel's Ignored Build Step (ignoreCommand in vercel.json): skips the
// deployment when no file the website is built from changed since the last
// deployment of this branch (scripts/site-inputs.mjs lists them).
// Exit 0 skips the deployment, exit 1 builds it. Anything unexpected builds.
// A branch's first deployment has no previous one, so it compares with main.
// Usage: node scripts/vercel-ignore.mjs [baseCommit]   (to try it locally)
import { execFileSync } from "node:child_process";
import { siteChanges } from "./site-inputs.mjs";

const root = new URL("../", import.meta.url);
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const build = (why) => {
  console.log(`Deploying: ${why}`);
  process.exit(1);
};

let base = process.argv[2] || process.env.VERCEL_GIT_PREVIOUS_SHA;
const firstDeployment = !base;
try {
  if (!base) {
    git("fetch", "--quiet", "--depth=1", "origin", "main");
    base = git("rev-parse", "FETCH_HEAD");
    console.log(`First deployment of this branch, comparing with main (${base.slice(0, 7)})`);
  }
  // Vercel's clone is shallow, so the base may need fetching. Only its tree is needed.
  try {
    git("cat-file", "-e", `${base}^{commit}`);
  } catch {
    git("fetch", "--quiet", "--depth=1", "origin", base);
  }
} catch {
  build(base ? `couldn't fetch ${base.slice(0, 7)} to compare with` : "couldn't fetch main to compare with");
}

// The same commit again is a redeploy someone asked for (new env vars, say).
if (!firstDeployment && git("rev-parse", `${base}^{commit}`) === git("rev-parse", "HEAD")) build("redeploying the same commit");

let changed;
try {
  changed = git("diff", "--name-only", "--no-renames", base, "HEAD").split("\n").filter(Boolean);
} catch {
  build(`couldn't compare with ${base.slice(0, 7)}`);
}
const site = siteChanges(changed, root);
if (site.length) build(`the website changed since ${base.slice(0, 7)}: ${site.slice(0, 5).join(", ")}${site.length > 5 ? ", …" : ""}`);
console.log(`Skipping: nothing the website uses changed since ${base.slice(0, 7)} (${changed.length} other file${changed.length === 1 ? "" : "s"})`);
process.exit(0);
