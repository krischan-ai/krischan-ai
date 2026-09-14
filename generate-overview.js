"use strict";

const fs = require("node:fs");

function read(path) {
  return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
}

function match(text, regex, fallback = "—") {
  const found = text.match(regex);
  return found?.[1]?.trim() || fallback;
}

function escapeXml(value) {
  return String(value).replace(/[&<>\"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char]);
}

const workload = read("workload-chart.svg");
const languages = read("languages.svg");
const repositories = read("repositories.svg");

const sourceCommits7d = match(workload, />(\d+) source commits ·/);
const changedLines7d = match(workload, /source commits · ([0-9,.]+) effective changed lines/);
const commits30d = match(languages, /metaStrong[^>]*>(\d+)<\/tspan> commits/);
const repos30d = match(languages, /commits · <tspan class="metaStrong">(\d+)<\/tspan> active repos/);
const mainLanguage = match(languages, /class="lang">([^<]+)<\/text>/);
const topRepository = match(repositories, /class="repo">([^<]+)<\/text>/).replace(/ · private$/, "");

const width = 740;
const height = 258;

const stats = [
  ["7D COMMITS", sourceCommits7d, "source commits"],
  ["7D CODE CHURN", changedLines7d, "effective lines"],
  ["30D ACTIVE REPOS", repos30d, "repositories"],
  ["30D COMMITS", commits30d, "authored commits"],
];

const cards = stats.map(([label, value, note], index) => {
  const x = 24 + index * 174;
  return `<g>
    <rect x="${x}" y="112" width="158" height="82" rx="10" fill="#161b22" stroke="#30363d"/>
    <text x="${x + 14}" y="137" class="eyebrow">${escapeXml(label)}</text>
    <text x="${x + 14}" y="166" class="value">${escapeXml(value)}</text>
    <text x="${x + 14}" y="184" class="note">${escapeXml(note)}</text>
  </g>`;
}).join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">krischan-ai Engineering Overview</title>
<desc id="desc">A compact overview of recent authored software development activity</desc>
<defs>
  <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="#58a6ff"/>
    <stop offset="50%" stop-color="#a371f7"/>
    <stop offset="100%" stop-color="#3fb950"/>
  </linearGradient>
</defs>
<style>
  .brand { fill:#f0f6fc; font:700 22px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .tagline { fill:#8b949e; font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .eyebrow { fill:#8b949e; font:600 10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:.8px }
  .value { fill:#f0f6fc; font:700 21px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .note { fill:#6e7681; font:11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .focus { fill:#c9d1d9; font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .focusStrong { fill:#58a6ff; font-weight:600 }
</style>
<rect x="0.5" y="0.5" width="739" height="257" rx="12" fill="#0d1117" stroke="#30363d"/>
<rect x="0" y="0" width="740" height="4" rx="2" fill="url(#accent)"/>
<text x="24" y="42" class="brand">krischan-ai · Engineering Dashboard</text>
<text x="24" y="65" class="tagline">AI · Applied Engineering · Simulation · Developer Tooling</text>
<text x="24" y="89" class="focus">Primary language: <tspan class="focusStrong">${escapeXml(mainLanguage)}</tspan>   ·   Most active repo: <tspan class="focusStrong">${escapeXml(topRepository)}</tspan></text>
${cards}
<text x="24" y="230" class="note">Metrics use authored source-code changes, excluding generated/vendor/data artifacts and capping bulk single-file changes.</text>
</svg>\n`;

fs.writeFileSync("overview.svg", svg);
console.log("Generated overview.svg from existing metric cards.");
