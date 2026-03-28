/**
 * analyze.ts — Lightweight AST analysis for codebase-analyze
 * Usage: node analyze.js [file1] [file2] ...
 * Output: JSON index { relPath: { imports, exports, symbols, lines } }
 */

import { readFileSync, existsSync } from 'node:fs';
import { relative, extname } from 'node:path';

interface FileAnalysis {
  imports: string[];
  exports: string[];
  symbols: string[];
  lines: number;
  ext: string;
}

const WORKSPACE = process.env.WORKSPACE ?? process.cwd();
const files = process.argv.slice(2).filter(f => existsSync(f));

if (!files.length) {
  process.stdout.write('{}');
  process.exit(0);
}

const JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.vue', '.mjs', '.cjs']);

const index: Record<string, FileAnalysis> = {};

for (const file of files) {
  try {
    const content = readFileSync(file, 'utf8');
    const relPath = relative(WORKSPACE, file);
    const ext = extname(file);

    const imports: string[] = [];
    const exports: string[] = [];
    const symbols: string[] = [];

    if (JS_EXTENSIONS.has(ext)) {
      const importRe = /(?:^|\n)\s*(?:import(?:\s+\w+,?\s*)?(?:\{[^}]*\})?\s+from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(content)) !== null) imports.push(m[1]!);

      const exportRe = /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g;
      while ((m = exportRe.exec(content)) !== null) exports.push(m[1]!);

      const symRe = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function\*?|class)\s+(\w+)/g;
      while ((m = symRe.exec(content)) !== null) symbols.push(m[1]!);

      const arrowRe = /(?:^|\n)\s*export\s+const\s+(\w+)\s*=\s*(?:async\s+)?\(?/g;
      while ((m = arrowRe.exec(content)) !== null) symbols.push(m[1]!);
    }

    if (ext === '.py') {
      const importRe = /(?:^|\n)\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.,\s]+))/g;
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(content)) !== null) imports.push(m[1] ?? m[2]!);
      const defRe = /(?:^|\n)(?:def|class)\s+(\w+)/g;
      while ((m = defRe.exec(content)) !== null) symbols.push(m[1]!);
    }

    if (ext === '.go') {
      const importRe = /"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(content)) !== null) imports.push(m[1]!);
      const funcRe = /func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/g;
      while ((m = funcRe.exec(content)) !== null) symbols.push(m[1]!);
    }

    const lines = content.split('\n').length;

    index[relPath] = {
      imports: [...new Set(imports)],
      exports: [...new Set(exports)],
      symbols: [...new Set(symbols)],
      lines,
      ext,
    };
  } catch {
    // Unreadable file — silent skip
  }
}

process.stdout.write(JSON.stringify(index, null, 2));
