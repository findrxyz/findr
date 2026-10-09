'use strict';

const LLAMA_POOLS = 'https://yields.llama.fi/pools';
const LLAMA_CHAINS = 'https://api.llama.fi/v2/chains';
const DS_TOKENS = 'https://api.dexscreener.com/tokens/v1/';
const GT_NETWORKS = 'https://api.geckoterminal.com/api/v2/networks/';
// Web app URL of the Google Apps Script in reports/Code.gs, which saves problem reports to a Google Sheet.
// Left empty, the Report button stays hidden, which suits a copy of the page with no sheet of its own.
const REPORT_URL = 'https://script.google.com/macros/s/AKfycbyV6jI8uDcEuqt1C1iaxOzCJqYCxvA0KXEcFaUTExdAvIfi4nBv5ZCx3LDh056MNFIdug/exec';
const ZERO = '0x0000000000000000000000000000000000000000';
const DAY = 864e5;
const POOLS_TTL = 15 * 60e3;
const STALE_MAX = 24 * 60 * 60e3; // saved pools older than this aren't shown at all
const CHAINS_TTL = 6 * 60 * 60e3;
const DS_TTL = 30 * 60e3;
const GT_TTL = 24 * 60 * 60e3;
// GeckoTerminal's free API allowed well under its documented 30 calls a minute when measured on 2026-09-28
// (3–10 depending on recent use), and calls over the limit extend the block. The budget starts at
// GT_PER_MIN per rolling minute, halves on every block and creeps back up after a run of successes.
const GT_PER_MIN = 9;
const GT_MIN_BUDGET = 2;
const GT_COOLOFF = 30e3;
const ENRICH_CAP = 1500;
const PAGE = 100;
const TOP_N = 20;

// Used only when DefiLlama's chain ranking can't be fetched.
const FALLBACK_TOP = [
  'Ethereum', 'Solana', 'Base', 'BSC', 'Tron', 'Bitcoin', 'Arbitrum', 'Hyperliquid L1', 'Robinhood Chain', 'Monad',
  'Polygon', 'Avalanche', 'Bittensor', 'Plasma', 'Sui', 'Arc', 'OP Mainnet', 'Anubis', 'Stellar', 'Near',
];

// DefiLlama chain name -> ids on DexScreener (ds), GeckoTerminal (gt), Uniswap (uni) and a token explorer (exp).
const CHAINS = {
  'Ethereum':        { ds: 'ethereum',  gt: 'eth',         uni: 'ethereum',  exp: 'https://etherscan.io/token/', index: 'data/ethereum.json' },
  'Solana':          { ds: 'solana',    gt: 'solana',      exp: 'https://solscan.io/token/' },
  'Base':            { ds: 'base',      gt: 'base',        uni: 'base',      exp: 'https://basescan.org/token/', index: 'data/base.json' },
  'BSC':             { ds: 'bsc',       gt: 'bsc',         uni: 'bnb',       exp: 'https://bscscan.com/token/' },
  'Tron':            { ds: 'tron',      gt: 'tron',        exp: 'https://tronscan.org/#/token20/' },
  'Arbitrum':        { ds: 'arbitrum',  gt: 'arbitrum',    uni: 'arbitrum',  exp: 'https://arbiscan.io/token/' },
  'Hyperliquid L1':  { ds: 'hyperevm',  gt: 'hyperevm',    exp: 'https://hyperevmscan.io/token/' },
  'Robinhood Chain': { ds: 'robinhood', gt: 'robinhood',   uni: 'robinhood', exp: 'https://robinhoodchain.blockscout.com/token/', index: 'data/robinhood.json' },
  'Monad':           { ds: 'monad',     gt: 'monad' },
  'Polygon':         { ds: 'polygon',   gt: 'polygon_pos', uni: 'polygon',   exp: 'https://polygonscan.com/token/' },
  'Avalanche':       { ds: 'avalanche', gt: 'avax',        uni: 'avalanche', exp: 'https://snowtrace.io/token/' },
  'Bittensor':       { ds: 'bittensor', gt: 'bittensor' },
  'Plasma':          { ds: 'plasma',    gt: 'plasma' },
  'Sui':             { ds: 'sui',       gt: 'sui-network', exp: 'https://suiscan.xyz/mainnet/coin/' },
  'Arc':             { ds: 'arc',       gt: 'arc',         uni: 'arc' },
  'OP Mainnet':      { ds: 'optimism',  gt: 'optimism',    uni: 'optimism',  exp: 'https://optimistic.etherscan.io/token/' },
  'Anubis':          { ds: 'anubis',    gt: 'anubis' },
  'Stellar':         { ds: 'stellar',   gt: 'stellar' },
  'Near':            { ds: 'near',      gt: 'near' },
};
function chainCfg(name) {
  return CHAINS[name] || { ds: name.toLowerCase().replace(/[^a-z0-9]/g, ''), gt: null, uni: null, exp: null };
}
// Chains with pools on the page. Their Uniswap pools come from our own indexer (indexer/uniswap.mjs), which reads
// them from the chain the way Uniswap counts them; DefiLlama's Uniswap v4 numbers were often far off. Other DEXes
// on these chains come from DefiLlama. The rest of the top 20 show as "Coming soon".
const ENABLED = new Set(['Ethereum', 'Base', 'Robinhood Chain']);
const isSoon = (name) => !ENABLED.has(name);
const NO_DEX_POOLS = new Set(['Bitcoin']); // top-20 chains with no AMM pools to list
const INDEX_POLL = 5 * 60e3;       // deployed data changes every 15–30 minutes
const INDEX_STALE = 60 * 60e3;

