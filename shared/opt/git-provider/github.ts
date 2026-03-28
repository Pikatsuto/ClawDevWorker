/**
 * git-provider/github.ts — Provider GitHub App
 *
 * Authentication via GitHub App (JWT + installation token).
 */

import { request as httpsRequest } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { createHmac, createSign } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type {
  ApiResponse,
  CreatePROptions,
  CreateRepoOptions,
  CreateWebhookOptions,
  GitProvider,
  ProtectBranchOptions,
  WebhookEvent,
} from './types.js';

const splitRepo = (repo: string): [string, string] => {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`Invalid repo format: ${repo}`);
  return [owner, name];
};

interface GithubProviderConfig {
  appId: string;
  privateKeyPath?: string;
  privateKeyB64?: string;
  webhookSecret?: string;
  installationId?: string;
}

export class GithubProvider implements GitProvider {
  readonly type = 'github' as const;
  private readonly appId: string;
  private readonly webhookSecret: string;
  private readonly installationId: string;
  private readonly privateKey: string | null;
  private installToken: string | null = null;
  private installExpiry = 0;

  constructor({ appId, privateKeyPath, privateKeyB64, webhookSecret = '', installationId = '' }: GithubProviderConfig) {
    this.appId = appId;
    this.webhookSecret = webhookSecret;
    this.installationId = installationId;

    if (privateKeyB64) {
      this.privateKey = Buffer.from(privateKeyB64, 'base64').toString('utf8');
    } else if (privateKeyPath && existsSync(privateKeyPath)) {
      this.privateKey = readFileSync(privateKeyPath, 'utf8');
    } else {
      this.privateKey = null;
    }

    if (!this.privateKey) {
      console.warn('[git-provider/github] Private key not found — GitHub App disabled');
    }
  }

  // ── JWT GitHub App ──────────────────────────────────────────────────────────

