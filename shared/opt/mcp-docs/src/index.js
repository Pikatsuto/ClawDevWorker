#!/usr/bin/env node
/**
 * mcp-docs — MCP documentation search server
 *
 * Cascade by priority order:
 *   1. Self-hosted DevDocs  → own API, 100+ docs, zero external network
 *   2. Official APIs        → only domains NOT covered by DevDocs
 *   3. SearXNG + nodriver   → only domains NOT covered by levels 1+2
 *
 * Fundamental rule: if a domain is covered by level N,
 * it is excluded from levels N+1, N+2... We never fetch the same source twice.
 */

const http  = require('http');
const https = require('https');

const DEVDOCS_URL   = process.env.DEVDOCS_URL   || 'http://devdocs:9292';
const SEARXNG_URL   = process.env.SEARXNG_URL   || 'http://searxng:8080';
const NODRIVER_URL  = process.env.NODRIVER_URL  || 'http://browserless:3000';
const MAX_RESULTS   = parseInt(process.env.MAX_RESULTS  || '5');
const FETCH_TIMEOUT = parseInt(process.env.FETCH_TIMEOUT || '8000');
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || '';  // optional — 60 req/h without, 5000 with

// ── Level 1: domains covered by DevDocs ──────────────────────────────────────
// Excluded from levels 2 and 3.
const DEVDOCS_DOMAINS = new Set([
  // Web & standards
  'developer.mozilla.org','w3.org','whatwg.org','tc39.es',
  // JS / Node / TS / Runtimes
  'nodejs.org','deno.land','bun.sh','typescriptlang.org','jsr.io','coffeescript.org',
  // Python
  'docs.python.org','peps.python.org','packaging.python.org',
  // Rust
  'doc.rust-lang.org','docs.rs','rust-lang.github.io',
  // Go
  'pkg.go.dev','go.dev','golang.org',
  // Ruby / Rails
  'ruby-lang.org','docs.ruby-lang.org','api.rubyonrails.org','guides.rubyonrails.org',
  // PHP
  'php.net','www.php.net','laravel.com','docs.laravel.com',
  // Java / JVM
  'docs.oracle.com','openjdk.org',
  // Kotlin
  'kotlinlang.org',
  // C / C++
  'en.cppreference.com','gcc.gnu.org',
  // Swift / Dart / Flutter
  'swift.org','docs.swift.org','dart.dev','api.flutter.dev',
  // Elixir / Haskell / Scala / Erlang
  'elixir-lang.org','hexdocs.pm','haskell.org','scala-lang.org','erlang.org',
  // Frontend frameworks
  'vuejs.org','react.dev','angular.dev','svelte.dev','solidjs.com','alpinejs.dev',
  'astro.build','nuxt.com','nextjs.org','remix.run','vitejs.dev',
  'esbuild.github.io','rollupjs.org','webpack.js.org','parceljs.org','turbo.build',
  'emberjs.com','backbonejs.org',
  // CSS
  'tailwindcss.com','getbootstrap.com','bulma.io','sass-lang.com','postcss.org','lesscss.org',
  // JS libraries in DevDocs
  'lodash.com','underscorejs.org','momentjs.com','day.js.org','date-fns.org',
  'rxjs.dev','reactivex.io','d3js.org',
  'jestjs.io','vitest.dev','playwright.dev','cypress.io','testing-library.com',
  'mochajs.org','chaijs.com','sinonjs.org','greensock.com',
  // Backend frameworks in DevDocs
  'expressjs.com','fastapi.tiangolo.com','flask.palletsprojects.com',
  'djangoproject.com','docs.djangoproject.com','django-rest-framework.org',
  'fastify.dev','nestjs.com','hono.dev','koajs.com','hapijs.com',
  // Databases in DevDocs
  'postgresql.org','www.postgresql.org','mysql.com','dev.mysql.com',
  'sqlite.org','redis.io','mongodb.com','docs.mongodb.com',
  // DevOps in DevDocs
  'docs.docker.com','kubernetes.io','helm.sh','nginx.org','nginx.com',
  'apache.org','httpd.apache.org',
  // GNU/Linux in DevDocs
  'gnu.org','www.gnu.org','man7.org','linux.die.net','git-scm.com','curl.se',
  // AI/ML in DevDocs
  'pytorch.org','tensorflow.org',
  // Tools in DevDocs
  'pnpm.io','yarnpkg.com','docs.npmjs.com','babeljs.io','eslint.org','prettier.io','biomejs.dev',
]);

