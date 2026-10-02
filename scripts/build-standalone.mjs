// Keep the one-file desktop page aligned with the existing source assets.
import {readFile, writeFile} from "node:fs/promises";
const root = new URL("../", import.meta.url);
let html = await readFile(new URL("index.html", root), "utf8");
for (const match of [...html.matchAll(/<link rel="stylesheet" href="(css\/[^\"]+)">/g)]) {
  const css = await readFile(new URL(match[1], root), "utf8");
  html = html.replace(match[0], () => `<style>\n${css}</style>`);
}
for (const match of [...html.matchAll(/<script src="(js\/[^\"]+)"><\/script>/g)]) {
  const js = await readFile(new URL(match[1], root), "utf8");
  html = html.replace(match[0], () => `<script>\n${js.replace(/<\/script/gi, "<\\/script")}</script>`);
}
await writeFile(new URL("project-martian-standalone.html", root), html);
