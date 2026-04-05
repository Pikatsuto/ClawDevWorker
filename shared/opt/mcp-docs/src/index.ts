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

import { get as httpGet, request as httpRequest } from 'node:http';
import { get as httpsGet } from 'node:https';

// ── Config ───────────────────────────────────────────────────────────────────

const DEVDOCS_URL = process.env.DEVDOCS_URL ?? 'http://devdocs:9292';
const SEARXNG_URL = process.env.SEARXNG_URL ?? 'http://searxng:8080';
const NODRIVER_URL = process.env.NODRIVER_URL ?? 'http://browserless:3000';
const MAX_RESULTS = parseInt(process.env.MAX_RESULTS ?? '5');
const FETCH_TIMEOUT = parseInt(process.env.FETCH_TIMEOUT ?? '8000');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const OLLAMA_CPU_URL = process.env.OLLAMA_CPU_URL ?? 'http://ollama-cpu:11434';

// ── Types ────────────────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  excerpt: string;
  content?: string;
  source: string;
}

interface SearchResponse {
  results: SearchResult[];
  level: number;
  source: string;
}

interface DevDocsEntry {
  name: string;
  path: string;
  type?: string;
}

interface OfficialApi {
  name: string;
  domain: string;
  search: (q: string) => string;
  parse: (d: Record<string, unknown>) => SearchResult[];
  headers?: Record<string, string>;
}

