import { ItemView, Modal, MarkdownRenderer, Notice, setIcon, TFile, type WorkspaceLeaf } from "obsidian";
import type TradebookPlugin from "../main";
import { renderAppShell } from "../ui";
import { fmtMoney, fmtMoneyCompact, todayKey } from "../tz";
import { toneClass } from "../lib/fills";
import { attachTip } from "../lib/tip";
import { netPnl } from "../lib/fees";
import { tradeR } from "../lib/tradeTable";
import { mountDropdown, type DropdownItem } from "../lib/dropdown";
import { reviewStatus } from "../lib/review";
import type { Trade } from "../types";

export const SETUPS_VIEW_TYPE = "tradebook-setups-view";

/** Everything one strategy's page shows, computed from the notes. */
interface StratStat {
  n: number;
  net: number;
  wins: number;
  /** Gross wins and gross losses (abs), for the profit factor. */
  grossWin: number;
  grossLoss: number;
  rSum: number;
  rN: number;
  /** Chronological (oldest first) — the chart's series and the streak. */
  series: Trade[];
  missedN: number;
  missedPnl: number;
}

const emptyStat = (): StratStat => ({
  n: 0, net: 0, wins: 0, grossWin: 0, grossLoss: 0, rSum: 0, rN: 0, series: [], missedN: 0, missedPnl: 0,
});

/** `+1.84R` — average R with its sign, or an honest absence. */
function fmtAvgR(rSum: number, rN: number): string {
  if (!rN) return "—";
  const v = rSum / rN;
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;
}

/** Profit factor: gross wins over gross losses; an absence reads as one. */
function profitFactor(s: StratStat): string {
  if (!s.grossWin || !s.grossLoss) return "—";
  return (s.grossWin / s.grossLoss).toFixed(2);
}

/** A profit factor above 1 makes money; below 1 it leaks. */
function profitFactorClass(s: StratStat): string {
  if (!s.grossWin || !s.grossLoss) return "";
  return s.grossWin / s.grossLoss >= 1 ? "tj-pos" : "tj-neg";
}

/** The run the strategy is on right now: `3W streak`, `2L streak`. */
function streakLabel(series: Trade[]): string {
  const newestFirst = [...series].reverse();
  if (!newestFirst.length) return "";
  const first = netPnl(newestFirst[0]) > 0;
  let i = 0;
  while (i < newestFirst.length && (netPnl(newestFirst[i]) > 0) === first) i++;
  return `${i}${first ? "W" : "L"} streak`;
}

/** Chart drawing state — ids of gradients must be unique per document. */
let chartSeq = 0;

/**
 * A smooth curve through the points: uniform Catmull-Rom, the round-shouldered
 * spline a proper chart library draws — peaks stay round, dips stay round, and
 * the curve reads as one flowing line instead of a chain of straightish beats.
 * (A strict monotone variant was tried first; it refuses to overshoot but
 * flattens at every data point, which is exactly the stiffness being fixed.)
 */
function monotonePath(xs: number[], ys: number[]): string {
  const n = xs.length;
  if (n < 2) return "";
  if (n === 2) return `M ${xs[0].toFixed(2)} ${ys[0].toFixed(2)} L ${xs[1].toFixed(2)} ${ys[1].toFixed(2)}`;
  const px = (i: number): number => xs[Math.max(0, Math.min(n - 1, i))];
  const py = (i: number): number => ys[Math.max(0, Math.min(n - 1, i))];
  let path = `M ${xs[0].toFixed(2)} ${ys[0].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const c1x = px(i) + (px(i + 1) - px(i - 1)) / 6;
    const c1y = py(i) + (py(i + 1) - py(i - 1)) / 6;
    const c2x = px(i + 1) - (px(i + 2) - px(i)) / 6;
    const c2y = py(i + 1) - (py(i + 2) - py(i)) / 6;
    path += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${px(i + 1).toFixed(2)} ${py(i + 1).toFixed(2)}`;
  }
  return path;
}

/** Friendly round numbers for the y axis: enough labels to read the scale
 *  (0, 100, 200… in dollars; 0.00, 1.00, 2.00… in R), stopping where the
 *  lines stop — never drawing ticks beyond the range the chart holds. */
function niceTicks(min: number, max: number, count = 6): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / (count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2.5 ? 2.5 : norm >= 2 ? 2 : norm >= 1 ? 1 : 0.5) * mag;
  const out: number[] = [];
  const start = Math.ceil(min / step - 1e-9) * step;
  for (let v = start; v <= max + step * 1e-9; v += step) {
    out.push(Number(v.toFixed(10)));
  }
  return out;
}

/**
 * N cumulative lines on one axis, drawn the way a chart should look: dashed
 * gridlines, a dashed zero reference, translucent area under each line,
 * uniform stroke (vector-effect keeps it crisp through the viewBox stretch)
 * and a dot on every point that names its day and running total on hover.
 */
