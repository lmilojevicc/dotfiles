// Keep synthetic key names, but exercise the installed TUI's actual ANSI/cell layout. The shared test
// loader resolves this deep specifier from the Pi install under test.
const tuiPath = import.meta.resolve("@earendil-works/pi-tui/dist/utils.js");
const tui = await import(tuiPath);
export const { truncateToWidth, visibleWidth, wrapTextWithAnsi } = tui;
const keys = await import(new URL("./keys.js", tuiPath).href);
export function matchesKey(data, key) { return data === key || keys.matchesKey(data, key); }
