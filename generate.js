"use strict";

const fs = require("node:fs");

const USERNAME = process.env.GITHUB_USERNAME || "krischan-ai";
const TOKEN = process.env.METRICS_TOKEN;
const DAYS = 7;
const TZ_OFFSET_HOURS = 8;
const API_URL = process.env.GITHUB_API_URL || "https://api.github.com";

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
  const active = repositories.filter((repo) => !repo.archived && !repo.disabled);

  const commitGroups = await mapLimit(active, 5, async (repo) => {
    try {
      const commits = await allPages(`/repos/${repo.full_name}/commits`, {
        author: USERNAME,
        since,
      });
      return commits.map((commit) => ({ repo: repo.full_name, sha: commit.sha }));
    } catch (error) {
      // Empty repositories return 409; inaccessible histories should not abort every metric.
      console.warn(`Skipping ${repo.full_name}: ${error.message}`);
      return [];
    }
  });

  const unique = [...new Map(commitGroups.flat().map((item) => [item.sha, item])).values()];
  const details = await mapLimit(unique, 5, ({ repo, sha }) =>
    github(`/repos/${repo}/commits/${sha}`),
  );
  for (const detail of details) {
    const timestamp = detail.commit?.author?.date || detail.commit?.committer?.date;
    const day = timestamp && byDate.get(localDate(new Date(timestamp)));
    if (day) {
      day.additions += detail.stats?.additions || 0;
      day.deletions += detail.stats?.deletions || 0;
    }
  }
  return days;
}

function render(days) {
  const width = 740;
  const height = 320;
  const baseline = 160;
  const chartHeight = 86;
  const max = Math.max(1, ...days.flatMap((day) => [day.additions, day.deletions]));
  const bars = days.map((day, index) => {
    const x = 61 + index * 96;
    const addHeight = Math.round((day.additions / max) * chartHeight);
    const delHeight = Math.round((day.deletions / max) * chartHeight);
    return [
      `<rect x="${x}" y="${baseline - addHeight}" width="28" height="${addHeight}" rx="4" fill="#3fb950"/>`,
      `<rect x="${x}" y="${baseline}" width="28" height="${delHeight}" rx="4" fill="#f85149"/>`,
      `<text x="${x + 14}" y="${baseline - addHeight - 7}" text-anchor="middle" class="value add">+${day.additions}</text>`,
      `<text x="${x + 14}" y="${baseline + delHeight + 16}" text-anchor="middle" class="value del">-${day.deletions}</text>`,
      `<text x="${x + 14}" y="286" text-anchor="middle" class="date">${day.label}</text>`,
    ].join("\n");
  }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">7-Day Code Activity</title>
<desc id="desc">Additions and deletions by day for ${USERNAME}</desc>
<style>
  .title { fill:#e6edf3; font:600 17px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .legend,.date { fill:#8b949e; font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .value { font:600 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  .add { fill:#3fb950 } .del { fill:#f85149 }
</style>
<rect x="0.5" y="0.5" width="739" height="319" rx="10" fill="#0d1117" stroke="#30363d"/>
<text x="24" y="34" class="title">7-Day Code Activity</text>
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
