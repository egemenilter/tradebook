/**
 * The weekly review page — the Journalit experience in the fork's own frame.
 *
 * The note is the storage (plain markdown, readable anywhere); this page is
 * how the trader works with it: the forecast written on Sunday, the checklist
 * kept honest through the week, and on Friday the week's own performance
 * rendered live — charts are computed from the record, never pasted.
 */
import { ItemView, Notice, TFile, type WorkspaceLeaf } from "obsidian";
import type TradebookPlugin from "../main";
import { renderAppShell } from "../ui";
import { fmtMoney, fmtMoney2 } from "../tz";
import { toneClass } from "../lib/fills";
import { netPnl } from "../lib/fees";
import { tradeR } from "../lib/tradeTable";
import { renderLineChart } from "../lib/lineChart";
import { weekBounds, weekDays, type WeekBounds } from "../lib/weeks";
import { readSection, writeSection, parseChecklist, writeChecklist } from "../lib/noteSections";

export const WEEKLY_REVIEW_VIEW_TYPE = "tradebook-weekly-review-view";

export class WeeklyReviewView extends ItemView {
  private weekKey = "";
  private plugin: TradebookPlugin;
  private _saveTimers: Record<string, number> = {};

  constructor(leaf: WorkspaceLeaf, plugin: TradebookPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return WEEKLY_REVIEW_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.weekKey ? `Weekly Review · ${this.weekKey}` : "Weekly Review";
  }

  getIcon(): string {
    return "clipboard-check";
  }

  async setWeek(weekKey: string): Promise<void> {
    this.weekKey = weekKey;
    await this.render();
  }

  async refresh(): Promise<void> {
    await this.render();
  }

  async onOpen(): Promise<void> {
    if (!this.weekKey) this.weekKey = weekBounds(new Date()).key;
    await this.render();
  }

  /** The week a key names — the key's Thursday carries the identity. */
  private bounds(): WeekBounds {
    const m = /^(\d{4})-W(\d{2})$/.exec(this.weekKey);
    if (!m) return weekBounds(new Date());
    const thursday = new Date(Number(m[1]), 0, 1 + (Number(m[2]) - 1) * 7 + 3);
    return weekBounds(thursday);
  }

  private shiftWeek(days: number): void {
    const m = /^(\d{4})-W(\d{2})$/.exec(this.weekKey);
    if (!m) return;
    const thursday = new Date(Number(m[1]), 0, 1 + (Number(m[2]) - 1) * 7 + 3);
    thursday.setDate(thursday.getDate() + days);
    void this.setWeek(weekBounds(thursday).key);
  }

