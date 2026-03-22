#!/usr/bin/env node
/**
 * git-provider/github.js — Provider GitHub App
 *
 * Authentication via GitHub App (JWT + installation token).
 * Supports GitHub webhooks.
 */
'use strict';

const https  = require('https');
const fs     = require('fs');
const crypto = require('crypto');

class GithubProvider {
  constructor({ appId, privateKeyPath, privateKeyB64, webhookSecret = '', installationId = '' }) {
    this.type           = 'github';
    this.appId          = appId;
    this.webhookSecret  = webhookSecret;
    this.installationId = installationId;
    // Priority: base64 variable (atomic, no bind mount)
    // Fallback: file path (local development only)
    if (privateKeyB64) {
      this._privateKey = Buffer.from(privateKeyB64, 'base64').toString('utf8');
    } else if (privateKeyPath && fs.existsSync(privateKeyPath)) {
      this._privateKey = fs.readFileSync(privateKeyPath, 'utf8');
    } else {
      this._privateKey = null;
    }
    this._installToken  = null;
    this._installExpiry = 0;

    if (!this._privateKey) {
      console.warn('[git-provider/github] Private key not found — GitHub App disabled');
    }
  }

  // ── JWT GitHub App ──────────────────────────────────────────────────────────

  _makeJwt() {
    if (!this._privateKey) throw new Error('GitHub App private key missing');
    const now = Math.floor(Date.now() / 1000);
    const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iat: now - 60,
      exp: now + 540,
      iss: this.appId,
    })).toString('base64url');
    const sig = crypto.createSign('RSA-SHA256')
      .update(`${header}.${payload}`)
      .sign(this._privateKey, 'base64url');
    return `${header}.${payload}.${sig}`;
  }

  async _getInstallToken() {
    if (this._installToken && Date.now() < this._installExpiry) {
      return this._installToken;
    }
    const jwt = this._makeJwt();
    const r   = await this._req(
      'POST',
      `/app/installations/${this.installationId}/access_tokens`,
      null,
      jwt,
    );
    this._installToken  = r.data.token;
    this._installExpiry = Date.now() + 55 * 60 * 1000; // 55min
    return this._installToken;
  }

  // ── Webhook signature ──────────────────────────────────────────────────────

  verifyWebhook(body, signature) {
    if (!this.webhookSecret) return true;
    const expected = 'sha256=' + crypto
      .createHmac('sha256', this.webhookSecret)
      .update(typeof body === 'string' ? body : JSON.stringify(body))
      .digest('hex');
    return expected === signature;
  }

  // ── Webhook parsing ─────────────────────────────────────────────────────────

  parseWebhook(headers, body) {
    const event = headers['x-github-event'];
    const repo  = body.repository?.full_name;

    if (event === 'issues' && body.action === 'assigned') {
      return {
        type: 'issue.assigned',
        repo,
        issue: {
          id:      body.issue?.number,
          title:   body.issue?.title,
          body:    body.issue?.body || '',
          labels:  (body.issue?.labels || []).map(l => l.name),
          assignee: body.issue?.assignee?.login,
        },
      };
    }

    if (event === 'pull_request') {
      return {
        type: `pr.${body.action}`,
        repo,
        pr: {
          id:     body.pull_request?.number,
          title:  body.pull_request?.title,
          body:   body.pull_request?.body || '',
          head:   body.pull_request?.head?.ref,
          base:   body.pull_request?.base?.ref,
          labels: (body.pull_request?.labels || []).map(l => l.name),
        },
      };
    }

    if (event === 'issue_comment') {
      return {
        type:    'comment',
        repo,
        issueId: body.issue?.number,
        comment: { body: body.comment?.body, author: body.comment?.user?.login },
      };
    }

    return { type: `unknown.${event}`, repo };
  }

  // ── REST API ────────────────────────────────────────────────────────────────

  async _req(method, path, body = null, authToken = null) {
    const token   = authToken || await this._getInstallToken();
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const opts = {
        method,
        hostname: 'api.github.com',
        port:     443,
        path,
        headers: {
          'Authorization':        `Bearer ${token}`,
          'Accept':               'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent':           'clawdevworker/1.0',
          ...(payload ? {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(payload),
          } : {}),
        },
      };
      const req = https.request(opts, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
          catch { resolve({ status: res.statusCode, data: d }); }
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ── Unified interface (identical to Forgejo) ────────────────────────────────

  async getIssue(repo, issueId) {
    const [owner, name] = repo.split('/');
    const r = await this._req('GET', `/repos/${owner}/${name}/issues/${issueId}`);
    return r.data;
  }

  async getIssueComments(repo, issueId) {
    const [owner, name] = repo.split('/');
    const r = await this._req('GET', `/repos/${owner}/${name}/issues/${issueId}/comments`);
    return r.data;
  }

  async addComment(repo, issueId, body) {
    const [owner, name] = repo.split('/');
    return this._req('POST', `/repos/${owner}/${name}/issues/${issueId}/comments`, { body });
  }

  async createPR(repo, { title, body, head, base }) {
    const [owner, name] = repo.split('/');
    return this._req('POST', `/repos/${owner}/${name}/pulls`, { title, body, head, base });
  }

  async getPR(repo, prId) {
    const [owner, name] = repo.split('/');
    const r = await this._req('GET', `/repos/${owner}/${name}/pulls/${prId}`);
    return r.data;
  }

  async getPRDiff(repo, prId) {
    const [owner, name] = repo.split('/');
    const r = await this._req('GET', `/repos/${owner}/${name}/pulls/${prId}`,
      null).then(() =>
      // GitHub returns the diff via specific Accept header
      new Promise((resolve, reject) => {
        const opts = {
          method: 'GET', hostname: 'api.github.com', port: 443,
          path: `/repos/${owner}/${name}/pulls/${prId}`,
          headers: {
            'Authorization': `Bearer ${this._installToken}`,
            'Accept': 'application/vnd.github.diff',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'clawdevworker/1.0',
          },
        };
        const req = https.request(opts, res => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => resolve({ status: res.statusCode, data: d }));
        });
        req.on('error', reject); req.end();
      })
    );
    return r.data;
  }

  async listOpenIssues(repo) {
    const [owner, name] = repo.split('/');
    const r = await this._req('GET',
      `/repos/${owner}/${name}/issues?state=open&per_page=50`);
    return r.data;
  }

  async listOpenPRs(repo) {
    const [owner, name] = repo.split('/');
    const r = await this._req('GET',
      `/repos/${owner}/${name}/pulls?state=open&per_page=50`);
    return r.data;
  }

  async setLabel(repo, issueId, label) {
    const [owner, name] = repo.split('/');
    await this._req('POST', `/repos/${owner}/${name}/issues/${issueId}/labels`,
      { labels: [label] });
  }

  async removeLabel(repo, issueId, label) {
    const [owner, name] = repo.split('/');
    await this._req('DELETE',
      `/repos/${owner}/${name}/issues/${issueId}/labels/${encodeURIComponent(label)}`);
  }

  async closeIssue(repo, issueId) {
    const [owner, name] = repo.split('/');
    return this._req('PATCH', `/repos/${owner}/${name}/issues/${issueId}`,
      { state: 'closed' });
  }

  async getFileContent(repo, path, ref = 'main') {
    const [owner, name] = repo.split('/');
    const r = await this._req('GET',
      `/repos/${owner}/${name}/contents/${path}?ref=${ref}`);
    if (r.data?.content) {
      return Buffer.from(r.data.content, 'base64').toString('utf8');
    }
    return null;
  }

  async listRepoFiles(repo, ref = 'main') {
    const [owner, name] = repo.split('/');
    const r = await this._req('GET',
      `/repos/${owner}/${name}/git/trees/${ref}?recursive=true`);
    return (r.data?.tree || []).filter(f => f.type === 'blob').map(f => f.path);
  }

  cloneUrl(repo) {
    // GitHub App clone via installation token
    return `https://x-access-token:${this._installToken}@github.com/${repo}.git`;
  }

  // ── Privileged operations (chat/codeserver only, require human confirmation) ─

  async createRepo(name, { private: priv = true, description = '' } = {}) {
    const r = await this._req('POST', '/user/repos', {
      name, private: priv, description, auto_init: true, default_branch: 'main',
    });
    return r.data;
  }

  async addCollaborator(repo, username, permission = 'push') {
    const [owner, name] = repo.split('/');
    return this._req('PUT', `/repos/${owner}/${name}/collaborators/${username}`, { permission });
  }

  async createWebhook(repo, { url, secret = '', events = ['push', 'issues', 'pull_request', 'issue_comment'] } = {}) {
    const [owner, name] = repo.split('/');
    return this._req('POST', `/repos/${owner}/${name}/hooks`, {
      name: 'web',
      active: true,
      config: { url, content_type: 'json', secret },
      events,
    });
  }

  async protectBranch(repo, branch = 'main', { requiredApprovals = 1 } = {}) {
    const [owner, name] = repo.split('/');
    return this._req('PUT', `/repos/${owner}/${name}/branches/${branch}/protection`, {
      required_pull_request_reviews: {
        required_approving_review_count: requiredApprovals,
        dismiss_stale_reviews: true,
      },
      enforce_admins: false,
      restrictions: null,
      required_status_checks: null,
    });
  }

  async deleteBranch(repo, branch) {
    const [owner, name] = repo.split('/');
    return this._req('DELETE', `/repos/${owner}/${name}/git/refs/heads/${branch}`);
  }
}

module.exports = GithubProvider;