// DefiLlama projects that hold two-token positions but aren't DEX pools (vaults, perps, lending wrappers).
const NON_DEX = new Set([
  'beefy', 'convex-finance', 'gmx-v2-perps', 'gmx-solana', 'stake-dao-yield', 'kamino-liquidity', 'yearn-finance',
  'frax', 'gamma', 'extra-finance-leverage-farming', 'gammaswap-open-interest', 'steer-protocol', 'goose-finance',
  'fx-protocol', 'yield-yak-aggregator', 'concentrator', 'coffer', 'meme-dollar', 'hydt-protocol', 'pendle-v2',
  'abracadabra-spell', 'origami-finance', 'hrusd', 'everything', 'arrakis-v2', 'ichi', 'aura', 'sommelier',
]);
const DEX_NAMES = {
  'aerodrome-v1': 'Aerodrome', 'aerodrome-slipstream': 'Aerodrome Slipstream',
  'velodrome-v2': 'Velodrome', 'velodrome-v3': 'Velodrome Slipstream',
  'pancakeswap-amm': 'PancakeSwap v2', 'pancakeswap-amm-v3': 'PancakeSwap v3', 'curve-dex': 'Curve',
  'raydium-amm': 'Raydium', 'orca-dex': 'Orca', 'cetus-clmm': 'Cetus', 'bluefin-spot': 'Bluefin', 'project-x': 'Project X',
  'sushiswap': 'SushiSwap', 'sushiswap-v3': 'SushiSwap v3', 'quickswap-dex': 'QuickSwap', 'hyperswap-v2': 'HyperSwap v2',
  'hyperswap-v3': 'HyperSwap v3', 'camelot-v2': 'Camelot', 'camelot-v3': 'Camelot v3', 'balancer-v2': 'Balancer v2',
  'balancer-v3': 'Balancer v3', 'fluid-dex': 'Fluid', 'joe-v2.1': 'Trader Joe v2.1', 'joe-v2.2': 'Trader Joe v2.2',
};
function prettyDex(slug) {
  return slug.split(/[-_]/).filter(Boolean).map((w) => (/^v\d/.test(w) ? w
    : /^(amm|clmm|dex|cl|lb)$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');
}
const uniVersion = (slug) => { const m = /^uniswap[-_ ]?v?(\d)/i.exec(slug); return m ? 'v' + m[1] : null; };
// One display name per DEX, so e.g. DefiLlama's and the indexer's Uniswap v4 pools share one filter entry.
const canonDex = (name) => name.replace(/\s*\(.*?\)\s*$/, '').replace(/\bV(\d+(?:\.\d+)?)\b/g, 'v$1').trim();
function dexFromLlama(slug) {
  const v = uniVersion(slug);
  return v ? 'Uniswap ' + v : canonDex(DEX_NAMES[slug] || prettyDex(slug));
}

// Official contracts for the tokens memecoins pair against. On these chains the list is complete enough
// that a token borrowing one of these names without the official address gets flagged.
const QUOTES = {
  'Ethereum': {
    USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    WETH: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', DAI: '0x6b175474e89094c44da98b954eedeac495271d0f',
    WBTC: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', USDS: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
  },
  'Base': {
    USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', USDBC: '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca',
    USDT: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', DAI: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
    WETH: '0x4200000000000000000000000000000000000006', CBBTC: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
    ZORA: '0x1111111111166b7fe7bd91427724b487980afc69',
  },
  'Arbitrum': {
    USDC: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', 'USDC.E': '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
    USDT: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', DAI: '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
    WETH: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', ARB: '0x912ce59144191c1204e64559fe8253a0e49e6548',
  },
  'BSC': {
    USDT: '0x55d398326f99059ff775485246999027b3197955', USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    DAI: '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3', WBNB: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    BTCB: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', ETH: '0x2170ed0880ac9a755fd29b2688956bd959f933f8',
  },
  'Polygon': {
    USDC: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', 'USDC.E': '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
    USDT: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', DAI: '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063',
    WETH: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', WPOL: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
  },
  'OP Mainnet': {
    USDC: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', 'USDC.E': '0x7f5c764cbc14f9669b88837ca1490cca17c31607',
    USDT: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', DAI: '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
    WETH: '0x4200000000000000000000000000000000000006', OP: '0x4200000000000000000000000000000000000042',
  },
  'Avalanche': {
    USDC: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', 'USDC.E': '0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664',
    USDT: '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', WAVAX: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
  },
};
// Partial lists for other chains: good enough to pick the memecoin side of a pair, not to call anything fake.
const EXTRA_QUOTES = {
  'Solana': ['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'],
  'Sui': [
    '0x2::sui::SUI', '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
    '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  ],
  'Hyperliquid L1': ['0x5555555555555555555555555555555555555555', '0xb88339cb7199b77e23db6e890353e22632ba630f'],
  'Robinhood Chain': ['0x0bd7d308f8e1639fab988df18a8011f41eacad73', '0x5fc5360d0400a0fd4f2af552add042d716f1d168'],
};
const QUOTE_SYMBOLS = new Set([
  'ETH', 'WETH', 'USDC', 'USDT', 'USDG', 'DAI', 'USDS', 'USDE', 'USD1', 'USDB', 'PYUSD', 'FDUSD', 'USDC.E', 'USDT0', 'USD₮0',
  'WBTC', 'CBBTC', 'BTC', 'SOL', 'WSOL', 'SUI', 'HYPE', 'WHYPE', 'BNB', 'WBNB', 'POL', 'WPOL', 'AVAX', 'WAVAX',
  'TRX', 'WTRX', 'MON', 'WMON', 'XPL', 'WXPL', 'NEAR', 'WNEAR', 'XLM', 'TAO', 'ZORA',
]);
const QUOTE_SETS = Object.fromEntries(Object.entries(QUOTES).map(([c, m]) => [c, new Set(Object.values(m))]));
const EXTRA_SETS = Object.fromEntries(Object.entries(EXTRA_QUOTES).map(([c, l]) => [c, new Set(l)]));
const LOOKALIKE = new Set(['USDC', 'USDT', 'WETH', 'ETH', 'WBTC', 'DAI', 'USDC.E', 'USDS']);

function isQuote(chain, a, sym) {
  if (a === ZERO) return true;
  if (QUOTE_SETS[chain]) return QUOTE_SETS[chain].has(a);
  if (EXTRA_SETS[chain]?.has(a)) return true;
  return !!sym && QUOTE_SYMBOLS.has(sym.toUpperCase());
}
function isCopycat(chain, a, sym) {
  if (!QUOTE_SETS[chain] || !sym || a === ZERO) return false;
  return LOOKALIKE.has(sym.toUpperCase()) && !QUOTE_SETS[chain].has(a);
}

// ---------- small helpers ----------

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false || kid === '') continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const ICONS = {
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.5 3.5 5.3 3.5 8.5s-1.2 6-3.5 8.5c-2.3-2.5-3.5-5.3-3.5-8.5s1.2-6 3.5-8.5z"/>',
  x: '<path fill="currentColor" stroke="none" transform="translate(2.4 2.4) scale(.8)" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>',
  telegram: '<path d="M20.5 4.5 3.5 11.2l5.3 1.9 2 6.1 3.1-3.6 4.9 3.6 1.7-14.7z"/><path d="m8.8 13.1 8.3-5.6-6.3 7.1"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
  more: '<circle fill="currentColor" stroke="none" cx="5.5" cy="12" r="1.6"/><circle fill="currentColor" stroke="none" cx="12" cy="12" r="1.6"/><circle fill="currentColor" stroke="none" cx="18.5" cy="12" r="1.6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  chart: '<path d="M4 19.5h16"/><path d="m6.5 15 4-4.5 3 2.5 4.5-6"/>',
  external: '<path d="M14 4.5h5.5V10"/><path d="m19.5 4.5-8.5 8.5"/><path d="M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10"/>',
  layers: '<path d="m12 4 8 4-8 4-8-4 8-4z"/><path d="m4 12 8 4 8-4"/><path d="m4 16 8 4 8-4"/>',
  history: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  cube: '<path d="m12 3.5 7.5 4.25v8.5L12 20.5l-7.5-4.25v-8.5L12 3.5z"/><path d="m4.5 7.75 7.5 4.25 7.5-4.25M12 12v8.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  flag: '<path d="M5.5 20.5v-16"/><path d="M5.5 5h12l-2.5 4 2.5 4h-12"/>',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'ico');
  svg.innerHTML = ICONS[name];
  return svg;
}

// Token websites and socials are user-submitted, so only plain web links get through.
function safeUrl(u) {
  if (typeof u !== 'string' || /missing/.test(u)) return null;
  try {
    const x = new URL(u.trim());
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
  } catch {
    return null;
  }
}

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

function fmtUsd(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K';
  return '$' + Math.round(n);
}
function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 100) return Math.round(n).toLocaleString('en-US') + '%';
  if (n >= 10) return n.toFixed(1) + '%';
  return n.toFixed(2) + '%';
}
function fmtAge(ms) {
  if (!ms) return '—';
  const d = (Date.now() - ms) / DAY;
  if (d < 1) return Math.max(1, Math.round(d * 24)) + 'h';
  if (d < 60) return Math.round(d) + 'd';
  if (d < 730) return Math.round(d / 30.4) + 'mo';
  return (d / 365).toFixed(1).replace(/\.0$/, '') + 'y';
}
const fmtInt = (n) => Number(n).toLocaleString('en-US');
const fmtFee = (f) => (f >= 1 ? +f.toFixed(2) : +f.toFixed(3)) + '%';
const parseFee = (s) => { const m = /([\d.]+)\s*%/.exec(s || ''); return m ? parseFloat(m[1]) : null; };
const shortAddr = (a) => (a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-4) : a);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'website'; } };
const xSearch = (q) => 'https://x.com/search?q=' + encodeURIComponent(q) + '&f=live';
const normAddr = (a) => { a = String(a || '').trim(); return /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a; };
const isTok = (a) => /^[A-Za-z0-9:_.-]{3,200}$/.test(a);
function xHandle(u) {
  try {
    const first = new URL(u).pathname.split('/').filter(Boolean)[0] || '';
    if (first === 'i') return 'X community';
    return /^\w{1,15}$/.test(first) ? '@' + first : 'X account';
  } catch {
    return 'X account';
  }
}

// ---------- state ----------

const DEFAULTS = {
  q: '', chain: 'all', dexOff: [], minApr: 100, basis: 'apy', minTvl: 25000, maxMc: 0,
  sort: 'apy', dir: -1, hideSpikes: false, hideNew: false, needLinks: false,
};
let F = { ...DEFAULTS, ...(store.get('ys:filters:v3') || {}), q: '' };
if (!Array.isArray(F.dexOff)) F.dexOff = [];
let DEX_OFF = new Set(F.dexOff);

