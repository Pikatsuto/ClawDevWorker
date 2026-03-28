/**
 * docker-exec skill — OpenClaw plugin
 *
 * Exposes the `exec_ephemeral` command which launches an ephemeral Docker container
 * with the provided code, captures stdout/stderr, and destroys the container.
 *
 * Security:
 *   --rm            → destroyed after execution
 *   --network none  → no network access
 *   --read-only     → read-only filesystem (except /tmp)
 *   --memory / --cpus → resource limits
 *   timeout kill    → container killed if timeout exceeded
 */

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

interface ExecParams {
  image: string;
  code?: string | undefined;
  command?: string | undefined;
  language?: string | undefined;
}

interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  image?: string;
}

const MEMORY = process.env.EPHEMERAL_MEMORY ?? '512m';
const CPUS = process.env.EPHEMERAL_CPUS ?? '0.5';
const TIMEOUT = parseInt(process.env.EPHEMERAL_TIMEOUT ?? '60') * 1000;

const ALLOWED_IMAGES = new Set([
  'python:3.12-slim',
  'python:3.11-slim',
  'python:3.10-slim',
  'node:24-slim',
  'node:22-slim',
  'ubuntu:24.04',
  'ubuntu:22.04',
  'bash:5',
  'alpine:3.19',
  'golang:1.22-alpine',
  'rust:1.77-slim',
  'ruby:3.3-slim',
  'php:8.3-cli-alpine',
]);

const EXT_MAP: Record<string, string> = {
  python: 'py', javascript: 'js', js: 'js', bash: 'sh',
  ruby: 'rb', go: 'go', rust: 'rs', php: 'php',
};

const RUN_CMD: Record<string, string[]> = {
  py: ['python', 'script.py'],
  js: ['node', 'script.js'],
  sh: ['bash', 'script.sh'],
  rb: ['ruby', 'script.rb'],
  go: ['go', 'run', 'script.go'],
  php: ['php', 'script.php'],
};

const detectExt = (image: string): string =>
  image.startsWith('python') ? 'py'
    : image.startsWith('node') ? 'js'
    : image.startsWith('ruby') ? 'rb'
    : image.startsWith('golang') ? 'go'
    : 'sh';

const runEphemeral = ({ image, command, code, language }: ExecParams): Promise<ExecResult> =>
  new Promise(resolve => {
    if (!ALLOWED_IMAGES.has(image)) {
      resolve({
        success: false,
        stdout: '',
        stderr: `Unauthorized image: ${image}. Available images: ${[...ALLOWED_IMAGES].join(', ')}`,
        exit_code: 1,
      });
      return;
    }

    let tmpFile: string | null = null;
    const dockerArgs = [
      'run', '--rm',
      '--network', 'none',
      '--read-only',
      '--tmpfs', '/tmp:size=64m',
      '--memory', MEMORY,
      '--cpus', CPUS,
      '--security-opt', 'no-new-privileges',
    ];

    if (code) {
      const ext = language ? (EXT_MAP[language.toLowerCase()] ?? 'txt') : detectExt(image);
      tmpFile = join(tmpdir(), `ephemeral-${Date.now()}.${ext}`);
      writeFileSync(tmpFile, code, 'utf8');

      dockerArgs.push('-v', `${tmpFile}:/code/script.${ext}:ro`);
      dockerArgs.push('-w', '/code');
      dockerArgs.push(image);
      dockerArgs.push(...(RUN_CMD[ext] ?? ['sh', '-c', `cat script.${ext}`]));
    } else if (command) {
      dockerArgs.push(image, 'sh', '-c', command);
    } else {
      resolve({ success: false, stdout: '', stderr: 'Provide code or command', exit_code: 1 });
      return;
    }

    let stdout = '';
    let stderr = '';

    const proc = spawn('docker', dockerArgs, {
      env: { ...process.env },
      timeout: TIMEOUT + 5000,
    });

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      stderr += `\n[docker-exec] Timeout exceeded (${TIMEOUT / 1000}s) — container killed`;
    }, TIMEOUT);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (tmpFile) {
        try { unlinkSync(tmpFile); } catch { /* silent */ }
      }
      resolve({
        success: code === 0,
        stdout: stdout.slice(0, 8192),
        stderr: stderr.slice(0, 2048),
        exit_code: code,
        image,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (tmpFile) {
        try { unlinkSync(tmpFile); } catch { /* silent */ }
      }
      resolve({ success: false, stdout: '', stderr: err.message, exit_code: -1 });
    });
  });

// ── Export OpenClaw skill ───────────────────────────────────────────────────

export default {
  name: 'docker-exec',
  description: 'Executes code in an isolated ephemeral Docker container (--network none, --rm)',
  commands: {
    exec_ephemeral: {
      description: 'Execute code or a command in an ephemeral container',
      parameters: {
        image: {
          type: 'string',
          description: `Docker image to use. Available: ${[...ALLOWED_IMAGES].join(', ')}`,
          required: true,
        },
        code: {
          type: 'string',
          description: 'Source code to execute (temporary file mounted as read-only)',
          required: false,
        },
        command: {
          type: 'string',
          description: 'Shell command to execute directly (alternative to code)',
          required: false,
        },
        language: {
          type: 'string',
          description: 'Code language (python, javascript, bash, ruby, go, php) — auto-detected if absent',
          required: false,
        },
      },
      handler: async ({ image, code, command, language }: ExecParams): Promise<string> => {
        const result = await runEphemeral({ image, code, command, language });
        const lines: string[] = [];
        if (result.stdout) lines.push(`**stdout:**\n\`\`\`\n${result.stdout}\n\`\`\``);
        if (result.stderr) lines.push(`**stderr:**\n\`\`\`\n${result.stderr}\n\`\`\``);
        lines.push(`**exit code:** ${result.exit_code} ${result.success ? 'OK' : 'FAIL'}`);
        lines.push(`**image:** ${result.image ?? image}`);
        return lines.join('\n\n');
      },
    },
  },
};
