/**
 * git-provider/forgejo.ts — Provider Forgejo/Gitea
 *
 * Implements the unified git provider API for Forgejo.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHmac } from 'node:crypto';
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

export class ForgejoProvider implements GitProvider {
  readonly type = 'forgejo' as const;
  readonly baseUrl: string;
  private readonly token: string;
  private readonly webhookSecret: string;
  private readonly useHttps: boolean;

  constructor({ url, token, webhookSecret = '' }: { url: string; token: string; webhookSecret?: string }) {
    this.baseUrl = url.replace(/\/$/, '');
    this.token = token;
    this.webhookSecret = webhookSecret;
    this.useHttps = url.startsWith('https');
  }

  // ── Webhook signature ──────────────────────────────────────────────────────

  verifyWebhook = (body: string | object, signature: string): boolean => {
    if (!this.webhookSecret) return true;
    const expected = createHmac('sha256', this.webhookSecret)
      .update(typeof body === 'string' ? body : JSON.stringify(body))
      .digest('hex');
    return `sha256=${expected}` === signature;
  };

  // ── Webhook parsing ─────────────────────────────────────────────────────────

  parseWebhook = (headers: IncomingHttpHeaders, body: Record<string, unknown>): WebhookEvent => {
    const event = (headers['x-gitea-event'] ?? headers['x-forgejo-event']) as string | undefined;
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

  _req = async (method: string, path: string, body: object | null = null): Promise<ApiResponse> => {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    const payload = body ? JSON.stringify(body) : null;
    const lib = this.useHttps ? httpsRequest : httpRequest;

    return new Promise((resolve, reject) => {
      const opts = {
        method,
        hostname: url.hostname,
        port: url.port || (this.useHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Authorization': `token ${this.token}`,
          'Accept': 'application/json',
          ...(payload ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload).toString(),
          } : {}),
        },
      };

      const req = lib(opts, res => {
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

  getPRDiff = async (repo: string, prId: number) => {
    const [owner, name] = splitRepo(repo);
    const r = await this._req('GET', `/repos/${owner}/${name}/pulls/${prId}.diff`);
    return r.data as string;
  };

  listOpenIssues = async (repo: string) => {
    const [owner, name] = splitRepo(repo);
    const r = await this._req('GET', `/repos/${owner}/${name}/issues?type=issues&state=open&limit=50`);
    return r.data as Record<string, unknown>[];
  };

  listOpenPRs = async (repo: string) => {
    const [owner, name] = splitRepo(repo);
    const r = await this._req('GET', `/repos/${owner}/${name}/pulls?state=open&limit=50`);
    return r.data as Record<string, unknown>[];
  };

  setLabel = async (repo: string, issueId: number, label: string) => {
    const [owner, name] = splitRepo(repo);
    const labels = await this._req('GET', `/repos/${owner}/${name}/labels`);
    const found = (labels.data as Array<Record<string, unknown>>).find(l => l.name === label);
    if (!found) {
      const created = await this._req('POST', `/repos/${owner}/${name}/labels`, {
        name: label, color: '#0075ca',
      });
      await this._req('POST', `/repos/${owner}/${name}/issues/${issueId}/labels`,
        { labels: [(created.data as Record<string, unknown>).id] });
    } else {
      await this._req('POST', `/repos/${owner}/${name}/issues/${issueId}/labels`,
        { labels: [found.id] });
    }
  };

  removeLabel = async (repo: string, issueId: number, label: string) => {
    const [owner, name] = splitRepo(repo);
    const labels = await this._req('GET', `/repos/${owner}/${name}/labels`);
    const found = (labels.data as Array<Record<string, unknown>>).find(l => l.name === label);
    if (found) {
      await this._req('DELETE', `/repos/${owner}/${name}/issues/${issueId}/labels/${found.id}`);
    }
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
    return ((r.data as Record<string, unknown>)?.tree as Array<Record<string, unknown>> ?? []).map(f => f.path as string);
  };

  cloneUrl = (repo: string): string => {
    const [owner, name] = splitRepo(repo);
    const base = this.baseUrl.replace('://', `://agent:${this.token}@`);
    return `${base}/${owner}/${name}.git`;
  };

  // ── Worker operations ──────────────────────────────────────────────────────

  createBranch = async (repo: string, branch: string, fromRef = 'main') => {
    const [owner, name] = splitRepo(repo);
    return this._req('POST', `/repos/${owner}/${name}/branches`, {
      new_branch_name: branch,
      old_branch_name: fromRef,
    });
  };

  forkRepo = async (repo: string) => {
    const [owner, name] = splitRepo(repo);
    const r = await this._req('POST', `/repos/${owner}/${name}/forks`, {});
    return r.data as Record<string, unknown>;
  };

  listBranches = async (repo: string) => {
    const [owner, name] = splitRepo(repo);
    const r = await this._req('GET', `/repos/${owner}/${name}/branches?limit=50`);
    return r.data as Record<string, unknown>[];
  };

  // ── Privileged operations ──────────────────────────────────────────────────

  createRepo = async (repoName: string, { private: priv = true, description = '' }: CreateRepoOptions = {}) => {
    const r = await this._req('POST', '/user/repos', {
      name: repoName, private: priv, description, auto_init: true, default_branch: 'main',
    });
    return r.data as Record<string, unknown>;
  };

  addCollaborator = async (repo: string, username: string, permission = 'write') => {
    const [owner, name] = splitRepo(repo);
    return this._req('PUT', `/repos/${owner}/${name}/collaborators/${username}`, { permission });
  };

  createWebhook = async (repo: string, { url, secret = '', events = ['push', 'issues', 'pull_request', 'issue_comment'] }: CreateWebhookOptions = { url: '' }) => {
    const [owner, name] = splitRepo(repo);
    return this._req('POST', `/repos/${owner}/${name}/hooks`, {
      type: 'gitea',
      active: true,
      config: { url, content_type: 'json', secret },
      events,
    });
  };

  protectBranch = async (repo: string, branch = 'main', { requiredApprovals = 1 }: ProtectBranchOptions = {}) => {
    const [owner, name] = splitRepo(repo);
    return this._req('POST', `/repos/${owner}/${name}/branch_protections`, {
      branch_name: branch,
      enable_push: false,
      enable_merge_whitelist: true,
      required_approvals: requiredApprovals,
      dismiss_stale_approvals: true,
    });
  };

  deleteBranch = async (repo: string, branch: string) => {
    const [owner, name] = splitRepo(repo);
    return this._req('DELETE', `/repos/${owner}/${name}/branches/${branch}`);
  };
}