const APR_PRESETS = [0, 50, 100, 500, 1000, 10000];
const TVL_PRESETS = [0, 10000, 25000, 50000, 100000, 250000, 1000000];
const MC_PRESETS = [0, 1e6, 3e6, 10e6, 100e6, 1e9];
const SORTS = [
  ['apy', -1, 'APR 24h'], ['apy30', -1, 'APR 30d'], ['tvl', -1, 'TVL'], ['vol', -1, 'Volume 24h'],
  ['mc', 1, 'Smallest market cap'], ['age', 1, 'Newest'],
];

let TOP = [];      // [{ name, tvl, rank }]
let LLAMA = [];    // pools from DefiLlama
let llamaAt = 0;
let INDEXED = [];  // Robinhood Chain pools from the indexer
let indexedAt = 0;
let POOLS = [];
let GEN = 0;
let shown = PAGE;
let lastS1 = null;
// load and ds are work in progress (they drive the progress bar); indexed and info are just notes.
const statusParts = { load: '', ds: '', indexed: '', info: '' };

const DS = new Map(Object.entries(store.get('ys:ds:v2') || {}));
const GT = new Map(Object.entries(store.get('ys:gt:v2') || {}));
for (const [k, v] of DS) if (Date.now() - v.ts > 6 * 60 * 60e3) DS.delete(k);
for (const [k, v] of GT) if (Date.now() - v.ts > GT_TTL) GT.delete(k);

const dsGet = (chain, a) => DS.get(chainCfg(chain).ds + ':' + a) || null;
const dsInfo = (chain, a) => { const d = dsGet(chain, a); return d && !d.miss ? d : null; };
function gtGet(chain, a) {
  const net = chainCfg(chain).gt;
  return net ? GT.get(net + ':' + a) || null : null;
}

// ---------- chains and pools ----------

async function loadChains(force) {
  const cached = !force && store.get('ys:chains:v1');
  if (cached && Date.now() - cached.ts < CHAINS_TTL && Array.isArray(cached.top)) { TOP = cached.top; return; }
  try {
    const r = await fetch(LLAMA_CHAINS);
    if (!r.ok) throw new Error(String(r.status));
    const list = (await r.json()).filter((c) => c && c.name && c.tvl > 0).sort((a, b) => b.tvl - a.tvl).slice(0, TOP_N);
    TOP = list.map((c, i) => ({ name: c.name, tvl: c.tvl, rank: i + 1 }));
    store.set('ys:chains:v1', { ts: Date.now(), top: TOP });
  } catch {
    TOP = FALLBACK_TOP.map((name, i) => ({ name, tvl: null, rank: i + 1 }));
  }
}

// Fee APR only. Token-reward emissions (common on Aerodrome-style DEXes) make tiny pools show six-figure
// APRs that trading never earned, and they aren't what Uniswap or GeckoTerminal report.
const hasRewards = (p) => (p.apyReward ?? 0) > 0;
const feeApr = (p) => p.apyBase ?? (hasRewards(p) ? 0 : p.apy ?? 0);

function fromLlama(p) {
  const tokens = p.underlyingTokens.map(normAddr);
  const parts = p.symbol.split('-');
  const dexName = dexFromLlama(p.project);
  return {
    id: p.pool,
    src: 'llama',
    chain: p.chain,
    dexName,
    dexKey: dexName.toLowerCase(),
    symbol: p.symbol,
    fee: p.project === 'uniswap-v2' ? 0.3 : parseFee(p.poolMeta),
    tvl: p.tvlUsd,
    apy: feeApr(p),
    // DefiLlama's 30-day mean includes rewards, so it only compares cleanly for fee-only pools.
    apy30: hasRewards(p) ? null : p.apyMean30d ?? null,
    vol1d: p.volumeUsd1d ?? null,
    tokens,
    syms: parts.length === tokens.length ? parts : [null, null],
  };
}

// Saved pools show immediately. Once they're older than POOLS_TTL they're refreshed in the background,
// so a returning visitor never waits on a download.
async function loadLlama(force) {
  const cached = !force && store.get('ys:llama:v6');
  if (cached && Array.isArray(cached.pools) && Date.now() - cached.ts < STALE_MAX) {
    LLAMA = cached.pools;
    llamaAt = cached.ts;
    if (Date.now() - cached.ts >= POOLS_TTL) {
      fetchLlama(cached.pools.length ? 'Updating pools' : '')
        .then(() => { updateFresh(); assemblePools(); scheduleRun(); })
        .catch(() => { statusParts.load = ''; renderStatus(); });
    }
    return;
  }
  await fetchLlama();
}

async function fetchLlama(label) {
  statusParts.load = label || 'Downloading pools from DefiLlama';
  renderStatus();
  const res = await fetch(LLAMA_POOLS);
  if (!res.ok) throw new Error(`DefiLlama answered with HTTP ${res.status}`);
  const json = await res.json();
  LLAMA = (json.data || [])
    .filter((p) => ENABLED.has(p.chain) && !p.project.startsWith('uniswap') && p.exposure === 'multi' && !NON_DEX.has(p.project)
      && Array.isArray(p.underlyingTokens) && p.underlyingTokens.length === 2 && p.tvlUsd >= 5000 && feeApr(p) >= 5)
    .map(fromLlama)
    .filter((p) => p.tokens.every(isTok));
  llamaAt = Date.now();
  statusParts.load = '';
  store.set('ys:llama:v6', { ts: llamaAt, pools: LLAMA });
}

// Uniswap pools come from indexer/uniswap.mjs, which reads them straight from each chain. Its files also carry
// each token's DexScreener details, which seed the token cache so the browser skips those lookups.
function fromIndexed(chain, p) {
  const tokens = [normAddr(p.base?.address), normAddr(p.quote?.address)];
  if (!tokens.every(isTok) || !isTok(String(p.id || ''))) return null;
  DS.set(chainCfg(chain).ds + ':' + tokens[0], {
    ts: p.statsAt || Date.now(),
    name: p.base.name || '',
    symbol: p.base.symbol || '',
    mc: p.mc ?? null,
    created: p.created ?? null,
    img: safeUrl(p.img),
    url: safeUrl(p.url),
    websites: (p.websites || []).map(safeUrl).filter(Boolean),
    socials: (p.socials || []).map((s) => ({ type: String(s.type || ''), url: safeUrl(s.url) })).filter((s) => s.url),
  });
  const dexName = 'Uniswap ' + p.version;
  return {
    id: chainCfg(chain).ds + ':' + p.id,
    src: 'indexer',
    chain,
    pool: p.id,
    dexName,
    dexKey: dexName.toLowerCase(),
    symbol: `${p.base.symbol || '?'}-${p.quote.symbol || '?'}`,
    fee: p.fee,
    tvl: p.tvl,
    apy: p.apr,
    apy30: null,
    vol1d: p.vol,
    tokens,
    syms: [p.base.symbol || null, p.quote.symbol || null],
    names: [p.base.name || '', p.quote.name || ''],
    imgs: [safeUrl(p.img), null],
    mc: p.mc ?? null,
    created: p.created ?? null,
  };
}

const indexedByChain = {}; // chain -> { pools, updatedAt }

