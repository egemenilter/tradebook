import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type TradebookPlugin from "../main";
import { renderAppShell } from "../ui";
import { fmtMoney } from "../tz";
import { toneClass } from "../lib/fills";
import { attachTip } from "../lib/tip";
import { netPnl } from "../lib/fees";
import { tradeR } from "../lib/tradeTable";
import type { Trade } from "../types";

export const SETUPS_VIEW_TYPE = "tradebook-setups-view";

/** Everything one strategy's card shows, computed from the notes. */
interface StratStat {
  n: number;
  net: number;
  wins: number;
  rSum: number;
  rN: number;
  /** Newest first, capped at 20 — the recent list and the streak read it. */
  recent: Trade[];
  missedN: number;
  missedPnl: number;
}

/** `+1.84R` — average R with its sign, or a dash-shaped absence. */
function fmtAvgR(rSum: number, rN: number): string {
  if (!rN) return "no R yet";
  const v = rSum / rN;
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}R avg`;
}

/** The run the strategy is on right now: `3W streak`, `2L streak`. */
function streakLabel(recent: Trade[]): string {
  if (!recent.length) return "";
  const first = netPnl(recent[0]) > 0;
  let i = 0;
  while (i < recent.length && netPnl(recent[i]) > 0 === first) i++;
  return `${i}${first ? "W" : "L"} streak`;
}

/**
 * Strategies — registering the names you trade under. A name is enough to file
 * every trade under one strategy, and each registration also leaves a note in
 * `library/strategies/` so the rules and documentation have a home when the full
 * engine lands. Nothing typed here is thrown away later.
 */
export class SetupsView extends ItemView {
  plugin: TradebookPlugin;
  private adding = false;
  private renaming: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: TradebookPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SETUPS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Strategies";
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
    await this.render();
  }

  async render(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("tj-setups");
    const main = renderAppShell(root, this.plugin, "setups");
    main.createEl("h1", { text: "Strategies", cls: "tj-view-h1" });
    main.createEl("p", {
      cls: "tj-view-intro",
      text: "Name the strategies you trade so every trade can be filed under one. Each name keeps its own note in your vault.",
    });

    // ---- Usage, computed from the notes ----
    const stats = new Map<string, StratStat>();
    try {
      const trades = await this.plugin.loadTrades();
      // Portfolio demo rule — the same one the dashboard's baseTrades()
      // applies. Strategies has no account or account-type picker of its own,
      // so there is never an explicit scope here: with the setting on, demo
      // trades and archived accounts stay out of these totals.
      const excludeDemos = this.plugin.settings.excludeDemosFromPortfolio !== false;
      const usable = trades.filter(
        (t) => !this.plugin.isArchivedTrade(t) && !(excludeDemos && this.plugin.resolveAccountType(t.account) === "demo") && Number.isFinite(t.pnl)
      );
      const statOf = (name: string): StratStat => {
        const k = name.trim().toLowerCase();
        let s = stats.get(k);
        if (!s) {
          s = { n: 0, net: 0, wins: 0, rSum: 0, rN: 0, recent: [], missedN: 0, missedPnl: 0 };
          stats.set(k, s);
        }
        return s;
      };
      for (const t of usable) {
        const name = (t.setup || "").trim();
        if (!name) continue;
        const s = statOf(name);
        const net = netPnl(t);
        s.n += 1;
        s.net += net;
        if (net > 0) s.wins += 1;
        const r = tradeR(t);
        if (r !== null) {
          s.rSum += r;
          s.rN += 1;
        }
        s.recent.push(t);
      }
      // Missed setups filed under the strategy: visible, never counted.
      try {
        for (const t of await this.plugin.loadMissedTrades()) {
          const name = (t.setup || "").trim();
          if (!name) continue;
          const s = statOf(name);
          s.missedN += 1;
          s.missedPnl += Number.isFinite(t.pnl) ? netPnl(t) : 0;
        }
      } catch { /* notes unreadable — the card still shows the taken trades */ }
      for (const s of stats.values()) {
        s.recent.sort((a, b) => `${b.date} ${b.entryTime}`.localeCompare(`${a.date} ${a.entryTime}`));
        s.recent = s.recent.slice(0, 20);
      }
    } catch {
      /* notes unreadable — the registry still renders below */
    }

    const registered = this.plugin.settings.strategies ?? [];
    const registeredKeys = new Set(registered.map((s) => s.name.trim().toLowerCase()));
    const names = await this.plugin.knownSetups();
    const untracked = names.filter((n) => !registeredKeys.has(n.toLowerCase()));

    // ---- Your strategies card ----
    const card = main.createDiv({ cls: "tj-strat-card" });
    const head = card.createDiv({ cls: "tj-strat-card-head" });
    head.createDiv({ cls: "tj-strat-card-title", text: "Your strategies" });
    const addBtn = head.createEl("button", { cls: "tj-btn tj-mini", text: "＋ add strategy" });
    addBtn.addEventListener("click", () => {
      this.adding = true;
      this.renaming = null;
      void this.render();
    });

    let focusInput: HTMLInputElement | null = null;

    if (this.adding) {
      const row = card.createDiv({ cls: "tj-strat-add" });
      const input = row.createEl("input", { type: "text", cls: "tj-strat-input" });
      input.placeholder = "E.g. Reversal";
      focusInput = input;
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

    if (!names.length && !this.adding) {
      const empty = card.createDiv({ cls: "tj-strat-empty" });
      empty.createDiv({ text: "No strategies named yet." });
      empty.createDiv({
        cls: "tj-strat-empty-sub",
        text: "Add one here, or create it straight from a trade's Strategy picker.",
      });
    } else {
      const list = card.createDiv({ cls: "tj-strat-rows" });
      for (const s of registered) this.renderRow(list, s.name, stats, false, (el) => (focusInput = el));
      for (const name of untracked) this.renderRow(list, name, stats, true, (el) => (focusInput = el));
    }

    // ---- In development — kept quiet; the card above is the page ----

    if (focusInput) {
      const el = focusInput;
      window.setTimeout(() => el.focus(), 0);
    }
  }

  /** One registry or untracked row; `tracked` false while being renamed. */
  private renderRow(
    list: HTMLElement,
    name: string,
    stats: Map<string, StratStat>,
    untracked: boolean,
    captureFocus: (el: HTMLInputElement) => void
  ): void {
    const g = stats.get(name.toLowerCase());
    const row = list.createDiv({ cls: "tj-strat-item" });
    const info = row.createDiv({ cls: "tj-strat-item-main" });

    if (this.renaming === name) {
      const input = info.createEl("input", { type: "text", cls: "tj-strat-input" });
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
      const actions = row.createDiv({ cls: "tj-strat-item-actions is-open" });
      const ok = actions.createEl("button", { cls: "tj-iconbtn" });
      setIcon(ok, "check");
      attachTip(ok, { title: "Save the rename", sub: "Every trade filed under it is updated." });
      ok.addEventListener("click", save);
      const cancel = actions.createEl("button", { cls: "tj-iconbtn" });
      setIcon(cancel, "x");
      cancel.addEventListener("click", () => {
        this.renaming = null;
        void this.render();
      });
      return;
    }

    info.createDiv({ cls: "tj-strat-item-name", text: name });
    const meta = info.createDiv({ cls: "tj-strat-item-meta" });
    if (!g || !g.n) {
      meta.createSpan({ text: "not used yet" });
    } else {
      const winRate = Math.round((g.wins / g.n) * 100);
      meta.createSpan({ text: `${g.n} ${g.n === 1 ? "trade" : "trades"}` });
      meta.createSpan({ cls: "tj-strat-sep", text: "·" });
      meta.createSpan({ text: `${winRate}% win` });
      meta.createSpan({ cls: "tj-strat-sep", text: "·" });
      meta.createSpan({ text: fmtAvgR(g.rSum, g.rN) });
      const streak = streakLabel(g.recent);
      if (streak) {
        meta.createSpan({ cls: "tj-strat-sep", text: "·" });
        meta.createSpan({ text: streak });
      }
      if (g.missedN) {
        meta.createSpan({ cls: "tj-strat-sep", text: "·" });
        const mchip = meta.createSpan({ cls: "tj-strat-missed", text: `missed ${g.missedN}` });
        attachTip(mchip, {
          title: "Missed setups",
          sub: `What they would have been: ${fmtMoney(g.missedPnl)}. They count in no total.`,
        });
      }
      const pnl = meta.createSpan({ cls: "tj-strat-item-pnl " + toneClass(g.net) });
      pnl.setText(g.net === 0 ? "—" : fmtMoney(g.net));

      if (g.recent.length) {
        const recent = info.createDiv({ cls: "tj-strat-recent" });
        for (const t of g.recent.slice(0, 5)) {
          const rowEl = recent.createDiv({ cls: "tj-strat-recent-row" });
          rowEl.createSpan({ cls: "tj-strat-recent-date", text: t.date.slice(5) });
          rowEl.createSpan({ cls: "tj-strat-recent-sym", text: `${t.symbol} ${t.direction === "long" ? "▲" : "▼"}` });
          const p = rowEl.createSpan({ cls: "tj-strat-recent-pnl " + toneClass(netPnl(t)) });
          p.setText(fmtMoney(netPnl(t)));
          rowEl.setAttr("title", "Open the trade");
          rowEl.addEventListener("click", () => void this.plugin.openTradeDetail({ id: t.id }));
        }
      }
    }
    if (untracked) {
      const chip = meta.createSpan({ cls: "tj-strat-untracked", text: "untracked" });
      attachTip(chip, {
        title: "Not registered",
        sub: "A trade carries this name, but it is not in your list yet.",
      });
    }

    const actions = row.createDiv({ cls: "tj-strat-item-actions" });
    if (untracked) {
      const add = actions.createEl("button", { cls: "tj-iconbtn" });
      setIcon(add, "plus");
      attachTip(add, { title: `Register "${name}"`, sub: "Adds it to the list and gives it a note." });
      add.addEventListener("click", () => void this.registerStrategy(name));
      return;
    }

    const renameBtn = actions.createEl("button", { cls: "tj-iconbtn" });
    setIcon(renameBtn, "pencil");
    attachTip(renameBtn, { title: "Rename", sub: "Every trade filed under it is updated." });
    renameBtn.addEventListener("click", () => {
      this.renaming = name;
      this.adding = false;
      void this.render();
    });
    const noteBtn = actions.createEl("button", { cls: "tj-iconbtn" });
    setIcon(noteBtn, "book-open");
    attachTip(noteBtn, { title: "Open the strategy note", sub: "The rules and documentation for this strategy." });
    noteBtn.addEventListener("click", () => void this.plugin.openStrategyNote(name));
    const delBtn = actions.createEl("button", { cls: "tj-iconbtn" });
    setIcon(delBtn, "trash");
    attachTip(delBtn, { title: "Remove from the list", sub: "Trades and the strategy note stay as they are." });
    delBtn.addEventListener("click", () => void this.removeStrategy(name));
  }

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
    if (!next || next.toLowerCase() === oldName.toLowerCase()) {
      this.renaming = null;
      await this.render();
      return;
    }
    const changed = await this.plugin.renameSetup(oldName, next);
    this.renaming = null;
    new Notice(`Renamed to "${next}" · ${changed} trade${changed === 1 ? "" : "s"} updated.`);
    await this.render();
  }

  private async removeStrategy(name: string): Promise<void> {
    const msg = `Remove "${name}" from the list?\n\nTrades keep their strategy and its vault note is kept — only the list entry goes away. To change the trades too, rename it instead.`;
    if (!window.confirm(msg)) return;
    await this.plugin.removeStrategy(name);
    await this.render();
  }
}
