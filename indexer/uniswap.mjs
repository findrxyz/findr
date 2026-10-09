#!/usr/bin/env node
// Uniswap pool indexer for findr.
//
// For each chain below it finds the Uniswap v2, v3 and v4 pools that traded in the last 24 hours by reading swap
// events straight from the chain, looks up each pool's TVL, volume, market cap and links on DexScreener, reads
// the fee liquidity providers actually keep, and writes data/<chain>.json for the page.
// APR = 24h volume × LP fee ÷ TVL, the same way Uniswap computes it.
//
//   node indexer/uniswap.mjs                     keep running, refresh every 3 minutes
//   node indexer/uniswap.mjs --once              one pass, then exit
//   node indexer/uniswap.mjs --chain base        only the named chain(s); repeat the flag for more
//
// Uses free public RPCs (no keys, rate-limited). With ALCHEMY_API_KEY set in the repo's .env (git-ignored), Alchemy
// becomes each chain's last-resort endpoint, so its free tier is only spent when the public RPCs fail. RPC_ETHEREUM,
// RPC_BASE or RPC_ROBINHOOD put your own endpoint first.

import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(HERE, '..', '.env');

// Minimal .env reader (Node 18 has no --env-file). Values already in the environment win.
function loadEnv() {
  let text = '';
  try { text = readFileSync(ENV_FILE, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();
const DS_PAIRS = 'https://api.dexscreener.com/latest/dex/pairs/';
const UA = 'findr-indexer/1.0';

// Contract addresses are from Uniswap's deployment docs, except Robinhood's v2 factory, which was read from the
// factory() of a known Uniswap v2 pool there.
const CHAINS = {
  ethereum: {
    name: 'Ethereum',
    ds: 'ethereum',
    alchemy: 'eth-mainnet',
    // PublicNode is left out: it refuses log queries that don't name a contract, which the v2/v3 scan needs.
    rpcs: [process.env.RPC_ETHEREUM, 'https://eth.drpc.org', 'https://rpc.mevblocker.io', 'https://eth-pokt.nodies.app'],
    lag: 2,
    v4Backfill: 24,
    poolManager: '0x000000000004444c5dc75cb358380d2e3de08a90',
    stateView: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
    v3Factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984',
    v2Factory: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f',
  },
  base: {
    name: 'Base',
    ds: 'base',
    alchemy: 'base-mainnet',
    rpcs: [process.env.RPC_BASE, 'https://mainnet.base.org', 'https://base-pokt.nodies.app'],
    lag: 5,
    v4Backfill: 24,
    poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b',
    stateView: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
    v3Factory: '0x33128a8fc17869897dce68ed026d694621f6fdfd',
    v2Factory: '0x8909dc15e40173ff4699343b6eb8132c65e18ec6',
  },
  robinhood: {
    name: 'Robinhood Chain',
    ds: 'robinhood',
    alchemy: 'robinhood-mainnet',
    rpcs: [process.env.RPC_ROBINHOOD, 'https://rpc.mainnet.chain.robinhood.com'],
    lag: 30,
    v4Backfill: 1, // ~1.3M v4 swaps a day and one rate-limited RPC: a longer first look-back gets throttled
    poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
    v3Factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
    v2Factory: '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f',
  },
};

const TOPIC = {
  v4Swap: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
  v3Swap: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  v2Swap: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
};
const SEL = { factory: '0xc45a0155', fee: '0xddca3f43', slot0: '0x3850c7bd', feeTo: '0x017e7e58', getSlot0: '0xc815641c' };

const ACTIVE_WINDOW = 24 * 60 * 60e3; // pools that haven't traded for this long drop out
const BOOTSTRAP = 60 * 60e3;          // a fresh start looks back this far for v2/v3 swaps (a chain-wide, heavy query)
const MAX_CATCH_UP = 3 * 60 * 60e3;   // after downtime, scan at most this much history
const CHUNK_TIME = 4 * 60e3;          // chain time covered by one eth_getLogs call
const INTERVAL = 3 * 60e3;
const MIN_TVL = 5000;
const DS_FRESH = 5 * 60e3;            // stats age before a refresh, for pools worth showing
const DS_FRESH_SMALL = 30 * 60e3;     // …and for pools too small or unknown to show
const DS_MAX_CALLS = 150;             // per chain per cycle; DexScreener allows 300 a minute
const LP_FEE_TTL = 30 * 60e3;         // how long a v4 pool's LP fee is trusted before it's read again
const STATE_VERSION = 2;              // bump when the saved shape changes, so old state is rebuilt instead of misread

// Robinhood's public RPC allows about 30 requests a minute from one address, then answers HTTP 403 (a Cloudflare
// challenge) for a minute or more. Requests to a host listed here are spaced at least this far apart.
const PACE = { 'rpc.mainnet.chain.robinhood.com': 2500 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexNum = (h) => parseInt(h, 16);
const words = (data) => data.slice(2).match(/.{64}/g) || [];
const hex = (n) => '0x' + n.toString(16);

// ---------- RPC ----------

// Errors worth retrying, possibly on another endpoint. Used for individual calls inside a batch.
const TRANSIENT = /rate limit|over rate|too many requests|can't route|cannot route|timed? ?out|unavailable|busy|capacity|beyond current head|header not found|internal error|try again|specify an address|unknown state/i;
// eth_getLogs refusals that mean "ask for a smaller block range".
const TOO_BIG = /more than \d+ results|too many results|block range|range (is )?too (large|big)|exceeds? (the )?(max|limit)|limit of \d+|response (size|too large)|query returned more than/i;
// Errors about the request itself, which another endpoint would refuse too. Anything else (a pruned node, a
// provider-specific refusal, an outage) is tried on the next endpoint.
const BAD_REQUEST = /revert|invalid (argument|params|opcode|address)|method not found|unsupported method/i;

// One client per chain. Temporary failures rotate to the next endpoint in the list.
function rpcClient(urls) {
  urls = urls.filter(Boolean);
  let current = 0;
  let batchMax = 40; // shrinks when an endpoint says it accepts fewer calls per batch
  const url = () => urls[current % urls.length];
  const rotate = () => { current++; };
  const nextSlot = {}; // per paced host: when its next request may go out

  async function send(body) {
    const target = url();
    const host = new URL(target).host;
    if (PACE[host]) {
      const at = Math.max(Date.now(), nextSlot[host] || 0);
      nextSlot[host] = at + PACE[host];
      await sleep(at - Date.now());
    }
    const r = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify(body),
    });
    if (r.status === 401 || r.status === 403 || r.status === 429 || r.status >= 500) throw new Error(`${host} answered HTTP ${r.status}`);
    return r.json();
  }

  async function call(method, params) {
    let lastError;
    for (let attempt = 0; attempt < Math.max(6, urls.length * 3); attempt++) {
      try {
        const j = await send({ jsonrpc: '2.0', id: 1, method, params });
        if (!j.error) return j.result;
        const msg = j.error.message || '';
        lastError = new Error(`${method}: ${msg}`);
        if (TOO_BIG.test(msg) || BAD_REQUEST.test(msg)) throw Object.assign(lastError, { final: true });
      } catch (e) {
        if (e.final) throw e;
        lastError = e;
      }
      rotate();
      // A 429 means slow down, and a 403 is usually the same thing said by a firewall, so back off exponentially
      // (about a minute and a half in all, enough to outlast a block); other failures retry sooner.
      await sleep(/HTTP 4(03|29)|rate limit|too many requests/i.test(lastError.message) ? 2000 * 2 ** Math.min(attempt, 4) : 500 * (attempt + 1));
    }
    throw lastError;
  }

  // Returns one entry per call: its result, null when the call itself failed (e.g. reverted), or undefined when
  // no endpoint answered. Callers treat undefined as "unknown, try again later" and never cache it.
  async function batch(calls) {
    const out = new Array(calls.length).fill(undefined);
    let pending = calls.map((_, i) => i);
    for (let round = 0; round < 6 && pending.length; round++) {
      const retry = [];
      for (let s = 0; s < pending.length; s += batchMax) {
        const idx = pending.slice(s, s + batchMax);
        let j;
        try {
          j = await send(idx.map((i) => ({ jsonrpc: '2.0', id: i, method: calls[i].method, params: calls[i].params })));
        } catch {
          // Some endpoints reject batches outright or above a size they don't state; try smaller, elsewhere.
          batchMax = Math.max(5, Math.floor(batchMax / 2));
          retry.push(...idx);
          rotate();
          continue;
        }
        if (!Array.isArray(j)) {
          const max = /maximum (\d+) calls/i.exec(j?.error?.message || '');
          batchMax = max ? Math.max(1, +max[1]) : Math.max(5, Math.floor(batchMax / 2));
          retry.push(...idx);
          rotate();
          continue;
        }
        const byId = new Map(j.map((x) => [x.id, x]));
        for (const i of idx) {
          const x = byId.get(i);
          if (x && !x.error) out[i] = x.result;
          else if (x?.error && !TRANSIENT.test(x.error.message || '')) out[i] = null;
          else retry.push(i);
        }
      }
      pending = retry;
      if (pending.length) { rotate(); await sleep(1000 * (round + 1)); }
    }
    return out;
  }

  // Splits the range when the node refuses a query for returning too much.
  async function getLogs(filter, from, to) {
    try {
      return await call('eth_getLogs', [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }]);
    } catch (e) {
      if (to <= from || !TOO_BIG.test(e.message)) throw e;
      const mid = Math.floor((from + to) / 2);
      return [...(await getLogs(filter, from, mid)), ...(await getLogs(filter, mid + 1, to))];
    }
  }
  // Each cycle starts back on the first endpoint, so a fallback (and Alchemy's free tier) is only used while needed.
  const reset = () => { current = 0; };
  return { call, batch, getLogs, urls, reset };
}

// Adds Alchemy as the chain's last-resort endpoint once a key is in the environment or .env (checked every cycle,
// so adding the key doesn't need a restart). Only the host is ever logged, never the URL with the key.
function ensureAlchemy(c) {
  loadEnv();
  const key = process.env.ALCHEMY_API_KEY;
  if (!key || !c.alchemy || c.rpc.urls.some((u) => u.includes('.g.alchemy.com'))) return;
  c.rpc.urls.push(`https://${c.alchemy}.g.alchemy.com/v2/${key}`);
  console.log(`[${new Date().toLocaleTimeString('en-US')}] ${c.name}: Alchemy added as the backup endpoint`);
}

// Estimates a block's time from the head and an older block, which is plenty for "traded in the last 24h".
async function chainClock(rpc, head) {
  const back = 5000;
  const [a, b] = await Promise.all([
    rpc.call('eth_getBlockByNumber', [hex(head), false]),
    rpc.call('eth_getBlockByNumber', [hex(head - back), false]),
  ]);
  const headTs = hexNum(a.timestamp) * 1000;
  const blockMs = (headTs - hexNum(b.timestamp) * 1000) / back;
  return { blockMs, at: (n) => headTs - (head - n) * blockMs };
}

// ---------- state ----------

const stateFile = (key) => join(HERE, 'state', `${key}.json`);
const outFile = (key) => join(HERE, '..', 'data', `${key}.json`);

async function loadState(key) {
  try {
    const s = JSON.parse(await readFile(stateFile(key), 'utf8'));
    if (s.version === STATE_VERSION) return s;
  } catch { /* first run */ }
  return { version: STATE_VERSION, lastBlock: 0, pools: {}, meta: {}, ds: {} };
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file + '.tmp', JSON.stringify(value));
  await rename(file + '.tmp', file);
}