// ── Level 2: domains covered by official APIs ────────────────────────────────
// Excluded from level 3 (in addition to DEVDOCS_DOMAINS).
const API_DOMAINS = new Set([
  'npmjs.com','www.npmjs.com','registry.npmjs.org',
  'pypi.org','files.pythonhosted.org',
  'crates.io','static.crates.io',
  'github.com','raw.githubusercontent.com','objects.githubusercontent.com',
  'hub.docker.com',
  'readthedocs.io','readthedocs.org',
]);

// ── Level 3: domains allowed for nodriver fetch ──────────────────────────────
// Official sites tolerating scraping, NOT covered by levels 1 and 2.
const LEVEL3_FETCH_DOMAINS = new Set([
  // Java / JVM frameworks
  'spring.io','docs.spring.io','quarkus.io','micronaut.io','vertx.io',
  // Kotlin
  'ktor.io',
  // C / C++ / LLVM
  'clang.llvm.org','llvm.org',
  // Rust not covered by docs.rs
  'rust-unofficial.github.io',
  // Go modules
  'go.googlesource.com',
  // Backend frameworks not in DevDocs
  'axum.rs','actix.rs','rocket.rs','gin-gonic.com','echo.labstack.com','fiber.wiki',
  'gorilla.github.io','beego.me','aiohttp.readthedocs.io','starlette.io',
  'tortoise-orm.readthedocs.io','pydantic-docs.helpmanual.io','docs.pydantic.dev',
  // Databases not in DevDocs
  'clickhouse.com','clickhouse.tech','timescale.com','docs.timescale.com',
  'cassandra.apache.org','neo4j.com','docs.neo4j.com',
  'supabase.com','prisma.io','drizzle.team','typeorm.io',
  'sequelize.org','knexjs.org','mikro-orm.io',
  'sqlalchemy.org','docs.sqlalchemy.org','peewee-orm.com',
  // DevOps not in DevDocs
  'terraform.io','developer.hashicorp.com','ansible.com','docs.ansible.com',
  'traefik.io','doc.traefik.io','caddyserver.com',
  'prometheus.io','grafana.com','opentelemetry.io','jaegertracing.io',
  'www.consul.io','www.vaultproject.io','packer.io','www.vagrantup.com',
  'fluxcd.io','argo-cd.readthedocs.io',
  // Cloud (public docs)
  'cloud.google.com','docs.aws.amazon.com',
  'learn.microsoft.com','docs.microsoft.com','azure.microsoft.com',
  // CI/CD
  'docs.github.com','docs.gitlab.com',
  'circleci.com','docs.circleci.com','www.jenkins.io','docs.drone.io','woodpecker-ci.org',
  // JS libraries not in DevDocs
  'zod.dev','trpc.io','tanstack.com','swr.vercel.app',
  'zustand-demo.pmnd.rs','jotai.org','valtio.pmnd.rs','mobx.js.org',
  'redux.js.org','immerjs.github.io','socket.io','axios-http.com',
  'formik.org','react-hook-form.com',
  // AI/ML not in DevDocs
  'huggingface.co','docs.llamaindex.ai','python.langchain.com','ollama.com',
  'scikit-learn.org','keras.io','numpy.org','pandas.pydata.org','matplotlib.org',
  // Tools
  'jqlang.github.io','stedolan.github.io','tldp.org',
  'ecma-international.org','whatwg.org','tc39.es','w3.org',
  'rubygems.org',
  // Stack Overflow & SE
  'stackoverflow.com','unix.stackexchange.com','serverfault.com',
  'superuser.com','askubuntu.com','security.stackexchange.com',
  // Wikipedia
  'en.wikipedia.org','fr.wikipedia.org',
  // Linux
  'wiki.archlinux.org','wiki.gentoo.org','docs.kernel.org',
]);

const OLLAMA_CPU_URL = process.env.OLLAMA_CPU_URL || 'http://ollama-cpu:11434';

// ── Helpers ───────────────────────────────────────────────────────────────────
function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch (_) { return ''; }
}

