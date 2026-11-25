/**
 * The RoboForex "Trade History Report" — the .xlsx workbook MetaTrader
 * exports for a RoboForex account.
 *
 * The workbook is a zip of XML sheets. This reader opens it without any
 * dependency: the zip's central directory names the parts, zlib inflates
 * them (Node in the tests, Node in the desktop app), and a small XML scan
 * lifts the cells. The layout itself is a MetaTrader screen printed to a
 * sheet — title rows, the Positions table, then Orders and Deals the
 * journal does not read — so the reader walks it the way a reader does:
 * find the table, read the closed rows, skip the rest and say so.
 *
 * One row = one closed position (single entry, single exit). The row's
 * Profit is what the platform booked, its Swap and Commission travel as
 * costs beside it, so the journal's net reads the broker's net:
 * `pnl - commission - fees` with `fees = -swap` and
 * `commission = -commission_column` (MetaTrader bills in signed columns).
 *
 * Pure: no DOM, no plugin, no obsidian.
 */

import type { AccountType, InstantSource, ParsedResult, TimeIssues, Trade } from "../types";
import { parseInstant } from "./instant";
import { zoneWallParts } from "../tz";

export interface RoboZones {
  sourceZone?: string;
  systemSource?: boolean;
  journalZone?: string;
}

/** RoboForex's internal index names carry a platform prefix — the journal
 *  knows the instrument itself by its house name. */
const SYMBOL_MAP: Record<string, string> = {
  ".USTECHCASH": "USTEC",
  ".DE40CASH": "DE40",
  ".US500CASH": "US500",
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- the zip

/** Node's zlib, typed narrow — the workbook's parts are raw-deflated. */
declare const process: { getBuiltinModule?: (id: string) => { inflateRawSync: (data: Uint8Array) => Uint8Array } } | undefined;

async function unzip(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  // The end-of-central-directory record sits in the last 64KiB of a zip.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const parts = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
    // The local header repeats the name and extra lengths; the data follows it.
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compressed);
    parts.set(name, method === 0 ? raw : await inflate(raw));
  }
  return parts;
}

async function inflate(raw: Uint8Array): Promise<Uint8Array> {
  // Node (the tests) carries the builtin directly; the desktop renderer has
  // `process` too. A browser context inflates with DecompressionStream.
  try {
    const zlib = typeof process !== "undefined" ? process.getBuiltinModule?.("zlib") : undefined;
    if (zlib) return zlib.inflateRawSync(raw);
  } catch {
    // fall through to the streaming path
  }
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------- the xml

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/** Sheet cells into a grid: `rows.get(rowIndex)` → column values. */
function readGrid(sheetXml: string, shared: string[]): Map<number, string[]> {
  const rows = new Map<number, string[]>();
  const rowRe = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(sheetXml))) {
    const rowIndex = parseInt(rowMatch[1], 10);
    const cellRe = /<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[2]))) {
      const attrs = cellMatch[1];
      const inner = cellMatch[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!ref) continue;
      const type = /\bt="(\w+)"/.exec(attrs)?.[1] ?? "n";
      let value = "";
      const v = /<v(?:[^>]*?)>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      if (type === "s" && v !== undefined) value = shared[parseInt(v, 10)] ?? "";
      else if (type === "str" || type === "n" || type === "e") value = v !== undefined ? decodeEntities(v) : "";
      else if (type === "inlineStr") {
        value = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1])).join("");
      }
      const col = colIndex(ref);
      const line = rows.get(rowIndex) ?? [];
      line[col] = value;
      rows.set(rowIndex, line);
    }
  }
  return rows;
}

// ---------------------------------------------------------------- the report

export function isXlsxBuffer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const b = new Uint8Array(buffer, 0, 4);
  return b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07);
}

/** `2025.05.13 18:43:28` → `2025-05-13 18:43:28` — MetaTrader's dots to ISO. */
function mtStamp(raw: string): string {
  return raw.trim().replace(/^(\d{4})\.(\d{2})\.(\d{2})/, "$1-$2-$3");
}

function parseAccountType(header: string): AccountType {
  const text = (header || "").toLowerCase();
  if (text.includes("demo")) return "demo";
  return "live";
}