// ---------- 1. which pools traded ----------

async function scan(c, state) {
  // Stay a few seconds behind the tip: load-balanced RPCs disagree about the latest block.
  const head = hexNum(await c.rpc.call('eth_blockNumber', [])) - c.lag;
  const clock = await chainClock(c.rpc, head);
  const lookback = state.lastBlock ? head - state.lastBlock : BOOTSTRAP / clock.blockMs;
  const from = head - Math.round(Math.min(lookback, MAX_CATCH_UP / clock.blockMs)) + 1;
  // v4 swaps can be fetched for the PoolManager alone, which is cheap, so the first pass reaches further back
  // for them: pools that trade only a few times an hour would otherwise be missed until their next trade.
  const v4From = state.v4Backfilled ? from : Math.min(from, head - Math.round((c.v4Backfill * 3600e3) / clock.blockMs) + 1);
  const chunk = Math.max(10, Math.round(CHUNK_TIME / clock.blockMs));
  let swaps = 0;
  const touch = (id, kind, block) => {
    const p = state.pools[id] || (state.pools[id] = { kind });
    p.lastSeen = Math.max(p.lastSeen || 0, clock.at(block));
    swaps++;
  };
  for (let a = v4From; a <= head; a += chunk) {
    const b = Math.min(head, a + chunk - 1);
    const [v4, legacy] = await Promise.all([
      c.rpc.getLogs({ address: c.poolManager, topics: [TOPIC.v4Swap] }, a, b),
      b >= from ? c.rpc.getLogs({ topics: [[TOPIC.v3Swap, TOPIC.v2Swap]] }, Math.max(a, from), b) : [],
    ]);
    for (const lg of v4) touch(lg.topics[1].toLowerCase(), 'v4', hexNum(lg.blockNumber));
    for (const lg of legacy) touch(lg.address.toLowerCase(), lg.topics[0] === TOPIC.v3Swap ? 'v3' : 'v2', hexNum(lg.blockNumber));
    // Progress is kept chunk by chunk, so a pass that fails part-way resumes here instead of starting over.
    if (b >= from) state.lastBlock = b;
  }
  state.lastBlock = head;
  state.v4Backfilled = true;
  const cutoff = Date.now() - ACTIVE_WINDOW;
  for (const [id, p] of Object.entries(state.pools)) {
    if (p.lastSeen < cutoff) { delete state.pools[id]; delete state.ds[id]; }
  }
  return { blocks: head - v4From + 1, swaps, head };
}

