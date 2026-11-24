import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type TradebookPlugin from "../main";
import { renderAppShell } from "../ui";
import { fmtMoney, todayKey } from "../tz";
import { toneClass } from "../lib/fills";
import { attachTip } from "../lib/tip";
import { netPnl } from "../lib/fees";
import { tradeR } from "../lib/tradeTable";
import { mountDropdown, type DropdownItem } from "../lib/dropdown";
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

/** The run the strategy is on right now: `3W streak`, `2L streak`. */
function streakLabel(series: Trade[]): string {
  const newestFirst = [...series].reverse();
  if (!newestFirst.length) return "";
  const first = netPnl(newestFirst[0]) > 0;
  let i = 0;
  while (i < newestFirst.length && (netPnl(newestFirst[i]) > 0) === first) i++;
  return `${i}${first ? "W" : "L"} streak`;
}

/** Eight distinguishable line colours — one per strategy on the overview. */
const LINE_COLORS = ["#4a9eda", "#d98a4a", "#3fb96f", "#c96fd9", "#e2c044", "#5bc8c8", "#e2699a", "#8aa2f0"];

/**
 * N cumulative lines on one axis, drawn the way a chart should look: dashed
 * gridlines, a dashed zero reference, translucent area under each line,
 * uniform stroke (vector-effect keeps it crisp through the viewBox stretch)
 * and a dot on every point that names its day and running total on hover.
 */