  private async render(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("tj-weekly");
    const main = renderAppShell(root, this.plugin, "weekly-review");
    const week = this.bounds();

    // ---- Header: the week, with the weeks beside it ----
    const head = main.createDiv({ cls: "tj-weekly-head" });
    const prevBtn = head.createEl("button", { cls: "tj-iconbtn", attr: { type: "button" } });
    prevBtn.setText("◀");
    prevBtn.addEventListener("click", () => this.shiftWeek(-7));
    const titleBlock = head.createDiv({ cls: "tj-weekly-title" });
    titleBlock.createEl("h1", { text: this.weekKey, cls: "tj-view-h1" });
    titleBlock.createSpan({
      cls: "tj-weekly-range",
      text: `${week.start.slice(5)} → ${week.end.slice(5)}`,
    });
    const nextBtn = head.createEl("button", { cls: "tj-iconbtn", attr: { type: "button" } });
    nextBtn.setText("▶");
    nextBtn.addEventListener("click", () => this.shiftWeek(7));
    const noteBtn = head.createEl("button", { cls: "tj-iconbtn", attr: { type: "button", title: "Open the raw note" } });
    import("obsidian").then(({ setIcon }) => setIcon(noteBtn, "file-text"));
    noteBtn.addEventListener("click", () => {
      const f = this.plugin.app.vault.getAbstractFileByPath(this.plugin.weeklyReviewPath(this.weekKey));
      if (f instanceof TFile) void this.plugin.openVaultPath(f.path);
    });

    // ---- The note and the week's trades ----
    const file = await this.plugin.ensureWeeklyReview(this.weekKey);
    if (!(file instanceof TFile)) {
      main.createDiv({ cls: "tj-empty", text: "The weekly review note could not be created." });
      return;
    }
    const body = await this.plugin.app.vault.cachedRead(file);
    const trades = (await this.plugin.loadTrades()).filter(
      (t) => t.date >= week.start && t.date <= week.end && Number.isFinite(t.pnl)
    );
    const sorted = [...trades].sort((a, b) => `${a.date} ${a.entryTime}`.localeCompare(`${b.date} ${b.entryTime}`));

    const grid = main.createDiv({ cls: "tj-weekly-grid" });
    const leftCol = grid.createDiv({ cls: "tj-strat-detail-col is-wide" });
    const rightCol = grid.createDiv({ cls: "tj-strat-detail-col" });

    // ---- Forecast — written on Sunday, before the week runs ----
    const forecastCard = leftCol.createDiv({ cls: "tj-strat-card" });
    forecastCard.createDiv({ cls: "tj-strat-card-title", text: "Forecast" });
    forecastCard.createDiv({
      cls: "tj-weekly-hint",
      text: "Written before the week runs: bias, key events, the trades you are hunting.",
    });
    const forecastTa = forecastCard.createEl("textarea", { cls: "tj-strat-rules-input tj-weekly-ta" });
    forecastTa.value = readSection(body, "Forecast");
    forecastTa.placeholder = "Sunday's plan goes here…";
    this.wireSectionSave(forecastTa, "Forecast");

    // ---- Review — written on Friday, with the week closed ----
    const reviewCard = leftCol.createDiv({ cls: "tj-strat-card" });
    reviewCard.createDiv({ cls: "tj-strat-card-title", text: "Review" });
    reviewCard.createDiv({
      cls: "tj-weekly-hint",
      text: "The five questions, answered with the week closed.",
    });
    const reviewTa = reviewCard.createEl("textarea", { cls: "tj-strat-rules-input tj-weekly-ta" });
    reviewTa.value = readSection(body, "Review");
    if (!reviewTa.value.trim()) {
      reviewTa.value = "### What worked\n\n\n### What didn't\n\n\n### Most profitable setups\n\n\n### Costly mistakes\n";
    }
    this.wireSectionSave(reviewTa, "Review");

    // ---- Checklist — live through the week ----
    const checklistCard = rightCol.createDiv({ cls: "tj-strat-card" });
    checklistCard.createDiv({ cls: "tj-strat-card-title", text: "Checklist" });
    const checklist = parseChecklist(body);
    const list = checklistCard.createDiv({ cls: "tj-weekly-checklist" });
    const saveChecklist = (): void => {
      void (async () => {
        const fresh = await this.plugin.app.vault.cachedRead(file);
        await this.plugin.app.vault.process(file, (content) => writeChecklist(content, checklist));
        this._touched();
        void fresh;
      })();
    };
    if (!checklist.length) {
      list.createDiv({ cls: "tj-weekly-hint", text: "No checklist items — add what must hold this week." });
    }
    checklist.forEach((item, index) => {
      const row = list.createDiv({ cls: "tj-weekly-check" });
      const box = row.createEl("input", { type: "checkbox" });
      box.checked = item.done;
      box.addEventListener("change", () => {
        checklist[index].done = box.checked;
        saveChecklist();
      });
      const label = row.createSpan({ cls: "tj-weekly-check-label" + (item.done ? " is-done" : ""), text: item.text });
      label.addEventListener("click", () => {
        checklist[index].done = !checklist[index].done;
        box.checked = checklist[index].done;
        label.toggleClass("is-done", checklist[index].done);
        saveChecklist();
      });
    });
    const addRow = list.createDiv({ cls: "tj-weekly-check-add" });
    const addInput = addRow.createEl("input", { type: "text", cls: "tj-add-input", attr: { placeholder: "Add an item…" } });
    addInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const text = addInput.value.trim();
      if (!text) return;
      checklist.push({ text, done: false });
      addInput.value = "";
      const row = list.createDiv({ cls: "tj-weekly-check" });
      const box = row.createEl("input", { type: "checkbox" });
      const label = row.createSpan({ cls: "tj-weekly-check-label", text });
      box.addEventListener("change", () => {
        checklist[checklist.length - 1].done = box.checked;
        saveChecklist();
      });
      label.addEventListener("click", () => {
        checklist[checklist.length - 1].done = !checklist[checklist.length - 1].done;
        box.checked = checklist[checklist.length - 1].done;
        label.toggleClass("is-done", checklist[checklist.length - 1].done);
        saveChecklist();
      });
      saveChecklist();
    });

    // ---- Performance — live from the record, never pasted ----
    const perfCard = rightCol.createDiv({ cls: "tj-strat-card" });
    perfCard.createDiv({ cls: "tj-strat-card-title", text: "Performance" });
    const net = trades.reduce((s, t) => s + netPnl(t), 0);
    const wins = trades.filter((t) => netPnl(t) > 0).length;
    const grossWin = trades.reduce((s, t) => s + (netPnl(t) > 0 ? netPnl(t) : 0), 0);
    const grossLoss = trades.reduce((s, t) => s + (netPnl(t) < 0 ? -netPnl(t) : 0), 0);
    const rRows = trades.map((t) => tradeR(t)).filter((r): r is number => r !== null);
    const strip = perfCard.createDiv({ cls: "tj-weekly-perf" });
    const stat = (label: string, value: string, cls = ""): void => {
      const cell = strip.createDiv({ cls: "tj-weekly-perf-cell" });
      cell.createDiv({ cls: "tj-strat-stat-l", text: label });
      cell.createDiv({ cls: `tj-strat-stat-v ${cls}`.trim(), text: value });
    };
    stat("Net", trades.length ? fmtMoney2(net) : "—", trades.length ? toneClass(net) : "");
    stat("Trades", String(trades.length));
    stat("Win rate", trades.length ? `${Math.round((wins / trades.length) * 100)}%` : "—");
    stat("Profit factor", grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "—", grossLoss > 0 ? (grossWin >= grossLoss ? "tj-pos" : "tj-neg") : "");
    stat("Avg R", rRows.length ? `${rRows.reduce((a, b) => a + b, 0) / rRows.length >= 0 ? "+" : ""}${(rRows.reduce((a, b) => a + b, 0) / rRows.length).toFixed(2)}R` : "—");

    // Cumulative net across the seven days — flat days carry the line on.
    let cum = 0;
    const values: number[] = [];
    for (const d of weekDays(week)) {
      cum += trades.filter((t) => t.date === d).reduce((s, t) => s + netPnl(t), 0);
      values.push(Math.round(cum * 100) / 100);
    }
    const chartBox = perfCard.createDiv({ cls: "tj-weekly-chart" });
    chartBox.style.height = "150px";
    if (trades.length) {
      renderLineChart(chartBox, { values, dates: weekDays(week), key: `week-${this.weekKey}`, compact: true });
    } else {
      chartBox.createDiv({ cls: "tj-weekly-hint", text: "No trades this week — the chart waits for the record." });
    }

    // By symbol + the two trades that made the week
    const symbols = new Map<string, { n: number; net: number }>();
    for (const t of trades) {
      const k = (t.symbol || "").toUpperCase() || "—";
      const s = symbols.get(k) ?? { n: 0, net: 0 };
      s.n += 1;
      s.net += netPnl(t);
      symbols.set(k, s);
    }
    if (symbols.size > 1) {
      const symLine = perfCard.createDiv({ cls: "tj-weekly-context" });
      symLine.createSpan({
        text: [...symbols.entries()].sort((a, b) => b[1].net - a[1].net).map(([k, s]) => `${k} ${s.n}×${fmtMoney2(s.net)}`).join(" · "),
      });
    }
    const byTrade = [...sorted].sort((a, b) => netPnl(b) - netPnl(a));
    if (byTrade.length) {
      const extremes = perfCard.createDiv({ cls: "tj-weekly-extremes" });
      const best = byTrade[0];
      const worst = byTrade[byTrade.length - 1];
      for (const [t, tag] of [[best, "Best trade"], [worst, "Worst trade"]] as Array<[typeof best, string]>) {
        const row = extremes.createDiv({ cls: "tj-weekly-extreme" });
        row.createSpan({ text: tag });
        row.createSpan({ text: `${t.symbol} · ${t.date.slice(5)}` });
        const v = row.createSpan({ cls: toneClass(netPnl(t)) });
        v.setText(fmtMoney2(netPnl(t)));
        row.setAttr("title", "Open the trade");
        row.addEventListener("click", () => void this.plugin.openTradeDetail({ id: t.id }));
      }
    }
  }

  /** Debounced section save: typing settles, then the note catches up. */
  private wireSectionSave(ta: HTMLTextAreaElement, heading: string): void {
    ta.addEventListener("input", () => {
      const key = heading;
      window.clearTimeout(this._saveTimers[key]);
      this._saveTimers[key] = window.setTimeout(() => {
        delete this._saveTimers[key];
        void (async () => {
          const ok = await this.plugin.saveWeeklyReviewSection(this.weekKey, heading, ta.value);
          if (!ok) new Notice("Could not save — check the note still exists.");
        })();
      }, 600);
    });
  }

  /** The page was written by hand; the vault watcher should not double-paint. */
  private _touched(): void {
    // Reserved: the reload guard reads a timestamp the trade detail keeps.
  }

  async onClose(): Promise<void> {
    for (const key of Object.keys(this._saveTimers)) window.clearTimeout(this._saveTimers[key]);
  }
}
