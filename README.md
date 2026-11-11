# apish

The command line for [API.SH](https://api.sh/?utm_source=github&utm_medium=readme). API.SH turns public web pages from around
1,000 websites into clean JSON: search engines, social media, e-commerce, real estate, jobs, travel, news and
sports (Google, Amazon, TikTok, Zillow, LinkedIn and more). `apish` runs any endpoint from your terminal and
writes JSON, CSV or NDJSON.

```sh
npm install -g @api.sh/cli
apish login                                   # paste a key from https://app.api.sh/keys
apish zillow search --location "Austin, TX" -o csv --out austin.csv
```

Every account gets free monthly credits ([sign up](https://app.api.sh/signup?utm_source=github&utm_medium=readme)).
Failed calls are free. There are no rate limits.

## Run an endpoint

`apish <platform> <endpoint> --param value ...`

```sh
apish tiktok profile --username nasa --no-raw
apish zillow search --location 78704 --status for_rent --beds 2
apish google search --q "best running shoes" --country us --fields results.title,results.url
apish github repository issues --url https://github.com/nodejs/node
apish youtube transcript --url "https://www.youtube.com/watch?v=aircAruvnKk" -o ndjson
```

Parameters are written as on the [docs](https://api.sh/docs?utm_source=github&utm_medium=readme) page
(`--min_price`); `--min-price` works too. A misspelled parameter is caught before the call is sent.

To see an endpoint's parameters, read them from the live catalog:

```sh
apish zillow search --help
apish help tiktok                  # every TikTok endpoint
```

## Any route

`apish call` runs a route exactly as written in the docs, with `name=value` pairs or a full URL:

```sh
apish call /zillow/v1/search location="Austin, TX"
apish call "https://api.api.sh/hackernews/v1/item?id=8863"
```

## Find endpoints

```sh
apish search youtube transcript    # best matches first, from the live catalog
apish list                         # every platform
apish list reddit                  # one platform's endpoints and prices
```

The catalog (free, no key needed) is cached for an hour and each platform's parameter list for a day. When you are
offline, the last cached copy is used.

## Output

| Option | What it does |
| --- | --- |
| `-o, --output json\|csv\|ndjson` | JSON (default, pretty-printed) or the response's records as CSV / NDJSON |
| `--out <file>` | Write to a file instead of stdout |
| `--all-pages` | Follow the endpoint's next-page field until the last page (one call per page) |
| `--page-limit <n>` | Stop `--all-pages` after `n` pages (default 100) |
| `--no-raw` | Leave out the bulky `raw` source blocks (often 10-30x smaller) |
| `--fields a,b.c` | Only these fields |
| `--fresh` | Skip the 24-hour cache |
| `--records <key>` | With CSV/NDJSON: which list becomes the rows (`.` for the whole object as one row) |
| `-q, --quiet` | No credits line on stderr |

Data goes to stdout; the credits line and messages go to stderr, so pipes stay clean:

```sh
apish reddit subreddit --subreddit python --all-pages --page-limit 5 -o csv > python.csv
apish tiktok profile --username nasa --no-raw | jq '.followers'
```

With `--all-pages`, JSON output is an array of pages; CSV and NDJSON join the rows of every page.

## API key

The key is read from, in order: `--api-key`, the `APISH_API_KEY` environment variable, then the key saved by
`apish login`. `apish login` checks the key (free) and saves it in your config directory with owner-only
permissions:

- Linux and macOS: `~/.config/apish/config.json` (or `$XDG_CONFIG_HOME/apish`)
- Windows: `%APPDATA%\apish\config.json`

`apish login` also reads a key from stdin (`echo "$KEY" | apish login`). `apish logout` removes it.
In CI, set `APISH_API_KEY` from a secret instead.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected error |
| 2 | Bad usage or input (unknown parameter, missing value, HTTP 400) |
| 3 | No API key, or the key is invalid (HTTP 401) |
| 4 | Not enough credits, or a spend limit you set was reached (HTTP 402) |
| 5 | Not found: unknown platform or endpoint, or HTTP 404 |
| 6 | The source site failed (HTTP 502/503/504, already retried). Failed calls are free |
| 7 | Network error or timeout |

Errors print the API's message and the request id, which support can look up.

## Use from scripts

```sh
if ! apish zillow property --url "$URL" -q --out home.json; then
  case $? in
    4) echo "Out of credits" ;;
    6) echo "Zillow did not answer, try later" ;;
  esac
fi
```

The CLI is built on the official SDK, [`@api.sh/sdk`](https://www.npmjs.com/package/@api.sh/sdk). Use the SDK
directly from Node.js code. Python: [`apish-sdk`](https://pypi.org/project/apish-sdk/).

## Links

- Docs: https://api.sh/docs?utm_source=github&utm_medium=readme
- Status: https://status.api.sh
- MCP server for AI clients: https://api.sh/mcp?utm_source=github&utm_medium=readme

## Development

```sh
npm install
npm test                                     # offline tests with a mocked API
APISH_API_KEY=... npm run test:live          # one real call (costs one call's credits)
```

## License

MIT
