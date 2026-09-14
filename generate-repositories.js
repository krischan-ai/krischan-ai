"use strict";

const fs = require("node:fs");

const USERNAME = process.env.GITHUB_USERNAME || "krischan-ai";
const AUTHOR_EMAILS = csvSet(process.env.METRICS_AUTHOR_EMAILS);
const EXCLUDED_REPOSITORIES = csvSet(process.env.METRICS_EXCLUDED_REPOSITORIES);
const TOKEN = process.env.METRICS_TOKEN;
const DAYS = Number(process.env.REPOSITORY_METRICS_DAYS || 30);
const FILE_CHANGE_CAP = Number(process.env.REPOSITORY_FILE_CHANGE_CAP || 1000);
const API_URL = process.env.GITHUB_API_URL || "https://api.github.com";

if (!TOKEN) {
  console.error("METRICS_TOKEN is required.");
  process.exit(1);
}

function csvSet(value = "") {
  return new Set(value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${TOKEN}`,
  "User-Agent": `${USERNAME}-profile-repository-activity`,
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

const sourceExtensions = new Set([
  ".py", ".ipynb", ".ts", ".tsx", ".js", ".jsx", ".vue", ".gd", ".sh", ".bash", ".zsh",
  ".html", ".htm", ".css", ".scss", ".java", ".kt", ".kts", ".go", ".rs", ".c", ".h", ".cc",
  ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".dart", ".lua", ".r", ".sql",
]);

const excludedPathPatterns = [
  /(^|\/)(node_modules|vendor|vendors|dist|build|coverage|generated|outputs?|reports?|artifacts?|\.next|\.nuxt|\.cache|site|docs\/_build)(\/|$)/i,
  /(^|\/)(static\/vendor|public\/vendor)(\/|$)/i,
  /(^|\/)(data|datasets?|assets?)(\/|$)/i,
  /\.min\.(js|css)$/i,
  /\.(map|lock|svg|csv|tsv|parquet|feather|pickle|pkl|npy|npz|vtk|obj|stl|nii|nii\.gz)$/i,
];

function isSourceFile(filename = "") {
  const lower = filename.toLowerCase();
  if (excludedPathPatterns.some((pattern) => pattern.test(lower))) return false;
  const dot = lower.lastIndexOf(".");
  return dot >= 0 && sourceExtensions.has(lower.slice(dot));
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
  const since = new Date(Date.now() - DAYS * 86400000).toISOString();
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

  const active = repositories.filter(
    (repo) => !repo.archived && !repo.disabled && !EXCLUDED_REPOSITORIES.has(repo.full_name.toLowerCase()),
  );

  const groups = await mapLimit(active, 5, async (repo) => {
    try {
      const branches = await collectBranches(repo);
      const commitsByBranch = await mapLimit(branches, 3, (branch) => collectBranchCommits(repo, branch, since));
      const commits = commitsByBranch.flat().filter(authorMatches);
      const unique = [...new Map(commits.map((commit) => [commit.sha, commit])).values()];
      return unique.map((commit) => ({ repo, sha: commit.sha }));
    } catch (error) {
      console.warn(`Skipping ${repo.full_name}: ${error.message}`);
      return [];
    }
  });

  const commits = groups.flat();
  const details = await mapLimit(commits, 5, ({ repo, sha }) =>
    github(`/repos/${repo.full_name}/commits/${sha}`).then((detail) => ({ repo, detail })),
  );

  const byRepo = new Map();
  for (const { repo, detail } of details) {
    if (!authorMatches(detail)) continue;
    let score = 0;
    let files = 0;
    for (const file of detail.files || []) {
      if (!isSourceFile(file.filename || "")) continue;
      const raw = (file.additions || 0) + (file.deletions || 0);
      const effective = Math.min(raw, FILE_CHANGE_CAP);
      if (effective <= 0) continue;
      score += effective;
      files += 1;
    }
    if (!score) continue;

    const current = byRepo.get(repo.full_name) || {
      name: repo.name,
      fullName: repo.full_name,
      private: Boolean(repo.private),
      description: repo.description || "",
      score: 0,
      commits: 0,
      files: 0,
      latest: null,
    };
    current.score += score;
    current.commits += 1;
    current.files += files;
    const timestamp = detail.commit?.author?.date || detail.commit?.committer?.date;
    if (timestamp && (!current.latest || timestamp > current.latest)) current.latest = timestamp;
    byRepo.set(repo.full_name, current);
  }

  return [...byRepo.values()].sort((a, b) => b.score - a.score);
}

function escapeXml(value) {
  return String(value).replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

function compact(value) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function render(repositories) {
  const top = repositories.slice(0, 6);
  const width = 740;
  const height = 326;
  const max = Math.max(1, ...top.map((repo) => repo.score));

  const rows = top.length
    ? top.map((repo, index) => {
        const y = 83 + index * 38;
        const name = repo.private ? `${repo.name} · private` : repo.name;
        const barWidth = Math.max(4, (repo.score / max) * 360);
        return [
          `<text x="24" y="${y + 11}" class="repo">${escapeXml(name)}</text>`,
          `<rect x="260" y="${y}" width="360" height="11" rx="5.5" fill="#21262d"/>`,
          `<rect x="260" y="${y}" width="${barWidth.toFixed(1)}" height="11" rx="5.5" fill="#58a6ff"/>`,
          `<text x="700" y="${y + 10}" text-anchor="end" class="value">${compact(repo.score)} · ${repo.commits}c</text>`,
        ].join("\n");
      }).join("\n")
    : `<text x="24" y="110" class="muted">No authored source-code activity found in the last ${DAYS} days.</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">Active Repositories</title>
<desc id="desc">Repositories ranked by effective authored source-code changes over the last ${DAYS} days</desc>
<style>
  .title { fill:#e6edf3; font:600 17px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .subtitle,.muted,.value { fill:#8b949e; font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .repo { fill:#c9d1d9; font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
</style>
<rect x="0.5" y="0.5" width="739" height="325" rx="10" fill="#0d1117" stroke="#30363d"/>
<text x="24" y="34" class="title">Active Repositories · Last ${DAYS} Days</text>
<text x="24" y="56" class="subtitle">Ranked by effective authored source-code changes · generated/vendor/data files excluded</text>
${rows}
</svg>\n`;
}

collect()
  .then((repositories) => {
    fs.writeFileSync("repositories.svg", render(repositories));
    console.log(`Generated repositories.svg with ${repositories.length} active repositories.`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
