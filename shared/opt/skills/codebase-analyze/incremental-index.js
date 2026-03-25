#!/usr/bin/env node
/**
 * incremental-index.js — Incremental AST index based on git diff
 *
 * Usage:
 *   node incremental-index.js [--full] [--search <query>] [--impact <file>] [--symbols <name>]
 *
 * Modes:
 *   (no args)         → incremental update from git diff HEAD~1
 *   --full            → full workspace scan (first run or forced)
 *   --search <query>  → semantic search in the index
 *   --impact <file>   → compute the impact radius of a file
 *   --symbols <name>  → find where a symbol is defined/used
 *
 * Index stored in: $PROJECT_DATA_DIR/$PROJECT_NAME/.coderclaw/codebase-index.json
 * Shared across all agents of the same project via the project_data volume.
 */
'use strict';

const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');

const WORKSPACE        = process.env.WORKSPACE      || process.cwd();
const PROJECT_DATA_DIR = process.env.PROJECT_DATA_DIR || '/projects';
const PROJECT_NAME     = process.env.PROJECT_NAME    || path.basename(WORKSPACE);
const MAX_FILES        = parseInt(process.env.INDEX_MAX_FILES || '500');

const INDEX_DIR  = path.join(PROJECT_DATA_DIR, PROJECT_NAME, '.coderclaw');
const INDEX_FILE = path.join(INDEX_DIR, 'codebase-index.json');

fs.mkdirSync(INDEX_DIR, { recursive: true });

// ── Lightweight AST analysis ─────────────────────────────────────────────────

const CODE_EXTENSIONS = new Set([
  '.ts','.tsx','.js','.jsx','.vue','.mjs','.cjs',
  '.py','.go','.rs','.sh','.bash',
]);

const EXCLUDE_DIRS = new Set([
  'node_modules','.git','dist','build','.next','.nuxt',
  '.venv','__pycache__','target','vendor',
]);

function shouldExclude(filePath) {
  return filePath.split(path.sep).some(part => EXCLUDE_DIRS.has(part));
}

function parseFile(absPath) {
  const ext = path.extname(absPath);
  if (!CODE_EXTENSIONS.has(ext)) return null;

  let content;
  try { content = fs.readFileSync(absPath, 'utf8'); }
  catch { return null; }

  const imports = [];
  const exports = [];
  const symbols = [];

  // ── TypeScript / JavaScript / Vue ─────────────────────────────────────────
  if (['.ts','.tsx','.js','.jsx','.vue','.mjs','.cjs'].includes(ext)) {
    const importRe = /(?:^|\n)\s*(?:import(?:\s+[\w{},\s*]+\s+from\s+)?|require\s*\(\s*)['"]([^'"]+)['"]/g;
    let m;
    while ((m = importRe.exec(content)) !== null) imports.push(m[1]);

    const exportRe = /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g;
    while ((m = exportRe.exec(content)) !== null) exports.push(m[1]);

    const symRe = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function\*?|class)\s+(\w+)/g;
    while ((m = symRe.exec(content)) !== null) symbols.push(m[1]);

    const arrowRe = /(?:^|\n)\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(?/g;
    while ((m = arrowRe.exec(content)) !== null) symbols.push(m[1]);
  }

  // ── Python ─────────────────────────────────────────────────────────────────
  if (ext === '.py') {
    const importRe = /(?:^|\n)\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.,\s]+))/g;
    let m;
    while ((m = importRe.exec(content)) !== null) imports.push(m[1] || m[2]);
    const defRe = /(?:^|\n)(?:def|class)\s+(\w+)/g;
    while ((m = defRe.exec(content)) !== null) symbols.push(m[1]);
  }

  // ── Go ─────────────────────────────────────────────────────────────────────
  if (ext === '.go') {
    const importRe = /"([^"]+)"/g;
    let m;
    while ((m = importRe.exec(content)) !== null) imports.push(m[1]);
    const funcRe = /func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/g;
    while ((m = funcRe.exec(content)) !== null) symbols.push(m[1]);
  }

  return {
    imports:  [...new Set(imports)],
    exports:  [...new Set(exports)],
    symbols:  [...new Set(symbols)],
    lines:    content.split('\n').length,
    ext,
    mtime:    fs.statSync(absPath).mtimeMs,
  };
}

