import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The RoboForex Trade History Report (.xlsx) — a zip of XML the journal reads
// without a dependency. These tests build a tiny workbook in the report's own
// shape (via openpyxl, the way MetaTrader lays it out) and pin what the reader
// lifts from it: the closed positions, the broker net, the stops, the account.

const result = await build({
  entryPoints: {
    robo: new URL("../src/lib/roboreport.ts", import.meta.url).pathname,
    futures: new URL("../src/futures.ts", import.meta.url).pathname,
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  outdir: "bundle",
});
const loadBundle = (name) => {
  const output = result.outputFiles.find((file) => file.path.endsWith(`${name}.js`));
  return import(`data:text/javascript;base64,${Buffer.from(output.text).toString("base64")}`);
};
const [robo, futures] = await Promise.all([loadBundle("robo"), loadBundle("futures")]);

// -- the fixture workbook, in MetaTrader's layout ---------------------------
const dir = mkdtempSync(join(tmpdir(), "robo-report-"));
const xlsxPath = join(dir, "report.xlsx");
const py = `
import openpyxl
wb = openpyxl.Workbook()
ws = wb.active
rows = [
    ["Trade History Report"],
    ["Name:", None, None, "Egemen Ilter"],
    ["Account:", None, None, "27297873 (USD, RoboForex-Pro, real, Hedge)"],
    ["Company:", None, None, "RoboForex Ltd"],
    ["Positions"],
    ["Time", "Position", "Symbol", "Type", "Volume", "Price", "S / L", "T / P", "Time", "Price", "Commission", "Swap", "Profit"],
    ["2025.05.13 18:43:28", 918501914, "XAUUSD", "sell", "0.1", 3249.01, 3249.01, 3237.501, "2025.05.13 20:33:15", 3244.84, 0.0, 0.0, 41.7],
    ["2025.05.14 09:14:12", 919293599, "XAUUSD", "sell", "0.05", 3233.01, 3238.72, 3200.0, "2025.05.14 09:18:24", 3232.22, 0.0, -0.5, 3.95],
    ["2025.05.20 11:02:00", 927300001, ".USTECHCash", "buy", "1", 21000.0, 20990.0, 21040.0, "2025.05.20 12:10:00", 21010.0, -1.2, 0.2, 10.0],
    ["2025.05.21 10:00:00", 927300002, "GBPUSD", "buy", "0.1", 1.2500, 1.2480, None, "2025.05.21 11:00:00", 1.2550, 0.0, 0.0, 50.0],
    ["2025.05.22 10:00:00", 927300003, "XAUEUR", "sell", "0.05", 2700.0, None, None, "2025.05.22 10:30:00", 2705.0, 0.0, 0.0, -25.0],
]
for r in rows:
    ws.append(r)
wb.save(${JSON.stringify(xlsxPath)})
`;
execFileSync("python3", ["-c", py]);
const workbook = readFileSync(xlsxPath);
const buffer = workbook.buffer.slice(workbook.byteOffset, workbook.byteOffset + workbook.byteLength);

const zones = { sourceZone: "Europe/Istanbul", journalZone: "Europe/Istanbul" };
const parsed = await robo.parseRoboForexXlsx(buffer, zones);

const net = parsed.trades.reduce((s, t) => s + t.pnl - t.commission - t.fees, 0);

test("the closed positions are read, one trade each", () => {
  assert.equal(parsed.trades.length, 5);
});

test("the account line names the account and its truth", () => {
  assert.equal(parsed.accountsSeen[0].name, "27297873 (USD, RoboForex-Pro, real, Hedge)");
  assert.equal(parsed.accountsSeen[0].type, "live");
  for (const t of parsed.trades) assert.equal(t.account, parsed.accountsSeen[0].name);
});

test("the journal's net reads the broker's net (profit + swap + commission)", () => {
  // 41.7 + (3.95 + 0.5 swap credit) + (10 - 1.2 commission + 0.2 swap credit) + 50 - 25
  assert.equal(Math.round(net * 100) / 100, 79.15);
});

test("times are pinned to the chosen source zone and read in the journal zone", () => {
  const first = parsed.trades[0];
  assert.equal(first.date, "2025-05-13");
  assert.equal(first.entryTime, "18:43:28");
  assert.equal(first.exitTime, "20:33:15");
  assert.equal(first.entryInstant, "2025-05-13T15:43:28.000Z");
  assert.equal(first.timezone, "Europe/Istanbul");
});

test("RoboForex's index names file under the house contracts", () => {
  const ustec = parsed.trades.find((t) => t.symbol === "USTEC");
  assert.ok(ustec, "the index trade was mapped");
  assert.equal(ustec.direction, "long");
});

test("stops and targets are the broker's own levels", () => {
  const first = parsed.trades[0];
  assert.equal(first.stopSource, "broker");
  assert.deepEqual(first.stopLevels, [3249.01]);
  assert.equal(first.stopLoss, 3249.01);
  assert.equal(first.target, 3237.501);
  const gbp = parsed.trades.find((t) => t.symbol === "GBPUSD");
  assert.equal(gbp.stopLoss, 1.248);
  assert.equal(gbp.target, undefined);
});

test("the position id travels as the import identity", () => {
  assert.equal(parsed.trades[0].fillId, "918501914");
  assert.ok(futures.knownFuturesSpec("USTEC"));
});

test("unpriced crosses stay known but unpriced", () => {
  assert.ok(futures.unpricedPair("XAUEUR"), "XAUEUR is a known unpriced pair");
});

test("a file that is not a workbook is refused, not guessed", () => {
  assert.equal(robo.isXlsxBuffer(new TextEncoder().encode("Time,Position\n").buffer), false);
  assert.equal(robo.isXlsxBuffer(workbook.buffer), true);
});

test("a workbook without a Positions table says so", async () => {
  const emptyPath = join(mkdtempSync(join(tmpdir(), "robo-empty-")), "empty.xlsx");
  execFileSync("python3", ["-c", `import openpyxl; wb = openpyxl.Workbook(); wb.active.append(["Nothing here"]); wb.save(${JSON.stringify(emptyPath)})`]);
  const emptyBuf = readFileSync(emptyPath);
  const empty = await robo.parseRoboForexXlsx(
    emptyBuf.buffer.slice(emptyBuf.byteOffset, emptyBuf.byteOffset + emptyBuf.byteLength),
    zones
  );
  assert.equal(empty.trades.length, 0);
  assert.ok(empty.warnings.some((w) => w.includes("Positions")));
});

rmSync(dir, { recursive: true, force: true });
