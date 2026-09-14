"use strict";

const fs = require("node:fs");

const USERNAME = process.env.GITHUB_USERNAME || "krischan-ai";
const AUTHOR_EMAILS = csvSet(process.env.METRICS_AUTHOR_EMAILS);
const EXCLUDED_REPOSITORIES = csvSet(process.env.METRICS_EXCLUDED_REPOSITORIES);
const TOKEN = process.env.METRICS_TOKEN;
const DAYS = Number(process.env.LANGUAGE_METRICS_DAYS || 30);
const FILE_CHANGE_CAP = Number(process.env.LANGUAGE_FILE_CHANGE_CAP || 1000);
const API_URL = process.env.GITHUB_API_URL || "https://api.github.com";
const RULES = loadRules();

if (!TOKEN) {
  console.error("METRICS_TOKEN is required.");
  process.exit(1);
}

function csvSet(value = "") {
  return new Set(value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function loadRules() {
  try {
    return JSON.parse(fs.readFileSync("repository-rules.json", "utf8"));
  } catch (error) {
    console.warn(`Could not load repository-rules.json: ${error.message}`);
    return { defaults: { weight: 1, exclude: false }, repositories: {} };
  }
}

function repoRule(fullName) {
  const defaults = RULES.defaults || {};
  const exact = RULES.repositories?.[fullName] || {};
  return {
    weight: Number.isFinite(Number(exact.weight)) ? Number(exact.weight) : Number(defaults.weight || 1),
    exclude: Boolean(exact.exclude ?? defaults.exclude ?? false),
  };
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${TOKEN}`,
  "User-Agent": `${USERNAME}-profile-language-activity`,
  "X-GitHub-Api-Version": "2022-11-28",
};

async function github(path, params = {}) {
  const url = new URL(path, API_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${url.pathname}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

async function allPages(path, params = {}) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const batch = await github(path, { ...params, per_page: "100", page: String(page) });
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

async function mapLimit(items, limit, worker) {
  let cursor = 0;
  const results = new Array(items.length);
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function authorMatches(commit) {
  const login = commit.author?.login?.toLowerCase();
  const email = commit.commit?.author?.email?.toLowerCase();
  return login === USERNAME.toLowerCase() || AUTHOR_EMAILS.has(email);
}

const languageByExtension = new Map([
  [".py", ["Python", "#3572A5", 1]],
  [".ipynb", ["Jupyter Notebook", "#DA5B0B", 0.45]],
  [".ts", ["TypeScript", "#3178c6", 1]],
  [".tsx", ["TypeScript", "#3178c6", 1]],
  [".js", ["JavaScript", "#f1e05a", 1]],
  [".jsx", ["JavaScript", "#f1e05a", 1]],
  [".vue", ["Vue", "#41b883", 1]],
  [".gd", ["GDScript", "#355570", 1]],
  [".sh", ["Shell", "#89e051", 1]],
  [".bash", ["Shell", "#89e051", 1]],
  [".zsh", ["Shell", "#89e051", 1]],
  [".html", ["HTML", "#e34c26", 1]],
  [".htm", ["HTML", "#e34c26", 1]],
  [".css", ["CSS", "#563d7c", 1]],
  [".scss", ["SCSS", "#c6538c", 1]],
  [".java", ["Java", "#b07219", 1]],
  [".kt", ["Kotlin", "#A97BFF", 1]],
  [".kts", ["Kotlin", "#A97BFF", 1]],
  [".go", ["Go", "#00ADD8", 1]],
  [".rs", ["Rust", "#dea584", 1]],
  [".c", ["C", "#555555", 1]],
  [".h", ["C/C++", "#f34b7d", 1]],
  [".cc", ["C/C++", "#f34b7d", 1]],
  [".cpp", ["C/C++", "#f34b7d", 1]],
  [".hpp", ["C/C++", "#f34b7d", 1]],
  [".cs", ["C#", "#178600", 1]],
  [".rb", ["Ruby", "#701516", 1]],
  [".php", ["PHP", "#4F5D95", 1]],
  [".swift", ["Swift", "#F05138", 1]],
  [".dart", ["Dart", "#00B4AB", 1]],
  [".lua", ["Lua", "#000080", 1]],
  [".r", ["R", "#198CE7", 1]],
  [".sql", ["SQL", "#e38c00", 1]],
]);

const excludedPathPatterns = [
  /(^|\/)(node_modules|vendor|vendors|dist|build|coverage|generated|outputs?|reports?|artifacts?|\.next|\.nuxt|\.cache|site|docs\/_build)(\/|$)/i,
  /(^|\/)(static\/vendor|public\/vendor)(\/|$)/i,
  /(^|\/)(data|datasets?|assets?)(\/|$)/i,
  /\.min\.(js|css)$/i,
  /\.(map|lock|svg|csv|tsv|parquet|feather|pickle|pkl|npy|npz|vtk|obj|stl|nii|nii\.gz)$/i,
];

function languageFor(filename) {
  const lower = filename.toLowerCase();
  if (excludedPathPatterns.some((pattern) => pattern.test(lower))) return null;
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  return languageByExtension.get(lower.slice(dot)) || null;
}

async function collectBranches(repo) {
  try {
    const branches = await allPages(`/repos/${repo.full_name}/branches`);
    return [...new Set([repo.default_branch, ...branches.map((branch) => branch.name)].filter(Boolean))];
  } catch (error) {
    console.warn(`Could not load branches for ${repo.full_name}: ${error.message}`);
    return [repo.default_branch].filter(Boolean);
  }
}

async function collectBranchCommits(repo, branch, since) {
  try {
    return await allPages(`/repos/${repo.full_name}/commits`, { sha: branch, since });
  } catch (error) {
    console.warn(`Skipping ${repo.full_name}@${branch}: ${error.message}`);
    return [];
  }
}

async function collect() {
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
  let repositories;
  try {
    repositories = await allPages("/user/repos", {
      visibility: "all",
      affiliation: "owner,collaborator,organization_member",
      sort: "updated",
    });
  } catch (error) {
    if (!error.message.includes("GitHub API 403")) throw error;
    repositories = await allPages(`/users/${USERNAME}/repos`, { type: "owner", sort: "updated" });
  }

  const active = repositories.filter((repo) => {
    const rule = repoRule(repo.full_name);
    return !repo.archived && !repo.disabled && !rule.exclude && !EXCLUDED_REPOSITORIES.has(repo.full_name.toLowerCase());
  });

  const commitGroups = await mapLimit(active, 5, async (repo) => {
    const branches = await collectBranches(repo);
    const commitsByBranch = await mapLimit(branches, 3, (branch) => collectBranchCommits(repo, branch, since));
    return commitsByBranch
      .flat()
      .filter(authorMatches)
      .map((commit) => ({ repo: repo.full_name, sha: commit.sha }));
  });

  const unique = [...new Map(commitGroups.flat().map((item) => [`${item.repo}:${item.sha}`, item])).values()];
  console.log(`Matched ${unique.length} authored commits across ${active.length} repositories.`);

  const details = await mapLimit(unique, 5, ({ repo, sha }) => github(`/repos/${repo}/commits/${sha}`));
  const totals = new Map();
  const reposTouched = new Set();
  let sourceFiles = 0;
  let effectiveChanges = 0;

  for (let i = 0; i < details.length; i += 1) {
    const detail = details[i];
    if (!authorMatches(detail)) continue;
    const repo = unique[i].repo;
    const repoWeight = repoRule(repo).weight;
    let touchedSource = false;

    for (const file of detail.files || []) {
      const language = languageFor(file.filename || "");
      if (!language) continue;
      const [name, color, languageWeight] = language;
      const raw = (file.additions || 0) + (file.deletions || 0);
      const score = Math.round(Math.min(raw, FILE_CHANGE_CAP) * languageWeight * repoWeight);
      if (score <= 0) continue;

      const current = totals.get(name) || { name, color, score: 0, files: 0 };
      current.score += score;
      current.files += 1;
      totals.set(name, current);
      sourceFiles += 1;
      effectiveChanges += score;
      touchedSource = true;
    }
    if (touchedSource) reposTouched.add(repo);
  }

  return {
    languages: [...totals.values()].sort((a, b) => b.score - a.score),
    commits: unique.length,
    repos: reposTouched.size,
    files: sourceFiles,
    effectiveChanges,
  };
}

function escapeXml(value) {
  return String(value).replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

function render(data) {
  const top = data.languages.slice(0, 7);
  const total = Math.max(1, top.reduce((sum, item) => sum + item.score, 0));
  const width = 740;
  const height = 330;
  const barX = 180;
  const barWidth = 500;
  const rows = top.length
    ? top.map((item, index) => {
        const y = 96 + index * 31;
        const pct = (item.score / total) * 100;
        const w = Math.max(3, (item.score / total) * barWidth);
        return [
          `<text x="24" y="${y + 11}" class="lang">${escapeXml(item.name)}</text>`,
          `<rect x="${barX}" y="${y}" width="${barWidth}" height="12" rx="6" fill="#21262d"/>`,
          `<rect x="${barX}" y="${y}" width="${w.toFixed(1)}" height="12" rx="6" fill="${item.color}"/>`,
          `<text x="704" y="${y + 11}" text-anchor="end" class="pct">${pct.toFixed(1)}%</text>`,
        ].join("\n");
      }).join("\n")
    : `<text x="24" y="120" class="muted">No authored source-code changes found in the last ${DAYS} days.</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">Active Development Languages</title>
<desc id="desc">Weighted authored source-code activity by language over the last ${DAYS} days</desc>
<style>
  .title { fill:#e6edf3; font:600 17px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .subtitle,.muted,.meta,.pct { fill:#8b949e; font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .lang { fill:#c9d1d9; font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .metaStrong { fill:#e6edf3; font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
</style>
<rect x="0.5" y="0.5" width="739" height="329" rx="10" fill="#0d1117" stroke="#30363d"/>
<text x="24" y="34" class="title">Active Development · Last ${DAYS} Days</text>
<text x="24" y="56" class="subtitle">Authored source changes · generated/vendor/data excluded · reference repositories down-weighted</text>
<text x="24" y="78" class="meta"><tspan class="metaStrong">${data.commits}</tspan> commits · <tspan class="metaStrong">${data.repos}</tspan> active repos · <tspan class="metaStrong">${data.effectiveChanges.toLocaleString("en-US")}</tspan> weighted effective lines</text>
${rows}
</svg>\n`;
}

collect()
  .then((data) => {
    fs.writeFileSync("languages.svg", render(data));
    console.log(`Generated languages.svg with ${data.languages.length} active languages.`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
