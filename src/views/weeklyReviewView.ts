/**
 * The weekly review page — the Journalit experience in the fork's own frame.
 *
 * The note is the storage (plain markdown, readable anywhere); this page is
 * how the trader works with it: the checklist and forecast written on Sunday,
 * the checklist kept honest through the week, and on Friday the week's own
 * performance rendered live — charts are computed from the record, never
 * pasted.
 */
import { ItemView, Notice, TFile, type WorkspaceLeaf } from "obsidian";
import type TradebookPlugin from "../main";
import { renderAppShell } from "../ui";
import { fmtMoney2 } from "../tz";
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

    // One column, the trader's reading order. Full-width cards.
    const stack = main.createDiv({ cls: "tj-weekly-stack" });

    // ---- 1. Checklist — live through the week ----
    const checklistCard = stack.createDiv({ cls: "tj-strat-card" });
    checklistCard.createDiv({ cls: "tj-strat-card-title", text: "Checklist" });
    const checklist = parseChecklist(body).filter((i) => i.text);
    const list = checklistCard.createDiv({ cls: "tj-weekly-checklist" });
    const saveChecklist = (): void => {
      void (async () => {
        await this.plugin.app.vault.process(file, (content) => writeChecklist(content, checklist));
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
    const addInput = addRow.createEl("input", { type: "text", cls: "tj-add-input", attr: { placeholder: "Add a new checklist item…" } });
    addInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const text = addInput.value.trim();
      if (!text) return;
      checklist.push({ text, done: false });
      addInput.value = "";
      saveChecklist();
      void this.render();
    });

    // ---- 2. Key events — the news the week traded around ----
    const eventsCard = stack.createDiv({ cls: "tj-strat-card" });
    eventsCard.createDiv({ cls: "tj-strat-card-title", text: "Key events" });
    const eventLines = readSection(body, "Key events").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const saveEvents = (): void =>
      void this.plugin.saveWeeklyReviewSection(this.weekKey, "Key events", eventLines.join("\n"));
    const eventsList = eventsCard.createDiv({ cls: "tj-weekly-events" });
    if (!eventLines.length) {
      eventsList.createDiv({ cls: "tj-weekly-hint", text: "No events yet — the news that can move the week." });
    }
    for (const [index, text] of eventLines.entries()) {
      const row = eventsList.createDiv({ cls: "tj-weekly-event" });
      row.createSpan({ text });
      const x = row.createEl("button", { cls: "tj-strat-linked-x", text: "✕", attr: { type: "button" } });
      x.addEventListener("click", () => {
        eventLines.splice(index, 1);
        saveEvents();
        void this.render();
      });
    }
    const eventAdd = eventsList.createDiv({ cls: "tj-weekly-check-add" });
    const eventInput = eventAdd.createEl("input", { type: "text", cls: "tj-add-input", attr: { placeholder: "Tue 15:30 — CPI…" } });
    eventInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const text = eventInput.value.trim();
      if (!text) return;
      eventLines.push(text);
      eventInput.value = "";
      saveEvents();
      void this.render();
    });

    // ---- 3. Screenshots — Before (forecast) against After (review) ----
    const meta = await this.plugin.readWeeklyMeta(this.weekKey);
    const shotsCard = stack.createDiv({ cls: "tj-strat-card" });
    shotsCard.createDiv({ cls: "tj-strat-card-title", text: "Screenshots" });
    const shotsGrid = shotsCard.createDiv({ cls: "tj-weekly-shots" });
    for (const [kind, label, hint] of [
      ["forecast", "Before", "Sunday's chart lands here."],
      ["review", "After", "Friday's charts land here."],
    ] as const) {
      const col = shotsGrid.createDiv({ cls: "tj-weekly-shotcol" });
      const colHead = col.createDiv({ cls: "tj-strat-notes-label" });
      const prints = kind === "forecast" ? meta.forecast : meta.review;
      colHead.createSpan({ text: `${label}${prints.length ? ` (${prints.length})` : ""}` });
      const plus = colHead.createEl("button", { cls: "tj-strat-notes-plus", text: "+", attr: { type: "button", title: `Add a ${kind} screenshot` } });
      const fileInput = plus.createEl("input", { type: "file", attr: { accept: "image/png,image/jpeg,image/webp" } });
      fileInput.style.display = "none";
      plus.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => {
        const f = fileInput.files?.[0];
        if (!f) return;
        const ext = (f.name.split(".").pop() || "png").toLowerCase();
        void (async () => {
          const saved = await this.plugin.addWeeklyPrint(this.weekKey, kind, await f.arrayBuffer(), ext);
          if (!saved) new Notice("Could not store the screenshot.");
          await this.render();
        })();
      });
      const thumbs = col.createDiv({ cls: "tj-weekly-prints" });
      if (!prints.length) {
        thumbs.createDiv({ cls: "tj-weekly-hint", text: hint });
      }
      for (const path of prints) {
        const pf = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(pf instanceof TFile)) continue;
        const cell = thumbs.createDiv({ cls: "tj-weekly-print" });
        const img = cell.createEl("img", { attr: { src: this.plugin.app.vault.getResourcePath(pf), alt: path } });
        img.style.cursor = "zoom-in";
        img.addEventListener("click", () => this.openPrintOverlay(this.plugin.app.vault.getResourcePath(pf)));
        const x = cell.createEl("button", { cls: "tj-strat-print-x", text: "✕", attr: { type: "button", title: "Remove from the list (the file stays in the vault)" } });
        x.addEventListener("click", () => {
          void (async () => {
            await this.plugin.removeWeeklyPrint(this.weekKey, kind, path);
            await this.render();
          })();
        });
      }
    }

    // ---- 4. Forecast — written on Sunday, before the week runs ----
    const forecastCard = stack.createDiv({ cls: "tj-strat-card" });
    forecastCard.createDiv({ cls: "tj-strat-card-title", text: "Forecast" });
    forecastCard.createDiv({
      cls: "tj-weekly-hint",
      text: "Written before the week runs: bias, key levels, the trades you are hunting.",
    });
    const forecastTa = forecastCard.createEl("textarea", { cls: "tj-strat-rules-input tj-weekly-ta" });
    forecastTa.value = readSection(body, "Forecast");
    forecastTa.placeholder = "Sunday's plan goes here…";
    this.wireSectionSave(forecastTa, "Forecast");

    // ---- 5. Review — written on Friday, with the week closed ----
    const reviewCard = stack.createDiv({ cls: "tj-strat-card" });
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

    // ---- 6. Performance and Trades, side by side ----
    const duo = stack.createDiv({ cls: "tj-weekly-duo" });
    const perfCard = duo.createDiv({ cls: "tj-strat-card" });
    const tradesCard = duo.createDiv({ cls: "tj-strat-card" });

    // Performance — live from the record, never pasted.
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

    // By symbol + the two trades that made the week.
    const symbols = new Map<string, { n: number; net: number }>();
    for (const t of trades) {
      const k = (t.symbol || "").toUpperCase() || "—";
      const s = symbols.get(k) ?? { n: 0, net: 0 };
      s.n += 1;
      s.net += netPnl(t);
      symbols.set(k, s);
    }
    if (symbols.size) {
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

    // Trades — one row each, oldest first.
    tradesCard.createDiv({ cls: "tj-strat-card-title", text: `Trades (${trades.length})` });
    if (!sorted.length) {
      tradesCard.createDiv({ cls: "tj-weekly-hint", text: "No trades this week." });
    }
    const tradeList = tradesCard.createDiv({ cls: "tj-strat-recent tj-weekly-trades" });
    for (const t of sorted) {
      const rowEl = tradeList.createDiv({ cls: "tj-strat-recent-row" });
      rowEl.createSpan({ cls: "tj-strat-recent-date", text: t.date.slice(5) });
      rowEl.createSpan({ cls: "tj-strat-recent-sym", text: `${t.symbol} ${t.direction === "long" ? "▲" : "▼"}` });
      const r = tradeR(t);
      if (r !== null) rowEl.createSpan({ cls: "tj-strat-recent-r", text: `${r >= 0 ? "+" : ""}${r.toFixed(2)}R` });
      const p = rowEl.createSpan({ cls: "tj-strat-recent-pnl " + toneClass(netPnl(t)) });
      p.setText(fmtMoney2(netPnl(t)));
      rowEl.setAttr("title", "Open the trade");
      rowEl.addEventListener("click", () => void this.plugin.openTradeDetail({ id: t.id }));
    }
  }

  /** The fullscreen media preview — the print over everything, Esc to leave. */
  private openPrintOverlay(src: string): void {
    document.querySelectorAll(".tj-strat-media-overlay").forEach((n) => n.remove());
    const overlay = document.body.createDiv({ cls: "tj-strat-media-overlay" });
    overlay.createEl("img", { attr: { src, alt: "" } });
    const close = (): void => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    overlay.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
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

  async onClose(): Promise<void> {
    for (const key of Object.keys(this._saveTimers)) window.clearTimeout(this._saveTimers[key]);
  }
}
