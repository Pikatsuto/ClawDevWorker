/**
 * git-provider/index.ts — Unified Forgejo + GitHub abstraction
 *
 * Supports multiple providers simultaneously.
 * Automatic source detection from webhooks.
 *
 * Config via env:
 *   GIT_PROVIDER_1=forgejo
 *   GIT_PROVIDER_1_URL=http://git.example.com
 *   GIT_PROVIDER_1_TOKEN=xxx
 *
 *   GIT_PROVIDER_2=github
 *   GIT_PROVIDER_2_APP_ID=123456
 *   GIT_PROVIDER_2_PRIVATE_KEY_B64=<base64 of PEM key>
 */

import type { IncomingMessage } from 'node:http';
import { ForgejoProvider } from './forgejo.js';
import { GithubProvider } from './github.js';
import type { GitProvider } from './types.js';

export type { GitProvider, ApiResponse, WebhookEvent } from './types.js';

// ── Load configured providers ────────────────────────────────────────────────

export const loadProviders = (): Map<string, GitProvider> => {
  const providers = new Map<string, GitProvider>();
  let i = 1;

  while (process.env[`GIT_PROVIDER_${i}`]) {
    const type = process.env[`GIT_PROVIDER_${i}`]!.toLowerCase();
    const prefix = `GIT_PROVIDER_${i}`;

    try {
      if (type === 'forgejo') {
        providers.set(`forgejo-${i}`, new ForgejoProvider({
          url: process.env[`${prefix}_URL`] ?? 'http://localhost:3000',
          token: process.env[`${prefix}_TOKEN`] ?? '',
          webhookSecret: process.env[`${prefix}_WEBHOOK_SECRET`] ?? '',
        }));
      } else if (type === 'github') {
        providers.set(`github-${i}`, new GithubProvider({
          appId: process.env[`${prefix}_APP_ID`] ?? '',
          privateKeyB64: process.env[`${prefix}_PRIVATE_KEY_B64`] ?? '',
          privateKeyPath: process.env[`${prefix}_PRIVATE_KEY_PATH`] ?? '',
          webhookSecret: process.env[`${prefix}_WEBHOOK_SECRET`] ?? '',
          installationId: process.env[`${prefix}_INSTALLATION_ID`] ?? '',
        }));
      } else {
        console.warn(`[git-provider] Unknown provider: ${type}`);
      }
    } catch (e) {
      console.error(`[git-provider] Init error ${type}-${i}: ${(e as Error).message}`);
    }
    i++;
  }

  // Fallback: Forgejo via legacy variables
  if (!providers.size && process.env.FORGEJO_TOKEN) {
    providers.set('forgejo-legacy', new ForgejoProvider({
      url: process.env.FORGEJO_URL ?? 'http://localhost:3000',
      token: process.env.FORGEJO_TOKEN ?? '',
    }));
    console.log('[git-provider] Legacy Forgejo provider loaded');
  }

  return providers;
};

// ── Webhook source detection ─────────────────────────────────────────────────

export const detectProvider = (req: IncomingMessage, providers: Map<string, GitProvider>): { id: string; provider: GitProvider } | null => {
  if (req.headers['x-github-event']) {
    for (const [id, p] of providers) {
      if (p.type === 'github') return { id, provider: p };
    }
  }
  if (req.headers['x-gitea-event'] || req.headers['x-forgejo-event']) {
    for (const [id, p] of providers) {
      if (p.type === 'forgejo') return { id, provider: p };
    }
  }
  const first = providers.entries().next().value;
  return first ? { id: first[0], provider: first[1] } : null;
};

// ── Provider by repo ─────────────────────────────────────────────────────────

export const getProviderForRepo = (repo: string, providers: Map<string, GitProvider>): { id: string; provider: GitProvider; repo: string } | null => {
  if (repo.startsWith('github:')) {
    for (const [id, p] of providers) {
      if (p.type === 'github') return { id, provider: p, repo: repo.slice(7) };
    }
  }
  if (repo.startsWith('forgejo:')) {
    for (const [id, p] of providers) {
      if (p.type === 'forgejo') return { id, provider: p, repo: repo.slice(8) };
    }
  }
  const first = providers.entries().next().value;
  return first ? { id: first[0], provider: first[1], repo } : null;
};
