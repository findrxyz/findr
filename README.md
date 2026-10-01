# findr

Token finder: high-APR DEX pools on Ethereum, Base and Robinhood Chain, with one-click links to each token's
website and X so you can check it before depositing. (The page itself is titled "Yield Sieve".)

- **Uniswap pools** (v2, v3, v4) come from `indexer/uniswap.mjs`. It reads swaps straight from each chain to find
  pools that traded in the last 24 hours, takes TVL, volume, market cap and links from DexScreener, and reads the
  fee liquidity providers keep from Uniswap's contracts. APR = 24h volume × LP fee ÷ TVL, as on Uniswap.
- **Other DEXes** on Ethereum and Base come from DefiLlama, loaded in the browser.

The page is plain HTML, CSS and JavaScript with no build step.

## Run locally

```
npm run serve      # the page at http://127.0.0.1:8765
npm run indexer    # writes data/<chain>.json every few minutes
```

No keys are needed: the indexer uses free public RPCs. The first pass looks back 24 hours on Ethereum and Base, so
it takes several minutes.

## Deploy (GitHub Actions → GitHub Pages)

`.github/workflows/update-data.yml` runs one indexer pass every 15 minutes and publishes the page with fresh data to
GitHub Pages. Deploys use the short-lived token GitHub gives each run, scoped to this repo, so no deploy secret is
stored. The site is at `https://<owner>.github.io/findr/`.

1. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
2. Optional: add an `ALCHEMY_API_KEY` repository secret (Settings → Secrets and variables → Actions). It's used only
   as a backup when the public RPCs fail.
3. Run **Update pool data** once from the Actions tab. The first run takes about 20 minutes; later runs take a few.

GitHub pauses scheduled workflows in public repos after 60 days without repository activity; re-enable it from the
Actions tab if that happens.

## Security notes

- Token names, logos and links come from token creators. The page inserts them as text, allows only http(s) links
  and https logos, and a Content-Security-Policy limits scripts to the site itself.
- Workflow actions are pinned to commit SHAs. The workflow runs only on a schedule or manually, never on pull
  requests, so forks can't reach its secrets.
- The page re-checks data with conditional requests, so an unchanged file costs a few hundred bytes, not megabytes.