function multiLineChart(
  el: HTMLElement,
  entries: Array<{ series: Trade[]; value?: (t: Trade) => number | null }>,
  opts: { value?: (t: Trade) => number | null; fmt?: (v: number) => string; axisFmt?: (v: number) => string; cssHeight?: number } = {}
): void {
  const valueOf = opts.value ?? netPnl;
  const fmt = opts.fmt ?? ((v: number): string => fmtMoney(v));
  const axisFmt = opts.axisFmt ?? fmt;
  const usable = entries
    .map((e) => {
      const pts: Array<{ date: string; v: number }> = [];
      for (const t of e.series) {
        const v = valueOf(t);
        // A trade the chart's unit cannot price (no stop → no R) just does not
        // sit on the curve; it does not erase the curve for everyone else.
        if (v === null || !Number.isFinite(v)) continue;
        pts.push({ date: t.date, v });
      }
      return pts;
    })
    .filter((pts) => pts.length >= 2);
  if (!usable.length) {
    el.createSpan({ cls: "tj-strat-chart-empty", text: "A curve needs two trades." });
    return;
  }
  const w = 320;
  const h = 150;
  const pad = 4;
  const cums = usable.map((pts) => {
    const out: number[] = [];
    let acc = 0;
    for (const p of pts) {
      acc += p.v;
      out.push(acc);
    }
    return out;
  });
  const flat = cums.flat();
  // The scale carries headroom: the spline's round shoulders swing a little
  // past the data, and the top (and bottom, when the curve dips under zero)
  // of the chart must hold that swing instead of cutting the peak flat.
  const dataMax = Math.max(0, ...flat);
  const dataMin = Math.min(0, ...flat);
  const head = (dataMax - dataMin || 1) * 0.08;
  const scaleHi = dataMax + head;
  const scaleLo = dataMin < 0 ? dataMin - head : dataMin;
  const span = scaleHi - scaleLo || 1;
  const y = (v: number): number => pad + (h - 2 * pad) * (1 - (v - scaleLo) / span);
  // One tick list drives both the gridlines and the axis labels.
  const ticks = niceTicks(scaleLo, scaleHi, 5);
  const svgNS = "http://www.w3.org/2000/svg";
  // Gradient stops cannot read CSS variables (an SVG attribute with var()
  // resolves to nothing and paints black), so the tones are resolved to their
  // real values here, once per chart.
  const bodyStyle = getComputedStyle(document.body);
  const toneGood = bodyStyle.getPropertyValue("--tj-tone-good").trim() || "#34d17a";
  const toneBad = bodyStyle.getPropertyValue("--tj-tone-bad").trim() || "#ff5d48";
  const toneMuted = bodyStyle.getPropertyValue("--text-muted").trim() || "#9aa0a6";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "tj-strat-chart");
  // The gradient each line's area fades with — from the line's colour at the
  // top to almost nothing at the zero line.
  const defs = document.createElementNS(svgNS, "defs");
  svg.appendChild(defs);
  // Gridlines at friendly round numbers; the zero line dashed over them.
  for (const v of ticks) {
    if (v === 0) continue;
    const gl = document.createElementNS(svgNS, "line");
    gl.setAttribute("x1", String(pad));
    gl.setAttribute("x2", String(w - pad));
    gl.setAttribute("y1", y(v).toFixed(1));
    gl.setAttribute("y2", y(v).toFixed(1));
    gl.setAttribute("class", "grid");
    svg.appendChild(gl);
  }
  const zero = document.createElementNS(svgNS, "line");
  zero.setAttribute("x1", String(pad));
  zero.setAttribute("x2", String(w - pad));
  zero.setAttribute("y1", y(0).toFixed(1));
  zero.setAttribute("y2", y(0).toFixed(1));
  zero.setAttribute("class", "zero");
  svg.appendChild(zero);
  // The zero line also splits the fill: whatever the curve holds above it
  // paints green, whatever it dips below paints red — the colour belongs to
  // the range, not to where the trade ended. Two clips cut the same area path
  // at the zero line; two gradients fade each colour from its curve side
  // toward the line.
  const zeroYv = y(0);
  const mkClip = (id: string, top: number, height: number): void => {
    const clip = document.createElementNS(svgNS, "clipPath");
    clip.setAttribute("id", id);
    const rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("x", String(pad));
    rect.setAttribute("y", top.toFixed(2));
    rect.setAttribute("width", String(w - 2 * pad));
    rect.setAttribute("height", Math.max(0, height).toFixed(2));
    clip.appendChild(rect);
    defs.appendChild(clip);
  };
  mkClip(`tjclipA${chartSeq}`, 0, zeroYv);
  mkClip(`tjclipB${chartSeq}`, zeroYv, h - pad - zeroYv);
  const mkGrad = (id: string, y1: number, y2: number, color: string, o1: number, o2: number): void => {
    const grad = document.createElementNS(svgNS, "linearGradient");
    grad.setAttribute("id", id);
    grad.setAttribute("gradientUnits", "userSpaceOnUse");
    grad.setAttribute("x1", "0");
    grad.setAttribute("x2", "0");
    grad.setAttribute("y1", y1.toFixed(2));
    grad.setAttribute("y2", y2.toFixed(2));
    for (const [offset, opacity] of [[0, o1], [1, o2]] as Array<[number, number]>) {
      const stop = document.createElementNS(svgNS, "stop");
      stop.setAttribute("offset", String(offset));
      stop.setAttribute("stop-color", color);
      stop.setAttribute("stop-opacity", String(opacity));
      grad.appendChild(stop);
    }
    defs.appendChild(grad);
  };
  mkGrad(`tjgradup${chartSeq}`, 0, zeroYv, toneGood, 0.32, 0.08);
  mkGrad(`tjgraddown${chartSeq}`, zeroYv, h - pad, toneBad, 0.08, 0.32);
  usable.forEach((pts, i) => {
    const cum: number[] = [];
    let acc = 0;
    for (const p of pts) {
      acc += p.v;
      cum.push(acc);
    }
    // The line wears the result it ends with: green over zero, red under it —
    // the same tones every other number in the journal speaks in.
    const final = cum[cum.length - 1];
    const color = final > 0 ? toneGood : final < 0 ? toneBad : toneMuted;
    const x = (j: number): number => pad + (j * (w - 2 * pad)) / (cum.length - 1);
    const lineD = monotonePath(cum.map((_, j) => x(j)), cum.map((v) => y(v)));
    // The area between the curve and the zero line, painted twice: the part
    // above the zero line clips to green, the part below it to red.
    const zeroY = y(0).toFixed(2);
    const areaD = `${lineD} L ${x(cum.length - 1).toFixed(2)} ${zeroY} L ${x(0).toFixed(2)} ${zeroY} Z`;
    for (const [fill, clip] of [
      [`url(#tjgradup${chartSeq})`, `url(#tjclipA${chartSeq})`],
      [`url(#tjgraddown${chartSeq})`, `url(#tjclipB${chartSeq})`],
    ] as Array<[string, string]>) {
      const area = document.createElementNS(svgNS, "path");
      area.setAttribute("d", areaD);
      area.setAttribute("fill", fill);
      area.setAttribute("clip-path", clip);
      area.setAttribute("stroke", "none");
      svg.appendChild(area);
    }
    // The stroke itself splits at the zero line: the same path drawn twice,
    // the part above zero green, below it red — the curve never carries one
    // trade's result across a crossing it did not make.
    for (const [stroke, clip] of [
      [toneGood, `url(#tjclipA${chartSeq})`],
      [toneBad, `url(#tjclipB${chartSeq})`],
    ] as Array<[string, string]>) {
      const seg = document.createElementNS(svgNS, "path");
      seg.setAttribute("d", lineD);
      seg.setAttribute("class", "tj-strat-chart-line");
      seg.setAttribute("style", `stroke: ${stroke}`);
      seg.setAttribute("vector-effect", "non-scaling-stroke");
      seg.setAttribute("fill", "none");
      seg.setAttribute("clip-path", clip);
      svg.appendChild(seg);
    }
    // One hover band per trade: names its day and the running total on hover,
    // and a band never distorts the way a stretched dot would.
    pts.forEach((p, j) => {
      const bandX = (k: number): number => (k === 0 ? pad : (x(k - 1) + x(k)) / 2);
      const band = document.createElementNS(svgNS, "rect");
      band.setAttribute("x", bandX(j).toFixed(1));
      band.setAttribute("y", String(pad));
      band.setAttribute("width", (j === pts.length - 1 ? w - pad - bandX(j) : bandX(j + 1) - bandX(j)).toFixed(1));
      band.setAttribute("height", String(h - 2 * pad));
      band.setAttribute("class", "band");
      // Filled transparent in the markup too — an SVG rect defaults to black
      // paint, and the CSS rule must not be the only thing keeping it away.
      band.setAttribute("fill", "transparent");
      band.setAttribute("pointer-events", "all");
      const title = document.createElementNS(svgNS, "title");
      title.textContent = `${p.date} · ${fmt(cum[j])}`;
      band.appendChild(title);
      svg.appendChild(band);
    });
  });
  chartSeq++;
  // The axes live around the svg as plain HTML: labels written into the svg
  // would stretch with the viewBox, HTML ones never do.
  const wrap = el.createDiv({ cls: "tj-chart-wrap" });
  wrap.appendChild(svg);
  const cssH = opts.cssHeight ?? 200;
  for (const v of ticks) {
    const l = wrap.createDiv({ cls: "tj-chart-ylabel", text: axisFmt(v) });
    l.style.top = `${((y(v) / h) * cssH).toFixed(0)}px`;
  }
  const maxN = Math.max(...usable.map((pts) => pts.length));
  // Every trade gets its number on the axis; a long series is thinned so the
  // numbers never collide, but #1 and #N are always printed.
  const every = maxN <= 10 ? 1 : Math.ceil(maxN / 8);
  for (let k = 0; k < maxN; k++) {
    if (k % every !== 0 && k !== maxN - 1) continue;
    const label = wrap.createDiv({ cls: "tj-chart-xlabel", text: `#${k + 1}` });
    const frac = (pad + (k * (w - 2 * pad)) / (maxN - 1)) / w;
    label.style.left = `calc(52px + (100% - 60px) * ${frac.toFixed(4)})`;
    label.style.transform = k === 0 ? "none" : k === maxN - 1 ? "translateX(-100%)" : "translateX(-50%)";
  }
}

