import { AccountType, FuturesSpec } from "./types";

export interface AccountRule {
  type: AccountType;
  keywords: string[];
}

/**
 * The contracts we can price.
 *
 * Point value, tick size and tick value are the exchange's and never change;
 * the money per trade in this journal is derived from them (R multiples, risk
 * per trade, P&L from prices). Every root also carries its usual counterpart
 * (mini ↔ micro) so a copy trade can cross the two.
 *
 * Nothing here prices a trade: what a fill actually cost comes from the
 * platform's own cash history, line by line (see parseCashHistoryCsv).
 */
/**
 * CFD instruments, priced per RoboForex contract specifications
 * (roboforex.com/forex-trading/trading/specifications). Same shape as a
 * futures contract: `pointValue` is the money a 1.0 price-unit move makes on
 * ONE LOT, so the journal's pricing math (risk from prices, R multiples)
 * works unchanged — the trader just types lots as quantity.
 *
 * Quoted only in USD pairs: a JPY-quoted pair (USDJPY…) prices its P&L in
 * yen, which the journal would show as dollars, so it is left out rather
 * than silently wrong.
 *
 * RoboForex names its index CFDs `.US30Cash` and friends on the platform;
 * the friendly roots are typed here and resolve by prefix (see rootSymbol).
 */
const CFD_SPECS: Record<string, FuturesSpec> = {
  // ---- forex, USD-quoted majors (1 lot = 100 000, pip 0.0001 = $10) ----
  EURUSD: { name: "Euro / US Dollar", exchange: "RoboForex", group: "fx", pointValue: 100000, tickSize: 0.0001, tickValue: 10 },
  GBPUSD: { name: "British Pound / US Dollar", exchange: "RoboForex", group: "fx", pointValue: 100000, tickSize: 0.0001, tickValue: 10 },
  AUDUSD: { name: "Australian Dollar / US Dollar", exchange: "RoboForex", group: "fx", pointValue: 100000, tickSize: 0.0001, tickValue: 10 },
  NZDUSD: { name: "New Zealand Dollar / US Dollar", exchange: "RoboForex", group: "fx", pointValue: 100000, tickSize: 0.0001, tickValue: 10 },

  // ---- metals (1 Pip Size 0.01; XAUUSD 1 lot = 100 oz, XAGUSD 5000 oz) ----
  XAUUSD: { name: "Gold (spot CFD)", exchange: "RoboForex", group: "metal", pointValue: 100, tickSize: 0.01, tickValue: 1 },
  XAGUSD: { name: "Silver (spot CFD)", exchange: "RoboForex", group: "metal", pointValue: 5000, tickSize: 0.01, tickValue: 50 },

  // ---- index CFDs (1 lot = 1 contract, pip size 1, tick 0.1 = $0.10) ----
  US30: { name: "US 30 / Dow (index CFD)", exchange: "RoboForex", group: "equity", pointValue: 1, tickSize: 0.1, tickValue: 0.1 },
  US500: { name: "US 500 / S&P (index CFD)", exchange: "RoboForex", group: "equity", pointValue: 1, tickSize: 0.1, tickValue: 0.1 },
  USTEC: { name: "US Tech / Nasdaq 100 (index CFD)", exchange: "RoboForex", group: "equity", pointValue: 1, tickSize: 0.1, tickValue: 0.1 },
  DE40: { name: "DE 40 / DAX (index CFD)", exchange: "RoboForex", group: "equity", pointValue: 1, tickSize: 0.1, tickValue: 0.1 },
  JP225: { name: "JP 225 / Nikkei (index CFD)", exchange: "RoboForex", group: "equity", pointValue: 1, tickSize: 0.1, tickValue: 0.1 },
  // Platform aliases: the same markets under the names the platform itself
  // lists (US500Cash on the spec sheet, GER40 on the market watch). Keys are
  // uppercase because symbols are read uppercased (see rootSymbol) — the
  // trader may type `US30Cash` or `US30CASH`, both land here.
  GER40: { name: "DE 40 / DAX (alias of DE40)", exchange: "RoboForex", group: "equity", pointValue: 1, tickSize: 0.1, tickValue: 0.1 },
  NAS100: { name: "US Tech / Nasdaq 100 (alias of USTEC)", exchange: "RoboForex", group: "equity", pointValue: 1, tickSize: 0.1, tickValue: 0.1 },
  US30CASH: { name: "US 30 / Dow (alias of US30)", exchange: "RoboForex", group: "equity", pointValue: 1, tickSize: 0.1, tickValue: 0.1 },
  US500CASH: { name: "US 500 / S&P (alias of US500)", exchange: "RoboForex", group: "equity", pointValue: 1, tickSize: 0.1, tickValue: 0.1 },
  USTECHCASH: { name: "US Tech / Nasdaq 100 (alias of USTEC)", exchange: "RoboForex", group: "equity", pointValue: 1, tickSize: 0.1, tickValue: 0.1 },
  DE40CASH: { name: "DE 40 / DAX (alias of DE40)", exchange: "RoboForex", group: "equity", pointValue: 1, tickSize: 0.1, tickValue: 0.1 },
  JP225CASH: { name: "JP 225 / Nikkei (alias of JP225)", exchange: "RoboForex", group: "equity", pointValue: 1, tickSize: 0.1, tickValue: 0.1 },

  // ---- energies (1 lot = 1000 barrels, tick 0.01 = $10) ----
  BRENT: { name: "Brent Crude (spot CFD)", exchange: "RoboForex", group: "energy", pointValue: 1000, tickSize: 0.01, tickValue: 10 },
  WTI: { name: "WTI Crude (spot CFD)", exchange: "RoboForex", group: "energy", pointValue: 1000, tickSize: 0.01, tickValue: 10 },

  // ---- crypto (BTCUSD 1 lot = 1 coin, ETHUSD 1 lot = 10 coins) ----
  BTCUSD: { name: "Bitcoin (spot CFD)", exchange: "RoboForex", group: "crypto", pointValue: 1, tickSize: 0.01, tickValue: 0.01 },
  ETHUSD: { name: "Ethereum (spot CFD)", exchange: "RoboForex", group: "crypto", pointValue: 10, tickSize: 0.01, tickValue: 0.1 },
};

