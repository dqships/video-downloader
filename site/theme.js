// Vidzilla website: the light/dark switch, shared by every page.

/* Theme ------------------------------------------------------------------ */

export function setupTheme() {
  const root = document.documentElement;
  const button = document.querySelector("[data-theme-toggle]");
  const system = matchMedia("(prefers-color-scheme: dark)");
  let saved = null;
  try {
    saved = localStorage.getItem("vz-theme");
  } catch {}

  const apply = (theme) => {
    root.dataset.theme = theme;
    button.setAttribute(
      "aria-label",
      theme === "dark" ? "Switch to the lightbox (light mode)" : "Switch to the darkroom (dark mode)",
    );
    document.dispatchEvent(new CustomEvent("vz-theme"));
  };

  apply(saved === "light" || saved === "dark" ? saved : system.matches ? "dark" : "light");
  system.addEventListener("change", (e) => {
    if (!saved) apply(e.matches ? "dark" : "light");
  });
  button.addEventListener("click", () => {
    saved = root.dataset.theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem("vz-theme", saved);
    } catch {}
    apply(saved);
  });
}
