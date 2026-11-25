/**
 * Note sections — the weekly review note's storage shape.
 *
 * A review note is plain markdown: the trader reads and edits it anywhere, so
 * the structure lives in `## ` headings. These helpers read one section out
 * and put edited content back without touching anything else on the page.
 */

export interface NoteSection {
  heading: string;
  body: string;
}

const isHeading = (line: string): boolean => /^##\s+/.test(line);
const headingText = (line: string): string => line.replace(/^##\s+/, "").trim();

/** The `## ` sections of a note body, in order (`###` stays inside its parent). */
export function parseSections(body: string): NoteSection[] {
  const out: NoteSection[] = [];
  let cur: NoteSection | null = null;
  for (const line of body.split(/\r?\n/)) {
    if (isHeading(line)) {
      cur = { heading: headingText(line), body: "" };
      out.push(cur);
    } else if (cur) {
      cur.body += (cur.body ? "\n" : "") + line;
    }
  }
  return out.map((s) => ({ heading: s.heading, body: s.body.replace(/^\n+|\n+$/g, "") }));
}

/** One section's content, or "" when the note does not hold it yet. */
export function readSection(body: string, heading: string): string {
  const key = heading.trim().toLowerCase();
  return parseSections(body).find((s) => s.heading.toLowerCase() === key)?.body ?? "";
}

/**
 * Replace one section's content — a section the note lacks is appended at the
 * end. Empty content keeps the heading, so a cleared answer never erases the
 * structure the trader navigates by.
 */
export function writeSection(body: string, heading: string, content: string): string {
  const lines = body.split(/\r?\n/);
  const key = heading.trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isHeading(lines[i]) && headingText(lines[i]).toLowerCase() === key) {
      start = i;
      break;
    }
  }
  const contentLines = content.replace(/^\n+|\n+$/g, "").split(/\r?\n/);
  if (start === -1) {
    const base = body.replace(/\n+$/, "");
    return `${base}\n\n## ${heading.trim()}\n${contentLines.length && contentLines[0] !== "" ? "\n" + contentLines.join("\n") : ""}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeading(lines[i])) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start + 1), "", ...contentLines, ...lines.slice(end)].join("\n");
}

/** The `- [ ]` / `- [x]` lines of a section, in order. */
export interface ChecklistItem {
  text: string;
  done: boolean;
}

export function parseChecklist(body: string): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  for (const line of readSection(body, "Checklist").split(/\r?\n/)) {
    const m = /^\s*-\s+\[( |x|X)\]\s*(.*)$/.exec(line);
    if (m) out.push({ text: m[2].trim(), done: m[1].toLowerCase() === "x" });
  }
  return out;
}

/** Rewrite every checkbox line of the Checklist section, preserving the rest. */
export function writeChecklist(body: string, items: ChecklistItem[]): string {
  const section = readSection(body, "Checklist");
  const lines = section.split(/\r?\n/);
  let i = 0;
  const rewritten = lines.map((line) => {
    if (!/^\s*-\s+\[( |x|X)\]\s+/.test(line) || i >= items.length) return line;
    const item = items[i++];
    return `- [${item.done ? "x" : " "}] ${item.text}`;
  });
  return writeSection(body, "Checklist", rewritten.join("\n"));
}
