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

const { execFile, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const MEMORY  = process.env.EPHEMERAL_MEMORY  || '512m';
const CPUS    = process.env.EPHEMERAL_CPUS    || '0.5';
const TIMEOUT = parseInt(process.env.EPHEMERAL_TIMEOUT || '60') * 1000;
const DOCKER  = process.env.DOCKER_HOST
  ? `DOCKER_HOST=${process.env.DOCKER_HOST}`
  : '';

// Allowed images (whitelist)
const ALLOWED_IMAGES = new Set([
  'python:3.12-slim',
  'python:3.11-slim',
  'python:3.10-slim',
  'node:22-slim',
  'node:20-slim',
  'ubuntu:24.04',
  'ubuntu:22.04',
  'bash:5',
  'alpine:3.19',
  'golang:1.22-alpine',
  'rust:1.77-slim',
  'ruby:3.3-slim',
  'php:8.3-cli-alpine',
]);

function runEphemeral({ image, command, code, language, timeout }) {
  return new Promise((resolve) => {
    if (!ALLOWED_IMAGES.has(image)) {
      return resolve({
        success: false,
        stdout: '',
        stderr: `Unauthorized image: ${image}. Available images: ${[...ALLOWED_IMAGES].join(', ')}`,
        exit_code: 1,
      });
    }

    // Create a temporary file if code is provided
    let tmpFile = null;
    let dockerArgs = [
      'run', '--rm',
      '--network', 'none',
      '--read-only',
      '--tmpfs', '/tmp:size=64m',
      '--memory', MEMORY,
      '--cpus', CPUS,
      '--security-opt', 'no-new-privileges',
    ];

    if (code) {
      // Detect extension based on language or image
      const ext = language
        ? { python: 'py', javascript: 'js', js: 'js', bash: 'sh', ruby: 'rb', go: 'go', rust: 'rs', php: 'php' }[language.toLowerCase()] || 'txt'
        : image.startsWith('python') ? 'py'
        : image.startsWith('node') ? 'js'
        : image.startsWith('ruby') ? 'rb'
        : image.startsWith('golang') ? 'go'
        : 'sh';

      tmpFile = path.join(os.tmpdir(), `ephemeral-${Date.now()}.${ext}`);
      fs.writeFileSync(tmpFile, code, 'utf8');

      // Mount the file as read-only in the container
      dockerArgs.push('-v', `${tmpFile}:/code/script.${ext}:ro`);
      dockerArgs.push('-w', '/code');
      dockerArgs.push(image);

      // Execution command based on language
      const runCmd = {
        py:  ['python', `script.${ext}`],
        js:  ['node', `script.${ext}`],
        sh:  ['bash', `script.${ext}`],
        rb:  ['ruby', `script.${ext}`],
        go:  ['go', 'run', `script.${ext}`],
        php: ['php', `script.${ext}`],
      }[ext] || ['sh', '-c', `cat script.${ext}`];

      dockerArgs.push(...runCmd);
    } else if (command) {
      // Direct shell command
      dockerArgs.push(image, 'sh', '-c', command);
    } else {
      return resolve({ success: false, stdout: '', stderr: 'Provide code or command', exit_code: 1 });
    }

    let stdout = '';
    let stderr = '';
    let containerId = null;

    const proc = spawn('docker', dockerArgs, {
      env: { ...process.env },
      timeout: TIMEOUT + 5000,
    });

    // Capture container ID for kill in case of timeout
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    // Timeout: kill the container
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      stderr += `\n[docker-exec] Timeout exceeded (${TIMEOUT / 1000}s) — container killed`;
    }, TIMEOUT);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (tmpFile) {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
      }
      resolve({
        success: code === 0,
        stdout: stdout.slice(0, 8192),  // max 8KB output
        stderr: stderr.slice(0, 2048),
        exit_code: code,
        image,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (tmpFile) {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
      }
      resolve({ success: false, stdout: '', stderr: err.message, exit_code: -1 });
    });
  });
}

// ── Export OpenClaw skill ─────────────────────────────────────────────────────
module.exports = {
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
      async handler({ image, code, command, language }) {
        const result = await runEphemeral({ image, code, command, language });
        const lines = [];
        if (result.stdout) lines.push(`**stdout:**\n\`\`\`\n${result.stdout}\n\`\`\``);
        if (result.stderr) lines.push(`**stderr:**\n\`\`\`\n${result.stderr}\n\`\`\``);
        lines.push(`**exit code:** ${result.exit_code} ${result.success ? '✅' : '❌'}`);
        lines.push(`**image:** ${result.image || image}`);
        return lines.join('\n\n');
      },
    },
  },
};