// ── List files ──────────────────────────────────────────────────────────────

function listFiles(dir, collected = []) {
  if (collected.length >= MAX_FILES) return collected;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return collected; }

  for (const e of entries) {
    if (EXCLUDE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      listFiles(full, collected);
    } else if (e.isFile() && CODE_EXTENSIONS.has(path.extname(e.name))) {
      collected.push(full);
    }
  }
  return collected;
}

// ── Load / save index ────────────────────────────────────────────────────────

function loadIndex() {
  try {
    if (fs.existsSync(INDEX_FILE)) {
      const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      return raw;
    }
  } catch {}
  return { files: {}, lastCommit: '', generatedAt: '', totalFiles: 0 };
}

function saveIndex(index) {
  index.generatedAt = new Date().toISOString();
  index.totalFiles  = Object.keys(index.files).length;
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

// ── Full scan ─────────────────────────────────────────────────────────────────

function fullScan() {
  console.log(`[codebase-index] Full scan of ${WORKSPACE}...`);
  const files  = listFiles(WORKSPACE);
  const index  = loadIndex();
  index.files  = {};
  let parsed   = 0;

  for (const absPath of files) {
    const relPath = path.relative(WORKSPACE, absPath);
    if (shouldExclude(relPath)) continue;
    const info = parseFile(absPath);
    if (info) { index.files[relPath] = info; parsed++; }
  }

  try {
    index.lastCommit = execSync('git rev-parse HEAD', { cwd: WORKSPACE, encoding: 'utf8' }).trim();
  } catch {}

  saveIndex(index);
  console.log(`[codebase-index] ${parsed} files indexed → ${INDEX_FILE}`);
  return index;
}

// ── Incremental update ───────────────────────────────────────────────────────

function incrementalUpdate() {
  const index = loadIndex();

  // If no index or no last commit → full scan
  if (!index.lastCommit || Object.keys(index.files).length === 0) {
    return fullScan();
  }

  let changedFiles = [];
  try {
    // Files modified since the last indexed commit
    const diff = execSync(
      `git diff --name-only ${index.lastCommit} HEAD`,
      { cwd: WORKSPACE, encoding: 'utf8' }
    ).trim();
    changedFiles = diff ? diff.split('\n').filter(Boolean) : [];

    // Uncommitted files (staged + unstaged)
    const status = execSync('git status --short', { cwd: WORKSPACE, encoding: 'utf8' }).trim();
    const statusFiles = status
      ? status.split('\n').map(l => l.slice(3).trim()).filter(Boolean)
      : [];

    changedFiles = [...new Set([...changedFiles, ...statusFiles])];
  } catch {
    // No git → full scan
    return fullScan();
  }

  if (changedFiles.length === 0) {
    console.log('[codebase-index] No changes since the last index.');
    return index;
  }

  console.log(`[codebase-index] Incremental update: ${changedFiles.length} files`);

  let updated = 0;
  for (const relPath of changedFiles) {
    const absPath = path.join(WORKSPACE, relPath);
    const ext     = path.extname(relPath);

    if (!CODE_EXTENSIONS.has(ext)) continue;
    if (shouldExclude(relPath)) continue;

    if (!fs.existsSync(absPath)) {
      // File deleted
      delete index.files[relPath];
      console.log(`  ✗ deleted: ${relPath}`);
    } else {
      const info = parseFile(absPath);
      if (info) {
        index.files[relPath] = info;
        console.log(`  ↻ updated: ${relPath}`);
        updated++;
      }
    }
  }

  try {
    index.lastCommit = execSync('git rev-parse HEAD', { cwd: WORKSPACE, encoding: 'utf8' }).trim();
  } catch {}

  saveIndex(index);
  console.log(`[codebase-index] ${updated} files updated. Total: ${Object.keys(index.files).length}`);
  return index;
}

// ── Semantic search ──────────────────────────────────────────────────────────

function search(query) {
  const index  = loadIndex();
  const q      = query.toLowerCase();
  const results = [];

  for (const [relPath, info] of Object.entries(index.files)) {
    const score = (
      (relPath.toLowerCase().includes(q)           ? 3 : 0) +
      (info.symbols.some(s => s.toLowerCase().includes(q)) ? 2 : 0) +
      (info.exports.some(e => e.toLowerCase().includes(q)) ? 2 : 0) +
      (info.imports.some(i => i.toLowerCase().includes(q)) ? 1 : 0)
    );
    if (score > 0) results.push({ relPath, score, info });
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, 10);

  console.log(`\n=== Search: "${query}" — ${top.length} results ===\n`);
  for (const { relPath, score, info } of top) {
    const matchSyms = info.symbols.filter(s => s.toLowerCase().includes(q));
    const matchExps = info.exports.filter(e => e.toLowerCase().includes(q));
    console.log(`[${score}] ${relPath} (${info.lines} lines)`);
    if (matchSyms.length) console.log(`  Symbols: ${matchSyms.join(', ')}`);
    if (matchExps.length) console.log(`  Exports: ${matchExps.join(', ')}`);
    console.log('');
  }
  return top;
}

// ── Impact radius ─────────────────────────────────────────────────────────────

function impact(targetRelPath) {
  const index   = loadIndex();
  const target  = targetRelPath.replace(/\\/g, '/');
  const targetBase = path.basename(target).replace(/\.(ts|js|tsx|jsx|vue|py|go)$/, '');
  const impacted = [];

  for (const [relPath, info] of Object.entries(index.files)) {
    if (relPath === target) continue;
    const importsTarget = info.imports.some(imp => {
      const impBase = imp.split('/').pop();
      return imp.includes(target.replace(/\.(ts|js)$/, '')) ||
             impBase === targetBase ||
             imp.endsWith(`/${targetBase}`);
    });
    if (importsTarget) impacted.push(relPath);
  }

  console.log(`\n=== Impact radius: ${target} ===`);
  console.log(`${impacted.length} impacted file(s):`);
  impacted.forEach(f => console.log(`  - ${f}`));

  const targetInfo = index.files[target];
  if (targetInfo) {
    console.log(`\nExported symbols: ${targetInfo.exports.join(', ') || '(none)'}`);
    console.log(`Defined symbols:  ${targetInfo.symbols.join(', ') || '(none)'}`);
  }
  return impacted;
}

// ── Symbol search ────────────────────────────────────────────────────────────

function findSymbol(name) {
  const index   = loadIndex();
  const defined = [];
  const used    = [];

  for (const [relPath, info] of Object.entries(index.files)) {
    if (info.symbols.includes(name) || info.exports.includes(name)) {
      defined.push(relPath);
    }
    if (info.imports.some(i => i.includes(name))) {
      used.push(relPath);
    }
  }

  console.log(`\n=== Symbol: ${name} ===`);
  console.log(`Defined in: ${defined.join(', ') || '(not found)'}`);
  console.log(`Used in: ${used.length ? used.join(', ') : '(no direct import found)'}`);
  return { defined, used };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--full')) {
  fullScan();
} else if (args.includes('--search')) {
  const q = args[args.indexOf('--search') + 1];
  if (!q) { console.error('Usage: --search <query>'); process.exit(1); }
  search(q);
} else if (args.includes('--impact')) {
  const f = args[args.indexOf('--impact') + 1];
  if (!f) { console.error('Usage: --impact <file>'); process.exit(1); }
  impact(f);
} else if (args.includes('--symbols')) {
  const s = args[args.indexOf('--symbols') + 1];
  if (!s) { console.error('Usage: --symbols <name>'); process.exit(1); }
  findSymbol(s);
} else {
  // Default: incremental update
  incrementalUpdate();
}