  private makeJwt = (): string => {
    if (!this.privateKey) throw new Error('GitHub App private key missing');
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iat: now - 60,
      exp: now + 540,
      iss: this.appId,
    })).toString('base64url');
    const sig = createSign('RSA-SHA256')
      .update(`${header}.${payload}`)
      .sign(this.privateKey, 'base64url');
    return `${header}.${payload}.${sig}`;
  };

  private getInstallToken = async (): Promise<string> => {
    if (this.installToken && Date.now() < this.installExpiry) {
      return this.installToken;
    }
    const jwt = this.makeJwt();
    const r = await this._req('POST', `/app/installations/${this.installationId}/access_tokens`, null, jwt);
    this.installToken = (r.data as Record<string, unknown>).token as string;
    this.installExpiry = Date.now() + 55 * 60 * 1000;
    return this.installToken;
  };

  // ── Webhook signature ──────────────────────────────────────────────────────

  verifyWebhook = (body: string | object, signature: string): boolean => {
    if (!this.webhookSecret) return true;
    const expected = 'sha256=' + createHmac('sha256', this.webhookSecret)
      .update(typeof body === 'string' ? body : JSON.stringify(body))
      .digest('hex');
    return expected === signature;
  };

  // ── Webhook parsing ─────────────────────────────────────────────────────────

  parseWebhook = (headers: IncomingHttpHeaders, body: Record<string, unknown>): WebhookEvent => {
    const event = headers['x-github-event'] as string | undefined;
    const repo = (body.repository as Record<string, unknown>)?.full_name as string;

    if (event === 'issues' && body.action === 'assigned') {
      const issue = body.issue as Record<string, unknown>;
      return {
        type: 'issue.assigned',
        repo,
        issue: {
          id: issue?.number as number,
          title: issue?.title as string,
          body: (issue?.body as string) ?? '',
          labels: ((issue?.labels as Array<Record<string, unknown>>) ?? []).map(l => l.name as string),
          assignee: (issue?.assignee as Record<string, unknown>)?.login as string,
        },
      };
    }

    if (event === 'pull_request') {
      const pr = body.pull_request as Record<string, unknown>;
      return {
        type: `pr.${body.action as string}`,
        repo,
        pr: {
          id: pr?.number as number,
          title: pr?.title as string,
          body: (pr?.body as string) ?? '',
          head: (pr?.head as Record<string, unknown>)?.ref as string,
          base: (pr?.base as Record<string, unknown>)?.ref as string,
          labels: ((pr?.labels as Array<Record<string, unknown>>) ?? []).map(l => l.name as string),
        },
      };
    }

    if (event === 'issue_comment') {
      const comment = body.comment as Record<string, unknown>;
      return {
        type: 'comment',
        repo,
        issueId: (body.issue as Record<string, unknown>)?.number as number,
        comment: {
          body: comment?.body as string,
          author: (comment?.user as Record<string, unknown>)?.login as string,
        },
      };
    }

    return { type: `unknown.${event}`, repo };
  };

  // ── REST API ────────────────────────────────────────────────────────────────

  _req = async (method: string, path: string, body: object | null = null, authToken: string | null = null): Promise<ApiResponse> => {
    const token = authToken ?? await this.getInstallToken();
    const payload = body ? JSON.stringify(body) : null;

    return new Promise((resolve, reject) => {
      const opts = {
        method,
        hostname: 'api.github.com',
        port: 443,
        path,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'clawdevworker/1.0',
          ...(payload ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload).toString(),
          } : {}),
        },
      };

      const req = httpsRequest(opts, res => {
        let d = '';
        res.on('data', (c: string) => d += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, data: JSON.parse(d) }); }
          catch { resolve({ status: res.statusCode!, data: d }); }
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  };

  // ── Unified interface ──────────────────────────────────────────────────────

  getIssue = async (repo: string, issueId: number) => {
    const [owner, name] = splitRepo(repo);
    const r = await this._req('GET', `/repos/${owner}/${name}/issues/${issueId}`);
    return r.data as Record<string, unknown>;
  };

  getIssueComments = async (repo: string, issueId: number) => {
    const [owner, name] = splitRepo(repo);
    const r = await this._req('GET', `/repos/${owner}/${name}/issues/${issueId}/comments`);
    return r.data as Record<string, unknown>[];
  };

  addComment = async (repo: string, issueId: number, body: string) => {
    const [owner, name] = splitRepo(repo);
    return this._req('POST', `/repos/${owner}/${name}/issues/${issueId}/comments`, { body });
  };

  createPR = async (repo: string, { title, body, head, base }: CreatePROptions) => {
    const [owner, name] = splitRepo(repo);
    return this._req('POST', `/repos/${owner}/${name}/pulls`, { title, body, head, base });
  };

  getPR = async (repo: string, prId: number) => {
    const [owner, name] = splitRepo(repo);
    const r = await this._req('GET', `/repos/${owner}/${name}/pulls/${prId}`);
    return r.data as Record<string, unknown>;
  };

  getPRDiff = async (repo: string, prId: number): Promise<string> => {
    const [owner, name] = splitRepo(repo);
    const token = await this.getInstallToken();
    return new Promise((resolve, reject) => {
      const opts = {
        method: 'GET',
        hostname: 'api.github.com',
        port: 443,
        path: `/repos/${owner}/${name}/pulls/${prId}`,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.diff',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'clawdevworker/1.0',
        },
      };
      const req = httpsRequest(opts, res => {
        let d = '';
        res.on('data', (c: string) => d += c);
        res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.end();
    });
  };

  listOpenIssues = async (repo: string) => {
    const [owner, name] = splitRepo(repo);
    const r = await this._req('GET', `/repos/${owner}/${name}/issues?state=open&per_page=50`);
    return r.data as Record<string, unknown>[];
  };

  listOpenPRs = async (repo: string) => {
    const [owner, name] = splitRepo(repo);
    const r = await this._req('GET', `/repos/${owner}/${name}/pulls?state=open&per_page=50`);
    return r.data as Record<string, unknown>[];
  };

  setLabel = async (repo: string, issueId: number, label: string) => {
    const [owner, name] = splitRepo(repo);
    await this._req('POST', `/repos/${owner}/${name}/issues/${issueId}/labels`, { labels: [label] });
  };

  removeLabel = async (repo: string, issueId: number, label: string) => {
    const [owner, name] = splitRepo(repo);
    await this._req('DELETE', `/repos/${owner}/${name}/issues/${issueId}/labels/${encodeURIComponent(label)}`);
  };

  closeIssue = async (repo: string, issueId: number) => {
    const [owner, name] = splitRepo(repo);
    return this._req('PATCH', `/repos/${owner}/${name}/issues/${issueId}`, { state: 'closed' });
  };

  getFileContent = async (repo: string, filePath: string, ref = 'main') => {
    const [owner, name] = splitRepo(repo);
    const r = await this._req('GET', `/repos/${owner}/${name}/contents/${filePath}?ref=${ref}`);
    const data = r.data as Record<string, unknown>;
    if (data?.content) {
      return Buffer.from(data.content as string, 'base64').toString('utf8');
    }
    return null;
  };

  listRepoFiles = async (repo: string, ref = 'main') => {
    const [owner, name] = splitRepo(repo);
    const r = await this._req('GET', `/repos/${owner}/${name}/git/trees/${ref}?recursive=true`);
    return ((r.data as Record<string, unknown>)?.tree as Array<Record<string, unknown>> ?? [])
      .filter(f => f.type === 'blob')
      .map(f => f.path as string);
  };

  cloneUrl = (repo: string): string =>
    `https://x-access-token:${this.installToken}@github.com/${repo}.git`;

  // ── Worker operations ──────────────────────────────────────────────────────

  createBranch = async (repo: string, branch: string, fromRef = 'main') => {
    const [owner, name] = splitRepo(repo);
    const ref = await this._req('GET', `/repos/${owner}/${name}/git/ref/heads/${fromRef}`);
    const sha = (ref.data as Record<string, unknown>)?.object as Record<string, unknown>;
    if (!sha?.sha) throw new Error(`Branch "${fromRef}" not found on ${repo}`);
    return this._req('POST', `/repos/${owner}/${name}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: sha.sha,
    });
  };

  forkRepo = async (repo: string) => {
    const [owner, name] = splitRepo(repo);
    const r = await this._req('POST', `/repos/${owner}/${name}/forks`, {});
    return r.data as Record<string, unknown>;
  };

  listBranches = async (repo: string) => {
    const [owner, name] = splitRepo(repo);
    const r = await this._req('GET', `/repos/${owner}/${name}/branches?per_page=50`);
    return r.data as Record<string, unknown>[];
  };

  // ── Privileged operations ──────────────────────────────────────────────────

  createRepo = async (repoName: string, { private: priv = true, description = '' }: CreateRepoOptions = {}) => {
    const r = await this._req('POST', '/user/repos', {
      name: repoName, private: priv, description, auto_init: true, default_branch: 'main',
    });
    return r.data as Record<string, unknown>;
  };

  addCollaborator = async (repo: string, username: string, permission = 'push') => {
    const [owner, name] = splitRepo(repo);
    return this._req('PUT', `/repos/${owner}/${name}/collaborators/${username}`, { permission });
  };

  createWebhook = async (repo: string, { url, secret = '', events = ['push', 'issues', 'pull_request', 'issue_comment'] }: CreateWebhookOptions = { url: '' }) => {
    const [owner, name] = splitRepo(repo);
    return this._req('POST', `/repos/${owner}/${name}/hooks`, {
      name: 'web',
      active: true,
      config: { url, content_type: 'json', secret },
      events,
    });
  };

  protectBranch = async (repo: string, branch = 'main', { requiredApprovals = 1 }: ProtectBranchOptions = {}) => {
    const [owner, name] = splitRepo(repo);
    return this._req('PUT', `/repos/${owner}/${name}/branches/${branch}/protection`, {
      required_pull_request_reviews: {
        required_approving_review_count: requiredApprovals,
        dismiss_stale_reviews: true,
      },
      enforce_admins: false,
      restrictions: null,
      required_status_checks: null,
    });
  };

  deleteBranch = async (repo: string, branch: string) => {
    const [owner, name] = splitRepo(repo);
    return this._req('DELETE', `/repos/${owner}/${name}/git/refs/heads/${branch}`);
  };
}
