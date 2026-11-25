/**
 * Weeks — the ISO week math the weekly review speaks in.
 *
 * A week is Monday through Sunday, keyed like `2026-W48`. The key's year is
 * the ISO year of the week's Thursday, which is what keeps a year's first
 * ragged days inside the last week of the previous year instead of inventing
 * a week 0.
 */

export interface WeekBounds {
  /** `YYYY-Www`, the week's identity. */
  key: string;
  /** Monday's `YYYY-MM-DD`. */
  start: string;
  /** Sunday's `YYYY-MM-DD`. */
  end: string;
}

const dayIso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The Monday `days` back from a date (0 = same day when already Monday). */
function mondayOf(d: Date): Date {
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

/** Everything a week needs, from any moment inside it. */
export function weekBounds(input: Date): WeekBounds {
  const start = mondayOf(input);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  // The ISO year belongs to the week's Thursday, not to its Sunday.
  const thursday = new Date(start);
  thursday.setDate(thursday.getDate() + 3);
  const week = (() => {
    const first = new Date(thursday.getFullYear(), 0, 1);
    const days = Math.round((thursday.getTime() - first.getTime()) / 86400000);
    // The first week is the one holding the year's first Thursday.
    return Math.ceil((days + 1) / 7);
  })();
  return {
    key: `${thursday.getFullYear()}-W${String(week).padStart(2, "0")}`,
    start: dayIso(start),
    end: dayIso(end),
  };
}

/** The week before the given one. */
export function previousWeek(input: Date): WeekBounds {
  const back = new Date(input.getFullYear(), input.getMonth(), input.getDate() - 7);
  return weekBounds(back);
}

/** The seven day keys of a week, Monday first. */
export function weekDays(bounds: WeekBounds): string[] {
  const days: string[] = [];
  const cursor = new Date(bounds.start + "T00:00:00");
  for (let i = 0; i < 7; i++) {
    days.push(dayIso(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}