function multiLineChart(
  el: HTMLElement,
  entries: Array<{ series: Trade[]; value?: (t: Trade) => number | null }>,
  opts: { value?: (t: Trade) => number | null; fmt?: (v: number) => string } = {}
): void {
  const valueOf = opts.value ?? netPnl;
  const fmt = opts.fmt ?? ((v: number): string => fmtMoney(v));
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
  const pad = 8;
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
  const min = Math.min(0, ...flat);
  const max = Math.max(0, ...flat);
  const span = max - min || 1;
  const y = (v: number): number => pad + (h - 2 * pad) * (1 - (v - min) / span);
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "tj-strat-chart");
  // Gridlines: the range quartered, dashed and quiet, like a real chart grid.
  for (const v of new Set([min, min + span / 3, min + (2 * span) / 3, max])) {
    const gl = document.createElementNS(svgNS, "line");
    gl.setAttribute("x1", String(pad));
    gl.setAttribute("x2", String(w - pad));
    gl.setAttribute("y1", y(v).toFixed(1));
    gl.setAttribute("y2", y(v).toFixed(1));
    gl.setAttribute("class", "grid");
    svg.appendChild(gl);
  }
  // The zero reference, stronger than the grid.
  const zero = document.createElementNS(svgNS, "line");
  zero.setAttribute("x1", String(pad));
  zero.setAttribute("x2", String(w - pad));
  zero.setAttribute("y1", y(0).toFixed(1));
  zero.setAttribute("y2", y(0).toFixed(1));
  zero.setAttribute("class", "zero");
  svg.appendChild(zero);
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
    const color = final > 0 ? "var(--tj-tone-good)" : final < 0 ? "var(--tj-tone-bad)" : "var(--text-muted)";
    const x = (j: number): number => pad + (j * (w - 2 * pad)) / (cum.length - 1);
    const toPts = (vals: number[]): string => vals.map((v, j) => `${x(j).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    // The area under the line, translucent in the line's own colour.
    const area = document.createElementNS(svgNS, "polygon");
    const zeroY = y(0).toFixed(1);
    area.setAttribute("points", `${toPts(cum)} ${x(cum.length - 1).toFixed(1)},${zeroY} ${pad},${zeroY}`);
    area.setAttribute("fill", color);
    area.setAttribute("fill-opacity", "0.10");
    area.setAttribute("stroke", "none");
    svg.appendChild(area);
    const polyline = document.createElementNS(svgNS, "polyline");
    polyline.setAttribute("points", toPts(cum));
    polyline.setAttribute("class", "tj-strat-chart-line");
    polyline.setAttribute("style", `stroke: ${color}`);
    polyline.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(polyline);
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
      const title = document.createElementNS(svgNS, "title");
      title.textContent = `${p.date} · ${fmt(cum[j])}`;
      band.appendChild(title);
      svg.appendChild(band);
    });
  });
  el.appendChild(svg);
  // Axis numbers at the range's ends and the zero line, printed beside the
  // chart so the eye can read the scale, not just the shape.
  el.addClass("has-axis");
  const axisLabel = (v: number): void => {
    const l = el.createDiv({ cls: "tj-chart-axislabel", text: fmt(v) });
    l.style.top = `${((y(v) / h) * 100).toFixed(1)}%`;
  };
  axisLabel(max);
  if (min !== max) axisLabel(min);
  if (min < 0 && max > 0) axisLabel(0);
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
  /** The other strategy shown beside this one, when comparing. */
  private compareWith: string | null = null;
  /** The detail chart's unit: dollars or R multiples. */
  private chartMode: "usd" | "r" = "usd";

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

    // ---- Cumulative net, one line per strategy ----
    const charted = registered
      .map((s) => ({ name: s.name, series: stats.get(s.name.toLowerCase())?.series ?? [] }))
      .filter((s) => s.series.length >= 2);
    if (charted.length) {
      const chartCard = main.createDiv({ cls: "tj-strat-card tj-strat-chartcard" });
      const chartHead = chartCard.createDiv({ cls: "tj-strat-card-head" });
      chartHead.createDiv({ cls: "tj-strat-card-title", text: "Cumulative net by strategy" });
      const chartEl = chartCard.createDiv({ cls: "tj-strat-chartbox" });
      multiLineChart(
        chartEl,
        charted.map((s) => ({ series: s.series }))
      );
      const legend = chartCard.createDiv({ cls: "tj-strat-legend" });
      charted.forEach((s) => {
        const net = stats.get(s.name.toLowerCase())?.net ?? 0;
        const item = legend.createSpan({ cls: "tj-strat-legend-item" });
        const dot = item.createSpan({ cls: "tj-strat-legend-dot", attr: { "aria-hidden": "true" } });
        dot.style.background = net > 0 ? "var(--tj-tone-good)" : net < 0 ? "var(--tj-tone-bad)" : "var(--text-muted)";
        item.createSpan({ text: s.name });
        item.addEventListener("click", () => {
          this.selected = s.name;
          this.rulesEditing = false;
          void this.render();
        });
      });
    }

    // ---- Names the trades carry that are not registered ----
    if (untracked.length) {
      const sub = main.createDiv({ cls: "tj-strat-card tj-strat-untracked-card" });
      sub.createDiv({ cls: "tj-strat-card-title", text: "Untracked strategy names" });
      const list = sub.createDiv({ cls: "tj-strat-rows" });
      for (const name of untracked) this.renderUntrackedRow(list, name, stats);
    }
  }

  /** One overview card: click opens the strategy's own page. */
  private renderCard(grid: HTMLElement, name: string, stats: Map<string, StratStat>, captureFocus: (el: HTMLInputElement) => void): void {
    const g = stats.get(name.toLowerCase()) ?? emptyStat();
    const item = grid.createDiv({ cls: "tj-strat-grid-item" });
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
    top.createDiv({ cls: "tj-strat-item-name", text: name });

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
    stat("Profit factor", g.n ? profitFactor(g) : "—");
    stat("Avg R", g.n ? fmtAvgR(g.rSum, g.rN) : "—", g.rN ? toneClass(g.rSum / (g.rN || 1)) : "");
    stat("Missed", g.missedN ? `${g.missedN} · ${fmtMoney(g.missedPnl)}` : "0", g.missedN ? "is-hypothetical" : "");

    // ---- Cumulative chart, in dollars or in R ----
    const chartCard = main.createDiv({ cls: "tj-strat-card tj-strat-chartcard" });
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
    multiLineChart(chartEl, [{ series: g.series }], { value: valueOf, fmt: fmtOf });
    if (this.chartMode === "r") {
      chartEl.setAttr("title", "Cumulative R — trades without a recorded stop cannot sit on an R curve, so they are left out.");
    }

    // ---- Outcomes: one bar per trade, tallest = biggest move ----
    if (g.series.length) {
      const ocCard = main.createDiv({ cls: "tj-strat-card" });
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
      const symCard = main.createDiv({ cls: "tj-strat-card" });
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

    // ---- Rules ----
    const rulesCard = main.createDiv({ cls: "tj-strat-card tj-strat-rulescard" });
    const rulesHead = rulesCard.createDiv({ cls: "tj-strat-card-head" });
    rulesHead.createDiv({ cls: "tj-strat-card-title", text: "Rules" });
    const bodyText = await this.plugin.readStrategyNoteBody(name);
    const shown = bodyText.trim().replace(/^#\s+.*\n?/, "").trim();
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
      ta.value = bodyText;
      const row = rulesBody.createDiv({ cls: "tj-strat-rules-actions" });
      const saveBtn = row.createEl("button", { cls: "tj-btn tj-mini", text: "Save rules" });
      saveBtn.addEventListener("click", async () => {
        const okSave = await this.plugin.saveStrategyNoteBody(name, ta.value);
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
      const recentCard = main.createDiv({ cls: "tj-strat-card" });
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

    // ---- Compare ----
    if (this.compareWith) {
      this.renderCompare(main, name, this.compareWith, stats);
    } else {
      const others = [...stats.keys()].filter((k) => k !== name.toLowerCase() && (stats.get(k)?.n ?? 0) > 0);
      if (others.length) {
        const bar = main.createDiv({ cls: "tj-strat-compare-bar" });
        bar.createSpan({ cls: "tj-strat-compare-l", text: "Compare with" });
        const items: DropdownItem[] = others.map((k) => ({ id: k, label: this.strategyLabel(k) }));
        mountDropdown(
          bar.createDiv({ cls: "tj-strat-compare-pick" }),
          items,
          "",
          (id) => {
            this.compareWith = id;
            void this.render();
          },
          { placeholder: "Pick a strategy" }
        );
      }
    }
  }

  /** The registry's own spelling of a stat key, or the key itself. */
  private strategyLabel(k: string): string {
    const rec = (this.plugin.settings.strategies ?? []).find((s) => s.name.trim().toLowerCase() === k);
    return rec?.name ?? k;
  }

  /** Two strategies side by side: the same numbers, twice, one curve each. */
  private renderCompare(main: HTMLElement, name: string, otherName: string, stats: Map<string, StratStat>): void {
    const a = stats.get(name.toLowerCase()) ?? emptyStat();
    const b = stats.get(otherName.toLowerCase()) ?? emptyStat();
    const labelOf = (k: string): string => this.strategyLabel(k);
    const card = main.createDiv({ cls: "tj-strat-card" });
    const head = card.createDiv({ cls: "tj-strat-card-head" });
    head.createDiv({ cls: "tj-strat-card-title", text: `${labelOf(name)} vs ${labelOf(otherName)}` });
    const clear = head.createEl("button", { cls: "tj-btn tj-mini", text: "✕ close" });
    clear.addEventListener("click", () => {
      this.compareWith = null;
      void this.render();
    });

    const cols = card.createDiv({ cls: "tj-strat-compare-cols" });
    const column = (s: StratStat, label: string): void => {
      const col = cols.createDiv({ cls: "tj-strat-compare-col" });
      col.createDiv({ cls: "tj-strat-compare-name", text: label });
      const pair = (l: string, v: string, cls = ""): void => {
        const row = col.createDiv({ cls: "tj-strat-compare-row" });
        row.createSpan({ text: l });
        row.createSpan({ cls: `tj-strat-compare-v ${cls}`.trim(), text: v });
      };
      pair("Trades", String(s.n));
      pair("Net", s.n ? fmtMoney(s.net) : "—", s.n ? toneClass(s.net) : "");
      pair("Win rate", s.n ? `${Math.round((s.wins / s.n) * 100)}%` : "—");
      pair("Profit factor", s.n ? profitFactor(s) : "—");
      pair("Avg R", s.n ? fmtAvgR(s.rSum, s.rN) : "—");
      pair("Missed", s.missedN ? `${s.missedN} · ${fmtMoney(s.missedPnl)}` : "0");
    };
    column(a, labelOf(name));
    column(b, labelOf(otherName));

    const chartEl = card.createDiv({ cls: "tj-strat-chartbox" });
    multiLineChart(chartEl, [
      { series: a.series },
      { series: b.series },
    ]);
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