const FUTURES_SPECS: Record<string, FuturesSpec> = {
  // ---- CME equity index ----
  NQ: { name: "E-mini Nasdaq 100", exchange: "CME", group: "equity", kind: "mini", micro: "MNQ", pointValue: 20, tickSize: 0.25, tickValue: 5 },
  MNQ: { name: "Micro E-mini Nasdaq 100", exchange: "CME", group: "equity", kind: "micro", mini: "NQ", pointValue: 2, tickSize: 0.25, tickValue: 0.5 },
  ES: { name: "E-mini S&P 500", exchange: "CME", group: "equity", kind: "mini", micro: "MES", pointValue: 50, tickSize: 0.25, tickValue: 12.5 },
  MES: { name: "Micro E-mini S&P 500", exchange: "CME", group: "equity", kind: "micro", mini: "ES", pointValue: 5, tickSize: 0.25, tickValue: 1.25 },
  RTY: { name: "E-mini Russell 2000", exchange: "CME", group: "equity", kind: "mini", micro: "M2K", pointValue: 50, tickSize: 0.1, tickValue: 5 },
  M2K: { name: "Micro E-mini Russell 2000", exchange: "CME", group: "equity", kind: "micro", mini: "RTY", pointValue: 5, tickSize: 0.1, tickValue: 0.5 },
  YM: { name: "Mini-Dow", exchange: "CBOT", group: "equity", kind: "mini", micro: "MYM", pointValue: 5, tickSize: 1, tickValue: 5 },
  MYM: { name: "Micro Mini-Dow", exchange: "CBOT", group: "equity", kind: "micro", mini: "YM", pointValue: 0.5, tickSize: 1, tickValue: 0.5 },
  NKD: { name: "Nikkei 225 (USD)", exchange: "CME", group: "equity", kind: "other", pointValue: 5, tickSize: 5, tickValue: 25 },

  // ---- energy ----
  CL: { name: "Crude Oil", exchange: "NYMEX", group: "energy", kind: "mini", micro: "MCL", pointValue: 1000, tickSize: 0.01, tickValue: 10 },
  MCL: { name: "Micro Crude Oil", exchange: "NYMEX", group: "energy", kind: "micro", mini: "CL", pointValue: 100, tickSize: 0.01, tickValue: 1 },
  QM: { name: "E-mini Crude Oil", exchange: "NYMEX", group: "energy", kind: "other", pointValue: 500, tickSize: 0.025, tickValue: 12.5 },
  NG: { name: "Natural Gas", exchange: "NYMEX", group: "energy", kind: "mini", micro: "MNG", pointValue: 10000, tickSize: 0.001, tickValue: 10 },
  MNG: { name: "Micro Henry Hub Natural Gas", exchange: "NYMEX", group: "energy", kind: "micro", mini: "NG", pointValue: 2500, tickSize: 0.001, tickValue: 2.5 },
  QG: { name: "E-mini Natural Gas", exchange: "NYMEX", group: "energy", kind: "other", pointValue: 2500, tickSize: 0.005, tickValue: 12.5 },
  RB: { name: "RBOB Gasoline", exchange: "NYMEX", group: "energy", kind: "other", pointValue: 42000, tickSize: 0.0001, tickValue: 4.2 },
  HO: { name: "Heating Oil", exchange: "NYMEX", group: "energy", kind: "other", pointValue: 42000, tickSize: 0.0001, tickValue: 4.2 },

  // ---- metals ----
  GC: { name: "Gold", exchange: "COMEX", group: "metal", kind: "mini", micro: "MGC", pointValue: 100, tickSize: 0.1, tickValue: 10 },
  MGC: { name: "Micro Gold", exchange: "COMEX", group: "metal", kind: "micro", mini: "GC", pointValue: 10, tickSize: 0.1, tickValue: 1 },
  SI: { name: "Silver", exchange: "COMEX", group: "metal", kind: "mini", micro: "SIL", pointValue: 5000, tickSize: 0.005, tickValue: 25 },
  SIL: { name: "Micro Silver", exchange: "COMEX", group: "metal", kind: "micro", mini: "SI", pointValue: 1000, tickSize: 0.005, tickValue: 5 },
  HG: { name: "Copper", exchange: "COMEX", group: "metal", kind: "mini", micro: "MHG", pointValue: 25000, tickSize: 0.0005, tickValue: 12.5 },
  MHG: { name: "Micro Copper", exchange: "COMEX", group: "metal", kind: "micro", mini: "HG", pointValue: 2500, tickSize: 0.0005, tickValue: 1.25 },
  PL: { name: "Platinum", exchange: "NYMEX", group: "metal", kind: "other", pointValue: 50, tickSize: 0.1, tickValue: 5 },

  // ---- interest rates ----
  ZT: { name: "2-Year Note", exchange: "CBOT", group: "rate", kind: "other", pointValue: 2000, tickSize: 0.0078125, tickValue: 15.625 },
  ZF: { name: "5-Year Note", exchange: "CBOT", group: "rate", kind: "other", pointValue: 1000, tickSize: 0.0078125, tickValue: 7.8125 },
  ZN: { name: "10-Year Note", exchange: "CBOT", group: "rate", kind: "other", pointValue: 1000, tickSize: 0.015625, tickValue: 15.625 },
  TN: { name: "Ultra 10-Year Note", exchange: "CBOT", group: "rate", kind: "other", pointValue: 1000, tickSize: 0.015625, tickValue: 15.625 },
  ZB: { name: "30-Year Bond", exchange: "CBOT", group: "rate", kind: "other", pointValue: 1000, tickSize: 0.03125, tickValue: 31.25 },
  UB: { name: "Ultra Bond", exchange: "CBOT", group: "rate", kind: "other", pointValue: 1000, tickSize: 0.03125, tickValue: 31.25 },

  // ---- currencies ----
  "6E": { name: "Euro FX", exchange: "CME", group: "fx", kind: "mini", micro: "M6E", pointValue: 125000, tickSize: 0.00005, tickValue: 6.25 },
  M6E: { name: "Micro EUR/USD", exchange: "CME", group: "fx", kind: "micro", mini: "6E", pointValue: 12500, tickSize: 0.0001, tickValue: 1.25 },
  "6B": { name: "British Pound", exchange: "CME", group: "fx", kind: "mini", micro: "M6B", pointValue: 62500, tickSize: 0.0001, tickValue: 6.25 },
  M6B: { name: "Micro GBP/USD", exchange: "CME", group: "fx", kind: "micro", mini: "6B", pointValue: 6250, tickSize: 0.0001, tickValue: 0.625 },
  "6J": { name: "Japanese Yen", exchange: "CME", group: "fx", kind: "other", pointValue: 12500000, tickSize: 0.0000005, tickValue: 6.25 },
  "6A": { name: "Australian Dollar", exchange: "CME", group: "fx", kind: "mini", micro: "M6A", pointValue: 100000, tickSize: 0.00005, tickValue: 5 },
  M6A: { name: "Micro AUD/USD", exchange: "CME", group: "fx", kind: "micro", mini: "6A", pointValue: 10000, tickSize: 0.0001, tickValue: 1 },
  "6C": { name: "Canadian Dollar", exchange: "CME", group: "fx", kind: "other", pointValue: 100000, tickSize: 0.00005, tickValue: 5 },
  "6S": { name: "Swiss Franc", exchange: "CME", group: "fx", kind: "other", pointValue: 125000, tickSize: 0.0001, tickValue: 12.5 },
  "6M": { name: "Mexican Peso", exchange: "CME", group: "fx", kind: "other", pointValue: 500000, tickSize: 0.00001, tickValue: 5 },
  "6N": { name: "New Zealand Dollar", exchange: "CME", group: "fx", kind: "other", pointValue: 100000, tickSize: 0.00005, tickValue: 5 },
  E7: { name: "E-mini Euro FX", exchange: "CME", group: "fx", kind: "other", pointValue: 62500, tickSize: 0.0001, tickValue: 6.25 },

  // ---- agriculture ----
  HE: { name: "Lean Hogs", exchange: "CME", group: "ag", kind: "other", pointValue: 400, tickSize: 0.025, tickValue: 10 },
  LE: { name: "Live Cattle", exchange: "CME", group: "ag", kind: "other", pointValue: 400, tickSize: 0.025, tickValue: 10 },
  ZC: { name: "Corn", exchange: "CBOT", group: "ag", kind: "other", pointValue: 50, tickSize: 0.25, tickValue: 12.5 },
  ZW: { name: "Wheat", exchange: "CBOT", group: "ag", kind: "other", pointValue: 50, tickSize: 0.25, tickValue: 12.5 },
  ZS: { name: "Soybean", exchange: "CBOT", group: "ag", kind: "other", pointValue: 50, tickSize: 0.25, tickValue: 12.5 },
  ZM: { name: "Soybean Meal", exchange: "CBOT", group: "ag", kind: "other", pointValue: 100, tickSize: 0.1, tickValue: 10 },
  ZL: { name: "Soybean Oil", exchange: "CBOT", group: "ag", kind: "other", pointValue: 600, tickSize: 0.01, tickValue: 6 },

  // ---- crypto (micros only — that is what the exchanges list) ----
  MBT: { name: "Micro Bitcoin", exchange: "CME", group: "crypto", kind: "micro", pointValue: 0.1, tickSize: 5, tickValue: 0.5 },
  MET: { name: "Micro Ether", exchange: "CME", group: "crypto", kind: "micro", pointValue: 0.1, tickSize: 0.5, tickValue: 0.05 },

  ...CFD_SPECS,
};

