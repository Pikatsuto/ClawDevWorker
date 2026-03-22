#!/usr/bin/env node
/**
 * mcp-docs — Serveur MCP de recherche de documentation
 *
 * Cascade par ordre de priorité :
 *   1. DevDocs self-hosted  → API propre, 100+ docs, zéro réseau externe
 *   2. APIs officielles     → uniquement les domaines NON couverts par DevDocs
 *   3. SearXNG + nodriver   → uniquement les domaines NON couverts par les niveaux 1+2
 *
 * Règle fondamentale : si un domaine est couvert par le niveau N,
 * il est exclu des niveaux N+1, N+2... On ne fetche jamais deux fois la même source.
 */

const http  = require('http');
const https = require('https');

const DEVDOCS_URL   = process.env.DEVDOCS_URL   || 'http://devdocs:9292';
const SEARXNG_URL   = process.env.SEARXNG_URL   || 'http://searxng:8080';
const NODRIVER_URL  = process.env.NODRIVER_URL  || 'http://browserless:3000';
const MAX_RESULTS   = parseInt(process.env.MAX_RESULTS  || '5');
const FETCH_TIMEOUT = parseInt(process.env.FETCH_TIMEOUT || '8000');
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || '';  // optionnel — 60 req/h sans, 5000 avec

// ── Niveau 1 : domaines couverts par DevDocs ──────────────────────────────────
// Exclus des niveaux 2 et 3.
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
  // Frameworks frontend
  'vuejs.org','react.dev','angular.dev','svelte.dev','solidjs.com','alpinejs.dev',
  'astro.build','nuxt.com','nextjs.org','remix.run','vitejs.dev',
  'esbuild.github.io','rollupjs.org','webpack.js.org','parceljs.org','turbo.build',
  'emberjs.com','backbonejs.org',
  // CSS
  'tailwindcss.com','getbootstrap.com','bulma.io','sass-lang.com','postcss.org','lesscss.org',
  // Librairies JS dans DevDocs
  'lodash.com','underscorejs.org','momentjs.com','day.js.org','date-fns.org',
  'rxjs.dev','reactivex.io','d3js.org',
  'jestjs.io','vitest.dev','playwright.dev','cypress.io','testing-library.com',
  'mochajs.org','chaijs.com','sinonjs.org','greensock.com',
  // Frameworks backend dans DevDocs
  'expressjs.com','fastapi.tiangolo.com','flask.palletsprojects.com',
  'djangoproject.com','docs.djangoproject.com','django-rest-framework.org',
  'fastify.dev','nestjs.com','hono.dev','koajs.com','hapijs.com',
  // BDD dans DevDocs
  'postgresql.org','www.postgresql.org','mysql.com','dev.mysql.com',
  'sqlite.org','redis.io','mongodb.com','docs.mongodb.com',
  // DevOps dans DevDocs
  'docs.docker.com','kubernetes.io','helm.sh','nginx.org','nginx.com',
  'apache.org','httpd.apache.org',
  // GNU/Linux dans DevDocs
  'gnu.org','www.gnu.org','man7.org','linux.die.net','git-scm.com','curl.se',
  // AI/ML dans DevDocs
  'pytorch.org','tensorflow.org',
  // Outils dans DevDocs
  'pnpm.io','yarnpkg.com','docs.npmjs.com','babeljs.io','eslint.org','prettier.io','biomejs.dev',
]);

// ── Niveau 2 : domaines couverts par APIs officielles ─────────────────────────
// Exclus du niveau 3 (en plus de DEVDOCS_DOMAINS).
const API_DOMAINS = new Set([
  'npmjs.com','www.npmjs.com','registry.npmjs.org',
  'pypi.org','files.pythonhosted.org',
  'crates.io','static.crates.io',
  'github.com','raw.githubusercontent.com','objects.githubusercontent.com',
  'hub.docker.com',
  'readthedocs.io','readthedocs.org',
]);