function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const t = setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT);
    const req = mod.get(url, { headers: opts.headers || {} }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { clearTimeout(t); try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    });
    req.on('error', e => { clearTimeout(t); reject(e); });
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const t = setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT);
    const req = mod.get(url, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { clearTimeout(t); resolve(body); });
    });
    req.on('error', e => { clearTimeout(t); reject(e); });
  });
}

// ── Level 1: DevDocs ──────────────────────────────────────────────────────────
// DevDocs does NOT have a server-side REST search API — search is
// entirely client-side. What actually exists on the Sinatra server:
//   GET /docs/<slug>/index.json  → list of docset entries (name, path, type)
//   GET /docs/<slug>/<path>.html → HTML content of a page
//
// Strategy:
//   1. Load the global manifest: GET / returns the HTML with available slugs,
//      or we use a static list of the most useful common docsets.
//   2. For each candidate docset, load its index.json and filter by query.
//   3. Fetch the HTML of matching entries, extract the text.

// Priority list of DevDocs docsets to query first.
// DevDocs slug → category mapping. Order = search priority.
const DEVDOCS_SLUGS = [
  // Web & standards
  'html', 'css', 'javascript', 'dom', 'http', 'web_extensions',
  // JS runtimes & supersets
  'node', 'node~20_lts', 'node~22_lts', 'node~24_lts',
  'typescript', 'deno', 'bun',
  // Python
  'python~3.12', 'python~3.11', 'python~3.10',
  // Rust
  'rust',
  // Go
  'go',
  // Ruby
  'ruby', 'ruby~3.3', 'rails~7.2',
  // PHP
  'php', 'laravel~11',
  // Java
  'openjdk~21', 'openjdk~17',
  // Kotlin / Swift / Dart
  'kotlin', 'swift', 'dart~3',
  // C / C++
  'c', 'cpp',
  // Frontend frameworks
  'vue~3', 'react', 'angular', 'svelte', 'astro', 'nuxt~3',
  'next.js', 'vite', 'webpack~5',
  // CSS frameworks
  'tailwindcss', 'bootstrap~5', 'sass',
  // JS libraries
  'lodash~4', 'd3~7', 'moment', 'rxjs', 'jest', 'vitest',
  'playwright', 'cypress', 'mocha', 'chai',
  // Backend frameworks
  'express', 'fastapi', 'django', 'flask', 'fastify', 'nest',
  // Databases
  'postgresql~16', 'mysql', 'sqlite', 'redis',
  // MongoDB
  // DevOps
  'docker', 'kubernetes', 'nginx', 'apache_http_server',
  // Git / tools
  'git', 'gnu_bash', 'gnu_make', 'curl',
  // AI/ML
  'pytorch', 'tensorflow~2',
  // Other tools
  'eslint', 'prettier', 'babel',
  // Linux man pages
  'man', 'linux',
];

// DevDocs index cache (slug → [{name, path, type}])
const _devdocsIndexCache = new Map();

async function fetchDevDocsIndex(slug) {
  if (_devdocsIndexCache.has(slug)) return _devdocsIndexCache.get(slug);
  try {
    const data = await fetchJson(`${DEVDOCS_URL}/docs/${slug}/index.json`);
    const entries = data.entries || [];
    _devdocsIndexCache.set(slug, entries);
    return entries;
  } catch (_) {
    _devdocsIndexCache.set(slug, []);
    return [];
  }
}

// Simple fuzzy search: checks if all query words are in the name
function matchesQuery(entryName, query) {
  const name = entryName.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  // Exact match first
  if (name.includes(query.toLowerCase())) return 2;
  // Match all words
  if (words.every(w => name.includes(w))) return 1;
  // Partial match (first word)
  if (words.length > 0 && name.includes(words[0])) return 0.5;
  return 0;
}