const UNKNOWN_SPEC: FuturesSpec = { pointValue: 1, tickSize: 0, tickValue: 0 };

// ================================================================
// THE CORE — what the journal opens on
// ================================================================

/** An instrument the journal prices out of the box: the market people actually
 *  trade, in two sizes. NQ and MNQ are the same market — the picker shows them
 *  as one line with two sizes, while the breakdown keeps them apart, because a
 *  $20/point contract and a $2/point one are not the same trade. */
export interface CoreInstrument {
  id: string;
  label: string;
  /** The standard contract. */
  mini: string;
  /** The micro contract: same market, a fraction of the size — a tenth for
   *  most instruments, a fifth for silver. CFD instruments have no size pair:
   *  one lot is the whole market, so `micro` is left off and the picker shows
   *  a single line. */
  micro?: string;
}

/** Six futures instruments, twelve contracts — then the CFD side of the
 *  journal, RoboForex instruments (forex, metals, indices, energies, crypto),
 *  one size each. Ordered by how often they are traded, so the picker opens
 *  on what a trader reaches for. The rest of the registry (rates, ag, FX
 *  futures) is still priced — a typed or imported contract resolves here —
 *  but it is not what the journal suggests. */
export const CORE_INSTRUMENTS: CoreInstrument[] = [
  { id: "nasdaq", label: "Nasdaq 100", mini: "NQ", micro: "MNQ" },
  { id: "spx", label: "S&P 500", mini: "ES", micro: "MES" },
  { id: "gold", label: "Gold", mini: "GC", micro: "MGC" },
  { id: "crude", label: "Crude Oil", mini: "CL", micro: "MCL" },
  { id: "silver", label: "Silver", mini: "SI", micro: "SIL" },
  { id: "russell", label: "Russell 2000", mini: "RTY", micro: "M2K" },

  // ---- CFDs, RoboForex ----
  { id: "xauusd", label: "Gold CFD (XAUUSD)", mini: "XAUUSD" },
  { id: "xagusd", label: "Silver CFD (XAGUSD)", mini: "XAGUSD" },
  { id: "eurusd", label: "EUR/USD", mini: "EURUSD" },
  { id: "gbpusd", label: "GBP/USD", mini: "GBPUSD" },
  { id: "audusd", label: "AUD/USD", mini: "AUDUSD" },
  { id: "nzdusd", label: "NZD/USD", mini: "NZDUSD" },
  { id: "us30", label: "US 30 / Dow CFD", mini: "US30" },
  { id: "us500", label: "US 500 / S&P CFD", mini: "US500" },
  { id: "ustec", label: "US Tech / Nasdaq CFD", mini: "USTEC" },
  { id: "de40", label: "DE 40 / DAX CFD", mini: "DE40" },
  { id: "jp225", label: "JP 225 / Nikkei CFD", mini: "JP225" },
  { id: "brent", label: "Brent Crude CFD", mini: "BRENT" },
  { id: "wti", label: "WTI Crude CFD", mini: "WTI" },
  { id: "btcusd", label: "Bitcoin CFD", mini: "BTCUSD" },
  { id: "ethusd", label: "Ethereum CFD", mini: "ETHUSD" },
];