async function loadIndexed() {
  const notes = [];
  await Promise.all([...ENABLED].map(async (chain) => {
    const file = chainCfg(chain).index;
    if (!file) return;
    try {
      // 'no-cache' revalidates with the server, so an unchanged file costs a tiny 304 instead of megabytes,
      // and a file whose ETag hasn't changed isn't parsed again.
      const r = await fetch(file, { cache: 'no-cache' });
      if (!r.ok) throw new Error(String(r.status));
      const tag = r.headers.get('etag') || r.headers.get('last-modified');
      if (!tag || indexedByChain[chain]?.tag !== tag) {
        const json = await r.json();
        indexedByChain[chain] = { pools: (json.pools || []).map((p) => fromIndexed(chain, p)).filter(Boolean), updatedAt: json.updatedAt || 0, tag };
      }
    } catch {
      if (!indexedByChain[chain]) notes.push(`${chain} Uniswap pools aren't available right now`);
      return;
    }
    const age = Date.now() - indexedByChain[chain].updatedAt;
    const mins = Math.round(age / 60e3);
    if (age > INDEX_STALE) notes.push(`${chain} data is ${mins < 120 ? mins + ' minutes' : fmtAge(indexedByChain[chain].updatedAt)} old`);
  }));
  INDEXED = Object.values(indexedByChain).flatMap((c) => c.pools);
  indexedAt = Math.max(0, ...Object.values(indexedByChain).map((c) => c.updatedAt));
  statusParts.indexed = notes.join(' · ');
  renderStatus();
}

function assemblePools() {
  POOLS = LLAMA.filter((p) => ENABLED.has(p.chain) && !p.dexKey.startsWith('uniswap')).concat(INDEXED);
  if (llamaAt && F.chain !== 'all' && !chainAvailable(F.chain)) F.chain = 'all';
  updateButtons();
  if (popKind === 'chain') refreshPop();
}

// ---------- GeckoTerminal request queue ----------
// Fills in website/X links DexScreener doesn't have, for rows on screen only.

const gtJobs = [];
let gtBusy = false;
let gtNext = 0;

function gtEnqueue(job) {
  gtJobs.push(job);
  pumpGt();
}

const gtSent = []; // start times of calls in the last minute
let gtBudget = GT_PER_MIN;
let gtStreak = 0;

function gtWait() {
  const now = Date.now();
  while (gtSent.length && now - gtSent[0] >= 60e3) gtSent.shift();
  const slot = gtSent.length < gtBudget ? 0 : gtSent[gtSent.length - gtBudget] + 60e3 - now + 200;
  return Math.max(slot, gtNext - now, 0);
}

function gtResult(ok) {
  if (ok) {
    if (++gtStreak >= gtBudget && gtBudget < GT_PER_MIN) { gtBudget++; gtStreak = 0; }
  } else {
    gtBudget = Math.max(GT_MIN_BUDGET, Math.floor(gtBudget / 2));
    gtStreak = 0;
    gtNext = Date.now() + GT_COOLOFF;
  }
}

async function pumpGt() {
  if (gtBusy) return;
  gtBusy = true;
  while (gtJobs.length) {
    for (let wait = gtWait(); wait > 0; wait = gtWait()) await sleep(wait);
    const job = gtJobs.shift();
    if (!job) break;
    gtSent.push(Date.now());
    const url = `${GT_NETWORKS}${job.net}/tokens/${encodeURIComponent(job.a)}/info`;
    let r = null;
    try { r = await fetch(url); } catch { /* handled below */ }
    // A rate-limited reply arrives without CORS headers, so the browser reports it as a network error.
    // Treat any failure except "not found" as temporary: cool off, retry, and don't cache it.
    const failed = !r || r.status === 429 || r.status >= 500;
    gtResult(!failed);
    if (failed) {
      job.tries = (job.tries || 0) + 1;
      if (job.tries < 4) {
        gtJobs.unshift(job);
        continue;
      }
      onGtInfo(job, { none: true, temp: true });
      continue;
    }
    const json = r.ok ? await r.json().catch(() => null) : null;
    const at = json?.data?.attributes;
    onGtInfo(job, at ? {
      websites: (at.websites || []).map(safeUrl).filter(Boolean),
      twitter: /^\w{1,15}$/.test(at.twitter_handle || '') ? at.twitter_handle : null,
      telegram: /^[\w+-]{3,64}$/.test(at.telegram_handle || '') ? at.telegram_handle : null,
      img: safeUrl(at.image_url),
    } : { none: true });
  }
  gtBusy = false;
}

const rowIndex = new Map();

function wantGt(chain, a) {
  const net = chainCfg(chain).gt;
  if (!net) return;
  const k = net + ':' + a;
  if (GT.has(k) || gtJobs.some((j) => j.k === k)) return;
  gtEnqueue({ kind: 'info', k, net, a });
}

function onGtInfo(job, data) {
  GT.set(job.k, { ts: Date.now(), ...data });
  store.set('ys:gt:v2', Object.fromEntries([...GT].filter(([, v]) => !v.temp)));
  for (const entry of rowIndex.get(job.k) || []) {
    if (popAnchor && entry.el.contains(popAnchor)) closePop();
    const fresh = rowEl(entry.p);
    entry.el.replaceWith(fresh);
    entry.el = fresh;
  }
}

// ---------- token data (DexScreener) ----------

async function fetchDs(ds, addrs) {
  let pairs;
  try {
    const r = await fetch(DS_TOKENS + ds + '/' + addrs.map(encodeURIComponent).join(','));
    if (!r.ok) return;
    pairs = await r.json();
  } catch {
    return;
  }
  const now = Date.now();
  const want = new Set(addrs);
  const best = new Map();
  for (const pr of Array.isArray(pairs) ? pairs : []) {
    const base = normAddr(pr.baseToken?.address);
    if (!want.has(base)) continue;
    const cur = best.get(base);
    const liq = pr.liquidity?.usd ?? 0;
    const created = cur?.created && pr.pairCreatedAt ? Math.min(cur.created, pr.pairCreatedAt) : (cur?.created || pr.pairCreatedAt || null);
    if (!cur || liq > cur.liq) best.set(base, { liq, pr, created });
    else cur.created = created;
  }
  for (const a of addrs) {
    const b = best.get(a);
    if (!b) { DS.set(ds + ':' + a, { ts: now, miss: true }); continue; }
    const { pr } = b;
    const info = pr.info || {};
    DS.set(ds + ':' + a, {
      ts: now,
      name: pr.baseToken.name || '',
      symbol: pr.baseToken.symbol || '',
      mc: pr.marketCap ?? pr.fdv ?? null,
      created: b.created,
      img: safeUrl(info.imageUrl),
      url: safeUrl(pr.url),
      websites: (info.websites || []).map((w) => safeUrl(w.url)).filter(Boolean),
      socials: (info.socials || []).map((s) => ({ type: String(s.type || ''), url: safeUrl(s.url) })).filter((s) => s.url),
    });
  }
}

