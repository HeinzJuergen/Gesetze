# Gesetze — Scraper

Scrapt die Gesetzbücher von gta5grand.com und committet Änderungen auf den `main`-Branch, sodass die Git-History als Changelog dient.

## Stack

- **Bun** — Runtime + Scraper-Logik
- **cheerio** — HTML-Parsing
- **curl_cffi** (Python) — Cloudflare-Bypass via Chrome TLS-Impersonation
- **git worktree** — `out/` ist der `main`-Branch

## Setup

```powershell
bun install
pip install curl_cffi
git worktree add out main
```

## Verwendung

```powershell
bun index.ts
```

Scrapet alle konfigurierten Threads, schreibt Markdown nach `out/` und committet auf `main` — nur bei inhaltlichen Änderungen.

## Threads konfigurieren

`config.json`:

```json
{
  "threads": {
    "Strafgesetzbuch - StGB": "https://gta5grand.com/forum/threads/101447/"
  }
}
```

Key = Dateiname (`Strafgesetzbuch - StGB.md`).

## CI

GitHub Action (`.github/workflows/scrape.yml`) läuft täglich um 6 Uhr und ist manuell triggerbar. Commits auf `main` laufen unter `github-actions[bot]`.