/** Every contract a picker suggests: both sizes of a futures instrument,
 *  the one size of a CFD. */
export const CORE_SYMBOLS: string[] = CORE_INSTRUMENTS.flatMap((i) => (i.micro ? [i.mini, i.micro] : [i.mini]));

/**
 * FX pairs whose quote currency is not the dollar — the crosses (EURGBP,
 * AUDJPY…) and the USD-based pairs the market quotes in another currency
 * (USDJPY, USDTRY…). One pip of EURGBP is ten euros a lot, and its dollar
 * value floats with the rate; a fixed dollar figure would be silently wrong,
 * and the exact number exists only on the platform that carried the trade.
 *
 * So these pairs are KNOWN (they autocomplete, the journal names them) but
 * UNPRICED: the trader records the P&L the platform reported, and the journal
 * keeps its priced money and its recorded money apart. `USDCAD` and `USDCHF`
 * move here from the priced registry for the same reason — their quote is
 * CAD / CHF, not dollars.
 */
export interface UnpricedPair {
  name: string;
}

const FX_UNPRICED_RECORD: Record<string, UnpricedPair> = {
  XAUEUR: { name: "Gold / Euro" },
  EURAUD: { name: "Euro / Australian Dollar" },
  EURCAD: { name: "Euro / Canadian Dollar" },
  EURCHF: { name: "Euro / Swiss Franc" },
  EURGBP: { name: "Euro / British Pound" },
  EURJPY: { name: "Euro / Japanese Yen" },
  EURNZD: { name: "Euro / New Zealand Dollar" },
  GBPAUD: { name: "British Pound / Australian Dollar" },
  GBPCAD: { name: "British Pound / Canadian Dollar" },
  GBPCHF: { name: "British Pound / Swiss Franc" },
  GBPJPY: { name: "British Pound / Japanese Yen" },
  GBPNZD: { name: "British Pound / New Zealand Dollar" },
  AUDCAD: { name: "Australian Dollar / Canadian Dollar" },
  AUDCHF: { name: "Australian Dollar / Swiss Franc" },
  AUDJPY: { name: "Australian Dollar / Japanese Yen" },
  AUDNZD: { name: "Australian Dollar / New Zealand Dollar" },
  CADCHF: { name: "Canadian Dollar / Swiss Franc" },
  CADJPY: { name: "Canadian Dollar / Japanese Yen" },
  NZDCAD: { name: "New Zealand Dollar / Canadian Dollar" },
  NZDCHF: { name: "New Zealand Dollar / Swiss Franc" },
  NZDJPY: { name: "New Zealand Dollar / Japanese Yen" },
  USDJPY: { name: "US Dollar / Japanese Yen" },
  USDCAD: { name: "US Dollar / Canadian Dollar" },
  USDCHF: { name: "US Dollar / Swiss Franc" },
  USDMXN: { name: "US Dollar / Mexican Peso" },
  USDNOK: { name: "US Dollar / Norwegian Krone" },
  USDSEK: { name: "US Dollar / Swedish Krona" },
  USDTRY: { name: "US Dollar / Turkish Lira" },
  USDZAR: { name: "US Dollar / South African Rand" },
};

