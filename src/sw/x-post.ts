// Kept in its own file, free of imports, because it is injected into X pages
// (chrome.scripting) and tested on its own in a browser page.

/**
 * X: which post a video belongs to; runs in the page. Logged-in X marks posts
 * up with data-testid; logged-out X has bare markup, so both are read.
 */
export function findXPost(mediaKey: string, statusId: string | null) {
  const video = [...document.querySelectorAll("video")].find((v) => v.poster.includes(`/${mediaKey}`));
  const post = video?.closest("article");
  if (!video || !post) return null;
  const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() || undefined;
  // The author's profile link is the first link to a bare "/handle" with a visible name.
  const profile = [...post.querySelectorAll<HTMLAnchorElement>("a[href]")].find(
    (a) => /^\/\w{1,15}$/.test(a.getAttribute("href") ?? "") && text(a) && !text(a)!.startsWith("@"),
  );
  const author = text(post.querySelector('[data-testid="User-Name"] span')) ?? text(profile);
  // The post text: the tagged element, else the longest dir="auto" block that isn't the author's name.
  const blocks = [...post.querySelectorAll('div[dir="auto"]')]
    .filter((d) => !d.querySelector('div[dir="auto"]') && !d.closest("a"))
    .map(text)
    .filter((t): t is string => !!t && t !== author);
  const body = text(post.querySelector('[data-testid="tweetText"]')) ?? blocks.sort((a, b) => b.length - a.length)[0];
  // The post the page is about links to its own status (its timestamp, its reply button).
  const main =
    post.getAttribute("tabindex") === "-1" ||
    (statusId !== null && post.querySelector(`a[href$="/status/${statusId}"], a[href$="in_reply_to=${statusId}"]`) !== null);
  const posts = [...document.querySelectorAll("article")];
  return {
    title: [author, body?.slice(0, 100)].filter(Boolean).join(": ") || undefined,
    thumbnail: video.poster || undefined,
    rank: main ? 0 : posts.indexOf(post) + 1,
  };
}
