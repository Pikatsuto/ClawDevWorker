#!/usr/bin/env node
/**
 * git-provider/forgejo.js — Provider Forgejo/Gitea
 *
 * Implémente l'API unifiée git provider pour Forgejo.
 */
'use strict';

const http  = require('http');
const https = require('https');
const crypto = require('crypto');

class ForgejoProvider {
  constructor({ url, token, webhookSecret = '' }) {
    this.type          = 'forgejo';
    this.baseUrl       = url.replace(/\/$/, '');
    this.token         = token;
    this.webhookSecret = webhookSecret;
    this._useHttps     = url.startsWith('https');
  }

  // ── Signature webhook ───────────────────────────────────────────────────────

  verifyWebhook(body, signature) {
    if (!this.webhookSecret) return true;
    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(typeof body === 'string' ? body : JSON.stringify(body))
      .digest('hex');
    return `sha256=${expected}` === signature;
  }

  // ── Parsing webhook ─────────────────────────────────────────────────────────

  parseWebhook(headers, body) {
    const event = headers['x-gitea-event'] || headers['x-forgejo-event'];
    const repo  = body.repository?.full_name;

    if (event === 'issues' && body.action === 'assigned') {
      return {
        type:    'issue.assigned',
        repo,
        issue: {
          id:     body.issue?.number,
          title:  body.issue?.title,
          body:   body.issue?.body || '',
          labels: (body.issue?.labels || []).map(l => l.name),
          assignee: body.issue?.assignee?.login,
        },
      };
    }

    if (event === 'pull_request') {
      return {
        type:   `pr.${body.action}`,
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
        type: 'comment',
        repo,
        issueId: body.issue?.number,
        comment: { body: body.comment?.body, author: body.comment?.user?.login },
      };
    }

    return { type: `unknown.${event}`, repo };
  }

  // ── API REST ────────────────────────────────────────────────────────────────

  _req(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url     = new URL(`${this.baseUrl}/api/v1${path}`);
      const payload = body ? JSON.stringify(body) : null;
      const lib     = this._useHttps ? https : http;
      const opts    = {
        method,
        hostname: url.hostname,
        port:     url.port || (this._useHttps ? 443 : 80),
        path:     url.pathname + url.search,
        headers: {
          'Authorization': `token ${this.token}`,
          'Accept':        'application/json',
          ...(payload ? {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(payload),
          } : {}),
        },
      };
      const req = lib.request(opts, res => {
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

  // ── Interface unifiée ───────────────────────────────────────────────────────

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
    const r = await this._req('GET', `/repos/${owner}/${name}/pulls/${prId}.diff`);
    return r.data;
  }

  async listOpenIssues(repo) {
    const [owner, name] = repo.split('/');
    const r = await this._req('GET', `/repos/${owner}/${name}/issues?type=issues&state=open&limit=50`);
    return r.data;
  }

  async listOpenPRs(repo) {
    const [owner, name] = repo.split('/');
    const r = await this._req('GET', `/repos/${owner}/${name}/pulls?state=open&limit=50`);
    return r.data;
  }

  async setLabel(repo, issueId, label) {
    const [owner, name] = repo.split('/');
    // Récupère l'ID du label
    const labels = await this._req('GET', `/repos/${owner}/${name}/labels`);
    const found  = labels.data.find(l => l.name === label);
    if (!found) {
      // Crée le label s'il n'existe pas
      const created = await this._req('POST', `/repos/${owner}/${name}/labels`, {
        name, color: '#0075ca',
      });
      await this._req('POST', `/repos/${owner}/${name}/issues/${issueId}/labels`,
        { labels: [created.data.id] });
    } else {
      await this._req('POST', `/repos/${owner}/${name}/issues/${issueId}/labels`,
        { labels: [found.id] });
    }
  }

  async removeLabel(repo, issueId, label) {
    const [owner, name] = repo.split('/');
    const labels = await this._req('GET', `/repos/${owner}/${name}/labels`);
    const found  = labels.data.find(l => l.name === label);
    if (found) {
      await this._req('DELETE',
        `/repos/${owner}/${name}/issues/${issueId}/labels/${found.id}`);
    }
  }

  async closeIssue(repo, issueId) {
    const [owner, name] = repo.split('/');
    return this._req('PATCH', `/repos/${owner}/${name}/issues/${issueId}`, { state: 'closed' });
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
    return (r.data?.tree || []).map(f => f.path);
  }

  cloneUrl(repo) {
    const [owner, name] = repo.split('/');
    const base = this.baseUrl.replace('://', `://agent:${this.token}@`);
    return `${base}/${owner}/${name}.git`;
  }
}

module.exports = ForgejoProvider;