/** The unpriced pair a symbol names, or null. A `.P`-style platform suffix is
 *  tolerated, the way a priced root tolerates one. */
export function unpricedPair(symbol: string): UnpricedPair | null {
  const normalized = (symbol || "").trim().toUpperCase().replace(/\.[A-Z]+$/, "");
  return FX_UNPRICED_RECORD[normalized] ?? null;
}

export const FX_UNPRICED: string[] = Object.keys(FX_UNPRICED_RECORD).sort();

/** Every symbol the picker suggests: the priced contracts and the known FX
 *  pairs whose P&L is recorded by hand. */
export const ALL_KNOWN_SYMBOLS: string[] = [...CORE_SYMBOLS, ...FX_UNPRICED];

/** "NQ (mini)" / "MNQ (micro)" — the size, since that is what moves the money. */
export function contractLabel(symbol: string): string {
  const root = rootSymbol(symbol);
  const kind = FUTURES_SPECS[root]?.kind;
  return kind === "mini" || kind === "micro" ? `${root} (${kind})` : root;
}

/** The core instrument a contract belongs to, when it is one of them. */
export function coreInstrumentOf(symbol: string): CoreInstrument | undefined {
  const root = rootSymbol(symbol);
  return CORE_INSTRUMENTS.find((i) => i.mini === root || i.micro === root);
}

