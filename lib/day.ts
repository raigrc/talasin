import "server-only";
import { APP_TZ } from "./env";

/**
 * Local-day helpers. The server assigns `local_day` from a fixed timezone
 * (Asia/Manila by default) so a wrong client clock can never inflate the streak
 * (DESIGN.md §6). All values are `YYYY-MM-DD` strings — the same shape the
 * Postgres `date` columns store.
 */

/** The current local calendar day in APP_TZ, formatted YYYY-MM-DD. */
export function todayLocal(now: Date = new Date()): string {
  return formatLocalDay(now, APP_TZ);
}

/** Format an instant as a YYYY-MM-DD calendar day in the given IANA timezone. */
export function formatLocalDay(instant: Date, timeZone: string = APP_TZ): string {
  // en-CA yields ISO-style YYYY-MM-DD; the timeZone option does the shift.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(instant);
}

/** Return the calendar day N days before the given YYYY-MM-DD string. */
export function addDays(day: string, delta: number): string {
  // Parse as UTC midnight to avoid the host machine's tz shifting the date.
  const [y, m, d] = day.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  const shifted = new Date(base + delta * 86_400_000);
  const yy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
