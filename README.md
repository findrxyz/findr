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

## Deploy (GitHub Actions → Netlify)

`.github/workflows/update-data.yml` runs one indexer pass every 15 minutes and deploys the page with fresh data to
Netlify. Netlify doesn't build anything itself.

1. Create a Netlify site that isn't linked to this repo (for example, deploy the folder once by hand). If it's linked,
   Netlify's own builds would publish the page without data. Copy its **Site ID** from Site configuration → Site
   details.
2. Create a Netlify personal access token under User settings → Applications.
3. Add repository secrets (Settings → Secrets and variables → Actions):
   - `NETLIFY_AUTH_TOKEN`: the token
   - `NETLIFY_SITE_ID`: the site ID
   - `ALCHEMY_API_KEY` (optional): used only as a backup when the public RPCs fail
4. Run the workflow once from the Actions tab. The first run takes about 20 minutes; later runs take a few.

GitHub pauses scheduled workflows in public repos after 60 days without repository activity; re-enable it from the
Actions tab if that happens.