/**
 * The configured default symbol — but only when the journal supports it.
 *
 * Settings offers the twelve core contracts, so a saved value naming anything
 * else is an old or hand-edited setting, not a choice. It is ignored, and the
 * answer is `""`: the field starts empty and the trader picks. A contract whose
 * root is core counts, dated or not — `NQU6` is an NQ.
 */
export function supportedDefaultSymbol(raw: string | undefined | null): string {
  const symbol = (raw || "").trim().toUpperCase();
  return coreInstrumentOf(symbol) ? symbol : "";
}

/** The contracts, by market — for a grouped picker or a symbol breakdown. */
export const FUTURES_GROUPS: Record<string, string[]> = Object.keys(FUTURES_SPECS).reduce(
  (acc, sym) => {
    const g = FUTURES_SPECS[sym].group ?? "other";
    (acc[g] ||= []).push(sym);
    return acc;
  },
  {} as Record<string, string[]>
);

// Longest root first: NKD has to win over N, MGC over M… whatever the symbol.
const ROOTS: string[] = Object.keys(FUTURES_SPECS).sort((a, b) => b.length - a.length);

export function rootSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  for (const root of ROOTS) {
    if (s.startsWith(root)) return root;
  }
  let letters = "";
  for (const ch of s) {
    if (ch >= "A" && ch <= "Z") letters += ch;
    else break;
  }
  return letters;
}

