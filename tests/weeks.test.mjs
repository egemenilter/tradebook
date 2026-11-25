import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { test } from "node:test";

// Weeks — the math the weekly review speaks in. Monday through Sunday, keyed
// like `2026-W48` by the ISO year of the week's Thursday, so a year's ragged
// opening days stay inside the previous year's last week.

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const result = await build({
  entryPoints: { weeks: new URL("src/lib/weeks.ts", root).pathname },
  bundle: true,
  format: "esm",
  platform: "browser",
  outdir: "bundle",
  write: false,
});
const { weekBounds, previousWeek, weekDays } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);

test("a week runs Monday to Sunday and keys by ISO week", () => {
  // Wednesday 2026-11-25 sits inside the week Mon 23rd → Sun 29th.
  const w = weekBounds(new Date(2026, 10, 25));
  assert.equal(w.start, "2026-11-23");
  assert.equal(w.end, "2026-11-29");
  assert.equal(w.key, "2026-W48");
});

test("a Sunday belongs to its own week, a Monday to the next", () => {
  const sunday = weekBounds(new Date(2026, 10, 29));
  assert.equal(sunday.key, "2026-W48");
  assert.equal(sunday.start, "2026-11-23");
  const monday = weekBounds(new Date(2026, 10, 30));
  assert.equal(monday.key, "2026-W49");
  assert.equal(monday.start, "2026-11-30");
});

test("the year's ragged first days stay in the previous year's last week", () => {
  // Jan 1 2026 is a Thursday — its week is 2026-W01, starting Mon Dec 29 2025.
  const w = weekBounds(new Date(2026, 0, 1));
  assert.equal(w.key, "2026-W01");
  assert.equal(w.start, "2025-12-29");
  assert.equal(w.end, "2026-01-04");
});

test("the previous week is exactly seven days earlier", () => {
  const w = weekBounds(new Date(2026, 10, 25));
  const p = previousWeek(new Date(2026, 10, 25));
  assert.equal(p.key, "2026-W47");
  assert.equal(p.start, "2026-11-16");
  assert.equal(p.end, "2026-11-22");
  assert.deepEqual(weekDays(w), [
    "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26",
    "2026-11-27", "2026-11-28", "2026-11-29",
  ]);
});

test("the weekly review reads weeks only through this module", () => {
  const main = read("src/main.ts");
  const dash = read("src/views/dashboard.ts");
  for (const [file, src] of [["main", main], ["dashboard", dash]]) {
    assert.doesNotMatch(src, /getISOWeekThursday|getWeekStringForDate/, `${file} borrows no foreign week math`);
  }
  assert.match(main, /weeklyReviewPath\(weekKey\)/);
  assert.match(main, /ensureWeeklyReview/);
  assert.match(dash, /openWeeklyReviewView\(week\.key\)/, "the widget opens the review page, not just the note");
  assert.match(main, /openWeeklyReviewView/);
  assert.match(main, /saveWeeklyReviewSection/);
});