// ---------- 2. keep only Uniswap's own v2/v3 pools ----------

// Other DEXes reuse the same swap events, so v2/v3 pools are checked against Uniswap's factories once and
// remembered, along with the share of fees that reaches LPs. Uniswap's protocol fee takes 1/feeProtocol of a
// v3 pool's fees, and 1/6 of a v2 pool's 0.3% when the factory's fee switch (feeTo) is on.
async function checkLegacyPools(c, state) {
  const todo = Object.entries(state.pools).filter(([id, p]) => p.kind !== 'v4' && !state.meta[id]).map(([id, p]) => [id, p.kind]);
  if (!todo.length) return 0;
  if (state.v2FeeOn == null) {
    const feeTo = await c.rpc.call('eth_call', [{ to: c.v2Factory, data: SEL.feeTo }, 'latest']);
    state.v2FeeOn = /[1-9a-f]/i.test(feeTo.slice(2));
  }
  // Ask every pool for its factory first; only Uniswap's own v3 pools need the fee and protocol-cut calls.
  const factories = await c.rpc.batch(todo.map(([id]) => ({ method: 'eth_call', params: [{ to: id, data: SEL.factory }, 'latest'] })));
  const v3 = [];
  todo.forEach(([id, kind], k) => {
    const res = factories[k];
    if (res === undefined) return; // no answer isn't a "no": the next cycle asks again
    const addr = res && res.length >= 42 ? '0x' + res.slice(-40).toLowerCase() : '';
    const ok = kind === 'v3' ? addr === c.v3Factory : addr === c.v2Factory;
    if (!ok) state.meta[id] = { ok: false };
    else if (kind === 'v2') state.meta[id] = { ok, fee: 0.3, lpShare: state.v2FeeOn ? 5 / 6 : 1 };
    else v3.push(id);
  });
  const details = await c.rpc.batch(v3.flatMap((id) => [
    { method: 'eth_call', params: [{ to: id, data: SEL.fee }, 'latest'] },
    { method: 'eth_call', params: [{ to: id, data: SEL.slot0 }, 'latest'] },
  ]));
  const cut = (n) => (n ? 1 / n : 0);
  v3.forEach((id, k) => {
    const [feeRaw, slot0] = [details[2 * k], details[2 * k + 1]];
    if (!feeRaw || !slot0) return;
    const fp = hexNum(words(slot0)[5] || '0');
    state.meta[id] = { ok: true, fee: hexNum(feeRaw) / 1e4, lpShare: 1 - (cut(fp & 15) + cut(fp >> 4)) / 2 };
  });
  return todo.length;
}