/**
 * Strategies — registering the names you trade under. A name is enough to file
 * every trade under one, and each registration also leaves a note in
 * `library/strategies/`. The overview is a grid of cards, one per strategy;
 * opening a card is the strategy's own page — its numbers, its cumulative
 * curve, its rules (written straight into the note) and its recent trades.
 */
export class SetupsView extends ItemView {
  plugin: TradebookPlugin;
  private adding = false;
  private renaming: string | null = null;
  /** The strategy whose detail page is open; null = the overview grid. */
  private selected: string | null = null;
  private rulesEditing = false;
  private focusTarget: HTMLInputElement | null = null;
  /** The stats window: every number on the page reads through it. */
  private period: "all" | "month" | "year" = "all";
  /** The detail chart's unit: dollars or R multiples. */
  private chartMode: "usd" | "r" = "usd";
  /** The overview comparison: which metric, which trade side, which strategy. */
  private overviewMetric: "pf" | "net" | "winrate" | "avgr" | "exp" = "pf";
  private overviewSide: "all" | "wins" | "losses" = "all";
  private overviewPick = "";

  constructor(leaf: WorkspaceLeaf, plugin: TradebookPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SETUPS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.selected ? `Strategy · ${this.selected}` : "Strategies";
  }

  getIcon(): string {
    return "target";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async refresh(): Promise<void> {
    await this.render();
  }

  /** Open the page directly in its small name-only creation state. */
  async beginAddStrategy(): Promise<void> {
    this.adding = true;
    this.renaming = null;
    this.selected = null;
    await this.render();
  }

  // ------------------------------------------------------------------ data --

  /**
   * Per-strategy aggregates, computed from the notes once per render. Real
   * trades only — missed setups are counted separately, and count in nothing.
   */
  private async collectStats(): Promise<Map<string, StratStat>> {
    const stats = new Map<string, StratStat>();
    const statOf = (name: string): StratStat => {
      const k = name.trim().toLowerCase();
      let s = stats.get(k);
      if (!s) {
        s = emptyStat();
        stats.set(k, s);
      }
      return s;
    };
    try {
      const trades = await this.plugin.loadTrades();
      // Portfolio demo rule — the same one the dashboard's baseTrades()
      // applies. Strategies has no account or account-type picker of its own,
      // so there is never an explicit scope here: with the setting on, demo
      // trades and archived accounts stay out of these totals.
      const excludeDemos = this.plugin.settings.excludeDemosFromPortfolio !== false;
      const prefix = this.period === "month" ? todayKey(this.plugin.settings.timeZone).slice(0, 7) : this.period === "year" ? todayKey(this.plugin.settings.timeZone).slice(0, 4) : "";
      const inPeriod = (t: Trade): boolean => !prefix || t.date.startsWith(prefix);
      const usable = trades.filter(
        (t) => inPeriod(t) && !this.plugin.isArchivedTrade(t) && !(excludeDemos && this.plugin.resolveAccountType(t.account) === "demo") && Number.isFinite(t.pnl)
      );
      for (const t of usable) {
        const name = (t.setup || "").trim();
        if (!name) continue;
        const s = statOf(name);
        const net = netPnl(t);
        s.n += 1;
        s.net += net;
        if (net > 0) {
          s.wins += 1;
          s.grossWin += net;
        } else {
          s.grossLoss += Math.abs(net);
        }
        const r = tradeR(t);
        if (r !== null) {
          s.rSum += r;
          s.rN += 1;
        }
        s.series.push(t);
      }
      // Missed setups filed under the strategy: visible, never counted.
      try {
        for (const t of await this.plugin.loadMissedTrades()) {
          if (!inPeriod(t)) continue;
          const name = (t.setup || "").trim();
          if (!name) continue;
          const s = statOf(name);
          s.missedN += 1;
          s.missedPnl += Number.isFinite(t.pnl) ? netPnl(t) : 0;
        }
      } catch { /* notes unreadable — the card still shows the taken trades */ }
      for (const s of stats.values()) {
        s.series.sort((a, b) => `${a.date} ${a.entryTime}`.localeCompare(`${b.date} ${b.entryTime}`));
      }
    } catch {
      /* notes unreadable — the registry still renders below */
    }
    return stats;
  }

  // ---------------------------------------------------------------- render --

  async render(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("tj-setups");
    const main = renderAppShell(root, this.plugin, "setups");
    if (this.selected) await this.renderDetail(main);
    else await this.renderOverview(main);
    if (this.focusTarget) {
      const el = this.focusTarget;
      window.setTimeout(() => el.focus(), 0);
      this.focusTarget = null;
    }
  }

  /** How many filed trades each window holds — the buttons show their reach. */
  private async windowCounts(): Promise<{ all: number; month: number; year: number }> {
    const trades = await this.plugin.loadTrades();
    const excludeDemos = this.plugin.settings.excludeDemosFromPortfolio !== false;
    const usable = trades.filter(
      (t) => !this.plugin.isArchivedTrade(t) && !(excludeDemos && this.plugin.resolveAccountType(t.account) === "demo") && Number.isFinite(t.pnl) && !!(t.setup || "").trim()
    );
    const today = todayKey(this.plugin.settings.timeZone);
    const count = (prefix: string): number => usable.filter((t) => !prefix || t.date.startsWith(prefix)).length;
    return { all: usable.length, month: count(today.slice(0, 7)), year: count(today.slice(0, 4)) };
  }

  /** The stats window as three buttons, each showing its own trade count. */
  private async renderPeriodControl(main: HTMLElement): Promise<void> {
    const counts = await this.windowCounts();
    const seg = main.createDiv({ cls: "tj-strat-period" });
    const opts: Array<["all" | "month" | "year", string, number]> = [
      ["all", "All time", counts.all],
      ["month", "This month", counts.month],
      ["year", "This year", counts.year],
    ];
    for (const [id, label, n] of opts) {
      const b = seg.createEl("button", {
        cls: "tj-add-seg-btn" + (this.period === id ? " on" : ""),
        attr: { type: "button" },
      });
      b.createSpan({ text: label });
      const badge = b.createSpan({ cls: "tj-strat-period-badge", text: String(n) });
      badge.setAttr("title", "Filed trades inside this window");
      b.addEventListener("click", () => {
        if (this.period === id) return;
        this.period = id;
        void this.render();
      });
    }
  }

  private async renderOverview(main: HTMLElement): Promise<void> {
    main.createEl("h1", { text: "Strategies", cls: "tj-view-h1" });
    main.createEl("p", {
      cls: "tj-view-intro",
      text: "Name the strategies you trade so every trade can be filed under one. Open a card for the strategy's own numbers, rules and recent trades.",
    });

    const stats = await this.collectStats();
    await this.renderPeriodControl(main);

    const registered = this.plugin.settings.strategies ?? [];
    const registeredKeys = new Set(registered.map((s) => s.name.trim().toLowerCase()));
    const names = await this.plugin.knownSetups();
    const untracked = names.filter((n) => !registeredKeys.has(n.toLowerCase()));

    // ---- Your strategies ----
    const card = main.createDiv({ cls: "tj-strat-card" });
    const head = card.createDiv({ cls: "tj-strat-card-head" });
    head.createDiv({ cls: "tj-strat-card-title", text: "Your strategies" });
    const addBtn = head.createEl("button", { cls: "tj-btn tj-mini", text: "＋ add strategy" });
    addBtn.addEventListener("click", () => {
      this.adding = true;
      this.renaming = null;
      void this.render();
    });

    if (this.adding) {
      const row = card.createDiv({ cls: "tj-strat-add" });
      const input = row.createEl("input", { type: "text", cls: "tj-strat-input" });
      input.placeholder = "E.g. Reversal";
      this.focusTarget = input;
      const submit = () => void this.addStrategy(input.value);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
        if (e.key === "Escape") {
          this.adding = false;
          void this.render();
        }
      });
      const add = row.createEl("button", { cls: "tj-btn tj-mini", text: "Add" });
      add.addEventListener("click", submit);
      const cancel = row.createEl("button", { cls: "tj-btn tj-mini", text: "Cancel" });
      cancel.addEventListener("click", () => {
        this.adding = false;
        void this.render();
      });
    }

