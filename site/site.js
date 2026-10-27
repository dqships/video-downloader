// Vidzilla website: theme switch and the interactive demo.
// The demo drives the same frame markup and classes as the extension popup
// (design/components.css), with a simulated download instead of a real one.

const ICONS = "../design/icons.svg";
const icon = (name) => `<svg aria-hidden="true"><use href="${ICONS}#i-${name}"/></svg>`;
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/* Theme ------------------------------------------------------------------ */

function setupTheme() {
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

/* The clip: a kaiju walking past a harbour at night, drawn from the logo's shapes. */

function createClip(canvas) {
  const ctx = canvas.getContext("2d");
  let colors = {};
  const readColors = () => {
    colors = {
      sky: css("--color-film"),
      city: css("--color-film-frame"),
      edge: css("--color-film-edge"),
      text: css("--color-film-text"),
      muted: css("--color-film-muted"),
      primary: css("--color-primary"),
    };
  };

  const resize = () => {
    const { width, height } = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(canvas.width / 640, 0, 0, canvas.height / 360, 0, 0);
  };

  // A fixed skyline so every frame matches.
  const buildings = [];
  let x = -10;
  let seed = 7;
  const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  while (x < 660) {
    const w = 28 + rand() * 40;
    const h = 40 + rand() * 110;
    const lit = [];
    for (let wy = 300 - h + 10; wy < 290; wy += 14)
      for (let wx = x + 6; wx < x + w - 8; wx += 12) if (rand() > 0.72) lit.push([wx, wy]);
    buildings.push({ x, w, h, lit });
    x += w + 4;
  }

  const tri = (ax, ay, bx, by, cx, cy, fill) => {
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(cx, cy);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };

  function kaiju(t) {
    // Walks left to right over 16 s, bobbing with each step.
    const loop = (t % 16) / 16;
    const kx = -140 + loop * 920;
    const step = Math.sin(t * 4.2);
    const bob = Math.abs(step) * 4;
    const base = 300;
    const body = colors.muted;
    // Tail
    tri(kx - 120, base - 8, kx - 10, base - 70 - bob, kx, base - 30 - bob, body);
    // Legs
    tri(kx - 30 + step * 10, base, kx - 4, base - 60 - bob, kx + 14 + step * 10, base, body);
    tri(kx + 16 - step * 10, base, kx + 28, base - 60 - bob, kx + 50 - step * 10, base, body);
    // Body: a triangle pointing up
    tri(kx - 40, base - 40 - bob, kx + 64, base - 40 - bob, kx + 20, base - 190 - bob, body);
    // Head: a rhombus, looking ahead
    ctx.beginPath();
    ctx.moveTo(kx + 30, base - 200 - bob);
    ctx.lineTo(kx + 62, base - 186 - bob);
    ctx.lineTo(kx + 30, base - 168 - bob);
    ctx.lineTo(kx + 14, base - 184 - bob);
    ctx.closePath();
    ctx.fillStyle = body;
    ctx.fill();
    ctx.fillStyle = colors.edge;
    ctx.fillRect(kx + 38, base - 189 - bob, 5, 4);
    // Dorsal plates: safelight triangles down the back
    for (let i = 0; i < 4; i++) {
      const px = kx - 4 - i * 16;
      const py = base - 150 + i * 30 - bob;
      tri(px - 8, py + 14, px + 4, py + 18, px - 14, py - 6, colors.primary);
    }
  }

  function draw(t) {
    ctx.fillStyle = colors.sky;
    ctx.fillRect(0, 0, 640, 360);
    // Moon
    ctx.beginPath();
    ctx.arc(530, 78, 30, 0, Math.PI * 2);
    ctx.fillStyle = colors.edge;
    ctx.fill();
    // Far skyline
    for (const b of buildings) {
      ctx.fillStyle = colors.city;
      ctx.fillRect(b.x, 300 - b.h, b.w, b.h);
    }
    kaiju(t);
    // Near skyline windows flicker a little
    for (const b of buildings)
      for (const [wx, wy] of b.lit) {
        ctx.fillStyle = colors.edge;
        ctx.globalAlpha = 0.35 + 0.25 * Math.sin(t * 2 + wx * 0.3 + wy);
        ctx.fillRect(wx, wy, 4, 5);
      }
    ctx.globalAlpha = 1;
    // Water
    ctx.fillStyle = colors.city;
    ctx.fillRect(0, 300, 640, 60);
    ctx.fillStyle = colors.muted;
    for (let i = 0; i < 9; i++) {
      const wx = ((i * 83 + t * 18) % 700) - 30;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(wx, 318 + (i % 3) * 12, 26, 2);
    }
    ctx.globalAlpha = 1;
  }

  readColors();
  resize();
  return { draw, readColors, resize };
}

/* Demo ------------------------------------------------------------------- */

const MEDIA = [
  {
    id: "mp4",
    name: "Night stomp over the harbour.mp4",
    badge: "MP4",
    meta: "1080p · 148 MB · cdn.harbourcam.example",
    url: "https://cdn.harbourcam.example/v/night-stomp/harbour_1080.mp4",
    totalMb: 148,
  },
  {
    id: "hls",
    name: "Night stomp over the harbour (stream).mp4",
    badge: "HLS",
    meta: "4 qualities, up to 1080p · cdn.harbourcam.example",
    url: "https://cdn.harbourcam.example/v/night-stomp/master.m3u8",
    note: "Stream downloads arrive in the next update.",
  },
  {
    id: "drm",
    name: "Harbour Cam Plus trailer.mp4",
    badge: "DASH",
    meta: "Protected · plus.harbourcam.example",
    url: "https://plus.harbourcam.example/trailer/manifest.mpd",
    drm: true,
  },
];

function setupDemo() {
  const scene = document.querySelector("[data-scene]");
  if (!scene) return;
  const player = scene.querySelector(".player");
  const canvas = scene.querySelector("[data-canvas]");
  const playBtn = scene.querySelector("[data-play]");
  const timecode = scene.querySelector("[data-timecode]");
  const strip = scene.querySelector("[data-strip]");
  const empty = scene.querySelector("[data-empty]");
  const popup = scene.querySelector("[data-popup]");
  const ext = scene.querySelector("[data-ext]");
  const count = scene.querySelector("[data-count]");
  const shelf = scene.querySelector("[data-shelf]");
  const shelfName = scene.querySelector("[data-shelf-name]");
  const steps = Object.fromEntries([...document.querySelectorAll("[data-step]")].map((el) => [el.dataset.step, el]));

  const clip = createClip(canvas);
  let playing = false;
  let clipTime = 2.4; // start on a frame where the kaiju is in view
  let last = 0;
  let caught = false;
  let raf = 0;

  const setStep = (active) => {
    const order = ["play", "caught", "saved"];
    const at = order.indexOf(active);
    order.forEach((key, i) => {
      steps[key]?.classList.toggle("is-done", i < at);
      steps[key]?.classList.toggle("is-active", i === at);
    });
  };
  setStep("play");

  const tc = (t) => {
    const f = Math.floor(t * 24);
    const pad = (n) => String(n).padStart(2, "0");
    return `00:${pad(Math.floor(f / 1440) % 60)}:${pad(Math.floor(f / 24) % 60)}:${pad(f % 24)}`;
  };

  const tick = (now) => {
    if (last) clipTime += (now - last) / 1000;
    last = now;
    clip.draw(clipTime);
    timecode.textContent = tc(clipTime);
    if (playing) raf = requestAnimationFrame(tick);
  };

  const render = () => {
    last = 0;
    cancelAnimationFrame(raf);
    clip.draw(clipTime);
    timecode.textContent = tc(clipTime);
  };

  playBtn.addEventListener("click", () => {
    playing = !playing;
    player.classList.toggle("is-playing", playing);
    playBtn.setAttribute("aria-label", playing ? "Pause the clip" : "Play the clip");
    if (playing) {
      raf = requestAnimationFrame(tick);
      if (!caught) setTimeout(catchMedia, 900);
    } else {
      render();
    }
  });

  ext.addEventListener("click", () => {
    const open = popup.hidden;
    popup.hidden = !open;
    ext.setAttribute("aria-expanded", String(open));
  });

  document.addEventListener("vz-theme", () => {
    clip.readColors();
    render();
    if (playing) raf = requestAnimationFrame(tick);
  });
  new ResizeObserver(() => {
    clip.resize();
    clip.draw(clipTime);
  }).observe(canvas);

  /* Frames, exactly as the popup builds them. */

  function buildFrame(item, thumb, index) {
    const frame = document.createElement("article");
    frame.className = "vz-frame";
    frame.style.animationDelay = `calc(var(--duration-fast) * ${index * 0.5})`;
    frame.innerHTML = `
      <div class="vz-rail" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="vz-thumb"></div>
      <div class="vz-frame-body">
        <input class="vz-input vz-frame-name" type="text" spellcheck="false" aria-label="File name" />
        <p class="vz-frame-meta"><span class="vz-badge"></span><span class="meta-text"></span></p>
        <p class="vz-frame-note" hidden></p>
      </div>
      <div class="vz-frame-actions">
        <button class="vz-icon-btn" type="button" data-copy title="Copy link" aria-label="Copy link">${icon("doc.on.doc")}</button>
        <button class="vz-icon-btn vz-icon-btn--primary" type="button" data-download title="Download" aria-label="Download">${icon("arrow.down.circle")}</button>
      </div>
      <div class="vz-perf" hidden></div>`;

    const name = frame.querySelector(".vz-frame-name");
    name.value = item.name;
    name.title = item.name;
    frame.querySelector(".vz-badge").textContent = item.badge;
    frame.querySelector(".meta-text").textContent = item.meta;
    const thumbEl = frame.querySelector(".vz-thumb");
    if (thumb && !item.drm) thumbEl.style.backgroundImage = `url(${thumb})`;
    else thumbEl.innerHTML = icon("film");

    const note = frame.querySelector(".vz-frame-note");
    const download = frame.querySelector("[data-download]");
    const copy = frame.querySelector("[data-copy]");
    const perf = frame.querySelector(".vz-perf");

    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(item.url);
      } catch {}
      copy.innerHTML = icon("checkmark");
      setTimeout(() => (copy.innerHTML = icon("doc.on.doc")), 1200);
    });

    if (item.drm) {
      frame.classList.add("is-fogged");
      download.disabled = true;
      note.hidden = false;
      note.innerHTML = `${icon("lock")}<span>Protected by DRM. Not supported.</span>`;
      return frame;
    }
    if (item.note) {
      download.disabled = true;
      note.hidden = false;
      note.textContent = item.note;
      return frame;
    }

    let timer = 0;
    const setMode = (running) => {
      download.innerHTML = icon(running ? "xmark" : "arrow.down.circle");
      download.title = running ? "Cancel" : "Download";
      download.setAttribute("aria-label", download.title);
      download.classList.toggle("vz-icon-btn--primary", !running);
    };
    const stop = () => {
      clearInterval(timer);
      timer = 0;
      setMode(false);
      perf.hidden = true;
      frame.classList.remove("has-progress");
    };

    download.addEventListener("click", () => {
      if (timer) {
        stop();
        note.className = "vz-frame-note";
        note.textContent = "Cancelled.";
        return;
      }
      const filename = name.value.trim() || item.name;
      let received = 0;
      setMode(true);
      note.hidden = false;
      note.className = "vz-frame-note";
      perf.hidden = false;
      frame.classList.add("has-progress");
      perf.style.setProperty("--vz-perf-value", "0%");
      // Ranges arrive in uneven bursts, like a real connection.
      timer = setInterval(() => {
        received = Math.min(item.totalMb, received + 6 + Math.random() * 14);
        perf.style.setProperty("--vz-perf-value", `${(received / item.totalMb) * 100}%`);
        note.textContent = `Downloading ${Math.round(received)} MB of ${item.totalMb} MB`;
        if (received >= item.totalMb) {
          stop();
          note.classList.add("is-done");
          note.textContent = `Saved as ${filename}`;
          note.title = `Downloads/${filename}`;
          shelfName.textContent = filename;
          shelf.hidden = false;
          shelf.style.animation = "none";
          void shelf.offsetWidth;
          shelf.style.animation = "";
          setStep("saved");
          steps.saved?.classList.replace("is-active", "is-done");
        }
      }, reducedMotion.matches ? 60 : 260);
    });
    return frame;
  }

  function catchMedia() {
    if (caught) return;
    caught = true;
    let thumb = "";
    try {
      thumb = canvas.toDataURL("image/jpeg", 0.7);
    } catch {}
    empty.remove();
    MEDIA.forEach((item, i) => strip.append(buildFrame(item, thumb, i)));
    count.textContent = String(MEDIA.length);
    count.hidden = false;
    setStep("caught");
  }

  render();
}

setupTheme();
if (document.fonts?.ready) document.fonts.ready.then(setupDemo);
else setupDemo();