// A v4 swap's fee includes Uniswap's protocol cut; StateView reports the LP fee alone, which is what liquidity
// earns and what Uniswap displays. Dynamic-fee pools can change it, so it's re-read with the stats.
async function readV4LpFees(c, state, ids) {
  const now = Date.now();
  const v4 = ids.filter((id) => state.pools[id]?.kind === 'v4' && !(now - (state.pools[id].lpFeeAt || 0) < LP_FEE_TTL));
  if (!v4.length) return;
  const res = await c.rpc.batch(v4.map((id) => ({ method: 'eth_call', params: [{ to: c.stateView, data: SEL.getSlot0 + id.slice(2) }, 'latest'] })));
  v4.forEach((id, k) => {
    const w = res[k] ? words(res[k]) : [];
    if (w.length >= 4) { state.pools[id].lpFee = hexNum(w[3]) / 1e4; state.pools[id].lpFeeAt = now; }
  });
}

// ---------- 3. stats from DexScreener ----------

async function refreshStats(c, state) {
  const now = Date.now();
  const due = Object.entries(state.pools)
    .filter(([id, p]) => p.kind === 'v4' || state.meta[id]?.ok)
    .filter(([id]) => {
      const d = state.ds[id];
      if (!d) return true;
      const worth = !d.miss && d.liq >= MIN_TVL;
      return now - d.t > (worth ? DS_FRESH : DS_FRESH_SMALL);
    })
    // Never-seen pools first, then the most recently active.
    .sort(([a, pa], [b, pb]) => (state.ds[a] ? 1 : 0) - (state.ds[b] ? 1 : 0) || pb.lastSeen - pa.lastSeen)
    .map(([id]) => id);
  let calls = 0;
  for (let i = 0; i < due.length && calls < DS_MAX_CALLS; i += 30, calls++) {
    const ids = due.slice(i, i + 30);
    let pairs = [];
    try {
      const r = await fetch(DS_PAIRS + c.ds + '/' + ids.join(','), { headers: { 'user-agent': UA } });
      if (r.status === 429) { await sleep(20e3); i -= 30; continue; }
      if (r.ok) pairs = (await r.json()).pairs || [];
    } catch {
      continue;
    }
    const byId = new Map(pairs.map((pr) => [String(pr.pairAddress).toLowerCase(), pr]));
    for (const id of ids) {
      const pr = byId.get(id);
      state.ds[id] = pr ? {
        t: now,
        liq: pr.liquidity?.usd ?? 0,
        vol: pr.volume?.h24 ?? 0,
        base: { address: String(pr.baseToken?.address || '').toLowerCase(), name: pr.baseToken?.name || '', symbol: pr.baseToken?.symbol || '' },
        quote: { address: String(pr.quoteToken?.address || '').toLowerCase(), name: pr.quoteToken?.name || '', symbol: pr.quoteToken?.symbol || '' },
        mc: pr.marketCap ?? pr.fdv ?? null,
        created: pr.pairCreatedAt ?? null,
        url: pr.url || null,
        img: pr.info?.imageUrl || null,
        websites: (pr.info?.websites || []).map((w) => w.url).filter(Boolean),
        socials: (pr.info?.socials || []).map((s) => ({ type: s.type, url: s.url })).filter((s) => s.url),
      } : { t: now, miss: true };
    }
    await readV4LpFees(c, state, ids.filter((id) => !state.ds[id].miss && state.ds[id].liq >= MIN_TVL));
    await sleep(250);
  }
  return { due: due.length, calls };
}

