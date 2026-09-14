"use strict";

const fs = require("node:fs");

const projects = JSON.parse(fs.readFileSync("featured-projects.json", "utf8"));
const width = 740;
const rowHeight = 104;
const height = 72 + projects.length * rowHeight + 24;

function escapeXml(value) {
  return String(value).replace(/[&<>\"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char]);
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

const rows = projects.map((project, index) => {
  const y = 68 + index * rowHeight;
  const name = escapeXml(project.name);
  const label = escapeXml(project.label);
  const description = escapeXml(truncate(project.description, 112));
  const stack = escapeXml(truncate(project.stack, 94));
  return `<g>
    <rect x="20" y="${y}" width="700" height="90" rx="11" fill="#161b22" stroke="#30363d"/>
    <rect x="34" y="${y + 16}" width="116" height="22" rx="11" fill="#1f6feb22" stroke="#1f6feb66"/>
    <text x="92" y="${y + 31}" text-anchor="middle" class="pill">${label}</text>
    <text x="166" y="${y + 31}" class="project">${name}</text>
    <text x="34" y="${y + 55}" class="desc">${description}</text>
    <text x="34" y="${y + 76}" class="stack">${stack}</text>
  </g>`;
}).join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">Featured Projects</title>
<desc id="desc">Selected public projects highlighting AI engineering, simulation, and data systems</desc>
<defs>
  <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="#58a6ff"/>
    <stop offset="50%" stop-color="#a371f7"/>
    <stop offset="100%" stop-color="#3fb950"/>
  </linearGradient>
</defs>
<style>
  .title { fill:#f0f6fc; font:700 18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .subtitle { fill:#8b949e; font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .project { fill:#f0f6fc; font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .pill { fill:#58a6ff; font:600 10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .desc { fill:#c9d1d9; font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .stack { fill:#8b949e; font:11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
</style>
<rect x="0.5" y="0.5" width="739" height="${height - 1}" rx="12" fill="#0d1117" stroke="#30363d"/>
<rect x="0" y="0" width="740" height="4" rx="2" fill="url(#accent)"/>
<text x="24" y="35" class="title">Featured Projects</text>
<text x="24" y="55" class="subtitle">Selected public work across AI engineering, simulation, and data systems</text>
${rows}
</svg>\n`;

fs.writeFileSync("featured-projects.svg", svg);
console.log(`Generated featured-projects.svg with ${projects.length} projects.`);