async function enrich(pairs, gen) {
  const byChain = new Map();
  for (const [chain, a] of pairs) {
    const ds = chainCfg(chain).ds;
    const e = DS.get(ds + ':' + a);
    if (e && Date.now() - e.ts < DS_TTL) continue;
    if (!byChain.has(ds)) byChain.set(ds, new Set());
    byChain.get(ds).add(a);
  }
  const jobs = [];
  for (const [ds, set] of byChain) {
    const arr = [...set];
    for (let i = 0; i < arr.length; i += 30) jobs.push([ds, arr.slice(i, i + 30)]);
  }
  if (!jobs.length) return;
  const total = jobs.length;
  let done = 0;
  const worker = async () => {
    while (jobs.length && gen === GEN) {
      const [ds, addrs] = jobs.shift();
      await fetchDs(ds, addrs);
      done++;
      if (gen === GEN) {
        statusParts.ds = `Loading market caps ${Math.round((done / total) * 100)}%`;
        renderStatus();
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  store.set('ys:ds:v2', Object.fromEntries(DS));
}

function tokenLinks(chain, d, g) {
  const socials = d?.socials || [];
  const site = d?.websites?.[0] || g?.websites?.[0] || null;
  const x = socials.find((s) => s.type === 'twitter' || s.type === 'x')?.url
    || (g?.twitter ? 'https://x.com/' + g.twitter : null);
  const tg = socials.find((s) => s.type === 'telegram')?.url
    || (g?.telegram ? 'https://t.me/' + g.telegram : null);
  return { site, x, tg, gtDone: !chainCfg(chain).gt || !!g };
}

// ---------- pool helpers ----------

const aprOf = (p) => (F.basis === 'apy30' ? p.apy30 ?? 0 : p.apy);
const isSpike = (p) => p.apy30 > 0 && p.apy / p.apy30 >= 3;
const symOf = (p, i) => dsInfo(p.chain, p.tokens[i])?.symbol || p.syms[i] || '';
const quoteAt = (p, i) => isQuote(p.chain, p.tokens[i], symOf(p, i));
const isMajorPair = (p) => quoteAt(p, 0) && quoteAt(p, 1);
function mcOf(p, i) {
  const d = dsInfo(p.chain, p.tokens[i]);
  if (d?.mc != null) return d.mc;
  return p.src === 'indexer' && i === 0 ? p.mc : null;
}
const createdOf = (p, i) => dsInfo(p.chain, p.tokens[i])?.created || (p.src === 'indexer' ? p.created : null);

function subjectIndex(p) {
  const q0 = quoteAt(p, 0);
  const q1 = quoteAt(p, 1);
  if (q0 !== q1) return q0 ? 1 : 0;
  if (q0) return 0;
  // Two unknown tokens: the smaller one is the less-discovered side.
  return (mcOf(p, 1) ?? Infinity) < (mcOf(p, 0) ?? Infinity) ? 1 : 0;
}

function matchesQuery(p, q) {
  if (p.symbol.toLowerCase().includes(q)) return true;
  if (q.length >= 6 && p.tokens.some((t) => t.toLowerCase().startsWith(q))) return true;
  if (p.names && p.names.some((n) => n.toLowerCase().includes(q))) return true;
  return p.tokens.some((t) => {
    const d = dsInfo(p.chain, t);
    return d && (d.name.toLowerCase().includes(q) || d.symbol.toLowerCase().includes(q));
  });
}

function chainCounts() {
  const counts = new Map();
  for (const p of POOLS) counts.set(p.chain, (counts.get(p.chain) || 0) + 1);
  return counts;
}
function chainAvailable(name) {
  return POOLS.some((p) => p.chain === name);
}
// DEXes with pools on the selected chain, alphabetically.
function visibleDexes() {
  const seen = new Map();
  for (const p of POOLS) if ((F.chain === 'all' || p.chain === F.chain) && !seen.has(p.dexKey)) seen.set(p.dexKey, p.dexName);
  return [...seen].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name));
}
const allDexKeys = () => new Set(POOLS.map((p) => p.dexKey));

// ---------- filtering ----------

function stage1() {
  const q = F.q.trim().toLowerCase();
  let list = POOLS.filter((p) => !DEX_OFF.has(p.dexKey) && (F.chain === 'all' || p.chain === F.chain));
  if (q) list = list.filter((p) => matchesQuery(p, q));
  const scanned = list.length;
  list = list.filter((p) => aprOf(p) >= F.minApr && p.tvl >= F.minTvl);
  list.sort((x, y) => aprOf(y) - aprOf(x));
  return { scanned, list };
}

const extraFilters = () => !!(F.maxMc || F.hideSpikes || F.hideNew || F.needLinks);

function stage2(list) {
  if (!extraFilters()) return list;
  return list.filter((p) => {
    const i = subjectIndex(p);
    const a = p.tokens[i];
    const mc = mcOf(p, i);
    if (F.maxMc && !(mc != null && mc <= F.maxMc)) return false;
    if (F.hideSpikes && isSpike(p)) return false;
    const created = createdOf(p, i);
    if (F.hideNew && created && Date.now() - created < 7 * DAY) return false;
    if (F.needLinks) {
      const L = tokenLinks(p.chain, dsInfo(p.chain, a), gtGet(p.chain, a));
      if (!L.site && !L.x) return false;
    }
    return true;
  });
}

const SORT_KEYS = {
  apy: (p) => p.apy,
  apy30: (p) => p.apy30,
  tvl: (p) => p.tvl,
  vol: (p) => p.vol1d,
  mc: (p) => mcOf(p, subjectIndex(p)),
  age: (p) => { const c = createdOf(p, subjectIndex(p)); return c ? Date.now() - c : null; },
};

function sortList(list) {
  const key = SORT_KEYS[F.sort] || SORT_KEYS.apy;
  return list
    .map((p) => [key(p), p])
    .sort((x, y) => {
      if (x[0] == null && y[0] == null) return 0;
      if (x[0] == null) return 1;
      if (y[0] == null) return -1;
      return (x[0] - y[0]) * F.dir;
    })
    .map((x) => x[1]);
}

// ---------- menus ----------

const pop = $('#pop');
let popAnchor = null;
let popBuild = null;
let popKind = '';

function openPop(anchor, kind, build) {
  if (popAnchor === anchor) { closePop(); return; }
  closePop();
  popAnchor = anchor;
  popBuild = build;
  popKind = kind;
  anchor.setAttribute('aria-expanded', 'true');
  pop.replaceChildren(build());
  pop.hidden = false;
  placePop();
  pop.querySelector('input[type="search"], .opt, input, button')?.focus({ preventScroll: true });
}
function refreshPop() {
  if (!popAnchor || !popBuild) return;
  pop.replaceChildren(popBuild());
  placePop();
}
function placePop() {
  const r = popAnchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const left = Math.min(r.left, vw - pop.offsetWidth - 12);
  pop.style.left = Math.max(12, left) + window.scrollX + 'px';
  pop.style.top = r.bottom + window.scrollY + 6 + 'px';
}
function closePop() {
  if (!popAnchor) return;
  popAnchor.setAttribute('aria-expanded', 'false');
  popAnchor = null;
  popBuild = null;
  popKind = '';
  pop.hidden = true;
  pop.replaceChildren();
}
document.addEventListener('mousedown', (e) => {
  if (popAnchor && !pop.contains(e.target) && !popAnchor.contains(e.target)) closePop();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && popAnchor) {
    const a = popAnchor;
    closePop();
    a.focus();
  }
});
window.addEventListener('resize', () => { if (popAnchor) placePop(); });

function optBtn(label, selected, onPick, note) {
  return h('button', { type: 'button', class: 'opt', 'aria-current': selected ? 'true' : null, onclick: onPick },
    h('span', { class: 'opt-check' }, selected ? icon('check') : null),
    h('span', { class: 'opt-label', text: label }),
    note ? h('span', { class: 'opt-note', text: note }) : null);
}
function checkOpt(label, checked, onToggle, sub) {
  const cb = h('input', { type: 'checkbox' });
  cb.checked = checked;
  cb.addEventListener('change', () => onToggle(cb.checked));
  return h('label', { class: 'opt' }, cb, h('span', { class: 'opt-label' }, label, sub ? h('span', { class: 'opt-sub', text: sub }) : null));
}
const pickAndClose = (fn) => () => { fn(); closePop(); changed(); };

function menuChain() {
  const counts = chainCounts();
  const list = h('div', { class: 'list' }, optBtn('All chains', F.chain === 'all', pickAndClose(() => { F.chain = 'all'; })));
  const soon = [];
  for (const c of TOP) {
    if (isSoon(c.name)) { if (!NO_DEX_POOLS.has(c.name)) soon.push(c.name); continue; }
    if (!counts.get(c.name)) continue;
    list.append(optBtn(c.name, F.chain === c.name, pickAndClose(() => { F.chain = c.name; })));
  }
  if (soon.length) {
    list.append(h('div', { class: 'sep' }), ...soon.map((name) => h('button', { type: 'button', class: 'opt', disabled: true },
      h('span', { class: 'opt-check' }), h('span', { class: 'opt-label', text: name }), h('span', { class: 'opt-note', text: 'Coming soon' }))));
  }
  return list;
}

let dexTimer;
function dexChanged() {
  F.dexOff = [...DEX_OFF];
  updateButtons();
  clearTimeout(dexTimer);
  dexTimer = setTimeout(() => changed(), 250);
}