// v4 pools whose LP fee lookup got no answer are retried every cycle rather than at their next stats refresh.
async function fillMissingLpFees(c, state) {
  const missing = Object.entries(state.pools)
    .filter(([id, p]) => p.kind === 'v4' && p.lpFee == null && state.ds[id] && !state.ds[id].miss && state.ds[id].liq >= MIN_TVL)
    .map(([id]) => id);
  await readV4LpFees(c, state, missing);
  return missing.length;
}

// ---------- 4. output ----------

async function writeOutput(c, state, head) {
  const pools = [];
  for (const [id, p] of Object.entries(state.pools)) {
    const meta = state.meta[id];
    // fee: the tier Uniswap displays. lpFee: the part liquidity providers keep, which the APR uses.
    const fee = p.kind === 'v4' ? p.lpFee : meta?.ok ? meta.fee : null;
    const lpFee = p.kind === 'v4' ? p.lpFee : fee != null ? fee * meta.lpShare : null;
    const d = state.ds[id];
    if (fee == null || lpFee == null || !d || d.miss || d.liq < MIN_TVL || !(d.vol > 0)) continue;
    pools.push({
      id,
      version: p.kind,
      fee,
      lpFee,
      tvl: Math.round(d.liq),
      vol: Math.round(d.vol),
      apr: (d.vol * lpFee * 365) / d.liq,
      base: d.base,
      quote: d.quote,
      mc: d.mc,
      created: d.created,
      url: d.url,
      img: d.img,
      websites: d.websites,
      socials: d.socials,
      statsAt: d.t,
    });
  }
  pools.sort((a, b) => b.apr - a.apr);
  await writeJson(outFile(c.key), { updatedAt: Date.now(), chain: c.name, block: head, pools });
  return pools.length;
}

