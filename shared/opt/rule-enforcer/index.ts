/**
 * rule-enforcer — 3-layer enforcement for immutable rules
 *
 * Wildcard syntax in triggers:
 *   <<*>> = any characters (zero or more) between previous and next token
 *   <<_>> = exactly one character
 *   These sequences are chosen because they NEVER appear in real commands or text.
 *
 * Enforcement flow:
 *   - block/cut + 100% heuristic match → kill immediately, no 0.8b
 *   - block/cut + partial match (>= threshold) → ask 0.8b before blocking
 *   - warn → 0.8b post-validation after full response
 *   - no match → skip, considered valid
 *
 * Layer 1: blockAction(command, rules) — pre-execution check on tool calls
 * Layer 2: checkStream(chunk, rules) — real-time stream check on accumulated text
 * Layer 3: postValidate(fullText, rules, ollamaCpuUrl) — 0.8b post-validation
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

// ── Types ───────────────────────────────────────────────────────────────────

export interface Rule {
  id: string;
  text: string;
  type: 'interdiction' | 'obligation';
  surfaces: string[];
  enforcement: 'block' | 'cut' | 'warn';
  triggers: string[];
  projects: {
    default: 'enabled' | 'disabled';
    overrides: Record<string, 'enabled' | 'disabled'>;
  };
  created: string;
  violations: number;
}

export interface Violation {
  ruleId: string;
  ruleText: string;
  trigger: string;
  matched: string;
  surface: string;
  project: string;
  enforcement: string;
  timestamp: string;
}

interface MatchResult {
  full: boolean;     // 100% match → immediate kill
  partial: boolean;  // partial match → ask 0.8b
  score: number;     // 0-1 match ratio
}

// ── Wildcard matching ───────────────────────────────────────────────────────
// <<*>> → .* (any characters)
// <<_>> → . (exactly one character)
// Everything else is literal (escaped for regex)

const triggerToRegex = (trigger: string): RegExp => {
  const parts = trigger.split(/(<<\?\*>>|<<\*>>|<<\?_>>|<<_>>)/);
  const regexStr = parts.map(part => {
    if (part === '<<*>>') return '.+';
    if (part === '<<?*>>') return '.*';
    if (part === '<<_>>') return '.';
    if (part === '<<?_>>') return '.?';
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(regexStr, 'i');
};

// Score a trigger against text — returns 0-1
// 1.0 = full regex match
// 0.x = partial match based on literal token overlap
const scoreTrigger = (trigger: string, text: string): MatchResult => {
  const regex = triggerToRegex(trigger);
  if (regex.test(text)) return { full: true, partial: false, score: 1.0 };

  // Partial match: count how many literal tokens from the trigger appear in the text
  const wildcards = new Set(['<<*>>', '<<?*>>', '<<_>>', '<<?_>>']);
  const literalParts = trigger
    .split(/(<<\?\*>>|<<\*>>|<<\?_>>|<<_>>)/)
    .filter(p => !wildcards.has(p) && p.trim().length > 0);

  if (!literalParts.length) return { full: false, partial: false, score: 0 };

  const textLower = text.toLowerCase();
  const matched = literalParts.filter(p => textLower.includes(p.toLowerCase()));
  const score = matched.length / literalParts.length;

  return { full: false, partial: score > 0 && score < 1, score };
};

// Default threshold for partial match → ask 0.8b
const PARTIAL_THRESHOLD = 0.5;

// ── Load rules ──────────────────────────────────────────────────────────────

export const loadRules = (projectDataDir: string): Rule[] => {
  const rulesDir = join(projectDataDir, '.coderclaw', 'rules');
  if (!existsSync(rulesDir)) return [];

  const rules: Rule[] = [];
  for (const file of readdirSync(rulesDir)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    try {
      const raw = readFileSync(join(rulesDir, file), 'utf8');
      // Simple YAML parsing for our format
      const id = raw.match(/^id:\s*"?([^"\n]+)"?/m)?.[1] ?? file.replace(/\.ya?ml$/, '');
      const text = raw.match(/^text:\s*"([^"]+)"/m)?.[1] ?? '';
      const surfacesMatch = raw.match(/^surfaces:\s*\[([^\]]+)\]/m);
      const surfaces = surfacesMatch
        ? surfacesMatch[1]!.split(',').map(s => s.trim())
        : ['all'];
      const type = (raw.match(/^type:\s*(\w+)/m)?.[1] ?? 'interdiction') as Rule['type'];
      const enforcement = (raw.match(/^enforcement:\s*(\w+)/m)?.[1] ?? 'warn') as Rule['enforcement'];
      const triggersMatch = raw.match(/^triggers:\s*\n((?:\s+-\s+.+\n?)+)/m);
      const triggers = triggersMatch
        ? triggersMatch[1]!.split('\n').map(l => l.replace(/^\s*-\s*/, '').trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
        : [];
      const defaultScope = (raw.match(/default:\s*(enabled|disabled)/m)?.[1] ?? 'enabled') as 'enabled' | 'disabled';
      const violations = parseInt(raw.match(/^violations:\s*(\d+)/m)?.[1] ?? '0');
      const created = raw.match(/^created:\s*"?([^"\n]+)"?/m)?.[1] ?? '';

      rules.push({ id, text, type, surfaces, enforcement, triggers, projects: { default: defaultScope, overrides: {} }, created, violations });
    } catch { /* skip malformed rule */ }
  }
  return rules;
};

