/**
 * learn-injector — Heuristic trigger matching + 0.8b extraction for learns
 *
 * Two-phase injection:
 *   1. matchTriggers(message, learnsDir) → pure regex/keyword match on YAML triggers (0ms)
 *   2. extractRelevant(message, learnContent, ollamaCpuUrl) → 0.8b selects relevant passages
 *      Returns the selected text verbatim (no summarization), or null if NO_MATCH
 *
 * Granularity: min ~1.5 lines, max 20% of current message length
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

// ── Types ───────────────────────────────────────────────────────────────────

interface LearnMatch {
  file: string;
  triggers: string[];
  content: string;
  priority: string;
}

interface InjectOptions {
  model?: string | undefined;
  maxTokens?: number | undefined;
}

interface OllamaResponse {
  response?: string;
}

// ── 1. Heuristic trigger matching (pure regex, no model) ────────────────────

/**
 * Scan all .yaml learn files in learnsDir, match their triggers against message.
 * Returns array of matched learns with their content.
 */
export const matchTriggers = (message: string, learnsDir: string): LearnMatch[] => {
  if (!existsSync(learnsDir)) return [];

  const msgLower = message.toLowerCase();
  const matched: LearnMatch[] = [];

  for (const file of readdirSync(learnsDir)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;

    const fullPath = join(learnsDir, file);
    const raw = readFileSync(fullPath, 'utf8');

    // Extract triggers from YAML
    const triggersMatch = raw.match(/triggers:\s*\n((?:\s+-\s+.+\n?)+)/);
    if (!triggersMatch) {
      // Fallback: inline format triggers: [a, b, c]
      const inlineMatch = raw.match(/triggers:\s*\[([^\]]+)\]/);
      if (!inlineMatch) continue;
      const triggers = inlineMatch[1]!.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
      const hit = triggers.some(t => msgLower.includes(t));
      if (!hit) continue;

      const priority = raw.match(/priority:\s*(\w+)/)?.[1] ?? 'normal';
      const learnName = file.replace(/\.ya?ml$/, '');
      const mdPath = join(learnsDir, `${learnName}.md`);
      const content = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : '';

      matched.push({ file, triggers, content, priority });
      continue;
    }

    // Multi-line YAML list format
    const triggers = triggersMatch[1]!
      .split('\n')
      .map(l => l.replace(/^\s*-\s*/, '').trim().toLowerCase())
      .filter(Boolean);

    const hit = triggers.some(t => msgLower.includes(t));
    if (!hit) continue;

    const priority = raw.match(/priority:\s*(\w+)/)?.[1] ?? 'normal';
    const learnName = file.replace(/\.ya?ml$/, '');
    const mdPath = join(learnsDir, `${learnName}.md`);
    const content = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : '';

    matched.push({ file, triggers, content, priority });
  }

  return matched;
};

// ── 2. 0.8b extraction (select relevant passages verbatim) ──────────────────

/**
 * Ask the CPU model to select relevant passages from learnContent for the given message.
 * Returns the verbatim selected text, or null if the model determines nothing is relevant.
 *
 * The model NEVER summarizes — it copies relevant blocks as-is.
 * Granularity: min ~1.5 lines, max 20% of message length.
 */
export const extractRelevant = async (
  message: string,
  learnContent: string,
  ollamaCpuUrl: string,
  opts: InjectOptions = {},
): Promise<string | null> => {
  const model = opts.model ?? process.env.MODEL_CPU ?? 'qwen3.5:0.8b';
  const maxTokens = opts.maxTokens ?? 500;

  // Granularity: min ~1.5 lines (~30 words), max 20% of message
  const messageWords = message.split(/\s+/).length;
  const maxWords = Math.max(30, Math.round(messageWords * 0.2));

  const prompt = `You are a context selector. Given a user message and a knowledge document, select ONLY the passages that are directly relevant to the user's message. Return them VERBATIM — do not summarize, rephrase, or add anything.

If nothing in the document is relevant to the user's message, respond with exactly: NO_MATCH

Rules:
- Copy relevant passages exactly as they appear in the document
- Do not add explanations, commentary, or transitions
- Do not summarize or rephrase — keep the original text intact
- Select at most ~${maxWords} words (${maxTokens} tokens)
- Minimum: at least 1-2 complete lines if something is relevant
- If unsure whether a passage is relevant, respond NO_MATCH

USER MESSAGE:
${message}

KNOWLEDGE DOCUMENT:
${learnContent}

SELECTED PASSAGES:`;

  try {
    const body = JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { num_predict: maxTokens, temperature: 0.1 },
    });

    const url = new URL('/api/generate', ollamaCpuUrl);
    const result = await new Promise<OllamaResponse | null>((resolve, reject) => {
      const req = httpRequest({
        method: 'POST',
        hostname: url.hostname,
        port: url.port ? parseInt(url.port) : 11434,
        path: url.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        timeout: 10000,
      }, res => {
        let data = '';
        res.on('data', (chunk: string) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data) as OllamaResponse); }
          catch { resolve(null); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });

    if (!result?.response) return null;

    const response = result.response.trim();
    if (response === 'NO_MATCH' || response.startsWith('NO_MATCH')) return null;

    return response;
  } catch {
    // Fail silently — no injection is better than blocking
    return null;
  }
};

// ── 3. Full injection pipeline ──────────────────────────────────────────────

/**
 * Complete injection: heuristic match → 0.8b extract → return injectable text.
 *
 * @param message       - Current user message
 * @param learnsDir     - Path to learns directory ($PROJECT_DATA_DIR/$PROJECT_NAME/.coderclaw/learns/)
 * @param ollamaCpuUrl  - Ollama CPU endpoint
 * @param opts          - { model, maxTokens }
 * @returns Verbatim passages to inject, or null
 */
export const inject = async (
  message: string,
  learnsDir: string,
  ollamaCpuUrl: string,
  opts: InjectOptions = {},
): Promise<string | null> => {
  // Phase 1: heuristic
  const matches = matchTriggers(message, learnsDir);
  if (!matches.length) return null;

  // Phase 2: 0.8b extraction on each matched learn
  const extracts: string[] = [];

  for (const match of matches) {
    // Critical priority: inject in full, no 0.8b filter
    if (match.priority === 'critical') {
      if (match.content) extracts.push(match.content);
      continue;
    }

    const extract = await extractRelevant(message, match.content, ollamaCpuUrl, opts);
    if (extract) extracts.push(extract);
  }

  if (!extracts.length) return null;
  return extracts.join('\n\n---\n\n');
};