// ---------- main ----------

async function cycle(c) {
  const t0 = Date.now();
  ensureAlchemy(c);
  c.rpc.reset();
  const { blocks, swaps, head } = await scan(c, c.state);
  const checked = await checkLegacyPools(c, c.state);
  const { due, calls } = await refreshStats(c, c.state);
  await fillMissingLpFees(c, c.state);
  const written = await writeOutput(c, c.state, head);
  await writeJson(stateFile(c.key), c.state);
  const n = (x) => x.toLocaleString('en-US');
  console.log(`[${new Date().toLocaleTimeString('en-US')}] ${c.name}: ${n(blocks)} blocks, ${n(swaps)} swaps`
    + ` · ${n(Object.keys(c.state.pools).length)} pools traded in 24h · ${checked} checked`
    + ` · ${calls} DexScreener calls (${Math.max(0, due - calls * 30)} still due)`
    + ` · wrote ${n(written)} pools in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

const args = process.argv.slice(2);
const once = args.includes('--once');
const picked = args.flatMap((a, i) => (a === '--chain' ? [args[i + 1]] : []));
const unknown = picked.filter((k) => !CHAINS[k]);
if (unknown.length) {
  console.error(`Unknown chain: ${unknown.join(', ')}. Choose from ${Object.keys(CHAINS).join(', ')}.`);
  process.exit(1);
}
const chains = [];
for (const key of picked.length ? picked : Object.keys(CHAINS)) {
  chains.push({ key, ...CHAINS[key], rpc: rpcClient(CHAINS[key].rpcs), state: await loadState(key) });
}
for (;;) {
  for (const c of chains) {
    try {
      await cycle(c);
    } catch (e) {
      console.log(`[${new Date().toLocaleTimeString('en-US')}] ${c.name}: cycle failed: ${e.message}`);
      // Keep what the pass did get through. With --once the next pass is a new process, and it should continue
      // from the blocks already scanned rather than repeat the same catch-up.
      await writeJson(stateFile(c.key), c.state).catch(() => {});
    }
  }
  if (once) break;
  await sleep(INTERVAL);
}