export async function parseRoboForexXlsx(buffer: ArrayBuffer, zones: RoboZones): Promise<ParsedResult> {
  const parts = await unzip(buffer);
  const sheetXml =
    [...parts.keys()].sort().find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)) ?? "";
  if (!sheetXml) throw new Error("the workbook carries no worksheet");
  const sharedRaw = parts.get("xl/sharedStrings.xml");
  const shared = sharedRaw
    ? [...sharedStr(sharedRaw).matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((m) =>
        [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeEntities(t[1])).join("")
      )
    : [];
  const grid = readGrid(xmlText(parts.get(sheetXml) ?? new Uint8Array()), shared);

  // The account line: `27297873 (USD, RoboForex-Pro, real, Hedge)`.
  let accountLabel = "";
  let accountType: AccountType = "unknown";
  const headerRe = (key: string): string => {
    for (const [i, row] of grid) {
      if ((row[0] || "").trim() === key) {
        for (const cell of row.slice(1)) if (cell && cell.trim()) return cell.trim();
      }
    }
    return "";
  };
  accountLabel = headerRe("Account:");
  accountType = parseAccountType(headerRe("Company:") + " " + accountLabel);

  // The Positions table: header row (Time…Profit), then closed rows.
  const headerRow = [...grid.values()].find(
    (r) => (r[0] || "").trim() === "Time" && (r[1] || "").trim() === "Position"
  );
  if (!headerRow) {
    return emptyResult(accountLabel, accountType, ["The report has no Positions table."]);
  }
  const issues: TimeIssues = { gap: 0, ambiguous: 0, noZone: 0, unknownZone: 0 };
  const civilZone = zones.journalZone || zones.sourceZone || "";
  const instantSource: InstantSource = zones.systemSource ? "system-zone" : "source-zone";
  const sourceZone = zones.sourceZone;

  const pinInstant = (raw: string): { instant: Date; wall: string } | null => {
    const res = parseInstant(mtStamp(raw), { sourceZone });
    if (res.status === "ok" && res.instant) {
      return { instant: res.instant, wall: civilZone ? zoneWallParts(res.instant, civilZone).time : res.time };
    }
    if (res.status === "gap") issues.gap += 1;
    else if (res.status === "ambiguous") issues.ambiguous += 1;
    else if (res.status === "need-zone") issues.noZone += 1;
    return null;
  };

  const trades: Trade[] = [];
  let skipped = 0;
  let unfilled = 0;
  const warnings: string[] = [];
  let started = false;
  const byPosition = new Map<string, ParsedResult["trades"][number][]>();
  for (const [rowIndex, row] of [...grid.entries()].sort((a, b) => a[0] - b[0])) {
    const a = (row[0] || "").trim();
    if (!started) {
      if (a === "Positions") started = true;
      continue;
    }
    if (/^(Orders|Deals|Results|Balance:|Credit Facility:|Floating P\/L:|Equity:)/i.test(a)) break;
    if (!/^\d{4}\./.test(a)) continue; // header/blank/summary lines
    const type = (row[3] || "").trim().toLowerCase();
    if (type !== "buy" && type !== "sell") {
      skipped += 1;
      continue;
    }
    const closeTime = (row[8] || "").trim();
    const closePrice = parseFloat(row[9] ?? "");
    if (!closeTime || !Number.isFinite(closePrice)) {
      unfilled += 1;
      continue;
    }
    const symbol = SYMBOL_MAP[(row[2] || "").trim().toUpperCase()] ?? (row[2] || "").trim().toUpperCase();
    const entry = pinInstant(a);
    const exit = pinInstant(closeTime);
    if (!entry || !exit) continue; // the issue is counted where it was refused
    const id = String(row[1] ?? "").trim();
    const spec = {
      symbol,
      direction: (type === "buy" ? "long" : "short") as Trade["direction"],
      quantity: parseFloat(String(row[4] ?? "").split("/")[0]) || 0,
      entryPrice: parseFloat(row[5] ?? "") || 0,
      exitPrice: closePrice,
      stop: parseFloat(row[6] ?? ""),
      target: parseFloat(row[7] ?? ""),
      commission: parseFloat(row[10] ?? "") || 0,
      swap: parseFloat(row[11] ?? "") || 0,
      profit: parseFloat(row[12] ?? "") || 0,
    };
    const sign = spec.direction === "long" ? 1 : -1;
    const trade: Trade = {
      id: `${accountLabel}_${symbol}_${entry.instant.getTime()}_${spec.entryPrice}`,
      origin: "broker",
      dataSource: "broker",
      date: civilZone ? zoneWallParts(entry.instant, civilZone).date : entry.instant.toISOString().slice(0, 10),
      entryTime: entry.wall,
      exitTime: exit.wall,
      entryInstant: entry.instant.toISOString(),
      exitInstant: exit.instant.toISOString(),
      instantSource,
      sourceZone,
      symbol,
      account: accountLabel,
      accountType,
      direction: spec.direction,
      quantity: spec.quantity,
      entryPrice: spec.entryPrice,
      exitPrice: spec.exitPrice,
      // The journal's net is `pnl - commission - fees`; the broker's net is
      // `profit + swap + commission` with those columns signed. The fees
      // field carries the negated signed columns, so the two nets meet.
      commission: round2(-spec.commission),
      fees: round2(-spec.swap),
      pnl: round2(spec.profit),
      pnlPoints: round2((spec.exitPrice - spec.entryPrice) * sign),
      stopLoss: Number.isFinite(spec.stop) && spec.stop > 0 ? spec.stop : undefined,
      stopSource: Number.isFinite(spec.stop) && spec.stop > 0 ? "broker" : undefined,
      stopLevels: Number.isFinite(spec.stop) && spec.stop > 0 ? [spec.stop] : undefined,
      target: Number.isFinite(spec.target) && spec.target > 0 ? spec.target : undefined,
      fillId: id || undefined,
      setup: "",
      mistake: "",
      thesis: "",
      review: "",
      screenshot: "",
      rating: 0,
      timezone: zones.journalZone || undefined,
    };
    // A position split across rows (a future export may) merges into one
    // trade: volumes, costs and profit add, the exits stay as fills.
    const prior = id ? byPosition.get(id) : undefined;
    if (prior) {
      prior[0].quantity = round2(prior[0].quantity + trade.quantity);
      prior[0].commission = round2(prior[0].commission + trade.commission);
      prior[0].fees = round2(prior[0].fees + trade.fees);
      prior[0].pnl = round2(prior[0].pnl + trade.pnl);
      prior[0].exitInstant = trade.exitInstant;
      prior[0].exitPrice = trade.exitPrice;
      prior[0].exitTime = trade.exitTime;
      prior[0].fills = [
        ...(prior[0].fills ?? []),
        {
          side: spec.direction === "long" ? "sell" : "buy",
          time: trade.exitTime,
          instant: trade.exitInstant,
          qty: trade.quantity,
          price: trade.exitPrice,
          pnl: trade.pnl,
          fees: trade.fees,
        },
      ];
    } else {
      trades.push(trade);
      if (id) byPosition.set(id, [trade]);
    }
  }
  const nonPositionRows = skipped;
  if (nonPositionRows) warnings.push(`${nonPositionRows} non-position row(s) skipped.`);
  if (unfilled) warnings.push(`${unfilled} row(s) without a close — not imported.`);
  if (issues.noZone && !sourceZone) {
    warnings.push("Choose the zone the report's times are in — the stamps carry no zone of their own.");
  }
  return {
    trades,
    warnings,
    skipped,
    unfilled,
    unpaired: 0,
    ...(issues.gap + issues.ambiguous + issues.noZone + issues.unknownZone ? { timeIssues: issues } : {}),
    accountsSeen: [{ name: accountLabel, type: accountType }],
  };
}

function xmlText(raw: Uint8Array): string {
  // MetaTrader writes its workbook parts in UTF-16; the BOM or a tell-tale
  // high zero byte decides the decoder.
  if (raw[0] === 0xff && raw[1] === 0xfe) return new TextDecoder("utf-16le").decode(raw.subarray(2));
  if (raw[0] === 0xfe && raw[1] === 0xff) return new TextDecoder("utf-16be").decode(raw.subarray(2));
  if (raw.length > 1 && raw[1] === 0x00) return new TextDecoder("utf-16le").decode(raw);
  return new TextDecoder().decode(raw);
}

function sharedStr(raw: Uint8Array): string {
  return xmlText(raw);
}

function emptyResult(account: string, type: AccountType, warnings: string[]): ParsedResult {
  return { trades: [], warnings, skipped: 0, unfilled: 0, unpaired: 0, accountsSeen: [{ name: account, type }] };
}