async function searchDevDocs(query) {
  const candidates = []; // { slug, entry, score }

  // Phase 1: search in each docset index (in parallel by batch)
  const BATCH = 8; // load 8 indexes at a time
  for (let i = 0; i < DEVDOCS_SLUGS.length; i += BATCH) {
    const batch = DEVDOCS_SLUGS.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async slug => {
        const entries = await fetchDevDocsIndex(slug);
        for (const entry of entries) {
          const score = matchesQuery(entry.name, query);
          if (score > 0) candidates.push({ slug, entry, score });
        }
      })
    );
    // Stop once we have enough good results (score 2 = exact match)
    if (candidates.filter(c => c.score === 2).length >= MAX_RESULTS) break;
  }

  if (candidates.length === 0) return [];

  // Phase 2: sort by descending score, take the best
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, MAX_RESULTS);

  // Phase 3: fetch the HTML content of each entry
  const results = [];
  for (const { slug, entry } of top) {
    let content = '';
    const pageUrl = `${DEVDOCS_URL}/docs/${slug}/${entry.path}`;
    const publicUrl = `https://devdocs.io/${slug}/${entry.path}`;
    try {
      const html = await fetchText(pageUrl);
      // Extract plain text from HTML (remove tags, scripts, styles)
      content = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 800);
    } catch (_) {}
    results.push({
      title: `[${slug}] ${entry.name}`,
      url: publicUrl,
      excerpt: content.slice(0, 300) || entry.name,
      content,
      source: 'DevDocs',
    });
  }
  return results;
}

// ── Level 2: Official APIs ────────────────────────────────────────────────────
const OFFICIAL_APIS = [
  {
    name: 'MDN', domain: 'developer.mozilla.org',
    search: q => `https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(q)}&locale=en-US`,
    parse: d => (d.documents||[]).slice(0,MAX_RESULTS).map(x=>({ title:x.title, url:`https://developer.mozilla.org${x.mdn_url}`, excerpt:x.summary, source:'MDN' })),
  },
  {
    name: 'npm', domain: 'npmjs.com',
    search: q => `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=${MAX_RESULTS}`,
    parse: d => (d.objects||[]).slice(0,MAX_RESULTS).map(o=>({ title:o.package.name, url:`https://www.npmjs.com/package/${o.package.name}`, excerpt:o.package.description, source:'npm' })),
  },
  {
    name: 'PyPI', domain: 'pypi.org',
    search: q => `https://pypi.org/pypi/${encodeURIComponent(q.split(' ')[0])}/json`,
    parse: d => d.info ? [{ title:`${d.info.name} ${d.info.version}`, url:`https://pypi.org/project/${d.info.name}/`, excerpt:d.info.summary, source:'PyPI' }] : [],
  },
  {
    name: 'crates.io', domain: 'crates.io',
    search: q => `https://crates.io/api/v1/crates?q=${encodeURIComponent(q)}&per_page=${MAX_RESULTS}`,
    parse: d => (d.crates||[]).slice(0,MAX_RESULTS).map(c=>({ title:c.name, url:`https://crates.io/crates/${c.name}`, excerpt:c.description, source:'crates.io' })),
    headers: { 'User-Agent': 'mcp-docs/2.0' },
  },
  {
    name: 'GitHub', domain: 'github.com',
    search: q => `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=${MAX_RESULTS}`,
    parse: d => (d.items||[]).slice(0,MAX_RESULTS).map(r=>({ title:r.full_name, url:r.html_url, excerpt:r.description, source:'GitHub' })),
    headers: { 'User-Agent':'mcp-docs/2.0','Accept':'application/vnd.github.v3+json',...(GITHUB_TOKEN ? { 'Authorization': `Bearer ${GITHUB_TOKEN}` } : {}) },
  },
  {
    name: 'Docker Hub', domain: 'hub.docker.com',
    search: q => `https://hub.docker.com/v2/search/repositories/?query=${encodeURIComponent(q)}&page_size=${MAX_RESULTS}`,
    parse: d => (d.results||[]).slice(0,MAX_RESULTS).map(r=>({ title:r.name||r.repo_name, url:`https://hub.docker.com/r/${r.repo_name||r.name}`, excerpt:r.short_description, source:'Docker Hub' })),
  },
  {
    name: 'ReadTheDocs', domain: 'readthedocs.io',
    search: q => `https://readthedocs.org/api/v3/search/?q=${encodeURIComponent(q)}&page_size=${MAX_RESULTS}`,
    parse: d => (d.results||[]).slice(0,MAX_RESULTS).map(r=>({ title:r.title||r.project?.name, url:r.domain||`https://readthedocs.org/projects/${r.project?.slug}/`, excerpt:r.highlights?.content?.[0]||r.project?.description, source:'ReadTheDocs' })),
  },
];