function menuDex() {
  const dexes = visibleDexes();
  const search = h('input', { type: 'search', class: 'pop-input', placeholder: 'Find a DEX', 'aria-label': 'Find a DEX', autocomplete: 'off' });
  const list = h('div', { class: 'list' });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shownDexes = dexes.filter((d) => !q || d.name.toLowerCase().includes(q));
    list.replaceChildren(...shownDexes.map((d) => checkOpt(d.name, !DEX_OFF.has(d.key), (on) => {
      if (on) DEX_OFF.delete(d.key); else DEX_OFF.add(d.key);
      dexChanged();
    })));
    if (!shownDexes.length) list.append(h('p', { class: 'pop-hint', text: 'No DEX by that name.' }));
  };
  search.addEventListener('input', draw);
  const actions = h('div', { class: 'pop-actions' },
    h('button', { type: 'button', text: 'Select all', onclick: () => { DEX_OFF.clear(); dexChanged(); draw(); } }),
    h('button', { type: 'button', text: 'Clear', onclick: () => { DEX_OFF = allDexKeys(); dexChanged(); draw(); } }),
    h('button', { type: 'button', text: 'Uniswap only', onclick: () => {
      DEX_OFF = new Set([...allDexKeys()].filter((k) => !k.startsWith('uniswap v')));
      dexChanged();
      draw();
    } }));
  draw();
  return h('div', null, search, actions, h('div', { class: 'sep' }), list);
}

function menuApr() {
  const segBtn = (label, value) => h('button', {
    type: 'button', 'aria-pressed': F.basis === value ? 'true' : 'false', text: label,
    onclick: () => { F.basis = value; changed(); refreshPop(); },
  });
  const custom = h('input', { type: 'number', min: '0', step: '10', class: 'pop-input', value: String(F.minApr), 'aria-label': 'Custom minimum APR' });
  let t;
  custom.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const v = parseFloat(custom.value);
      F.minApr = Number.isFinite(v) && v >= 0 ? v : 0;
      changed();
    }, 400);
  });
  return h('div', null,
    h('div', { class: 'pop-label', text: 'Based on' }),
    h('div', { class: 'seg' }, segBtn('Last 24 hours', 'apy'), segBtn('30-day average', 'apy30')),
    h('div', { class: 'sep' }),
    h('div', { class: 'list' }, APR_PRESETS.map((v) => optBtn(v ? `At least ${fmtInt(v)}%` : 'Any APR', F.minApr === v, pickAndClose(() => { F.minApr = v; })))),
    h('div', { class: 'sep' }),
    h('label', { class: 'custom' }, 'Custom', custom, '%'));
}

function menuTvl() {
  return h('div', { class: 'list' }, TVL_PRESETS.map((v) => optBtn(v ? `At least ${fmtUsd(v)}` : 'Any TVL', F.minTvl === v, pickAndClose(() => { F.minTvl = v; }))));
}

function menuMc() {
  return h('div', { class: 'list' }, MC_PRESETS.map((v) => optBtn(v ? `Under ${fmtUsd(v)}` : 'Any market cap', F.maxMc === v, pickAndClose(() => { F.maxMc = v; }))));
}

function menuMore() {
  const toggle = (k) => (on) => { F[k] = on; changed(); };
  return h('div', { class: 'list' },
    checkOpt('Hide 24h spikes', F.hideSpikes, toggle('hideSpikes'), 'Last day earned 3× the 30-day average'),
    checkOpt('Hide tokens under 7 days old', F.hideNew, toggle('hideNew')),
    checkOpt('Only tokens with a website or X', F.needLinks, toggle('needLinks')));
}

function menuSort() {
  return h('div', { class: 'list' }, SORTS.map(([k, dir, label]) => optBtn(label, F.sort === k && F.dir === dir, () => {
    F.sort = k;
    F.dir = dir;
    closePop();
    changed(false);
    run();
  })));
}

function menuLink(href, ic, label) {
  return h('a', { class: 'opt', href, target: '_blank', rel: 'noopener noreferrer', onclick: () => closePop() },
    h('span', { class: 'opt-icon' }, icon(ic)), h('span', { class: 'opt-label', text: label }));
}

function menuRow(p, i) {
  const a = p.tokens[i];
  const cfg = chainCfg(p.chain);
  const enc = encodeURIComponent(a);
  const d = dsInfo(p.chain, a);
  const items = [
    menuLink(xSearch(a), 'search', 'Search contract on X'),
    menuLink(d?.url || `https://dexscreener.com/${cfg.ds}/${enc}`, 'chart', 'Chart on DexScreener'),
  ];
  if (cfg.uni && p.dexKey.startsWith('uniswap v') && a !== ZERO) {
    items.push(p.src === 'indexer'
      ? menuLink(`https://app.uniswap.org/explore/pools/${cfg.uni}/${p.pool}`, 'external', 'Pool on Uniswap')
      : menuLink(`https://app.uniswap.org/explore/tokens/${cfg.uni}/${enc}`, 'external', 'Token on Uniswap'));
  }
  if (p.src === 'llama') items.push(menuLink('https://defillama.com/yields/pool/' + encodeURIComponent(p.id), 'history', 'APR history on DefiLlama'));
  if (cfg.exp && a !== ZERO) items.push(menuLink(cfg.exp + enc, 'cube', 'Block explorer'));
  if (a !== ZERO) {
    const label = h('span', { class: 'opt-label', text: 'Copy contract address' });
    items.push(h('button', { type: 'button', class: 'opt', title: a, onclick: async () => {
      try { await navigator.clipboard.writeText(a); label.textContent = 'Copied'; } catch { label.textContent = a; return; }
      setTimeout(closePop, 700);
    } }, h('span', { class: 'opt-icon' }, icon('copy')), label));
  }
  if (REPORT_URL) {
    items.push(h('div', { class: 'sep' }), h('button', { type: 'button', class: 'opt', onclick: () => openReport(p, i) },
      h('span', { class: 'opt-icon' }, icon('flag')), h('span', { class: 'opt-label', text: 'Report a problem' })));
  }
  return h('div', { class: 'list' }, items);
}

// ---------- rendering ----------

function renderStatus(error) {
  const el = $('#status');
  const busy = !!(statusParts.load || statusParts.ds);
  $('#progress').hidden = !busy;
  if (error) {
    el.textContent = error;
    return;
  }
  el.textContent = [statusParts.load, statusParts.ds, statusParts.indexed, statusParts.info].filter(Boolean).join(' · ');
}

