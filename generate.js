"use strict";

const fs = require("node:fs");

const USERNAME = process.env.GITHUB_USERNAME || "krischan-ai";
const AUTHOR_EMAILS = csvSet(process.env.METRICS_AUTHOR_EMAILS);
const EXCLUDED_REPOSITORIES = csvSet(process.env.METRICS_EXCLUDED_REPOSITORIES);
const TOKEN = process.env.METRICS_TOKEN;
const DAYS = 7;
const TZ_OFFSET_HOURS = 8;
const FILE_CHANGE_CAP = Number(process.env.WORKLOAD_FILE_CHANGE_CAP || 1000);
const API_URL = process.env.GITHUB_API_URL || "https://api.github.com";

function csvSet(value = "") {
  return new Set(
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

if (!TOKEN) {
  console.error("METRICS_TOKEN is required.");
  process.exit(1);
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${TOKEN}`,
  "User-Agent": `${USERNAME}-profile-metrics`,
  "X-GitHub-Api-Version": "2022-11-28",
};

const excludedPathPatterns = [
  /(^|\/)(node_modules|vendor|vendors|dist|build|coverage|generated|outputs?|reports?|artifacts?|\.next|\.nuxt|\.cache|site|docs\/_build)(\/|$)/i,
  /(^|\/)(static\/vendor|public\/vendor)(\/|$)/i,
  /(^|\/)(data|datasets?|assets?)(\/|$)/i,
  /\.min\.(js|css)$/i,
  /\.(map|lock|svg|csv|tsv|parquet|feather|pickle|pkl|npy|npz|vtk|obj|stl|nii|nii\.gz)$/i,
];

const sourceExtensions = new Set([
  ".py", ".ipynb", ".ts", ".tsx", ".js", ".jsx", ".vue", ".gd", ".sh", ".bash", ".zsh",
  ".html", ".htm", ".css", ".scss", ".java", ".kt", ".kts", ".go", ".rs", ".c", ".h", ".cc",
  ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".dart", ".lua", ".r", ".sql",
]);

function isSourceFile(filename = "") {
  const lower = filename.toLowerCase();
  if (excludedPathPatterns.some((pattern) => pattern.test(lower))) return false;
  const dot = lower.lastIndexOf(".");
  return dot >= 0 && sourceExtensions.has(lower.slice(dot));
}

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

function localDate(date) {
  const shifted = new Date(date.getTime() + TZ_OFFSET_HOURS * 3_600_000);
  return shifted.toISOString().slice(0, 10);
}

function authorMatches(commit) {
  const login = commit.author?.login?.toLowerCase();
  const email = commit.commit?.author?.email?.toLowerCase();
  return login === USERNAME.toLowerCase() || AUTHOR_EMAILS.has(email);
}

function recentDays(now = new Date()) {
  const today = new Date(now.getTime() + TZ_OFFSET_HOURS * 3_600_000);
  const result = [];
  for (let offset = DAYS - 1; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setUTCDate(today.getUTCDate() - offset);
    result.push({
      key: day.toISOString().slice(0, 10),
      label: `${day.getUTCMonth() + 1}/${day.getUTCDate()}`,
      additions: 0,
      deletions: 0,
      commits: 0,
    });
  }
  return result;
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

async function collect() {
  const days = recentDays();
  const byDate = new Map(days.map((day) => [day.key, day]));
  const since = new Date(`${days[0].key}T00:00:00+08:00`).toISOString();
  let repositories;
  try {
    repositories = await allPages("/user/repos", {
      visibility: "all",
      affiliation: "owner,collaborator,organization_member",
      sort: "updated",
    });
  } catch (error) {
    if (!error.message.includes("GitHub API 403")) throw error;
    console.warn("Token cannot list authenticated repositories; using public repositories instead.");
    repositories = await allPages(`/users/${USERNAME}/repos`, {
      type: "owner",
      sort: "updated",
    });
  }

  const active = repositories.filter(
    (repo) => !repo.archived && !repo.disabled && !EXCLUDED_REPOSITORIES.has(repo.full_name.toLowerCase()),
  );

  const commitGroups = await mapLimit(active, 5, async (repo) => {
    try {
      const branches = await collectBranches(repo);
      const commitsByBranch = await mapLimit(branches, 3, (branch) => collectBranchCommits(repo, branch, since));
      return commitsByBranch
        .flat()
        .filter(authorMatches)
        .map((commit) => ({ repo: repo.full_name, sha: commit.sha }));
    } catch (error) {
      console.warn(`Skipping ${repo.full_name}: ${error.message}`);
      return [];
    }
  });

  const unique = [...new Map(commitGroups.flat().map((item) => [`${item.repo}:${item.sha}`, item])).values()];
  console.log(`Matched ${unique.length} commits across ${active.length} repositories for ${USERNAME}.`);

  const details = await mapLimit(unique, 5, ({ repo, sha }) => github(`/repos/${repo}/commits/${sha}`));

  for (const detail of details) {
    if (!authorMatches(detail)) continue;
    const timestamp = detail.commit?.author?.date || detail.commit?.committer?.date;
    const day = timestamp && byDate.get(localDate(new Date(timestamp)));
    if (!day) continue;

    let hasSourceChange = false;
    for (const file of detail.files || []) {
      if (!isSourceFile(file.filename || "")) continue;
      const additions = Math.min(file.additions || 0, FILE_CHANGE_CAP);
      const deletions = Math.min(file.deletions || 0, FILE_CHANGE_CAP);
      if (additions + deletions <= 0) continue;
      day.additions += additions;
      day.deletions += deletions;
      hasSourceChange = true;
    }
    if (hasSourceChange) day.commits += 1;
  }

  return days;
}

async function collectBranches(repo) {
  try {
    const branches = await allPages(`/repos/${repo.full_name}/branches`, {});
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

function render(days) {
  const width = 740;
  const height = 338;
  const baseline = 170;
  const chartHeight = 86;
  const max = Math.max(1, ...days.flatMap((day) => [day.additions, day.deletions]));
  const totalCommits = days.reduce((sum, day) => sum + day.commits, 0);
  const totalChanges = days.reduce((sum, day) => sum + day.additions + day.deletions, 0);

  const bars = days.map((day, index) => {
    const x = 61 + index * 96;
    const addHeight = Math.round((day.additions / max) * chartHeight);
    const delHeight = Math.round((day.deletions / max) * chartHeight);
    return [
      `<rect x="${x}" y="${baseline - addHeight}" width="28" height="${addHeight}" rx="4" fill="#3fb950"/>`,
      `<rect x="${x}" y="${baseline}" width="28" height="${delHeight}" rx="4" fill="#f85149"/>`,
      `<text x="${x + 14}" y="${baseline - addHeight - 7}" text-anchor="middle" class="value add">+${day.additions}</text>`,
      `<text x="${x + 14}" y="${baseline + delHeight + 16}" text-anchor="middle" class="value del">-${day.deletions}</text>`,
      `<text x="${x + 14}" y="298" text-anchor="middle" class="date">${day.label}</text>`,
      `<text x="${x + 14}" y="316" text-anchor="middle" class="date">${day.commits}c</text>`,
    ].join("\n");
  }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">7-Day Engineering Activity</title>
<desc id="desc">Effective authored source-code additions and deletions by day for ${USERNAME}</desc>
<style>
  .title { fill:#e6edf3; font:600 17px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .legend,.date,.subtitle { fill:#8b949e; font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .value { font:600 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .add { fill:#3fb950 } .del { fill:#f85149 }
</style>
<rect x="0.5" y="0.5" width="739" height="337" rx="10" fill="#0d1117" stroke="#30363d"/>
<text x="24" y="34" class="title">7-Day Engineering Activity</text>
<text x="24" y="56" class="subtitle">${totalCommits} source commits · ${totalChanges.toLocaleString("en-US")} effective changed lines</text>
<circle cx="526" cy="29" r="5" fill="#3fb950"/><text x="538" y="33" class="legend">Additions</text>
<circle cx="624" cy="29" r="5" fill="#f85149"/><text x="636" y="33" class="legend">Deletions</text>
<line x1="36" y1="${baseline}" x2="704" y2="${baseline}" stroke="#30363d"/>
${bars}
</svg>\n`;
}

collect()
  .then((days) => {
    fs.writeFileSync("workload-chart.svg", render(days));
    console.log(`Generated workload-chart.svg for ${USERNAME}.`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