// ── Niveau 3 : domaines autorisés au fetch nodriver ──────────────────────────
// Sites officiels tolérant le scraping, NON couverts par les niveaux 1 et 2.
const LEVEL3_FETCH_DOMAINS = new Set([
  // Java / JVM frameworks
  'spring.io','docs.spring.io','quarkus.io','micronaut.io','vertx.io',
  // Kotlin
  'ktor.io',
  // C / C++ / LLVM
  'clang.llvm.org','llvm.org',
  // Rust non couvert par docs.rs
  'rust-unofficial.github.io',
  // Go modules
  'go.googlesource.com',
  // Frameworks backend non dans DevDocs
  'axum.rs','actix.rs','rocket.rs','gin-gonic.com','echo.labstack.com','fiber.wiki',
  'gorilla.github.io','beego.me','aiohttp.readthedocs.io','starlette.io',
  'tortoise-orm.readthedocs.io','pydantic-docs.helpmanual.io','docs.pydantic.dev',
  // BDD non dans DevDocs
  'clickhouse.com','clickhouse.tech','timescale.com','docs.timescale.com',
  'cassandra.apache.org','neo4j.com','docs.neo4j.com',
  'supabase.com','prisma.io','drizzle.team','typeorm.io',
  'sequelize.org','knexjs.org','mikro-orm.io',
  'sqlalchemy.org','docs.sqlalchemy.org','peewee-orm.com',
  // DevOps non dans DevDocs
  'terraform.io','developer.hashicorp.com','ansible.com','docs.ansible.com',
  'traefik.io','doc.traefik.io','caddyserver.com',
  'prometheus.io','grafana.com','opentelemetry.io','jaegertracing.io',
  'www.consul.io','www.vaultproject.io','packer.io','www.vagrantup.com',
  'fluxcd.io','argo-cd.readthedocs.io',
  // Cloud (docs publiques)
  'cloud.google.com','docs.aws.amazon.com',
  'learn.microsoft.com','docs.microsoft.com','azure.microsoft.com',
  // CI/CD
  'docs.github.com','docs.gitlab.com',
  'circleci.com','docs.circleci.com','www.jenkins.io','docs.drone.io','woodpecker-ci.org',
  // Librairies JS non dans DevDocs
  'zod.dev','trpc.io','tanstack.com','swr.vercel.app',
  'zustand-demo.pmnd.rs','jotai.org','valtio.pmnd.rs','mobx.js.org',
  'redux.js.org','immerjs.github.io','socket.io','axios-http.com',
  'formik.org','react-hook-form.com',
  // AI/ML non dans DevDocs
  'huggingface.co','docs.llamaindex.ai','python.langchain.com','ollama.com',
  'scikit-learn.org','keras.io','numpy.org','pandas.pydata.org','matplotlib.org',
  // Outils
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

// ── Niveau 1 : DevDocs ────────────────────────────────────────────────────────
// DevDocs n'a PAS d'API REST de recherche côté serveur — la recherche est
// entièrement client-side. Ce qui existe vraiment sur le serveur Sinatra :
//   GET /docs/<slug>/index.json  → liste des entrées du docset (name, path, type)
//   GET /docs/<slug>/<path>.html → contenu HTML d'une page
//
// Stratégie :
//   1. Charger le manifest global : GET / renvoie le HTML avec les slugs dispo,
//      ou on utilise une liste statique des docsets courants les plus utiles.
//   2. Pour chaque docset candidat, charger son index.json et filtrer par query.
//   3. Fetcher le HTML des entrées matchantes, en extraire le texte.

// Liste des docsets DevDocs prioritaires à interroger en premier.
// Correspondance slug DevDocs → catégorie. Ordre = priorité de recherche.
const DEVDOCS_SLUGS = [
  // Web & standards
  'html', 'css', 'javascript', 'dom', 'http', 'web_extensions',
  // JS runtimes & supersets
  'node', 'node~18_lts', 'node~20_lts', 'node~22_lts',
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
  // Frameworks frontend
  'vue~3', 'react', 'angular', 'svelte', 'astro', 'nuxt~3',
  'next.js', 'vite', 'webpack~5',
  // CSS frameworks
  'tailwindcss', 'bootstrap~5', 'sass',
  // Librairies JS
  'lodash~4', 'd3~7', 'moment', 'rxjs', 'jest', 'vitest',
  'playwright', 'cypress', 'mocha', 'chai',
  // Frameworks backend
  'express', 'fastapi', 'django', 'flask', 'fastify', 'nest',
  // Bases de données
  'postgresql~16', 'mysql', 'sqlite', 'redis',
  // MongoDB
  // DevOps
  'docker', 'kubernetes', 'nginx', 'apache_http_server',
  // Git / outils
  'git', 'gnu_bash', 'gnu_make', 'curl',
  // AI/ML
  'pytorch', 'tensorflow~2',
  // Autres outils
  'eslint', 'prettier', 'babel',
  // Linux man pages
  'man', 'linux',
];

// Cache des index DevDocs (slug → [{name, path, type}])
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

// Recherche fuzzy simple : vérifie si tous les mots de la query sont dans le nom
function matchesQuery(entryName, query) {
  const name = entryName.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  // Match exact en premier
  if (name.includes(query.toLowerCase())) return 2;
  // Match tous les mots
  if (words.every(w => name.includes(w))) return 1;
  // Match partiel (premier mot)
  if (words.length > 0 && name.includes(words[0])) return 0.5;
  return 0;
}

async function searchDevDocs(query) {
  const candidates = []; // { slug, entry, score }

  // Phase 1 : chercher dans les index de chaque docset (en parallèle par batch)
  const BATCH = 8; // charger 8 index à la fois
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
    // Arrêter dès qu'on a assez de bons résultats (score 2 = match exact)
    if (candidates.filter(c => c.score === 2).length >= MAX_RESULTS) break;
  }

  if (candidates.length === 0) return [];

  // Phase 2 : trier par score décroissant, prendre les meilleurs
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, MAX_RESULTS);

  // Phase 3 : fetcher le contenu HTML de chaque entrée
  const results = [];
  for (const { slug, entry } of top) {
    let content = '';
    const pageUrl = `${DEVDOCS_URL}/docs/${slug}/${entry.path}`;
    const publicUrl = `https://devdocs.io/${slug}/${entry.path}`;
    try {
      const html = await fetchText(pageUrl);
      // Extraire le texte brut depuis le HTML (supprimer balises, scripts, styles)
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

// ── Niveau 2 : APIs officielles ───────────────────────────────────────────────
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
    // Skip si couvert par DevDocs
    if (DEVDOCS_DOMAINS.has(api.domain)) continue;
    try {
      const data = await fetchJson(api.search(query), { headers: api.headers });
      const parsed = api.parse(data);
      if (parsed.length > 0) { results.push(...parsed); if (results.length >= MAX_RESULTS) break; }
    } catch (_) {}
  }
  return results.slice(0, MAX_RESULTS);
}

// ── Niveau 3 : SearXNG + nodriver ────────────────────────────────────────────
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

    // Exclure tout ce qui est couvert par les niveaux 1 et 2
    if (DEVDOCS_DOMAINS.has(domain) || API_DOMAINS.has(domain)) continue;

    let content = r.content || '';

    // Fetch nodriver uniquement sur domaines whitelist niveau 3
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

// ── Orchestrateur ─────────────────────────────────────────────────────────────
async function searchDocs(query) {
  let results = await searchDevDocs(query);
  if (results.length > 0) return { results, level: 1, source: 'DevDocs' };

  results = await searchOfficialApis(query);
  if (results.length > 0) return { results, level: 2, source: 'APIs officielles' };

  results = await searchWeb(query);
  return { results, level: 3, source: 'Web (SearXNG + nodriver)' };
}

// ── MCP stdio ─────────────────────────────────────────────────────────────────
const TOOLS = [{
  name: 'search_docs',
  description: [
    'Recherche documentation — cascade 3 niveaux (filtrage strict par couverture) :',
    '1. DevDocs self-hosted : JS/TS, Python, Rust, Go, Ruby, PHP, Java, Docker, React, Vue, Django...',
    '2. APIs officielles : npm, PyPI, crates.io, GitHub, Docker Hub, ReadTheDocs',
    '   (skippé si domaine déjà couvert par DevDocs)',
    '3. SearXNG (DuckDuckGo/Brave/Qwant) + nodriver sur sites officiels hors niveaux 1-2',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Requête de recherche' } },
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
        ? `Aucun résultat pour : "${params.arguments.query}"`
        : [`# Résultats : "${params.arguments.query}"`, `_${source} — niveau ${level}_`, '',
            ...results.map((r,i) => `## ${i+1}. ${r.title}\n**URL** : ${r.url}\n\n${(r.content||r.excerpt||'').slice(0,1200)}\n`)
          ].join('\n');
      process.stdout.write(mRes(id, { content: [{ type:'text', text }] }));
    } catch (e) { process.stdout.write(mErr(id, -32603, e.message)); }
  } else if (method !== 'notifications/initialized') {
    process.stdout.write(mErr(id, -32601, `Method not found: ${method}`));
  }
}

process.stderr.write('[mcp-docs] v2.0.0 started\n');