interface JsonRpcMessage {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

// ── Level 1: domains covered by DevDocs ──────────────────────────────────────

const DEVDOCS_DOMAINS = new Set([
  'developer.mozilla.org', 'w3.org', 'whatwg.org', 'tc39.es',
  'nodejs.org', 'deno.land', 'bun.sh', 'typescriptlang.org', 'jsr.io', 'coffeescript.org',
  'docs.python.org', 'peps.python.org', 'packaging.python.org',
  'doc.rust-lang.org', 'docs.rs', 'rust-lang.github.io',
  'pkg.go.dev', 'go.dev', 'golang.org',
  'ruby-lang.org', 'docs.ruby-lang.org', 'api.rubyonrails.org', 'guides.rubyonrails.org',
  'php.net', 'www.php.net', 'laravel.com', 'docs.laravel.com',
  'docs.oracle.com', 'openjdk.org',
  'kotlinlang.org',
  'en.cppreference.com', 'gcc.gnu.org',
  'swift.org', 'docs.swift.org', 'dart.dev', 'api.flutter.dev',
  'elixir-lang.org', 'hexdocs.pm', 'haskell.org', 'scala-lang.org', 'erlang.org',
  'vuejs.org', 'react.dev', 'angular.dev', 'svelte.dev', 'solidjs.com', 'alpinejs.dev',
  'astro.build', 'nuxt.com', 'nextjs.org', 'remix.run', 'vitejs.dev',
  'esbuild.github.io', 'rollupjs.org', 'webpack.js.org', 'parceljs.org', 'turbo.build',
  'emberjs.com', 'backbonejs.org',
  'tailwindcss.com', 'getbootstrap.com', 'bulma.io', 'sass-lang.com', 'postcss.org', 'lesscss.org',
  'lodash.com', 'underscorejs.org', 'momentjs.com', 'day.js.org', 'date-fns.org',
  'rxjs.dev', 'reactivex.io', 'd3js.org',
  'jestjs.io', 'vitest.dev', 'playwright.dev', 'cypress.io', 'testing-library.com',
  'mochajs.org', 'chaijs.com', 'sinonjs.org', 'greensock.com',
  'expressjs.com', 'fastapi.tiangolo.com', 'flask.palletsprojects.com',
  'djangoproject.com', 'docs.djangoproject.com', 'django-rest-framework.org',
  'fastify.dev', 'nestjs.com', 'hono.dev', 'koajs.com', 'hapijs.com',
  'postgresql.org', 'www.postgresql.org', 'mysql.com', 'dev.mysql.com',
  'sqlite.org', 'redis.io', 'mongodb.com', 'docs.mongodb.com',
  'docs.docker.com', 'kubernetes.io', 'helm.sh', 'nginx.org', 'nginx.com',
  'apache.org', 'httpd.apache.org',
  'gnu.org', 'www.gnu.org', 'man7.org', 'linux.die.net', 'git-scm.com', 'curl.se',
  'pytorch.org', 'tensorflow.org',
  'pnpm.io', 'yarnpkg.com', 'docs.npmjs.com', 'babeljs.io', 'eslint.org', 'prettier.io', 'biomejs.dev',
]);

// ── Level 2: domains covered by official APIs ────────────────────────────────

const API_DOMAINS = new Set([
  'npmjs.com', 'www.npmjs.com', 'registry.npmjs.org',
  'pypi.org', 'files.pythonhosted.org',
  'crates.io', 'static.crates.io',
  'github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com',
  'hub.docker.com',
  'readthedocs.io', 'readthedocs.org',
]);

// ── Level 3: domains allowed for nodriver fetch ──────────────────────────────

const LEVEL3_FETCH_DOMAINS = new Set([
  'spring.io', 'docs.spring.io', 'quarkus.io', 'micronaut.io', 'vertx.io',
  'ktor.io',
  'clang.llvm.org', 'llvm.org',
  'rust-unofficial.github.io',
  'go.googlesource.com',
  'axum.rs', 'actix.rs', 'rocket.rs', 'gin-gonic.com', 'echo.labstack.com', 'fiber.wiki',
  'gorilla.github.io', 'beego.me', 'aiohttp.readthedocs.io', 'starlette.io',
  'tortoise-orm.readthedocs.io', 'pydantic-docs.helpmanual.io', 'docs.pydantic.dev',
  'clickhouse.com', 'clickhouse.tech', 'timescale.com', 'docs.timescale.com',
  'cassandra.apache.org', 'neo4j.com', 'docs.neo4j.com',
  'supabase.com', 'prisma.io', 'drizzle.team', 'typeorm.io',
  'sequelize.org', 'knexjs.org', 'mikro-orm.io',
  'sqlalchemy.org', 'docs.sqlalchemy.org', 'peewee-orm.com',
  'terraform.io', 'developer.hashicorp.com', 'ansible.com', 'docs.ansible.com',
  'traefik.io', 'doc.traefik.io', 'caddyserver.com',
  'prometheus.io', 'grafana.com', 'opentelemetry.io', 'jaegertracing.io',
  'www.consul.io', 'www.vaultproject.io', 'packer.io', 'www.vagrantup.com',
  'fluxcd.io', 'argo-cd.readthedocs.io',
  'cloud.google.com', 'docs.aws.amazon.com',
  'learn.microsoft.com', 'docs.microsoft.com', 'azure.microsoft.com',
  'docs.github.com', 'docs.gitlab.com',
  'circleci.com', 'docs.circleci.com', 'www.jenkins.io', 'docs.drone.io', 'woodpecker-ci.org',
  'zod.dev', 'trpc.io', 'tanstack.com', 'swr.vercel.app',
  'zustand-demo.pmnd.rs', 'jotai.org', 'valtio.pmnd.rs', 'mobx.js.org',
  'redux.js.org', 'immerjs.github.io', 'socket.io', 'axios-http.com',
  'formik.org', 'react-hook-form.com',
  'huggingface.co', 'docs.llamaindex.ai', 'python.langchain.com', 'ollama.com',
  'scikit-learn.org', 'keras.io', 'numpy.org', 'pandas.pydata.org', 'matplotlib.org',
  'jqlang.github.io', 'stedolan.github.io', 'tldp.org',
  'ecma-international.org', 'whatwg.org', 'tc39.es', 'w3.org',
  'rubygems.org',
  'stackoverflow.com', 'unix.stackexchange.com', 'serverfault.com',
  'superuser.com', 'askubuntu.com', 'security.stackexchange.com',
  'en.wikipedia.org', 'fr.wikipedia.org',
  'wiki.archlinux.org', 'wiki.gentoo.org', 'docs.kernel.org',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

const getDomain = (url: string): string => {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
};

const fetchJson = (url: string, opts: { headers?: Record<string, string> | undefined } = {}): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? httpsGet : httpGet;
    const t = setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT);
    mod(url, { headers: opts.headers ?? {} }, res => {
      let body = '';
      res.on('data', (d: string) => body += d);
      res.on('end', () => {
        clearTimeout(t);
        try { resolve(JSON.parse(body) as Record<string, unknown>); }
        catch (e) { reject(e); }
      });
    }).on('error', e => { clearTimeout(t); reject(e); });
  });