// ── Filter rules for current context ────────────────────────────────────────

export const getActiveRules = (
  rules: Rule[],
  surface: string,
  projectName: string,
): Rule[] =>
  rules.filter(rule => {
    // Surface check
    if (!rule.surfaces.includes('all') && !rule.surfaces.includes(surface)) return false;
    // Project check
    const override = rule.projects.overrides[projectName];
    if (override === 'disabled') return false;
    if (override === 'enabled') return true;
    return rule.projects.default === 'enabled';
  });

// ── Layer 1: Action interception (pre-execution) ───────────────────────────
// Full match → kill immediately
// Partial match (>= PARTIAL_THRESHOLD) → returns with partial flag (caller asks 0.8b)
// No match → null

export interface EnforcementResult extends Violation {
  needsCpuValidation: boolean;
}

export const blockAction = (
  command: string,
  rules: Rule[],
): EnforcementResult | null => {
  for (const rule of rules) {
    if (rule.enforcement !== 'block') continue;
    for (const trigger of rule.triggers) {
      const result = scoreTrigger(trigger, command);

      if (rule.type === 'interdiction') {
        // Interdiction: trigger match = forbidden action detected
        if (result.full) {
          return {
            ruleId: rule.id, ruleText: rule.text, trigger,
            matched: command, surface: '', project: '',
            enforcement: 'block', timestamp: new Date().toISOString(),
            needsCpuValidation: false, // full match → kill immediately
          };
        }
        if (result.score >= PARTIAL_THRESHOLD) {
          return {
            ruleId: rule.id, ruleText: rule.text, trigger,
            matched: command, surface: '', project: '',
            enforcement: 'block', timestamp: new Date().toISOString(),
            needsCpuValidation: true, // partial → ask 0.8b
          };
        }
      } else {
        // Obligation: trigger match = context detected, 0.8b must verify compliance
        if (result.full || result.score >= PARTIAL_THRESHOLD) {
          return {
            ruleId: rule.id, ruleText: rule.text, trigger,
            matched: command, surface: '', project: '',
            enforcement: 'block', timestamp: new Date().toISOString(),
            needsCpuValidation: true, // obligation always needs 0.8b validation
          };
        }
      }
    }
  }
  return null;
};

// ── Layer 2: Stream check (real-time, accumulated text) ─────────────────────
// Same logic: full match → cut, partial → ask 0.8b, no match → skip

export const checkStream = (
  accumulatedText: string,
  rules: Rule[],
): EnforcementResult | null => {
  for (const rule of rules) {
    if (rule.enforcement !== 'cut') continue;
    for (const trigger of rule.triggers) {
      const result = scoreTrigger(trigger, accumulatedText);

      if (rule.type === 'interdiction') {
        if (result.full) {
          return {
            ruleId: rule.id, ruleText: rule.text, trigger,
            matched: accumulatedText.slice(-200), surface: '', project: '',
            enforcement: 'cut', timestamp: new Date().toISOString(),
            needsCpuValidation: false,
          };
        }
        if (result.score >= PARTIAL_THRESHOLD) {
          return {
            ruleId: rule.id, ruleText: rule.text, trigger,
            matched: accumulatedText.slice(-200), surface: '', project: '',
            enforcement: 'cut', timestamp: new Date().toISOString(),
            needsCpuValidation: true,
          };
        }
      } else {
        if (result.full || result.score >= PARTIAL_THRESHOLD) {
          return {
            ruleId: rule.id, ruleText: rule.text, trigger,
            matched: accumulatedText.slice(-200), surface: '', project: '',
            enforcement: 'cut', timestamp: new Date().toISOString(),
            needsCpuValidation: true,
          };
        }
      }
    }
  }
  return null;
};

// ── Layer 3: Post-validation (0.8b CPU) ─────────────────────────────────────

