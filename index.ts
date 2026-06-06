#!/usr/bin/env bun
import * as cheerio from "cheerio";
import type { CheerioAPI, Cheerio, Element } from "cheerio";
import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const c = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  blue:   "\x1b[34m",
  cyan:   "\x1b[36m",
  red:    "\x1b[31m",
  gray:   "\x1b[90m",
};
const fmt = {
  header:  (s: string) => `${c.bold}${c.cyan}${s}${c.reset}`,
  changed: (s: string) => `${c.green}${s}${c.reset}`,
  same:    (s: string) => `${c.gray}${s}${c.reset}`,
  warn:    (s: string) => `${c.yellow}${s}${c.reset}`,
  error:   (s: string) => `${c.red}${s}${c.reset}`,
  ok:      (s: string) => `${c.bold}${c.green}${s}${c.reset}`,
  label:   (s: string) => `${c.dim}${s}${c.reset}`,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ThreadConfig {
  url: string;
  exportTable?: boolean;
  tableSchema?: Record<string, string>; // forum header → stable field name
}

interface Config {
  threads: Record<string, ThreadConfig>;
}

function validateConfig(raw: unknown): Config {
  if (!raw || typeof raw !== "object") throw new Error("config.json: kein Objekt");
  const c = raw as Record<string, unknown>;
  if (!c.threads || typeof c.threads !== "object") throw new Error("config.json: 'threads' fehlt");

  for (const [name, entry] of Object.entries(c.threads as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") throw new Error(`Thread '${name}': kein Objekt`);
    const t = entry as Record<string, unknown>;
    if (typeof t.url !== "string" || !t.url.startsWith("http"))
      throw new Error(`Thread '${name}': ungültige URL`);
    if (t.exportTable && !t.tableSchema)
      throw new Error(`Thread '${name}': exportTable=true benötigt tableSchema`);
  }

  return raw as Config;
}

const REPO_DIR = import.meta.dir;
const OUTPUT_DIR = join(REPO_DIR, "out");
const isCI = !!process.env.CI;
const doCommit = isCI || Bun.argv.includes("--commit");

const config = validateConfig(await Bun.file(join(REPO_DIR, "config.json")).json());

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchThread(url: string, attempt = 1): Promise<string | null> {
  const script = `
import sys
from curl_cffi import requests
r = requests.get(sys.argv[1], impersonate="chrome", timeout=30)
if r.status_code != 200:
    print(f"STATUS:{r.status_code}", file=sys.stderr)
    sys.exit(1)
sys.stdout.buffer.write(r.content)
`.trim();

  const proc = Bun.spawn(["python", "-c", script, url], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    if (attempt < 3) {
      console.warn(fmt.warn(`  Versuch ${attempt} fehlgeschlagen, retry...`));
      await Bun.sleep(2000 * attempt);
      return fetchThread(url, attempt + 1);
    }
    console.error(fmt.error(`  FEHLER: ${stderr.trim()}`));
    return null;
  }

  const html = new TextDecoder("utf-8").decode(stdout);
  if (html.includes('name="login"')) {
    console.error("  FEHLER: Login-Seite — Cookie erforderlich.");
    return null;
  }
  return html;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

interface Post {
  author: string;
  date: string;
  content: string;
}

const ZWSP = /[​‌‍﻿]/g;
const cleanup = (s: string) => s.replace(ZWSP, "").trim();

function htmlToMarkdown($: CheerioAPI, el: Cheerio<Element>): string {
  el.find("[style]").removeAttr("style");

  // Verschachtelte Tabellen vorher zu Text flatten
  el.find("table table").each((_, t) => { $(t).replaceWith($(t).text()); });

  // Tabellen → Markdown
  el.find("table").each((_, table) => {
    const rows = $(table).find("tr").toArray();
    if (!rows.length) return;

    const toRow = (cells: Cheerio<Element>) =>
      "| " + cells.toArray().map((c) => cleanup($(c).text()).replace(/\|/g, "\\|")).join(" | ") + " |";

    const lines: string[] = [];
    rows.forEach((row, i) => {
      const cells = $(row).find("td, th");
      lines.push(toRow(cells));
      if (i === 0) lines.push("| " + cells.toArray().map(() => "---").join(" | ") + " |");
    });

    $(table).replaceWith("\n" + lines.join("\n") + "\n");
  });

  // bbCodeBlock--expandable → Abschnittsüberschrift
  el.find("blockquote.bbCodeBlock--expandable").each((_, bq) => {
    const $bq = $(bq);
    const heading = $bq
      .find(".bbCodeBlock-expandContent h1,.bbCodeBlock-expandContent h2,.bbCodeBlock-expandContent h3,.bbCodeBlock-expandContent h4")
      .first();
    const text = cleanup(heading.text());
    $bq.replaceWith(text ? `<h3-marker>${text}</h3-marker>` : "");
  });

  el.find("blockquote").remove();
  el.find("img").remove();

  el.find("b, strong").each((_, e) => {
    const t = $(e).text();
    if (t.trim()) $(e).replaceWith(`**${t}**`);
  });
  el.find("i, em").each((_, e) => {
    const t = $(e).text();
    if (t.trim()) $(e).replaceWith(`*${t}*`);
  });

  el.find("a").each((_, e) => { $(e).replaceWith($(e).text()); });
  el.find("li").each((_, e) => { $(e).replaceWith(`\n- ${$(e).text().trim()}`); });
  el.find("ul, ol").each((_, e) => { $(e).replaceWith($(e).text() + "\n"); });

  el.find("h1").each((_, e) => { $(e).replaceWith(`\n# ${cleanup($(e).text())}\n`); });
  el.find("h2").each((_, e) => { $(e).replaceWith(`\n## ${cleanup($(e).text())}\n`); });
  el.find("h3").each((_, e) => { $(e).replaceWith(`\n### ${cleanup($(e).text())}\n`); });
  el.find("h4, h5").each((_, e) => { $(e).replaceWith(`\n#### ${cleanup($(e).text())}\n`); });
  el.find("h3-marker").each((_, e) => { $(e).replaceWith(`\n### ${cleanup($(e).text())}\n`); });

  el.find("br").replaceWith("\n");
  el.find("p, div").each((_, e) => {
    const text = $(e).text();
    if (text.trim()) $(e).replaceWith(`\n${text}\n`);
  });
  el.find("hr").replaceWith("\n---\n");

  let text = cleanup(el.text());
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.split("\n").map((l) => l.trimEnd()).join("\n");
  return text.trim();
}

function extractTitle($: CheerioAPI): string {
  return (
    $("h1.p-title-value").first().text().trim() ||
    $("h1").first().text().trim() ||
    "Unbekannter Thread"
  );
}

function extractPosts($: CheerioAPI): Post[] {
  const posts: Post[] = [];

  $("article.message--post").each((_, article) => {
    const $article = $(article);
    const author =
      $article.attr("data-author") ||
      $article.find("a.username, .message-name a").first().text().trim() ||
      "";
    const date = $article.find("time").first().attr("datetime") || "";
    const body = $article.find(".bbWrapper").first();
    if (!body.length) return;
    const content = htmlToMarkdown($, body as Cheerio<Element>);
    if (content) posts.push({ author, date, content });
  });

  return posts;
}

function extractTableJson(
  $: CheerioAPI,
  schema: Record<string, string>
): Record<string, string>[] | null {
  const forumHeaders = Object.keys(schema);
  const stableKeys = Object.values(schema);

  const tables = $("article.message--post .bbWrapper table")
    .toArray()
    .filter((t) => !$(t).parents("table").length);

  if (!tables.length) return null;

  const result: Record<string, string>[] = [];

  for (const table of tables) {
    const rows = $(table).find("tr").toArray();
    for (const row of rows) {
      const cells = $(row).find("td, th").toArray();
      const values = cells.map((c) => cleanup($(c).text()));

      // Header-Zeilen überspringen
      if (forumHeaders.every((h, i) => values[i] === h)) continue;
      // Leere Zeilen überspringen
      if (values.every((v) => !v)) continue;

      result.push(Object.fromEntries(stableKeys.map((key, i) => [key, values[i] ?? ""])));
    }
  }

  return result.length ? result : null;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderMarkdown(title: string, url: string, posts: Post[]): string {
  const lines: string[] = [`# ${title}`, "", `Quelle: ${url}`, "", "---", ""];

  for (const post of posts) {
    const meta = [
      post.author && `von **${post.author}**`,
      post.date && post.date.slice(0, 10),
    ]
      .filter(Boolean)
      .join(" — ");
    if (meta) lines.push(meta, "");
    lines.push(post.content, "", "---", "");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function gitCommit(files: string[], message: string): boolean {
  try {
    execSync(`git add ${files.map((f) => `"${f}"`).join(" ")}`, { cwd: OUTPUT_DIR });
    const diff = execSync("git diff --cached --stat", { cwd: OUTPUT_DIR }).toString();
    if (!diff.trim()) return false;
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: OUTPUT_DIR });
    return true;
  } catch (e) {
    console.error("  Git-Fehler:", (e as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeIfChanged(file: string, content: string): boolean {
  const old = existsSync(file) ? readFileSync(file, "utf-8") : "";
  if (content === old) return false;
  writeFileSync(file, content, "utf-8");
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR);

const changed: string[] = [];
const errors: string[] = [];

for (const [name, thread] of Object.entries(config.threads)) {
  console.log(`\n${fmt.header(`>> ${name}`)}`);

  const html = await fetchThread(thread.url);
  if (!html) {
    console.error(fmt.error(`   FEHLER: Thread konnte nicht geladen werden.`));
    errors.push(name);
    continue;
  }

  const $ = cheerio.load(html);
  const title = extractTitle($);

  // JSON vor extractPosts — htmlToMarkdown transformiert den DOM
  if (thread.exportTable && thread.tableSchema) {
    const data = extractTableJson($, thread.tableSchema);
    if (data) {
      const file = join(OUTPUT_DIR, `${name}.json`);
      const content = JSON.stringify(data, null, 2);
      if (writeIfChanged(file, content)) {
        changed.push(file);
        console.log(fmt.changed(`   [+] ${name}.json`) + fmt.label(` (${data.length} Einträge)`));
      } else {
        console.log(fmt.same(`   [=] ${name}.json`));
      }
    } else {
      console.warn(fmt.warn(`   WARNUNG: Keine Tabelle gefunden.`));
      errors.push(`${name} (Tabelle leer)`);
    }
  }

  const posts = extractPosts($);
  console.log(fmt.label(`   Titel : ${title}`));
  console.log(fmt.label(`   Posts : ${posts.length}`));

  if (!posts.length) {
    console.warn(fmt.warn(`   WARNUNG: Keine Posts extrahiert.`));
    errors.push(`${name} (Posts leer)`);
    continue;
  }

  const file = join(OUTPUT_DIR, `${name}.md`);
  if (writeIfChanged(file, renderMarkdown(title, thread.url, posts))) {
    changed.push(file);
    console.log(fmt.changed(`   [+] ${name}.md`));
  } else {
    console.log(fmt.same(`   [=] ${name}.md`));
  }
}

// ---------------------------------------------------------------------------
// Zusammenfassung
// ---------------------------------------------------------------------------

console.log("\n" + c.dim + "─".repeat(50) + c.reset);
console.log(fmt.label(`Geändert  : `) + (changed.length ? fmt.ok(`${changed.length} Datei(en)`) : fmt.same("keine")));
if (errors.length) console.log(fmt.label(`Fehler    : `) + fmt.error(errors.join(", ")));

if (changed.length && doCommit) {
  if (isCI) {
    console.log(fmt.ok("CI committet."));
  } else {
    const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
    const msg = `scrape: ${timestamp}\n\n${changed.map((f) => `- ${f.split(/[\\/]/).pop()}`).join("\n")}`;
    console.log(gitCommit(changed, msg) ? fmt.ok("[OK] Commit erstellt.") : fmt.same("[=] Nichts zu committen."));
  }
} else if (changed.length && !doCommit) {
  console.log(fmt.warn("Kein Commit (--commit fehlt)."));
}

if (errors.length) process.exit(1);
