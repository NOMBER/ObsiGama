// Localized dates without moment: uses Obsidian's UI language when set.
function locale(): string | undefined {
  try { return window.localStorage.getItem("language") || undefined; } catch { return undefined; }
}

/** e.g. "11 November 2026" / "11 ноября 2026 г." */
export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(locale(), { year: "numeric", month: "long", day: "numeric" });
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536e6], ["month", 2592e6], ["week", 6048e5], ["day", 864e5], ["hour", 36e5], ["minute", 6e4]];

/** e.g. "3 days ago" / "3 дня назад" */
export function fromNow(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
  for (const [unit, ms] of UNITS) if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  return rtf.format(0, "minute");
}
