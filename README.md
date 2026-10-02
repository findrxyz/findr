# findr

**Discover tokens early.** findr watches Uniswap pools on Ethereum, Base and Robinhood Chain and surfaces the ones
trading far beyond their size, often the first public sign a token is catching on. Each token gets one-click links
to its website, X, Telegram and an X search, so you can check it before you buy.

**Live:** https://findrxyz.github.io/findr/

> Nothing here is financial advice. Most early tokens go to zero, trading volume can be faked, and the website and
> social links are set by token creators. Do your own research.

## How it works

**The signal.** Pools are ranked by fee APR: the trading fees a pool earned in the last 24 hours, annualized against
its liquidity. A high APR on a small pool means heavy trading relative to its size, which tends to show up before a
token is talked about on X or listed by the big trackers. Token reward emissions aren't counted.

**The data.**

- **Uniswap v2, v3 and v4 pools** come from `indexer/uniswap.mjs`. It reads swap events from each chain to find
  pools that traded in the last 24 hours, checks v2/v3 pools against Uniswap's factories, takes TVL, volume, market
  cap and links from [DexScreener](https://dexscreener.com), and reads the fee liquidity providers keep from
  Uniswap's contracts. APR = 24h volume × LP fee ÷ TVL, which matches Uniswap's own numbers.
- **Other DEXes** on Ethereum and Base (Aerodrome, Curve and so on) come from [DefiLlama](https://defillama.com).
- **Missing links** are filled in from [GeckoTerminal](https://www.geckoterminal.com).

**The flags.** Rows are tagged when a token is under two weeks old, when today's trading is a spike against the
30-day average, when the pool charges a high fee, when a token borrows a major stablecoin's name, or when it lists no
website or X.

**Updates.** A GitHub Actions workflow runs the indexer about every 15 minutes and publishes the page with fresh data
to GitHub Pages.

## Run it locally

Needs Node 18+ and Python 3. No API keys.

```
npm run serve      # the page at http://127.0.0.1:8765
npm run indexer    # writes data/<chain>.json every few minutes
```

The first indexer pass looks back 24 hours on Ethereum and Base, so it takes several minutes. The indexer uses free
public RPCs; set `ALCHEMY_API_KEY` in the environment (or in a git-ignored `.env`, see `.env.example`) to add Alchemy
as a backup endpoint.

## Deploy your own copy

1. Fork the repo and enable Actions on the fork.
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Optional: add an `ALCHEMY_API_KEY` secret (repository or `github-pages` environment). It's only used when the
   public RPCs fail.
4. Actions → **Update pool data** → Run workflow. The first run takes about 20 minutes; after that each run queues
   the next one about 15 minutes later. Cancel a run to stop the chain; the cron schedule is a backup.

Deploys use the short-lived token GitHub gives each run, so no deploy secret is needed.

## Project layout

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `styles.css` | The page. Plain HTML, CSS and JavaScript, no build step. |
| `indexer/uniswap.mjs` | The indexer. Node, no dependencies. |
| `.github/workflows/update-data.yml` | Runs the indexer and deploys to GitHub Pages. |
| `serve.py` | Local server that disables caching and refuses `.env` and `indexer/`. |

## Security

- Token names, logos and links come from token creators. The page inserts them as text, allows only http(s) links and
  https logos, and a Content-Security-Policy limits scripts to the site itself.
- Workflow actions are pinned to commit SHAs. The workflow runs only on its schedule, manually or when a run queues the
  next one, never on pull requests, so forks can't reach its secrets.

Found a security problem? Please report it privately through the repository's **Security** tab rather than opening a
public issue.

## Privacy

The page counts visits with [GoatCounter](https://www.goatcounter.com), without cookies or personal data. Your browser
also loads data directly from DefiLlama, DexScreener and GeckoTerminal, fonts from Google Fonts, and token logos from
their hosts. There are no accounts and no wallet connection.

## License

[MIT](LICENSE)