const fetchText = (url: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? httpsGet : httpGet;
    const t = setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT);
    mod(url, res => {
      let body = '';
      res.on('data', (d: string) => body += d);
      res.on('end', () => { clearTimeout(t); resolve(body); });
    }).on('error', e => { clearTimeout(t); reject(e); });
  });

const stripHtml = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

// ── Level 1: DevDocs ────────────────────────────────────────────────────────

const DEVDOCS_SLUGS = [
  'html', 'css', 'javascript', 'dom', 'http', 'web_extensions',
  'node', 'node~20_lts', 'node~22_lts', 'node~24_lts',
  'typescript', 'deno', 'bun',
  'python~3.12', 'python~3.11', 'python~3.10',
  'rust', 'go',
  'ruby', 'ruby~3.3', 'rails~7.2',
  'php', 'laravel~11',
  'openjdk~21', 'openjdk~17',
  'kotlin', 'swift', 'dart~3',
  'c', 'cpp',
  'vue~3', 'react', 'angular', 'svelte', 'astro', 'nuxt~3',
  'next.js', 'vite', 'webpack~5',
  'tailwindcss', 'bootstrap~5', 'sass',
  'lodash~4', 'd3~7', 'moment', 'rxjs', 'jest', 'vitest',
  'playwright', 'cypress', 'mocha', 'chai',
  'express', 'fastapi', 'django', 'flask', 'fastify', 'nest',
  'postgresql~16', 'mysql', 'sqlite', 'redis',
  'docker', 'kubernetes', 'nginx', 'apache_http_server',
  'git', 'gnu_bash', 'gnu_make', 'curl',
  'pytorch', 'tensorflow~2',
  'eslint', 'prettier', 'babel',
  'man', 'linux',
];

const devdocsIndexCache = new Map<string, DevDocsEntry[]>();

const fetchDevDocsIndex = async (slug: string): Promise<DevDocsEntry[]> => {
  const cached = devdocsIndexCache.get(slug);
  if (cached) return cached;
  try {
    const data = await fetchJson(`${DEVDOCS_URL}/docs/${slug}/index.json`);
    const entries = (data.entries ?? []) as DevDocsEntry[];
    devdocsIndexCache.set(slug, entries);
    return entries;
  } catch {
    devdocsIndexCache.set(slug, []);
    return [];
  }
};

const matchesQuery = (entryName: string, query: string): number => {
  const name = entryName.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (name.includes(query.toLowerCase())) return 2;
  if (words.every(w => name.includes(w))) return 1;
  if (words.length > 0 && name.includes(words[0]!)) return 0.5;
  return 0;
};

const searchDevDocs = async (query: string): Promise<SearchResult[]> => {
  const candidates: { slug: string; entry: DevDocsEntry; score: number }[] = [];

  const BATCH = 8;
  for (let i = 0; i < DEVDOCS_SLUGS.length; i += BATCH) {
    const batch = DEVDOCS_SLUGS.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async slug => {
        const entries = await fetchDevDocsIndex(slug);
        for (const entry of entries) {
          const score = matchesQuery(entry.name, query);
          if (score > 0) candidates.push({ slug, entry, score });
        }
      }),
    );
    if (candidates.filter(c => c.score === 2).length >= MAX_RESULTS) break;
  }

  if (candidates.length === 0) return [];

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, MAX_RESULTS);

  const results: SearchResult[] = [];
  for (const { slug, entry } of top) {
    let content = '';
    const pageUrl = `${DEVDOCS_URL}/docs/${slug}/${entry.path}`;
    const publicUrl = `https://devdocs.io/${slug}/${entry.path}`;
    try {
      const html = await fetchText(pageUrl);
      content = stripHtml(html).slice(0, 800);
    } catch { /* empty */ }
    results.push({
      title: `[${slug}] ${entry.name}`,
      url: publicUrl,
      excerpt: content.slice(0, 300) || entry.name,
      content,
      source: 'DevDocs',
    });
  }
  return results;
};

