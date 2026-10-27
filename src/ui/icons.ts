// Icons drawn to match SF Symbols' regular weight: 24 grid, 1.75 strokes,
// round caps and joins. See DESIGN.md.

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  download: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v8.5"/><path d="M8.5 12.75 12 16.25l3.5-3.5"/>'),
  copy: svg('<rect x="8.5" y="8.5" width="11" height="12" rx="2.25"/><path d="M15.5 8.5V6.25A2.25 2.25 0 0 0 13.25 4h-6.5A2.25 2.25 0 0 0 4.5 6.25v8.5A2.25 2.25 0 0 0 6.75 17H8.5"/>'),
  check: svg('<path d="M5.5 12.5 10 17l8.5-9.5"/>'),
  close: svg('<path d="M7 7l10 10M17 7 7 17"/>'),
  lock: svg('<rect x="5.5" y="10.5" width="13" height="9.5" rx="2.25"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'),
  film: svg('<rect x="4" y="4.5" width="16" height="15" rx="2.25"/><path d="M8 4.5v15M16 4.5v15M4 9h4M4 15h4M16 9h4M16 15h4"/>'),
  waveform: svg('<path d="M4 12h1.5M7.5 8.5v7M11 5v14M14.5 8v8M18 10.5v3M20 12h0"/>'),
};
