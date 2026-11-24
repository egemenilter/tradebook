import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// The missed-setup feature: `type: missed` notes are written, read back and
// kept out of every analytics population — the one guarantee the trader asked
// for ("total pnl'i etkilememeli").

const result = await build({
  entryPoints: Object.fromEntries(['storage', 'scope'].map((name) => [name,
    new URL(name === 'scope' ? '../src/lib/scope.ts' : '../src/storage.ts', import.meta.url).pathname])),
  bundle: true, format: 'esm', platform: 'browser', outdir: 'bundle', write: false,
  plugins: [{ name: 'host', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'host' }));
    builder.onLoad({ filter: /.*/, namespace: 'host' }, () => ({ contents: 'export class App{};export class TFile{};export class TFolder{};export const normalizePath=x=>x;export const setIcon=()=>{};export const moment=()=>{};export const Notice=()=>{};' }));
  } }],
});
const load = (name) => import('data:text/javascript;base64,' + Buffer.from(result.outputFiles.find((file) => file.path.endsWith('/' + name + '.js')).text).toString('base64'));
const [storage, scope] = await Promise.all(['storage', 'scope'].map(load));

const base = { id: 'synthetic.md', date: '2026-11-24', entryTime: '10:00:00', exitTime: '10:30:00', symbol: 'XAUUSD', account: 'Synthetic', accountType: 'funded', direction: 'long', quantity: 0.1, entryPrice: 4545, exitPrice: 4612, pnl: 670, pnlPoints: 67, commission: 0, fees: 0, setup: 'Breakout', mistake: '', review: '', thesis: '', screenshot: '', rating: 0, origin: 'manual', dataSource: 'manual' };

test('a normal trade still writes type: trade and reads back as a trade', () => {
  const markdown = storage.tradeToMarkdown({ ...base });
  assert.match(markdown, /^type: trade$/m);
  assert.equal(storage.parseTradeFromMarkdown(markdown).type, 'trade');
});

test('a missed setup writes type: missed and reads back as missed', () => {
  const markdown = storage.tradeToMarkdown({ ...base, type: 'missed' });
  assert.match(markdown, /^type: missed$/m);
  assert.equal(storage.parseTradeFromMarkdown(markdown).type, 'missed');
});

test('a missed trade counts in no analytics population', () => {
  const real = { ...base, pnl: 100 };
  const missed = { ...base, type: 'missed', pnl: 670, setup: 'Breakout' };
  const { money, unique, counts } = scope.analyticsTrades([real, missed]);
  assert.equal(money.length, 1, 'money: only the real trade');
  assert.equal(money[0].pnl, 100);
  assert.equal(unique.length, 1, 'unique: only the real trade');
  assert.equal(counts.length, 1, 'counts: only the real trade');
});

test('missed-only input yields an empty population, not an error', () => {
  const missed = { ...base, type: 'missed' };
  const { money, unique, counts } = scope.analyticsTrades([missed]);
  assert.deepEqual([money.length, unique.length, counts.length], [0, 0, 0]);
});