async function searchOfficialApis(query) {
  const results = [];
  for (const api of OFFICIAL_APIS) {
    // Skip if covered by DevDocs
    if (DEVDOCS_DOMAINS.has(api.domain)) continue;
    try {
      const data = await fetchJson(api.search(query), { headers: api.headers });
      const parsed = api.parse(data);
      if (parsed.length > 0) { results.push(...parsed); if (results.length >= MAX_RESULTS) break; }
    } catch (_) {}
  }
  return results.slice(0, MAX_RESULTS);
}

// ── Level 3: SearXNG + nodriver ───────────────────────────────────────────────
async function searchWeb(query) {
  let raw = [];
  try {
    const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&engines=duckduckgo,brave,qwant,wikipedia,stackoverflow&language=en`;
    const data = await fetchJson(url);
    raw = (data.results || []).slice(0, MAX_RESULTS * 3);
  } catch (_) { return []; }

  const results = [];
  for (const r of raw) {
    const domain = getDomain(r.url);

    // Exclude everything covered by levels 1 and 2
    if (DEVDOCS_DOMAINS.has(domain) || API_DOMAINS.has(domain)) continue;

    let content = r.content || '';

    // Fetch nodriver only on level 3 whitelisted domains
    if (LEVEL3_FETCH_DOMAINS.has(domain)) {
      try {
        const html = await fetchText(`${NODRIVER_URL}/content?url=${encodeURIComponent(r.url)}&timeout=${FETCH_TIMEOUT}`);
        content = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
      } catch (_) { content = r.content || ''; }
    }

    results.push({ title: r.title, url: r.url, excerpt: content.slice(0, 300), content, source: `Web (${r.engine||'search'})` });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

// ── Auto-download: language detection via CPU Ollama ──────────────────────────

const VALID_SLUGS = new Set([
  'javascript', 'python', 'react', 'node', 'go', 'rust', 'css', 'html',
  'ruby', 'php', 'typescript', 'vue', 'angular', 'docker', 'git', 'bash',
  'c', 'cpp', 'java', 'kotlin', 'swift', 'django', 'flask', 'express',
  'fastify', 'nextjs', 'svelte', 'tailwindcss', 'postgresql', 'redis',
  'mongodb', 'elasticsearch',
]);

async function detectLanguageViaCPU(query) {
  const slugList = [...VALID_SLUGS].join(', ');
  const prompt = `What is the main programming language or technology for this query? Reply with ONLY one DevDocs slug name from this list: ${slugList}. If none match, reply NONE.\n\nQuery: ${query}`;
  try {
    const postData = JSON.stringify({
      model: process.env.OLLAMA_CPU_MODEL || 'qwen3:0.6b',
      prompt,
      stream: false,
      keep_alive: 0,
      options: { num_gpu: 0, num_predict: 20, temperature: 0 },
    });
    const result = await new Promise((resolve, reject) => {
      const url = new URL(`${OLLAMA_CPU_URL}/api/generate`);
      const t = setTimeout(() => reject(new Error('timeout')), 15000);
      const req = http.request({
        hostname: url.hostname, port: url.port, path: url.pathname,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      }, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => { clearTimeout(t); try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      });
      req.on('error', e => { clearTimeout(t); reject(e); });
      req.write(postData);
      req.end();
    });
    const raw = (result.response || '').toLowerCase().trim().replace(/[^a-z0-9+._-]/g, '');
    if (VALID_SLUGS.has(raw)) return raw;
    // Try to find a valid slug in the response text
    for (const slug of VALID_SLUGS) {
      if ((result.response || '').toLowerCase().includes(slug)) return slug;
    }
    return null;
  } catch (e) {
    process.stderr.write(`[mcp-docs] detectLanguageViaCPU error: ${e.message}\n`);
    return null;
  }
}

async function isDocInstalled(slug) {
  try {
    const status = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 5000);
      const req = http.get(`${DEVDOCS_URL}/docs/${slug}/index.json`, (res) => {
        clearTimeout(t);
        // Consume body to free the socket
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', e => { clearTimeout(t); reject(e); });
    });
    return status === 200;
  } catch (_) {
    return false;
  }
}

async function triggerDocDownload(slug) {
  // Signal the orchestrator/sidecar via stdout with a special prefix
  process.stderr.write(`[devdocs-install] ${slug}\n`);

  // Also attempt a GET to DevDocs download endpoint (some versions support it)
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 10000);
      const req = http.get(`${DEVDOCS_URL}/docs/${slug}/download`, (res) => {
        clearTimeout(t);
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', e => { clearTimeout(t); reject(e); });
    });
    process.stderr.write(`[mcp-docs] triggered download for ${slug} via DevDocs endpoint\n`);
  } catch (e) {
    process.stderr.write(`[mcp-docs] DevDocs download endpoint unavailable for ${slug}: ${e.message}\n`);
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
async function searchDocs(query) {
  let results = await searchDevDocs(query);
  if (results.length > 0) return { results, level: 1, source: 'DevDocs' };

  // Auto-detect language and trigger doc download if missing
  try {
    const slug = await detectLanguageViaCPU(query);
    if (slug) {
      const installed = await isDocInstalled(slug);
      if (!installed) {
        process.stderr.write(`[mcp-docs] doc "${slug}" not installed, triggering download\n`);
        triggerDocDownload(slug); // fire-and-forget, don't await
      } else {
        process.stderr.write(`[mcp-docs] doc "${slug}" already installed\n`);
      }
    }
  } catch (e) {
    process.stderr.write(`[mcp-docs] auto-detect error: ${e.message}\n`);
  }

  results = await searchOfficialApis(query);
  if (results.length > 0) return { results, level: 2, source: 'Official APIs' };

  results = await searchWeb(query);
  return { results, level: 3, source: 'Web (SearXNG + nodriver)' };
}

// ── MCP stdio ─────────────────────────────────────────────────────────────────
const TOOLS = [{
  name: 'search_docs',
  description: [
    'Documentation search — 3-level cascade (strict filtering by coverage):',
    '1. Self-hosted DevDocs: JS/TS, Python, Rust, Go, Ruby, PHP, Java, Docker, React, Vue, Django...',
    '2. Official APIs: npm, PyPI, crates.io, GitHub, Docker Hub, ReadTheDocs',
    '   (skipped if domain already covered by DevDocs)',
    '3. SearXNG (DuckDuckGo/Brave/Qwant) + nodriver on official sites outside levels 1-2',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query'],
  },
}];

const mRes = (id, r) => JSON.stringify({ jsonrpc:'2.0', id, result:r }) + '\n';
const mErr = (id, c, m) => JSON.stringify({ jsonrpc:'2.0', id, error:{ code:c, message:m } }) + '\n';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  const lines = buf.split('\n'); buf = lines.pop();
  for (const l of lines) if (l.trim()) handle(l.trim());
});

async function handle(line) {
  let msg; try { msg = JSON.parse(line); } catch (_) { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    process.stdout.write(mRes(id, { protocolVersion:'2024-11-05', capabilities:{ tools:{} }, serverInfo:{ name:'mcp-docs', version:'2.0.0' } }));
  } else if (method === 'tools/list') {
    process.stdout.write(mRes(id, { tools: TOOLS }));
  } else if (method === 'tools/call') {
    if (params.name !== 'search_docs') { process.stdout.write(mErr(id, -32601, `Unknown tool: ${params.name}`)); return; }
    try {
      const { results, level, source } = await searchDocs(params.arguments.query);
      const text = results.length === 0
        ? `No results for: "${params.arguments.query}"`
        : [`# Results: "${params.arguments.query}"`, `_${source} — level ${level}_`, '',
            ...results.map((r,i) => `## ${i+1}. ${r.title}\n**URL**: ${r.url}\n\n${(r.content||r.excerpt||'').slice(0,1200)}\n`)
          ].join('\n');
      process.stdout.write(mRes(id, { content: [{ type:'text', text }] }));
    } catch (e) { process.stdout.write(mErr(id, -32603, e.message)); }
  } else if (method !== 'notifications/initialized') {
    process.stdout.write(mErr(id, -32601, `Method not found: ${method}`));
  }
}

process.stderr.write('[mcp-docs] v2.0.0 started\n');
