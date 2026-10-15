"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function run(script, cwd, apiUrl) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, script)], { cwd, env: { ...process.env, METRICS_TOKEN: 'fixture', GITHUB_API_URL: apiUrl } });
    let output = '';
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    child.on('exit', code => resolve({ code, output }));
  });
}
async function fixture(t, mode) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-test-'));
  for (const file of ['repository-rules.json', 'featured-projects.json']) fs.copyFileSync(path.join(root, file), path.join(cwd, file));
  let disconnects = 0;
  let detailRequests = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    if (route.endsWith('/commits/c1')) {
      detailRequests++;
      if (mode === 'persistent-504' || (['502', '504'].includes(mode) && detailRequests === 1)) {
        res.writeHead(mode === '502' ? 502 : 504); res.end('temporary GitHub server error'); return;
      }
    }
    if (route.endsWith('/commits/c1') && mode === 'disconnect' && disconnects++ === 0) { req.socket.destroy(); return; }
    if (route.endsWith('/branches') && mode === 'permission') { res.writeHead(403); res.end('Resource not accessible by personal access token'); return; }
    if (route.endsWith('/commits') && mode === 'invalid') { res.writeHead(422); res.end('Invalid sha parameter'); return; }
    let data;
    if (route === '/user/repos') data = [{ full_name: 'krischan-ai/fixture', name: 'fixture', owner: { login: 'krischan-ai' }, default_branch: 'main' }];
    else if (route.endsWith('/branches')) data = [{ name: 'main' }, { name: 'topic' }];
    else if (route.endsWith('/commits')) data = [{ sha: 'c1', author: { login: 'krischan-ai' }, commit: { author: { email: 'fixture@example.com' } } }];
    else if (route.endsWith('/commits/c1')) data = { author: { login: 'krischan-ai' }, commit: { author: { date: new Date().toISOString() } }, files: [{ filename: 'src/main.py', additions: 20, deletions: 10 }, { filename: 'vendor/main.js', additions: 999 }] };
    else { res.writeHead(404); res.end('Unexpected fixture route'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, apiUrl: `http://127.0.0.1:${server.address().port}`, disconnects: () => disconnects, detailRequests: () => detailRequests };
}
test('all five generators run; real socket disconnect recovers without changing language SVG', async t => {
  const f = await fixture(t, 'disconnect');
  const language = await run('generate-languages.js', f.cwd, f.apiUrl);
  assert.equal(language.code, 0, language.output); assert.match(language.output, /UND_ERR_SOCKET/);
  const recovered = fs.readFileSync(path.join(f.cwd, 'languages.svg'), 'utf8');
  assert.match(recovered, />1<\/tspan> commits/); assert.match(recovered, />30<\/tspan> weighted effective lines/);
  assert.match(recovered, /Python/); assert.doesNotMatch(recovered, /JavaScript/);
  const clean = await run('generate-languages.js', f.cwd, f.apiUrl);
  assert.equal(clean.code, 0, clean.output); assert.equal(fs.readFileSync(path.join(f.cwd, 'languages.svg'), 'utf8'), recovered);
  for (const script of ['generate.js', 'generate-repositories.js', 'generate-overview.js', 'generate-featured-projects.js']) {
    const result = await run(script, f.cwd, f.apiUrl); assert.equal(result.code, 0, result.output);
  }
  const overview = fs.readFileSync(path.join(f.cwd, 'overview.svg'), 'utf8');
  assert.match(overview, /Python/); assert.doesNotMatch(overview, /—/);
});
const apiGenerators = [
  ['generate.js', 'workload-chart.svg', /1 source commits · 30 weighted effective lines/],
  ['generate-languages.js', 'languages.svg', />30<\/tspan> weighted effective lines/],
  ['generate-repositories.js', 'repositories.svg', /30 · 1c/],
];
for (const [script, svg, expected] of apiGenerators) {
  for (const mode of ['disconnect', '502', '504']) {
    test(`${script} recovers from ${mode} without changing statistics`, async t => {
      const f = await fixture(t, mode);
      const result = await run(script, f.cwd, f.apiUrl);
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /Retrying/);
      assert.match(result.output, mode === 'disconnect' ? /UND_ERR_SOCKET/ : new RegExp(`GitHub API ${mode}`));
      assert.equal(f.detailRequests(), 2);
      const recovered = fs.readFileSync(path.join(f.cwd, svg), 'utf8');
      assert.match(recovered, expected);
      const clean = await run(script, f.cwd, f.apiUrl);
      assert.equal(clean.code, 0, clean.output);
      assert.equal(fs.readFileSync(path.join(f.cwd, svg), 'utf8'), recovered);
    });
  }
  for (const mode of ['permission', 'invalid', 'persistent-504']) {
    test(`${script} stops on ${mode} and preserves previous SVG`, async t => {
      const f = await fixture(t, mode);
      fs.writeFileSync(path.join(f.cwd, svg), 'previous complete chart');
      const result = await run(script, f.cwd, f.apiUrl);
      assert.equal(result.code, 1, result.output);
      if (mode === 'persistent-504') {
        assert.match(result.output, /failed after 4 attempt\(s\).*GitHub API 504/);
        assert.equal(f.detailRequests(), 4);
      } else {
        assert.match(result.output, mode === 'permission' ? /403.*Resource not accessible/ : /422.*Invalid sha/);
        assert.doesNotMatch(result.output, /Retrying/);
      }
      assert.equal(fs.readFileSync(path.join(f.cwd, svg), 'utf8'), 'previous complete chart');
    });
  }
}