export function futuresSpec(symbol: string): FuturesSpec {
  return FUTURES_SPECS[rootSymbol(symbol)] ?? UNKNOWN_SPEC;
}

/** A recognised monetary specification, or null instead of the $1 fallback.
 *  A platform suffix is tolerated on a priced root — Pro accounts name their
 *  pairs `XAUUSD.p`, so `XAUUSD.P` prices as XAUUSD. */
export function knownFuturesSpec(symbol: string): FuturesSpec | null {
  const normalized = (symbol || "").trim().toUpperCase();
  const root = rootSymbol(normalized);
  const spec = FUTURES_SPECS[root];
  if (!spec) return null;
  const suffix = normalized.slice(root.length);
  return suffix === "" || /^[FGHJKMNQUVXZ]\d{1,2}$/.test(suffix) || /^\.[A-Z]+$/.test(suffix) ? spec : null;
}

/** The micro version of a mini, when one exists (NQ → MNQ). */
export function microOf(symbol: string): string | undefined {
  return futuresSpec(symbol).micro;
}

/** And back (MNQ → NQ). */
export function miniOf(symbol: string): string | undefined {
  return futuresSpec(symbol).mini;
}

export const DEFAULT_ACCOUNT_RULES: AccountRule[] = [
  { type: "funded", keywords: ["FUNDED", "FUND", "REAL", "PAID", "PASSED", "CERTIFIED", "LIVE"] },
  { type: "eval", keywords: ["EVAL", "EVALUATION", "COMBINE", "FUNDING", "CHALLENGE", "PROP", "TOPSTEP", "TOPSSTEP", "TOSTEP", "TDF", "AXIO", "KWR", "T4C", "APEX", "TAKEPRO"] },
  { type: "demo", keywords: ["DEMO", "SIM", "SIMU", "SIMULATED", "PAPER", "TRAINING", "PRACTICE"] },
];

export function classifyAccount(account: string, rules?: AccountRule[]): AccountType {
  const name = account.toUpperCase().trim();
  if (!name) return "unknown";
  if (!rules || rules.length === 0) rules = DEFAULT_ACCOUNT_RULES;
  for (const rule of rules) {
    for (const kw of rule.keywords) {
      if (name.includes(kw.toUpperCase())) return rule.type;
    }
  }
  return /^\d+$/.test(name) ? "demo" : "unknown";
}