    if (!registered.length) {
      const empty = card.createDiv({ cls: "tj-strat-empty" });
      empty.createDiv({ text: "No strategies named yet." });
      empty.createDiv({
        cls: "tj-strat-empty-sub",
        text: "Add one here, or create it straight from a trade's Strategy picker.",
      });
    } else {
      const grid = card.createDiv({ cls: "tj-strat-grid" });
      for (const s of registered) this.renderCard(grid, s.name, stats, (el) => (this.focusTarget = el));
    }

    // ---- Strategy comparison, one bar per strategy (the setups overview) ----
    const charted = registered.filter((s) => (stats.get(s.name.toLowerCase())?.n ?? 0) > 0);
    if (charted.length) this.renderOverviewBars(main, stats);

    // ---- Names the trades carry that are not registered ----
    if (untracked.length) {
      const sub = main.createDiv({ cls: "tj-strat-card tj-strat-untracked-card" });
      sub.createDiv({ cls: "tj-strat-card-title", text: "Untracked strategy names" });
      const list = sub.createDiv({ cls: "tj-strat-rows" });
      for (const name of untracked) this.renderUntrackedRow(list, name, stats);
    }
  }

  /** The overview comparison: one horizontal bar per strategy against its
   *  metric's baseline, the way a setup list is actually scanned. */
  private renderOverviewBars(main: HTMLElement, stats: Map<string, StratStat>): void {
    const card = main.createDiv({ cls: "tj-strat-card tj-strat-chartcard" });
    const head = card.createDiv({ cls: "tj-strat-card-head" });
    head.createDiv({ cls: "tj-strat-card-title", text: "Strategy comparison" });
    const ctl = head.createDiv({ cls: "tj-strat-overview-ctl" });
    for (const [id, label] of [
      ["all", "All"],
      ["wins", "Wins"],
      ["losses", "Losses"],
    ] as const) {
      ctl.createEl("button", {
        cls: "tj-add-seg-btn" + (this.overviewSide === id ? " on" : ""),
        text: label,
        attr: { type: "button" },
      }).addEventListener("click", () => {
        if (this.overviewSide === id) return;
        this.overviewSide = id;
        void this.render();
      });
    }
    const metrics = [
      { id: "pf", label: "Profit factor" },
      { id: "net", label: "Net P&L" },
      { id: "winrate", label: "Win rate" },
      { id: "avgr", label: "Avg R" },
      { id: "exp", label: "Expectancy" },
    ] as const;
    mountDropdown(
      ctl.createDiv(),
      metrics.map((m) => ({ id: m.id, label: m.label })),
      this.overviewMetric,
      (id) => {
        if (id === this.overviewMetric) return;
        this.overviewMetric = id as (typeof metrics)[number]["id"];
        void this.render();
      },
      { placeholder: "Metric" }
    );
    const registeredAll = this.plugin.settings.strategies ?? [];
    mountDropdown(
      ctl.createDiv(),
      [{ id: "", label: "Setups: All" }, ...registeredAll.map((s) => ({ id: s.name, label: `Setups: ${s.name}` }))],
      this.overviewPick,
      (id) => {
        if (id === this.overviewPick) return;
        this.overviewPick = id;
        void this.render();
      },
      { placeholder: "Setups: All" }
    );

    const metric = metrics.find((m) => m.id === this.overviewMetric) ?? metrics[0];
    const rows = registeredAll
      .filter((s) => !this.overviewPick || s.name === this.overviewPick)
      .map((s) => {
        const g = stats.get(s.name.trim().toLowerCase()) ?? emptyStat();
        const series = g.series.filter((t) =>
          this.overviewSide === "wins" ? netPnl(t) > 0 : this.overviewSide === "losses" ? netPnl(t) < 0 : true
        );
        const n = series.length;
        let grossWin = 0;
        let grossLoss = 0;
        let net = 0;
        let wins = 0;
        for (const t of series) {
          const v = netPnl(t);
          net += v;
          if (v > 0) {
            wins += 1;
            grossWin += v;
          } else if (v < 0) grossLoss -= v;
        }
        const rRows = series.map(tradeR).filter((r): r is number => r !== null);
        let value: number | null = null;
        if (metric.id === "pf") value = grossLoss > 0 ? grossWin / grossLoss : null;
        else if (metric.id === "net") value = n ? net : null;
        else if (metric.id === "winrate") value = n ? (wins / n) * 100 : null;
        else if (metric.id === "avgr") value = rRows.length ? rRows.reduce((a, b) => a + b, 0) / rRows.length : null;
        else value = n ? net / n : null;
        return { name: s.name, status: s.status ?? "active", n, value };
      })
      .filter((r): r is { name: string; status: "active" | "testing" | "archived"; n: number; value: number } =>
        Number.isFinite(r.value)
      )
      .sort((a, b) => (a.status === "archived" ? 1 : 0) - (b.status === "archived" ? 1 : 0) || (b.value ?? 0) - (a.value ?? 0));

    // Header line: who leads, and how much of the record still awaits review.
    const needsReview = registeredAll.reduce((sum, s) => {
      const g = stats.get(s.name.trim().toLowerCase());
      return sum + (g?.series.filter((t) => !reviewStatus(t).complete).length ?? 0);
    }, 0);
    const best = rows[0];
    const info = card.createDiv({ cls: "tj-strat-overview-info" });
    if (best) {
      const fmt = metric.id === "pf" ? (v: number): string => v.toFixed(2) : metric.id === "avgr" ? (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R` : metric.id === "winrate" ? (v: number): string => `${Math.round(v)}%` : (v: number): string => fmtMoney(v);
      info.createSpan({ text: "Best performer: " });
      const lead = info.createEl("b", { text: best.name });
      lead.addClass(metric.id === "net" || metric.id === "exp" || metric.id === "avgr" ? toneClass(best.value) : "tj-pos");
      info.createSpan({ text: ` · ${fmt(best.value)} ${metric.label.toLowerCase()} · ${best.n} trades · Needs review: ` });
      const rev = info.createSpan({ text: String(needsReview) });
      if (needsReview) rev.addClass("tj-warn");
    }

    if (!rows.length) {
      card.createDiv({ cls: "tj-strat-chart-empty", text: `No strategy has a ${metric.label.toLowerCase()} to compare yet.` });
      return;
    }

    // ---- The bars ----
    const baseline = metric.id === "pf" ? 1 : metric.id === "winrate" ? 50 : 0;
    const values = rows.map((r) => r.value);
    let lo = Math.min(baseline, ...values);
    let hi = Math.max(baseline, ...values);
    const padV = (hi - lo || Math.abs(hi) || 1) * 0.15;
    lo -= padV;
    hi += padV;
    const ticks = niceTicks(lo, hi, 6);
    const span = hi - lo || 1;
    const labelW = 88;
    const rowH = 44;
    const width = Math.max(card.clientWidth || 640, 320);
    const height = rows.length * rowH + 26;
    const x = (v: number): number => labelW + ((v - lo) / span) * (width - labelW - 14);
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("class", "tj-strat-overview-svg");
    const bodyStyle = getComputedStyle(document.body);
    const good = bodyStyle.getPropertyValue("--tj-tone-good").trim() || "#34d17a";
    const bad = bodyStyle.getPropertyValue("--tj-tone-bad").trim() || "#ff5d48";
    for (const v of ticks) {
      const t = document.createElementNS(svgNS, "line");
      t.setAttribute("x1", x(v).toFixed(1));
      t.setAttribute("x2", x(v).toFixed(1));
      t.setAttribute("y1", "0");
      t.setAttribute("y2", String(rows.length * rowH));
      t.setAttribute("class", "grid");
      svg.appendChild(t);
      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", x(v).toFixed(1));
      label.setAttribute("y", String(rows.length * rowH + 16));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("class", "tj-strat-bar-tick");
      const fmt =
        metric.id === "pf"
          ? (v: number): string => v.toFixed(2)
          : metric.id === "net" || metric.id === "exp"
            ? (v: number): string => fmtMoneyCompact(v)
            : metric.id === "avgr"
              ? (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(1)}R`
              : (v: number): string => `${Math.round(v)}%`;
      label.textContent = fmt(v);
      svg.appendChild(label);
    }
    // The dotted baseline: what a strategy must beat.
    const base = document.createElementNS(svgNS, "line");
    base.setAttribute("x1", x(baseline).toFixed(1));
    base.setAttribute("x2", x(baseline).toFixed(1));
    base.setAttribute("y1", "0");
    base.setAttribute("y2", String(rows.length * rowH));
    base.setAttribute("class", "zero");
    svg.appendChild(base);
    rows.forEach((r, i) => {
      const yMid = i * rowH + rowH / 2;
      const name = document.createElementNS(svgNS, "text");
      name.setAttribute("x", "6");
      name.setAttribute("y", (yMid + 4).toFixed(1));
      name.setAttribute("class", "tj-strat-bar-label");
      name.textContent = r.name.length > 12 ? `${r.name.slice(0, 11)}…` : r.name;
      svg.appendChild(name);
      const barY = yMid - 8;
      const xFrom = x(baseline);
      const xTo = x(r.value);
      const bar = document.createElementNS(svgNS, "rect");
      bar.setAttribute("x", Math.min(xFrom, xTo).toFixed(1));
      bar.setAttribute("y", barY.toFixed(1));
      bar.setAttribute("width", Math.max(2, Math.abs(xTo - xFrom)).toFixed(1));
      bar.setAttribute("height", "16");
      bar.setAttribute("rx", "4");
      bar.setAttribute("fill", r.value >= baseline ? good : bad);
      if (r.status === "archived") bar.setAttribute("opacity", "0.4");
      const title = document.createElementNS(svgNS, "title");
      title.textContent = `${r.name} · ${r.value.toFixed(metric.id === "pf" ? 2 : 2)} · ${r.n} trades`;
      bar.appendChild(title);
      svg.appendChild(bar);
      const hit = document.createElementNS(svgNS, "rect");
      hit.setAttribute("x", "0");
      hit.setAttribute("y", String(i * rowH));
      hit.setAttribute("width", String(width));
      hit.setAttribute("height", String(rowH));
      hit.setAttribute("fill", "transparent");
      hit.setAttribute("cursor", "pointer");
      hit.addEventListener("click", () => {
        this.selected = r.name;
        this.rulesEditing = false;
        void this.render();
      });
      svg.appendChild(hit);
    });
    card.createDiv({ cls: "tj-strat-overview-chart" }).appendChild(svg);
  }

  /** One overview card: click opens the strategy's own page. */
  private renderCard(grid: HTMLElement, name: string, stats: Map<string, StratStat>, captureFocus: (el: HTMLInputElement) => void): void {
    const g = stats.get(name.toLowerCase()) ?? emptyStat();
    const rec = (this.plugin.settings.strategies ?? []).find((s) => s.name === name);
    const status = rec?.status ?? "active";
    const item = grid.createDiv({ cls: "tj-strat-grid-item" + (status === "archived" ? " is-archived" : "") });
    item.addEventListener("click", () => {
      this.selected = name;
      this.rulesEditing = false;
      void this.render();
    });
    item.setAttr("title", "Open the strategy");

    const top = item.createDiv({ cls: "tj-strat-card-top" });
    if (this.renaming === name) {
      const input = top.createEl("input", { type: "text", cls: "tj-strat-input" });
      input.value = name;
      captureFocus(input);
      const save = () => void this.renameStrategy(name, input.value);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") {
          this.renaming = null;
          void this.render();
        }
      });
      input.addEventListener("click", (e) => e.stopPropagation());
      const actions = item.createDiv({ cls: "tj-strat-item-actions is-open" });
      const ok = actions.createEl("button", { cls: "tj-iconbtn" });
      setIcon(ok, "check");
      attachTip(ok, { title: "Save the rename", sub: "Every trade filed under it is updated." });
      ok.addEventListener("click", (e) => {
        e.stopPropagation();
        save();
      });
      const cancel = actions.createEl("button", { cls: "tj-iconbtn" });
      setIcon(cancel, "x");
      cancel.addEventListener("click", (e) => {
        e.stopPropagation();
        this.renaming = null;
        void this.render();
      });
      return;
    }
    const nameEl = top.createDiv({ cls: "tj-strat-item-name", text: name });
    if (status !== "active") {
      const chip = nameEl.createSpan({ cls: `tj-strat-item-status is-${status}`, text: status });
      chip.setAttr("title", status === "testing" ? "Under trial — judged like the rest until you decide" : "Parked: still visible, judged by nothing new");
    }

    const actions = item.createDiv({ cls: "tj-strat-item-actions" });
    const renameBtn = actions.createEl("button", { cls: "tj-iconbtn" });
    setIcon(renameBtn, "pencil");
    attachTip(renameBtn, { title: "Rename", sub: "Every trade filed under it is updated." });
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.renaming = name;
      this.adding = false;
      void this.render();
    });
    const delBtn = actions.createEl("button", { cls: "tj-iconbtn" });
    setIcon(delBtn, "trash");
    attachTip(delBtn, { title: "Remove from the list", sub: "Trades and the strategy note stay as they are." });
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.removeStrategy(name);
    });

    if (!g.n) {
      const meta = item.createDiv({ cls: "tj-strat-item-meta" });
      meta.createSpan({ text: "not used yet" });
      return;
    }

    const winRate = Math.round((g.wins / g.n) * 100);
    const metrics = item.createDiv({ cls: "tj-strat-card-metrics" });
    metrics.createSpan({ text: `${g.n} ${g.n === 1 ? "trade" : "trades"}` });
    metrics.createSpan({ cls: "tj-strat-sep", text: "·" });
    metrics.createSpan({ text: `${winRate}% win` });
    if (g.missedN) {
      metrics.createSpan({ cls: "tj-strat-sep", text: "·" });
      const mchip = metrics.createSpan({ cls: "tj-strat-missed", text: `missed ${g.missedN}` });
      attachTip(mchip, {
        title: "Missed setups",
        sub: `What they would have been: ${fmtMoney(g.missedPnl)}. They count in no total.`,
      });
    }
    const bottom = item.createDiv({ cls: "tj-strat-card-bottom" });
    bottom.createSpan({
      cls: "tj-strat-card-expectancy",
      text: fmtAvgR(g.rSum, g.rN),
      attr: { title: "Average R — profit over the risk actually taken, when the trade carries a stop" },
    });
    const pnl = bottom.createSpan({ cls: "tj-strat-card-pnl " + toneClass(g.net) });
    pnl.setText(g.net === 0 ? "—" : fmtMoney(g.net));

    const streak = streakLabel(g.series);
    if (streak) {
      const foot = item.createDiv({ cls: "tj-strat-card-streak", text: streak });
      foot.setAttr("title", "The run it is on right now");
    }
  }

  /** A name the trades carry that is not registered — one quiet row. */
  private renderUntrackedRow(list: HTMLElement, name: string, stats: Map<string, StratStat>): void {
    const g = stats.get(name.toLowerCase());
    const row = list.createDiv({ cls: "tj-strat-item" });
    const info = row.createDiv({ cls: "tj-strat-item-main" });
    info.createDiv({ cls: "tj-strat-item-name", text: name });
    const meta = info.createDiv({ cls: "tj-strat-item-meta" });
    meta.createSpan({ text: g?.n ? `${g.n} ${g.n === 1 ? "trade" : "trades"}` : "not used yet" });
    if (g?.n) {
      const pnl = meta.createSpan({ cls: "tj-strat-item-pnl " + toneClass(g.net) });
      pnl.setText(g.net === 0 ? "—" : fmtMoney(g.net));
    }
    const chip = meta.createSpan({ cls: "tj-strat-untracked", text: "untracked" });
    attachTip(chip, {
      title: "Not registered",
      sub: "A trade carries this name, but it is not in your list yet.",
    });
    const actions = row.createDiv({ cls: "tj-strat-item-actions" });
    const add = actions.createEl("button", { cls: "tj-iconbtn" });
    setIcon(add, "plus");
    attachTip(add, { title: `Register "${name}"`, sub: "Adds it to the list and gives it a note." });
    add.addEventListener("click", () => void this.registerStrategy(name));
  }

  // ---------------------------------------------------------------- detail --

  private async renderDetail(main: HTMLElement): Promise<void> {
    const name = this.selected as string;
    const stats = await this.collectStats();
    const g = stats.get(name.toLowerCase()) ?? emptyStat();

    // ---- Back + title ----
    const nav = main.createDiv({ cls: "tj-strat-detail-nav" });
    const back = nav.createEl("button", { cls: "tj-btn tj-mini", text: "← All strategies" });
    back.addEventListener("click", () => {
      this.selected = null;
      this.rulesEditing = false;
      void this.render();
    });
    await this.renderPeriodControl(nav);

    const titleRow = main.createDiv({ cls: "tj-strat-detail-head" });
    const titleBlock = titleRow.createDiv({ cls: "tj-strat-detail-title" });
    titleBlock.createEl("h1", { text: name, cls: "tj-view-h1" });
    const streak = streakLabel(g.series);
    if (streak) titleBlock.createSpan({ cls: "tj-strat-detail-streak", text: streak });

    // Lifecycle: the strategy's own state, sitting beside its name where the
    // eye already is — not tucked into the icon row.
    const rec = (this.plugin.settings.strategies ?? []).find((s) => s.name === name);
    const status = rec?.status ?? "active";
    const statusSeg = titleBlock.createDiv({ cls: "tj-strat-status-seg" });
    for (const [id, label] of [
      ["active", "Active"],
      ["testing", "Testing"],
      ["archived", "Archived"],
    ] as const) {
      statusSeg.createEl("button", {
        cls: "tj-add-seg-btn" + (status === id ? " on" : ""),
        text: label,
        attr: { type: "button" },
      }).addEventListener("click", () => {
        if (status === id) return;
        void (async () => {
          await this.plugin.setStrategyStatus(name, id);
          new Notice(`"${name}" marked ${id}.`);
        })();
      });
    }

    const actions = titleRow.createDiv({ cls: "tj-strat-item-actions" });
    const noteBtn = actions.createEl("button", { cls: "tj-iconbtn" });
    setIcon(noteBtn, "book-open");
    attachTip(noteBtn, { title: "Open the strategy note", sub: "The note in your vault, outside this panel." });
    noteBtn.addEventListener("click", () => void this.plugin.openStrategyNote(name));
    const renameBtn = actions.createEl("button", { cls: "tj-iconbtn" });
    setIcon(renameBtn, "pencil");
    attachTip(renameBtn, { title: "Rename", sub: "Every trade filed under it is updated." });
    renameBtn.addEventListener("click", () => {
      this.renaming = name;
      this.selected = null;
      void this.render();
    });
    const delBtn = actions.createEl("button", { cls: "tj-iconbtn" });
    setIcon(delBtn, "trash");
    attachTip(delBtn, { title: "Remove from the list", sub: "Trades and the strategy note stay as they are." });
    delBtn.addEventListener("click", () => void this.removeStrategy(name));

    // ---- Metric grid ----
    const grid = main.createDiv({ cls: "tj-strat-statgrid" });
    const stat = (label: string, value: string, cls = ""): void => {
      const cell = grid.createDiv({ cls: "tj-strat-stat" });
      cell.createDiv({ cls: "tj-strat-stat-l", text: label });
      cell.createDiv({ cls: `tj-strat-stat-v ${cls}`.trim(), text: value });
    };
    stat("Trades", String(g.n));
    stat("Net", g.n ? fmtMoney(g.net) : "—", g.n ? toneClass(g.net) : "");
    stat("Win rate", g.n ? `${Math.round((g.wins / g.n) * 100)}%` : "—");
    stat("Profit factor", g.n ? profitFactor(g) : "—", g.n ? profitFactorClass(g) : "");
    stat("Avg R", g.n ? fmtAvgR(g.rSum, g.rN) : "—", g.rN ? toneClass(g.rSum / (g.rN || 1)) : "");
    stat("Missed", g.missedN ? `${g.missedN} · ${fmtMoney(g.missedPnl)}` : "0", g.missedN ? "is-hypothetical" : "");

    // ---- The chart in a wide column, the trade shapes stacked beside it ----
    const midGrid = main.createDiv({ cls: "tj-strat-detail-grid" });
    const chartCol = midGrid.createDiv({ cls: "tj-strat-detail-col is-wide" });
    const sideCol = midGrid.createDiv({ cls: "tj-strat-detail-col" });
    const chartCard = chartCol.createDiv({ cls: "tj-strat-card tj-strat-chartcard" });
    const chartHead = chartCard.createDiv({ cls: "tj-strat-card-head" });
    chartHead.createDiv({ cls: "tj-strat-card-title", text: "Cumulative" });
    const modeSeg = chartHead.createDiv({ cls: "tj-strat-chart-toggle" });
    for (const [id, label] of [["usd", "$"], ["r", "R"]] as const) {
      const b = modeSeg.createEl("button", {
        cls: "tj-add-seg-btn" + (this.chartMode === id ? " on" : ""),
        text: label,
        attr: { type: "button" },
      });
      b.addEventListener("click", () => {
        if (this.chartMode === id) return;
        this.chartMode = id;
        void this.render();
      });
    }
    const chartEl = chartCard.createDiv({ cls: "tj-strat-chartbox" });
    const valueOf = this.chartMode === "r" ? (t: Trade) => tradeR(t) : (t: Trade) => netPnl(t);
    const fmtOf =
      this.chartMode === "r"
        ? (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`
        : (v: number): string => fmtMoney(v);
    multiLineChart(chartEl, [{ series: g.series }], {
      value: valueOf,
      fmt: fmtOf,
      axisFmt: this.chartMode === "r" ? fmtOf : fmtMoneyCompact,
    });
    if (this.chartMode === "r") {
      chartEl.setAttr("title", "Cumulative R — trades without a recorded stop cannot sit on an R curve, so they are left out.");
    }

    // ---- Outcomes: one bar per trade, tallest = biggest move ----
    if (g.series.length) {
      const ocCard = sideCol.createDiv({ cls: "tj-strat-card" });
      ocCard.createDiv({ cls: "tj-strat-card-title", text: "Outcomes" });
      ocCard.createDiv({
        cls: "tj-strat-outcome-cap",
        text: "One bar per trade, oldest first — green wins, red losses; hover for the day and the amount.",
      });
      const strip = ocCard.createDiv({ cls: "tj-strat-outcome" });
      const maxAbs = Math.max(...g.series.map((t) => Math.abs(netPnl(t))), 1);
      for (const t of g.series) {
        const net = netPnl(t);
        const bar = strip.createDiv({ cls: `tj-strat-outcome-bar ${toneClass(net)}`.trim() });
        bar.style.height = `${Math.max(3, Math.round((Math.abs(net) / maxAbs) * 30))}px`;
        bar.setAttr("title", `${t.date} · ${t.symbol} · ${fmtMoney(net)}`);
      }
    }

    // ---- By symbol: where the strategy actually works ----
    const syms = new Map<string, { n: number; net: number }>();
    for (const t of g.series) {
      const k = (t.symbol || "").toUpperCase() || "—";
      const s = syms.get(k) ?? { n: 0, net: 0 };
      s.n += 1;
      s.net += netPnl(t);
      syms.set(k, s);
    }
    if (syms.size > 1) {
      const symCard = sideCol.createDiv({ cls: "tj-strat-card" });
      symCard.createDiv({ cls: "tj-strat-card-title", text: "By symbol" });
      const rowsEl = symCard.createDiv({ cls: "tj-strat-symbols" });
      const symMax = Math.max(...[...syms.values()].map((s) => Math.abs(s.net)), 1);
      for (const [sym, s] of [...syms.entries()].sort((x, y) => y[1].net - x[1].net)) {
        const row = rowsEl.createDiv({ cls: "tj-strat-symbol-row" });
        row.createSpan({ cls: "tj-strat-symbol-name", text: sym });
        const barWrap = row.createDiv({ cls: "tj-strat-symbol-barwrap" });
        const bar = barWrap.createDiv({ cls: `tj-strat-symbol-bar ${toneClass(s.net)}`.trim() });
        bar.style.width = `${Math.round((Math.abs(s.net) / symMax) * 100)}%`;
        row.createSpan({ cls: `tj-strat-symbol-val ${toneClass(s.net)}`.trim(), text: `${s.n} · ${fmtMoney(s.net)}` });
      }
    }

    // ---- Rules (under the chart, where the eye lands after it) ----
    // The editor shows only what the trader wrote: the note's own heading and
    // intro line stay in the file and are rebuilt on save.
    const rulesCard = chartCol.createDiv({ cls: "tj-strat-card tj-strat-rulescard" });
    const rulesHead = rulesCard.createDiv({ cls: "tj-strat-card-head" });
    rulesHead.createDiv({ cls: "tj-strat-card-title", text: "Rules" });
    const bodyText = await this.plugin.readStrategyNoteBody(name);
    const boiler = /^#[^\n]*\n+>[^\n]*\n?/.exec(bodyText)?.[0] ?? "";
    const userRules = bodyText.slice(boiler.length).trim();
    const shown = userRules;
    const statusChip = rulesHead.createSpan({
      cls: "tj-strat-rules-chip " + (shown ? "is-ready" : "is-empty"),
      text: shown ? "rules ✓" : "no rules yet",
    });
    attachTip(statusChip, {
      title: shown ? "Rules are written" : "No rules yet",
      sub: "Rules live in the strategy's vault note — write them here and they save into it.",
    });
    const rulesBody = rulesCard.createDiv({ cls: "tj-strat-rules-body" });
    if (this.rulesEditing) {
      const editBtn = rulesHead.createEl("button", { cls: "tj-btn tj-mini", text: "Cancel" });
      editBtn.addEventListener("click", () => {
        this.rulesEditing = false;
        void this.render();
      });
      const ta = rulesBody.createEl("textarea", { cls: "tj-strat-rules-input" });
      ta.value = userRules;
      const row = rulesBody.createDiv({ cls: "tj-strat-rules-actions" });
      const saveBtn = row.createEl("button", { cls: "tj-btn tj-mini", text: "Save rules" });
      saveBtn.addEventListener("click", async () => {
        const nextBody = boiler + (ta.value.trim() ? `${ta.value.trim()}\n` : "");
        const okSave = await this.plugin.saveStrategyNoteBody(name, nextBody);
        if (okSave) new Notice("Rules saved into the strategy note.");
        else new Notice("Could not write the note.");
        this.rulesEditing = false;
        await this.render();
      });
      row.createEl("button", { cls: "tj-btn tj-mini", text: "Discard" }).addEventListener("click", () => {
        this.rulesEditing = false;
        void this.render();
      });
      this.focusTarget = ta as unknown as HTMLInputElement;
    } else {
      const editBtn = rulesHead.createEl("button", { cls: "tj-btn tj-mini", text: "Edit rules" });
      editBtn.addEventListener("click", () => {
        this.rulesEditing = true;
        void this.render();
      });
      if (shown) {
        rulesBody.createDiv({ cls: "tj-strat-rules-text", text: shown });
      } else {
        rulesBody.createDiv({ cls: "tj-strat-rules-empty", text: "No rules written yet — Edit rules to add them." });
      }
    }

    // ---- Recent trades ----
    if (g.series.length) {
      const recentCard = sideCol.createDiv({ cls: "tj-strat-card" });
      recentCard.createDiv({ cls: "tj-strat-card-title", text: "Recent trades" });
      const recent = recentCard.createDiv({ cls: "tj-strat-recent tj-strat-recent-page" });
      for (const t of [...g.series].reverse().slice(0, 8)) {
        const rowEl = recent.createDiv({ cls: "tj-strat-recent-row" });
        rowEl.createSpan({ cls: "tj-strat-recent-date", text: t.date });
        rowEl.createSpan({ cls: "tj-strat-recent-sym", text: `${t.symbol} ${t.direction === "long" ? "▲" : "▼"}` });
        const r = tradeR(t);
        if (r !== null) rowEl.createSpan({ cls: "tj-strat-recent-r", text: `${r >= 0 ? "+" : ""}${r.toFixed(2)}R` });
        const p = rowEl.createSpan({ cls: "tj-strat-recent-pnl " + toneClass(netPnl(t)) });
        p.setText(fmtMoney(netPnl(t)));
        rowEl.setAttr("title", "Open the trade");
        rowEl.addEventListener("click", () => void this.plugin.openTradeDetail({ id: t.id }));
      }
    }

    // ---- Linked notes and prints, kept on the strategy note's frontmatter ----
    await this.renderLinkedNotes(sideCol, name);
    await this.renderPrints(sideCol, name);
  }

  /** The searchable note picker the link button opens — every markdown file
   *  in the vault, narrowed as the trader types. */
  private openNotePicker(name: string, linked: string[]): void {
    const modal = new Modal(this.plugin.app);
    modal.titleEl.setText("Link a note");
    const body = modal.contentEl;
    body.addClass("tj-strat-picker");
    const search = body.createEl("input", {
      type: "text",
      cls: "tj-add-input",
      attr: { spellcheck: "false", placeholder: "Type to search notes…" },
    });
    const list = body.createDiv({ cls: "tj-strat-picker-list" });
    const files = this.plugin.app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path));
    const draw = (): void => {
      const q = search.value.trim().toLowerCase();
      list.empty();
      for (const f of files.filter((f) => !q || f.path.toLowerCase().includes(q))) {
        const row = list.createDiv({ cls: "tj-strat-picker-row" });
        row.createSpan({ cls: "tj-strat-picker-name", text: f.path });
        row.addEventListener("click", () => {
          if (!linked.includes(f.path)) {
            // The newest link becomes the playbook — it sits first.
            void (async () => {
              await this.plugin.saveStrategyNoteMeta(name, { linked: [f.path, ...linked.filter((p) => p !== f.path)] });
              modal.close();
              await this.render();
            })();
          } else modal.close();
        });
      }
      if (!list.children.length) list.createDiv({ cls: "tj-strat-rules-empty", text: "No notes match." });
    };
    search.addEventListener("input", draw);
    draw();
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = list.querySelector<HTMLElement>(".tj-strat-picker-row");
        first?.click();
      }
    });
    modal.open();
    window.setTimeout(() => search.focus(), 50);
  }

  /** Linked notes: the first one is the playbook — its content renders right
   *  here; the rest are chips. Everything lives on the strategy note. */
  private async renderLinkedNotes(host: HTMLElement, name: string): Promise<void> {
    const card = host.createDiv({ cls: "tj-strat-card" });
    const meta = await this.plugin.readStrategyNoteMeta(name);
    const head = card.createDiv({ cls: "tj-strat-card-head" });
    head.createDiv({ cls: "tj-strat-card-title", text: "Linked notes" });
    const linkBtn = head.createEl("button", { cls: "tj-btn tj-mini", text: "＋ link note" });
    linkBtn.addEventListener("click", () => this.openNotePicker(name, meta.linked));

    if (!meta.linked.length) {
      card.createDiv({ cls: "tj-strat-rules-empty", text: "No notes linked yet — link the playbook you trade this setup from." });
      return;
    }

    // The playbook: the first linked note, rendered inline.
    const playbookPath = meta.linked[0];
    const pbFile = this.plugin.app.vault.getAbstractFileByPath(playbookPath);
    if (pbFile instanceof TFile) {
      const pbHead = card.createDiv({ cls: "tj-strat-playbook-head" });
      const pbName = pbHead.createSpan({ cls: "tj-strat-playbook-name", text: pbFile.basename });
      pbName.addEventListener("click", () => void this.plugin.openVaultPath(playbookPath));
      pbHead.createSpan({ cls: "tj-strat-playbook-tag", text: "playbook" });
      const open = pbHead.createEl("button", { cls: "tj-strat-linked-x", text: "open", attr: { type: "button", title: "Open the note" } });
      open.addEventListener("click", () => void this.plugin.openVaultPath(playbookPath));
      const pbBody = card.createDiv({ cls: "tj-strat-playbook-body" });
      try {
        const content = await this.plugin.app.vault.cachedRead(pbFile);
        void MarkdownRenderer.render(this.plugin.app, content, pbBody, playbookPath, this);
      } catch (err) {
        console.error("[tradebook] could not render the playbook note", err);
      }
    }
    // The rest: plain chips.
    if (meta.linked.length > 1) {
      const chips = card.createDiv({ cls: "tj-strat-linked" });
      for (const path of meta.linked.slice(1)) {
        const chip = chips.createDiv({ cls: "tj-strat-linked-chip" });
        chip.createSpan({ cls: "tj-strat-linked-name", text: path.split("/").pop()?.replace(/\.md$/, "") || path });
        chip.setAttr("title", "Open the note");
        chip.addEventListener("click", () => void this.plugin.openVaultPath(path));
        const x = chip.createEl("button", { cls: "tj-strat-linked-x", text: "✕", attr: { type: "button" } });
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          void (async () => {
            await this.plugin.saveStrategyNoteMeta(name, { linked: meta.linked.filter((p) => p !== path) });
            await this.render();
          })();
        });
      }
    }
    // Unlink the playbook: it just leaves the list.
    const unlink = card.createDiv({ cls: "tj-strat-playbook-foot" });
    const un = unlink.createEl("button", { cls: "tj-strat-linked-x", text: `unlink ${pbFile instanceof TFile ? pbFile.basename : ""}`.trim(), attr: { type: "button" } });
    un.addEventListener("click", () => {
      void (async () => {
        await this.plugin.saveStrategyNoteMeta(name, { linked: meta.linked.filter((p) => p !== playbookPath) });
        await this.render();
      })();
    });
  }

  /** The strategy's prints: stored with its note, shown as a thumbnail grid. */
  private async renderPrints(host: HTMLElement, name: string): Promise<void> {
    const card = host.createDiv({ cls: "tj-strat-card" });
    const head = card.createDiv({ cls: "tj-strat-card-head" });
    head.createDiv({ cls: "tj-strat-card-title", text: "Screenshots" });
    const meta = await this.plugin.readStrategyNoteMeta(name);
    const add = head.createEl("button", { cls: "tj-btn tj-mini", text: "＋ add" });
    const fileInput = add.createEl("input", { type: "file", attr: { accept: "image/png,image/jpeg,image/webp" } });
    fileInput.style.display = "none";
    add.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      void (async () => {
        const buf = await file.arrayBuffer();
        const saved = await this.plugin.addStrategyPrint(name, buf, ext);
        if (!saved) new Notice("Could not store the screenshot.");
        await this.render();
      })();
    });
    if (!meta.prints.length) {
      card.createDiv({ cls: "tj-strat-rules-empty", text: "No screenshots yet — ＋ add to attach one; they live with the strategy note." });
    }
    const grid = card.createDiv({ cls: "tj-strat-prints" });
    for (const path of meta.prints) {
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      const cell = grid.createDiv({ cls: "tj-strat-print" });
      const img = cell.createEl("img", { attr: { src: this.plugin.app.vault.getResourcePath(file), alt: path } });
      img.style.cursor = "zoom-in";
      img.addEventListener("click", () => void this.plugin.openMediaPreview(path));
      const x = cell.createEl("button", { cls: "tj-strat-print-x", text: "✕", attr: { type: "button", title: "Remove from the list (the file stays in the vault)" } });
      x.addEventListener("click", () => {
        void (async () => {
          await this.plugin.removeStrategyPrint(name, path);
          await this.render();
        })();
      });
    }
  }

  // -------------------------------------------------------------- registry --

  private async addStrategy(raw: string): Promise<void> {
    const name = (raw || "").trim();
    if (!name) return;
    const existing = this.plugin.findStrategy(name);
    const clean = await this.plugin.addStrategy(name);
    if (!clean) return;
    this.adding = false;
    new Notice(existing ? `Strategy "${clean}" is already registered.` : `Strategy "${clean}" added.`);
    await this.render();
  }

  private async registerStrategy(name: string): Promise<void> {
    await this.plugin.addStrategy(name);
    new Notice(`Strategy "${name}" registered.`);
    await this.render();
  }

  private async renameStrategy(oldName: string, raw: string): Promise<void> {
    const next = (raw || "").trim();
    this.renaming = null;
    if (!next || next.toLowerCase() === oldName.toLowerCase()) {
      await this.render();
      return;
    }
    const changed = await this.plugin.renameSetup(oldName, next);
    new Notice(`Renamed to "${next}" · ${changed} trade${changed === 1 ? "" : "s"} updated.`);
    if (this.selected === oldName) this.selected = next;
    await this.render();
  }

  private async removeStrategy(name: string): Promise<void> {
    const msg = `Remove "${name}" from the list?\n\nTrades keep their strategy and its vault note is kept — only the list entry goes away. To change the trades too, rename it instead.`;
    if (!window.confirm(msg)) return;
    await this.plugin.removeStrategy(name);
    if (this.selected === name) this.selected = null;
    await this.render();
  }
}