function updateFresh() {
  const t = new Date(llamaAt || Date.now());
  $('#fresh').textContent = 'Updated ' + t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function setBtn(id, value, on) {
  $('#v-' + id).textContent = value;
  $('#f-' + id).classList.toggle('on', !!on);
}

function updateButtons() {
  setBtn('chain', F.chain === 'all' ? 'All' : F.chain, F.chain !== 'all');
  const dexes = visibleDexes();
  const onCount = dexes.filter((d) => !DEX_OFF.has(d.key)).length;
  const dexLabel = onCount === dexes.length ? 'All'
    : onCount === 1 ? dexes.find((d) => !DEX_OFF.has(d.key)).name
    : `${onCount} of ${dexes.length}`;
  setBtn('dex', dexLabel, onCount !== dexes.length);
  setBtn('apr', (F.minApr ? `≥ ${fmtInt(F.minApr)}%` : 'Any') + (F.basis === 'apy30' ? ' · 30d' : ''),
    F.minApr !== DEFAULTS.minApr || F.basis !== DEFAULTS.basis);
  setBtn('tvl', F.minTvl ? `≥ ${fmtUsd(F.minTvl)}` : 'Any', F.minTvl !== DEFAULTS.minTvl);
  setBtn('mc', F.maxMc ? `< ${fmtUsd(F.maxMc)}` : 'Any', !!F.maxMc);
  const extras = [F.hideSpikes, F.hideNew, F.needLinks].filter(Boolean).length;
  setBtn('more', extras ? String(extras) : '', extras > 0);
  const sort = SORTS.find(([k, dir]) => k === F.sort && dir === F.dir);
  $('#v-sort').textContent = sort ? sort[2] : 'Custom';
  $('#reset').hidden = !(F.chain !== 'all' || DEX_OFF.size || F.minApr !== DEFAULTS.minApr || F.basis !== DEFAULTS.basis
    || F.minTvl !== DEFAULTS.minTvl || F.maxMc || extras || F.q.trim());
}

function renderCount(s1, n) {
  const where = F.chain === 'all' ? [...ENABLED].join(', ').replace(/, ([^,]*)$/, ' and $1') : F.chain;
  $('#count').replaceChildren(
    h('b', { text: fmtInt(n) }), n === 1 ? ' pool' : ' pools',
    h('span', { class: 'of', text: ` out of ${fmtInt(s1.scanned)} on ${where}` }));
}

function letterLogo(sym) {
  return h('div', { class: 'logo', 'aria-hidden': 'true', text: (sym || '?').replace(/^\$/, '').charAt(0).toUpperCase() || '?' });
}

const tag = (kind, text, title) => h('span', { class: 'tag' + (kind ? ' ' + kind : ''), title, text });

function tagsEl(p, i, looked, L) {
  const out = [];
  if (isSpike(p)) {
    const x = Math.round(p.apy / p.apy30);
    out.push(tag('warn', `Spike ×${x}`, `The last 24 hours earned ${x}× the 30-day average. This APR probably won't last.`));
  }
  const created = createdOf(p, i);
  if (created) {
    const days = (Date.now() - created) / DAY;
    if (days < 14) out.push(tag(days < 3 ? 'bad' : 'warn', `New · ${fmtAge(created)}`, `The token's main pool was created ${fmtAge(created)} ago.`));
  }
  if (p.fee != null && p.fee >= 2) out.push(tag('warn', 'High fee', `This pool charges ${fmtFee(p.fee)} per swap, so a few trades inflate the APR.`));
  const s0 = symOf(p, 0);
  const s1 = symOf(p, 1);
  if (s0 && s0.toUpperCase() === s1.toUpperCase()) {
    out.push(tag('bad', `Two ${s0.toUpperCase()}s`, `Both tokens in this pool are called ${s0}. At least one of them is a copy.`));
  } else {
    for (let j = 0; j < 2; j++) {
      const sym = symOf(p, j);
      if (isCopycat(p.chain, p.tokens[j], sym)) {
        out.push(tag('bad', `Unofficial ${sym.toUpperCase()}`, `This token is called ${sym} but isn't the official ${sym} contract on ${p.chain}.`));
      }
    }
  }
  if (isMajorPair(p)) out.push(tag('', 'Major pair', 'Both sides are major tokens, so a very high APR is unusual.'));
  if (looked && L.gtDone && !L.site && !L.x) out.push(tag('warn', 'No website or X', 'Neither DexScreener nor GeckoTerminal lists a website or X account.'));
  return out.length ? h('div', { class: 'tags' }, out) : null;
}

function iconLink(href, ic, label) {
  if (!href) return h('span', { class: 'ib off', title: label, 'aria-hidden': 'true' }, icon(ic));
  return h('a', { class: 'ib', href, target: '_blank', rel: 'noopener noreferrer', title: label, 'aria-label': label }, icon(ic));
}

function linksEl(p, i, looked, L) {
  const a = p.tokens[i];
  const sym = symOf(p, i).replace(/^\$/, '');
  const pending = !looked || !L.gtDone;
  const more = h('button', { type: 'button', class: 'ib', title: 'More links', 'aria-label': 'More links', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, icon('more'));
  more.addEventListener('click', () => openPop(more, 'row', () => menuRow(p, i)));
  return h('div', { class: 'lk' },
    iconLink(L.site, 'globe', L.site ? 'Website: ' + hostOf(L.site) : pending ? 'Looking for a website' : 'No website listed'),
    iconLink(L.x, 'x', L.x ? 'X: ' + xHandle(L.x) : pending ? 'Looking for an X account' : 'No X account listed'),
    iconLink(L.tg, 'telegram', L.tg ? 'Telegram' : pending ? 'Looking for Telegram' : 'No Telegram listed'),
    iconLink(xSearch(sym ? '$' + sym : a), 'search', sym ? `Search $${sym} on X` : 'Search contract on X'),
    more);
}

function num(label, value, cls, title) {
  return h('div', { class: 'num' + (cls ? ' ' + cls : ''), 'data-label': label, text: value, title });
}

function rowEl(p) {
  const i = subjectIndex(p);
  const a = p.tokens[i];
  // Major tokens are never looked up, so don't leave them waiting.
  const major = quoteAt(p, i);
  const looked = major || !!dsGet(p.chain, a);
  const d = dsInfo(p.chain, a);
  const g = gtGet(p.chain, a);
  const L = tokenLinks(p.chain, d, g);
  if (major) L.gtDone = true;
  const fullSym = symOf(p, i) || shortAddr(a);
  // Spam tokens sometimes use hundreds of tickers as a name; show the start and keep the rest in the tooltip.
  const sym = fullSym.length > 24 ? fullSym.slice(0, 22) + '…' : fullSym;
  const rawName = d?.name || p.names?.[i] || '';
  const name = rawName && rawName.toLowerCase() !== sym.toLowerCase() ? rawName : '';
  const pair = p.syms[0] && p.syms[1] ? p.syms.join(' / ') : p.symbol;
  const meta = [pair, p.fee != null ? fmtFee(p.fee) : null, p.dexName, p.chain].filter(Boolean).join(' · ');
  // https only: a plain-http logo would load insecurely and leak visitors' IPs over an unencrypted connection.
  const img = [d?.img, g?.img, p.imgs?.[i]].find((u) => u && u.startsWith('https:'));
  let logo = letterLogo(sym);
  if (img) {
    logo = h('img', { class: 'logo', src: img, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    logo.addEventListener('error', () => logo.replaceWith(letterLogo(sym)), { once: true });
  }
  const mc = mcOf(p, i);
  const created = createdOf(p, i);
  const wait = (v) => v == null && !looked;
  return h('div', { class: 'row' },
    h('div', { class: 'tok' }, logo,
      h('div', { class: 'tok-txt' },
        h('div', { class: 't1' }, h('span', { class: 'sym', text: sym, title: fullSym !== sym ? fullSym : null }), name ? h('span', { class: 'name', text: name, title: name }) : null),
        h('div', { class: 't2', text: meta, title: meta }),
        tagsEl(p, i, looked, L))),
    num('APR 24h', fmtPct(p.apy), 'hot'),
    num('APR 30d', fmtPct(p.apy30), 'dim', p.src === 'indexer' ? 'No 30-day history for Uniswap pools yet' : null),
    num('TVL', fmtUsd(p.tvl)),
    num('Volume 24h', fmtUsd(p.vol1d)),
    num('Market cap', wait(mc) ? '…' : fmtUsd(mc), wait(mc) ? 'wait' : ''),
    num('Age', wait(created) ? '…' : fmtAge(created), wait(created) ? 'wait' : ''),
    linksEl(p, i, looked || p.src === 'indexer', L));
}

function renderRows(s1, pending) {
  const final = sortList(stage2(s1.list));
  renderCount(s1, final.length);
  if (popKind === 'row') closePop();
  for (let j = gtJobs.length - 1; j >= 0; j--) if (gtJobs[j].kind === 'info') gtJobs.splice(j, 1);
  rowIndex.clear();
  const rows = final.slice(0, shown).map((p) => {
    const el = rowEl(p);
    const a = p.tokens[subjectIndex(p)];
    const net = chainCfg(p.chain).gt;
    if (net) {
      const k = net + ':' + a;
      if (!rowIndex.has(k)) rowIndex.set(k, []);
      rowIndex.get(k).push({ p, el });
      if (!pending && (dsGet(p.chain, a) || p.src === 'indexer') && !GT.has(k)) {
        const L = tokenLinks(p.chain, dsInfo(p.chain, a), null);
        if (!L.site && !L.x) wantGt(p.chain, a);
      }
    }
    return el;
  });
  const box = $('#rows');
  if (rows.length) {
    box.replaceChildren(...rows);
  } else {
    let text = 'No pools match these filters. Try a lower APR or TVL, or a wider market cap.';
    if (!POOLS.length) text = 'Loading pools…';
    else if (pending && extraFilters()) text = 'Loading market caps…';
    else if (F.q.trim()) text = 'No pools match that search with these filters.';
    box.replaceChildren(h('p', { class: 'empty', text }));
  }
  const more = $('#more');
  more.hidden = final.length <= shown;
  more.textContent = `Show ${Math.min(PAGE, Math.max(0, final.length - shown))} more`;
  syncSortUi();
}

function syncSortUi() {
  document.querySelectorAll('.sorter').forEach((b) => {
    if (b.dataset.sort === F.sort) b.setAttribute('aria-sort', F.dir < 0 ? 'descending' : 'ascending');
    else b.removeAttribute('aria-sort');
  });
  updateButtons();
}

async function run() {
  const gen = ++GEN;
  const s1 = stage1();
  lastS1 = s1;
  const need = [];
  const seen = new Set();
  // Rows on screen first, in the order they're shown, then everything else by APR.
  for (const p of [...sortList(s1.list).slice(0, shown), ...s1.list]) {
    for (let i = 0; i < 2; i++) {
      const a = p.tokens[i];
      if (quoteAt(p, i)) continue;
      const k = p.chain + ':' + a;
      if (seen.has(k)) continue;
      seen.add(k);
      need.push([p.chain, a]);
    }
  }
  renderRows(s1, true);
  await enrich(need.slice(0, ENRICH_CAP), gen);
  if (gen !== GEN) return;
  statusParts.ds = '';
  // Only worth mentioning when the missing market caps change what's shown.
  const missing = need.filter(([chain, a]) => !dsGet(chain, a)).length;
  statusParts.info = missing && (F.maxMc || F.sort === 'mc') ? `${fmtInt(missing)} tokens have no market cap yet` : '';
  renderStatus();
  renderRows(s1, false);
}

let runTimer;
function scheduleRun() {
  clearTimeout(runTimer);
  runTimer = setTimeout(run, 300);
}

// ---------- problem reports ----------

const reportDlg = $('#report');
let reportPool = null; // [pool, token index] when the report was opened from a row's menu

// What the page was showing, so a report can be acted on without a round of questions.
function reportContext() {
  const lines = ['Page: ' + location.href];
  if (reportPool) {
    const [p, i] = reportPool;
    lines.push(
      `Pool: ${p.symbol} · ${p.dexName} on ${p.chain} (${p.src === 'indexer' ? 'indexer' : 'DefiLlama'})`,
      'Pool id: ' + (p.pool || p.id),
      'Token: ' + p.tokens[i],
      `Shown: APR 24h ${fmtPct(p.apy)}, APR 30d ${fmtPct(p.apy30)}, TVL ${fmtUsd(p.tvl)}, volume ${fmtUsd(p.vol1d)}, market cap ${fmtUsd(mcOf(p, i))}, fee ${p.fee != null ? fmtFee(p.fee) : 'unknown'}`);
  }
  lines.push(
    'Filters: ' + JSON.stringify({ ...F, dexOff: [...DEX_OFF] }),
    'Showing: ' + $('#count').textContent,
    'Status: ' + ($('#status').textContent || 'none'));
  for (const [chain, c] of Object.entries(indexedByChain)) {
    lines.push(`${chain}: ${fmtInt(c.pools.length)} pools, updated ${c.updatedAt ? new Date(c.updatedAt).toISOString() : 'never'}`);
  }
  lines.push(
    'DefiLlama: ' + (llamaAt ? `${fmtInt(LLAMA.length)} pools, loaded ${new Date(llamaAt).toISOString()}` : 'not loaded'),
    'Sent: ' + new Date().toISOString(),
    `Window: ${window.innerWidth}×${window.innerHeight}`,
    'Browser: ' + navigator.userAgent);
  return lines.join('\n');
}

function reportError(text) {
  const el = $('#report-error');
  el.textContent = text || '';
  el.hidden = !text;
}

function openReport(p, i) {
  closePop();
  reportPool = p ? [p, i] : null;
  const about = $('#report-about');
  about.hidden = !p;
  if (p) about.textContent = 'About ' + [symOf(p, i) || shortAddr(p.tokens[i]), p.dexName, p.chain].join(' · ');
  $('#report-form').hidden = false;
  $('#report-done').hidden = true;
  reportError('');
  reportDlg.showModal();
  $('#report-text').focus();
}

async function sendReport() {
  const text = $('#report-text');
  const email = $('#report-email');
  const send = $('#report-send');
  if (!text.value.trim()) { reportError('Describe the problem before sending.'); text.focus(); return; }
  if (email.value.trim() && !email.checkValidity()) { reportError("That email address doesn't look right."); email.focus(); return; }
  reportError('');
  send.disabled = true;
  send.textContent = 'Sending…';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20e3);
  try {
    const pool = reportPool ? [reportPool[0].symbol, reportPool[0].dexName, reportPool[0].chain].join(' · ') : '';
    const r = await fetch(REPORT_URL, {
      method: 'POST',
      // JSON sent as plain text: a JSON content type makes the browser ask permission first, with a request
      // Apps Script can't answer.
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ message: text.value, email: email.value.trim(), pool, context: reportContext(), website: $('#report-website').value }),
      signal: ctl.signal,
    });
    const j = await r.json().catch(() => null);
    // Apps Script answers 200 either way. The script's own refusals (too many reports, a bad address) say what
    // to do; anything else is a failure to send.
    if (!j?.ok) throw new Error(j?.error || '');
    text.value = '';
    $('#report-form').hidden = true;
    $('#report-done').hidden = false;
    $('#report-ok').focus();
  } catch (e) {
    reportError(e.name !== 'AbortError' && e.name !== 'TypeError' && e.message
      ? e.message : "The report couldn't be sent. Check your connection and try again.");
  } finally {
    clearTimeout(timer);
    send.disabled = false;
    send.textContent = 'Send report';
  }
}

function bindReport() {
  if (!REPORT_URL) return;
  const open = $('#report-open');
  open.hidden = false;
  open.addEventListener('click', () => openReport());
  $('#report-form').addEventListener('submit', (e) => { e.preventDefault(); sendReport(); });
  for (const id of ['#report-cancel', '#report-ok']) $(id).addEventListener('click', () => reportDlg.close());
  // A click on the dimmed area around the dialog closes it. What was typed stays for next time.
  reportDlg.addEventListener('mousedown', (e) => {
    const r = reportDlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) reportDlg.close();
  });
}

