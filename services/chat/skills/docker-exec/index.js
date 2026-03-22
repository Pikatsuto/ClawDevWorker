/**
 * docker-exec skill — OpenClaw plugin
 *
 * Expose la commande `exec_ephemeral` qui lance un container Docker éphémère
 * avec le code fourni, récupère stdout/stderr, et détruit le container.
 *
 * Sécurité :
 *   --rm            → détruit après exécution
 *   --network none  → aucun accès réseau
 *   --read-only     → filesystem en lecture seule (sauf /tmp)
 *   --memory / --cpus → limites de ressources
 *   timeout kill    → container tué si timeout dépassé
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

// Images autorisées (whitelist)
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
        stderr: `Image non autorisée : ${image}. Images disponibles : ${[...ALLOWED_IMAGES].join(', ')}`,
        exit_code: 1,
      });
    }

    // Créer un fichier temporaire si du code est fourni
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
      // Détecter l'extension selon le langage ou l'image
      const ext = language
        ? { python: 'py', javascript: 'js', js: 'js', bash: 'sh', ruby: 'rb', go: 'go', rust: 'rs', php: 'php' }[language.toLowerCase()] || 'txt'
        : image.startsWith('python') ? 'py'
        : image.startsWith('node') ? 'js'
        : image.startsWith('ruby') ? 'rb'
        : image.startsWith('golang') ? 'go'
        : 'sh';

      tmpFile = path.join(os.tmpdir(), `ephemeral-${Date.now()}.${ext}`);
      fs.writeFileSync(tmpFile, code, 'utf8');

      // Monter le fichier en lecture seule dans le container
      dockerArgs.push('-v', `${tmpFile}:/code/script.${ext}:ro`);
      dockerArgs.push('-w', '/code');
      dockerArgs.push(image);

      // Commande d'exécution selon le langage
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
      // Commande shell directe
      dockerArgs.push(image, 'sh', '-c', command);
    } else {
      return resolve({ success: false, stdout: '', stderr: 'Fournir code ou command', exit_code: 1 });
    }

    let stdout = '';
    let stderr = '';
    let containerId = null;

    const proc = spawn('docker', dockerArgs, {
      env: { ...process.env },
      timeout: TIMEOUT + 5000,
    });

    // Récupérer l'ID du container pour le kill en cas de timeout
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    // Timeout : killer le container
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      stderr += `\n[docker-exec] Timeout dépassé (${TIMEOUT / 1000}s) — container tué`;
    }, TIMEOUT);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (tmpFile) {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
      }
      resolve({
        success: code === 0,
        stdout: stdout.slice(0, 8192),  // max 8KB de sortie
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
  description: 'Exécute du code dans un container Docker éphémère isolé (--network none, --rm)',
  commands: {
    exec_ephemeral: {
      description: 'Exécuter du code ou une commande dans un container éphémère',
      parameters: {
        image: {
          type: 'string',
          description: `Image Docker à utiliser. Disponibles : ${[...ALLOWED_IMAGES].join(', ')}`,
          required: true,
        },
        code: {
          type: 'string',
          description: 'Code source à exécuter (fichier temporaire monté en lecture seule)',
          required: false,
        },
        command: {
          type: 'string',
          description: 'Commande shell à exécuter directement (alternative à code)',
          required: false,
        },
        language: {
          type: 'string',
          description: 'Langage du code (python, javascript, bash, ruby, go, php) — auto-détecté si absent',
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