// ── Level 2: Official APIs ──────────────────────────────────────────────────

const OFFICIAL_APIS: OfficialApi[] = [
  {
    name: 'MDN', domain: 'developer.mozilla.org',
    search: (q: string) => `https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(q)}&locale=en-US`,
    parse: (d) => ((d.documents ?? []) as Array<Record<string, unknown>>).slice(0, MAX_RESULTS).map(x => ({
      title: x.title as string, url: `https://developer.mozilla.org${x.mdn_url}`, excerpt: x.summary as string, source: 'MDN',
    })),
  },
  {
    name: 'npm', domain: 'npmjs.com',
    search: (q: string) => `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=${MAX_RESULTS}`,
    parse: (d) => ((d.objects ?? []) as Array<Record<string, unknown>>).slice(0, MAX_RESULTS).map(o => {
      const pkg = (o as Record<string, unknown>).package as Record<string, unknown>;
      return { title: pkg.name as string, url: `https://www.npmjs.com/package/${pkg.name}`, excerpt: pkg.description as string, source: 'npm' };
    }),
  },
  {
    name: 'PyPI', domain: 'pypi.org',
    search: (q: string) => `https://pypi.org/pypi/${encodeURIComponent(q.split(' ')[0]!)}/json`,
    parse: (d) => {
      const info = d.info as Record<string, unknown> | undefined;
      return info ? [{ title: `${info.name} ${info.version}`, url: `https://pypi.org/project/${info.name}/`, excerpt: info.summary as string, source: 'PyPI' }] : [];
    },
  },
  {
    name: 'crates.io', domain: 'crates.io',
    search: (q: string) => `https://crates.io/api/v1/crates?q=${encodeURIComponent(q)}&per_page=${MAX_RESULTS}`,
    parse: (d) => ((d.crates ?? []) as Array<Record<string, unknown>>).slice(0, MAX_RESULTS).map(c => ({
      title: c.name as string, url: `https://crates.io/crates/${c.name}`, excerpt: c.description as string, source: 'crates.io',
    })),
    headers: { 'User-Agent': 'mcp-docs/2.0' },
  },
  {
    name: 'GitHub', domain: 'github.com',
    search: (q: string) => `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=${MAX_RESULTS}`,
    parse: (d) => ((d.items ?? []) as Array<Record<string, unknown>>).slice(0, MAX_RESULTS).map(r => ({
      title: r.full_name as string, url: r.html_url as string, excerpt: r.description as string, source: 'GitHub',
    })),
    headers: { 'User-Agent': 'mcp-docs/2.0', 'Accept': 'application/vnd.github.v3+json', ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}) },
  },
  {
    name: 'Docker Hub', domain: 'hub.docker.com',
    search: (q: string) => `https://hub.docker.com/v2/search/repositories/?query=${encodeURIComponent(q)}&page_size=${MAX_RESULTS}`,
    parse: (d) => ((d.results ?? []) as Array<Record<string, unknown>>).slice(0, MAX_RESULTS).map(r => ({
      title: (r.name ?? r.repo_name) as string, url: `https://hub.docker.com/r/${(r.repo_name ?? r.name) as string}`, excerpt: r.short_description as string, source: 'Docker Hub',
    })),
  },
  {
    name: 'ReadTheDocs', domain: 'readthedocs.io',
    search: (q: string) => `https://readthedocs.org/api/v3/search/?q=${encodeURIComponent(q)}&page_size=${MAX_RESULTS}`,
    parse: (d) => ((d.results ?? []) as Array<Record<string, unknown>>).slice(0, MAX_RESULTS).map(r => {
      const project = r.project as Record<string, unknown> | undefined;
      const highlights = r.highlights as Record<string, unknown> | undefined;
      return {
        title: (r.title ?? project?.name) as string,
        url: (r.domain ?? `https://readthedocs.org/projects/${project?.slug}/`) as string,
        excerpt: ((highlights?.content as string[])?.at(0) ?? project?.description) as string,
        source: 'ReadTheDocs',
      };
    }),
  },
];