export const postValidate = async (
  fullText: string,
  rules: Rule[],
  ollamaCpuUrl: string,
): Promise<Violation | null> => {
  const warnRules = rules.filter(r => r.enforcement === 'warn');
  if (!warnRules.length) return null;

  const rulesDescription = warnRules
    .map((r, i) => `Rule ${i + 1} [${r.id}] (${r.type}): "${r.text}"`)
    .join('\n');

  const prompt = `You are a rule compliance checker. Check if the following AI response violates any of these rules.

For INTERDICTION rules: the response must NOT contain or do what the rule forbids.
For OBLIGATION rules: the response MUST comply with what the rule requires.

RULES:
${rulesDescription}

AI RESPONSE:
${fullText.slice(0, 2000)}

If a rule is violated, respond with ONLY the rule number and a brief explanation:
VIOLATION: Rule N — [explanation]

If no rule is violated, respond with exactly: COMPLIANT`;

  try {
    const model = process.env.MODEL_CPU ?? 'qwen3.5:0.8b';
    const body = JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { num_predict: 100, temperature: 0.1 },
    });

    const url = new URL('/api/generate', ollamaCpuUrl);
    const result = await new Promise<Record<string, unknown> | null>((resolve, reject) => {
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
          try { resolve(JSON.parse(data) as Record<string, unknown>); }
          catch { resolve(null); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });

    if (!result?.response) return null;
    const response = (result.response as string).trim();

    if (response.startsWith('COMPLIANT')) return null;

    // Parse "VIOLATION: Rule N — explanation"
    const match = response.match(/VIOLATION:\s*Rule\s*(\d+)/i);
    if (!match) return null;

    const ruleIdx = parseInt(match[1]!) - 1;
    const violatedRule = warnRules[ruleIdx];
    if (!violatedRule) return null;

    return {
      ruleId: violatedRule.id,
      ruleText: violatedRule.text,
      trigger: '0.8b-post-validation',
      matched: response,
      surface: '',
      project: '',
      enforcement: 'warn',
      timestamp: new Date().toISOString(),
    };
  } catch {
    return null;
  }
};

// ── Record violation ────────────────────────────────────────────────────────

export const recordViolation = (
  projectDataDir: string,
  violation: Violation,
): void => {
  const violationsDir = join(projectDataDir, '.coderclaw', 'violations');
  mkdirSync(violationsDir, { recursive: true });

  const filename = `${violation.ruleId}-${Date.now()}.yaml`;
  const content = `ruleId: "${violation.ruleId}"
ruleText: "${violation.ruleText}"
trigger: "${violation.trigger}"
matched: "${violation.matched.replace(/"/g, '\\"').slice(0, 500)}"
surface: "${violation.surface}"
project: "${violation.project}"
enforcement: "${violation.enforcement}"
timestamp: "${violation.timestamp}"
`;
  writeFileSync(join(violationsDir, filename), content);

  // Increment violation counter on the rule
  const rulesDir = join(projectDataDir, '.coderclaw', 'rules');
  for (const file of readdirSync(rulesDir)) {
    const filePath = join(rulesDir, file);
    const raw = readFileSync(filePath, 'utf8');
    if (raw.includes(`id: "${violation.ruleId}"`) || raw.includes(`id: ${violation.ruleId}`)) {
      const updated = raw.replace(
        /^violations:\s*\d+/m,
        `violations: ${parseInt(raw.match(/^violations:\s*(\d+)/m)?.[1] ?? '0') + 1}`,
      );
      writeFileSync(filePath, updated);
      break;
    }
  }
};

// ── Load violations for systemPrompt injection ──────────────────────────────

export const loadViolationReminders = (
  projectDataDir: string,
  projectName: string,
  activeRules: Rule[],
): string[] => {
  const violationsDir = join(projectDataDir, '.coderclaw', 'violations');
  if (!existsSync(violationsDir)) return [];

  const activeRuleIds = new Set(activeRules.map(r => r.id));
  const reminders: string[] = [];

  for (const file of readdirSync(violationsDir)) {
    if (!file.endsWith('.yaml')) continue;
    try {
      const raw = readFileSync(join(violationsDir, file), 'utf8');
      const ruleId = raw.match(/^ruleId:\s*"?([^"\n]+)"?/m)?.[1] ?? '';
      const project = raw.match(/^project:\s*"?([^"\n]+)"?/m)?.[1] ?? '';
      const ruleText = raw.match(/^ruleText:\s*"([^"]+)"/m)?.[1] ?? '';
      const timestamp = raw.match(/^timestamp:\s*"?([^"\n]+)"?/m)?.[1] ?? '';

      // Only inject reminders for rules active on this project
      if (!activeRuleIds.has(ruleId)) continue;
      // Only inject reminders from this project
      if (project !== projectName) continue;

      reminders.push(
        `VIOLATION RECORD — You previously violated the following rule:\n` +
        `Rule: "${ruleText}"\n` +
        `Date: ${timestamp}\n` +
        `This violation was recorded. You have absolute prohibition from repeating it.`,
      );
    } catch { /* skip */ }
  }

  return reminders;
};