// ---------- controls ----------

let saveTimer;
function changed(rerun = true) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set('ys:filters:v3', { ...F, dexOff: [...DEX_OFF] }), 300);
  shown = PAGE;
  updateButtons();
  if (rerun) run();
}

function bindControls() {
  const q = $('#q');
  q.value = F.q;
  let qTimer;
  q.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { F.q = q.value; changed(); }, 250);
  });
  const menus = { chain: menuChain, dex: menuDex, apr: menuApr, tvl: menuTvl, mc: menuMc, more: menuMore, sort: menuSort };
  for (const [kind, build] of Object.entries(menus)) {
    const btn = $('#f-' + kind);
    btn.addEventListener('click', () => openPop(btn, kind, build));
  }
  document.querySelectorAll('.sorter').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.sort;
    if (F.sort === k) F.dir = -F.dir;
    else { F.sort = k; F.dir = k === 'age' || k === 'mc' ? 1 : -1; }
    changed(false);
    run();
  }));
  $('#more').addEventListener('click', () => {
    shown += PAGE;
    run();
  });
  $('#reset').addEventListener('click', () => {
    F = { ...DEFAULTS, sort: F.sort, dir: F.dir, dexOff: [] };
    DEX_OFF = new Set();
    q.value = '';
    closePop();
    changed();
  });
  $('#refresh').addEventListener('click', () => start(true));
}

async function start(force) {
  const btn = $('#refresh');
  btn.disabled = true;
  await loadChains(force);
  const indexed = loadIndexed();
  try {
    await loadLlama(force);
  } catch (e) {
    statusParts.load = '';
    renderStatus(`Couldn't load pools from DefiLlama (${e.message}). Check your connection and press Refresh.`);
  }
  await indexed;
  btn.disabled = false;
  updateFresh();
  assemblePools();
  run();
}

bindControls();
bindReport();
updateButtons();
start(false);
// The indexer rewrites its file every few minutes; pick up new Robinhood numbers without a reload.
setInterval(async () => {
  const before = indexedAt;
  await loadIndexed();
  if (indexedAt !== before) { assemblePools(); scheduleRun(); }
}, INDEX_POLL);