const searchOfficialApis = async (query: string): Promise<SearchResult[]> => {
  const results: SearchResult[] = [];
  for (const api of OFFICIAL_APIS) {
    if (DEVDOCS_DOMAINS.has(api.domain)) continue;
    try {
      const data = await fetchJson(api.search(query), { headers: api.headers });
      const parsed = api.parse(data);
      if (parsed.length > 0) {
        results.push(...parsed);
        if (results.length >= MAX_RESULTS) break;
      }
    } catch { /* empty */ }
  }
  return results.slice(0, MAX_RESULTS);
};

// ── Level 3: SearXNG + nodriver ─────────────────────────────────────────────

const searchWeb = async (query: string): Promise<SearchResult[]> => {
  let raw: Array<Record<string, unknown>> = [];
  try {
    const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&engines=duckduckgo,brave,qwant,wikipedia,stackoverflow&language=en`;
    const data = await fetchJson(url);
    raw = ((data.results ?? []) as Array<Record<string, unknown>>).slice(0, MAX_RESULTS * 3);
  } catch { return []; }

  const results: SearchResult[] = [];
  for (const r of raw) {
    const domain = getDomain(r.url as string);
    if (DEVDOCS_DOMAINS.has(domain) || API_DOMAINS.has(domain)) continue;

    let content = (r.content as string) ?? '';

    if (LEVEL3_FETCH_DOMAINS.has(domain)) {
      try {
        const html = await fetchText(`${NODRIVER_URL}/content?url=${encodeURIComponent(r.url as string)}&timeout=${FETCH_TIMEOUT}`);
        content = stripHtml(html).slice(0, 1500);
      } catch { content = (r.content as string) ?? ''; }
    }

    results.push({
      title: r.title as string,
      url: r.url as string,
      excerpt: content.slice(0, 300),
      content,
      source: `Web (${(r.engine as string) ?? 'search'})`,
    });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
};

// ── Auto-download: language detection via CPU Ollama ────────────────────────

const VALID_SLUGS = new Set([
  'javascript', 'python', 'react', 'node', 'go', 'rust', 'css', 'html',
  'ruby', 'php', 'typescript', 'vue', 'angular', 'docker', 'git', 'bash',
  'c', 'cpp', 'java', 'kotlin', 'swift', 'django', 'flask', 'express',
  'fastify', 'nextjs', 'svelte', 'tailwindcss', 'postgresql', 'redis',
  'mongodb', 'elasticsearch',
]);

const detectLanguageViaCPU = async (query: string): Promise<string | null> => {
  const slugList = [...VALID_SLUGS].join(', ');
  const prompt = `What is the main programming language or technology for this query? Reply with ONLY one DevDocs slug name from this list: ${slugList}. If none match, reply NONE.\n\nQuery: ${query}`;
  try {
    const postData = JSON.stringify({
      model: process.env.OLLAMA_CPU_MODEL ?? 'qwen3:0.6b',
      prompt,
      stream: false,
      keep_alive: 0,
      options: { num_gpu: 0, num_predict: 20, temperature: 0 },
    });

    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const url = new URL(`${OLLAMA_CPU_URL}/api/generate`);
      const t = setTimeout(() => reject(new Error('timeout')), 15000);
      const req = httpRequest({
        hostname: url.hostname, port: url.port, path: url.pathname,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData).toString() },
      }, res => {
        let body = '';
        res.on('data', (d: string) => body += d);
        res.on('end', () => { clearTimeout(t); try { resolve(JSON.parse(body) as Record<string, unknown>); } catch (e) { reject(e); } });
      });
      req.on('error', e => { clearTimeout(t); reject(e); });
      req.write(postData);
      req.end();
    });

    const raw = ((result.response as string) ?? '').toLowerCase().trim().replace(/[^a-z0-9+._-]/g, '');
    if (VALID_SLUGS.has(raw as typeof VALID_SLUGS extends Set<infer T> ? T : never)) return raw;
    for (const slug of VALID_SLUGS) {
      if (((result.response as string) ?? '').toLowerCase().includes(slug)) return slug;
    }
    return null;
  } catch (e) {
    process.stderr.write(`[mcp-docs] detectLanguageViaCPU error: ${(e as Error).message}\n`);
    return null;
  }
};

const isDocInstalled = async (slug: string): Promise<boolean> => {
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 5000);
      httpGet(`${DEVDOCS_URL}/docs/${slug}/index.json`, res => {
        clearTimeout(t);
        res.resume();
        resolve(res.statusCode!);
      }).on('error', e => { clearTimeout(t); reject(e); });
    });
    return status === 200;
  } catch { return false; }
};

const triggerDocDownload = async (slug: string): Promise<void> => {
  process.stderr.write(`[devdocs-install] ${slug}\n`);
  try {
    await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 10000);
      httpGet(`${DEVDOCS_URL}/docs/${slug}/download`, res => {
        clearTimeout(t);
        res.resume();
        resolve(res.statusCode!);
      }).on('error', e => { clearTimeout(t); reject(e); });
    });
    process.stderr.write(`[mcp-docs] triggered download for ${slug} via DevDocs endpoint\n`);
  } catch (e) {
    process.stderr.write(`[mcp-docs] DevDocs download endpoint unavailable for ${slug}: ${(e as Error).message}\n`);
  }
};

// ── Orchestrator ────────────────────────────────────────────────────────────

const searchDocs = async (query: string): Promise<SearchResponse> => {
  let results = await searchDevDocs(query);
  if (results.length > 0) return { results, level: 1, source: 'DevDocs' };

  try {
    const slug = await detectLanguageViaCPU(query);
    if (slug) {
      const installed = await isDocInstalled(slug);
      if (!installed) {
        process.stderr.write(`[mcp-docs] doc "${slug}" not installed, triggering download\n`);
        triggerDocDownload(slug);
      } else {
        process.stderr.write(`[mcp-docs] doc "${slug}" already installed\n`);
      }
    }
  } catch (e) {
    process.stderr.write(`[mcp-docs] auto-detect error: ${(e as Error).message}\n`);
  }

  results = await searchOfficialApis(query);
  if (results.length > 0) return { results, level: 2, source: 'Official APIs' };

  results = await searchWeb(query);
  return { results, level: 3, source: 'Web (SearXNG + nodriver)' };
};

// ── MCP stdio ───────────────────────────────────────────────────────────────

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

const mRes = (id: number, r: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id, result: r }) + '\n';

const mErr = (id: number, c: number, m: string): string =>
  JSON.stringify({ jsonrpc: '2.0', id, error: { code: c, message: m } }) + '\n';

const handle = async (line: string): Promise<void> => {
  let msg: JsonRpcMessage;
  try { msg = JSON.parse(line) as JsonRpcMessage; } catch { return; }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    process.stdout.write(mRes(id!, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mcp-docs', version: '2.0.0' } }));
  } else if (method === 'tools/list') {
    process.stdout.write(mRes(id!, { tools: TOOLS }));
  } else if (method === 'tools/call') {
    const args = (params as Record<string, unknown>)?.arguments as Record<string, unknown> | undefined;
    if ((params as Record<string, unknown>)?.name !== 'search_docs') {
      process.stdout.write(mErr(id!, -32601, `Unknown tool: ${(params as Record<string, unknown>)?.name}`));
      return;
    }
    try {
      const { results, level, source } = await searchDocs(args?.query as string);
      const text = results.length === 0
        ? `No results for: "${args?.query}"`
        : [
            `# Results: "${args?.query}"`,
            `_${source} — level ${level}_`,
            '',
            ...results.map((r, i) => `## ${i + 1}. ${r.title}\n**URL**: ${r.url}\n\n${(r.content ?? r.excerpt ?? '').slice(0, 1200)}\n`),
          ].join('\n');
      process.stdout.write(mRes(id!, { content: [{ type: 'text', text }] }));
    } catch (e) {
      process.stdout.write(mErr(id!, -32603, (e as Error).message));
    }
  } else if (method !== 'notifications/initialized') {
    process.stdout.write(mErr(id!, -32601, `Method not found: ${method}`));
  }
};

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop()!;
  for (const l of lines) if (l.trim()) handle(l.trim());
});

// Keep the process alive even when stdin closes (container without tty)
process.stdin.on('end', () => {
  process.stderr.write('[mcp-docs] stdin closed — staying alive for container healthcheck\n');
});
setInterval(() => {}, 1 << 30); // prevent event loop from exiting

process.stderr.write('[mcp-docs] v2.0.0 started\n');
