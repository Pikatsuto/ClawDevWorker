#!/usr/bin/env node
/**
 * analyze.js — Lightweight AST analysis for codebase-analyze
 * Usage: node analyze.js [file1] [file2] ...
 * Output: JSON index { relPath: { imports, exports, symbols, lines } }
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const WORKSPACE = process.env.WORKSPACE || process.cwd();
const files     = process.argv.slice(2).filter(f => fs.existsSync(f));

if (!files.length) {
  process.stdout.write('{}');
  process.exit(0);
}

const index = {};

for (const file of files) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const relPath = path.relative(WORKSPACE, file);
    const ext     = path.extname(file);

    const imports = [];
    const exports = [];
    const symbols = [];

    // ── TypeScript / JavaScript / Vue ──────────────────────────────────────
    if (['.ts','.tsx','.js','.jsx','.vue','.mjs','.cjs'].includes(ext)) {
      // Imports ES6 + require
      const importRe = /(?:^|\n)\s*(?:import(?:\s+\w+,?\s*)?(?:\{[^}]*\})?\s+from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g;
      let m;
      while ((m = importRe.exec(content)) !== null) imports.push(m[1]);

      // Named exports
      const exportRe = /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g;
      while ((m = exportRe.exec(content)) !== null) exports.push(m[1]);

      // Symbols (functions + classes)
      const symRe = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function\*?|class)\s+(\w+)/g;
      while ((m = symRe.exec(content)) !== null) symbols.push(m[1]);

      // Exported const arrow functions
      const arrowRe = /(?:^|\n)\s*export\s+const\s+(\w+)\s*=\s*(?:async\s+)?\(?/g;
      while ((m = arrowRe.exec(content)) !== null) symbols.push(m[1]);
    }

    // ── Python ─────────────────────────────────────────────────────────────
    if (ext === '.py') {
      const importRe = /(?:^|\n)\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.,\s]+))/g;
      let m;
      while ((m = importRe.exec(content)) !== null) imports.push(m[1] || m[2]);
      const defRe = /(?:^|\n)(?:def|class)\s+(\w+)/g;
      while ((m = defRe.exec(content)) !== null) symbols.push(m[1]);
    }

    // ── Go ─────────────────────────────────────────────────────────────────
    if (ext === '.go') {
      const importRe = /"([^"]+)"/g;
      let m;
      while ((m = importRe.exec(content)) !== null) imports.push(m[1]);
      const funcRe = /func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/g;
      while ((m = funcRe.exec(content)) !== null) symbols.push(m[1]);
    }

    const lines = content.split('\n').length;

    index[relPath] = {
      imports:  [...new Set(imports)],
      exports:  [...new Set(exports)],
      symbols:  [...new Set(symbols)],
      lines,
      ext,
    };
  } catch(e) {
    // Unreadable file — silent skip
  }
}

process.stdout.write(JSON.stringify(index, null, 2));
