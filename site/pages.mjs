// The site's pages, read by the build (heads, sitemap, llms.txt) and by the
// Vercel middleware (markdown versions). Each page is site/<file>.html, with
// its markdown twin in site/md/<file>.md.

// TODO: replace with the production domain once it's chosen.
export const origin = "https://vidzilla.app";

export const pages = [
  { path: "/", file: "index" },
  { path: "/about", file: "about" },
  { path: "/pricing", file: "pricing" },
  { path: "/contact", file: "contact" },
  { path: "/privacy", file: "privacy" },
];

export const repoUrl = "https://github.com/dqships/video-downloader";

// The 404 body for agents that ask for markdown. The middleware returns it
// as is, and the build writes it to 404.md.
export const notFoundMarkdown = `# Page not found

There's no page at this address on the Vidzilla site. It may have moved, or the link may have a typo.

Vidzilla is a free Chrome extension that finds the video playing on a page and saves it to your computer as a file.

## Pages on this site

- [Vidzilla home](${origin}/): what Vidzilla saves and how it works
- [About](${origin}/about): who makes Vidzilla and why
- [Pricing](${origin}/pricing): Vidzilla is free
- [Contact](${origin}/contact): bug reports and questions
- [Privacy policy](${origin}/privacy): what the extension reads and keeps
- [llms.txt](${origin}/llms.txt): an index of the site for language models
`;
