import type { IncomingHttpHeaders } from 'node:http';

export interface ApiResponse<T = unknown> {
  status: number;
  data: T;
}

export interface WebhookIssue {
  type: 'issue.assigned';
  repo: string;
  issue: {
    id: number;
    title: string;
    body: string;
    labels: string[];
    assignee: string;
  };
}

export interface WebhookPR {
  type: string;
  repo: string;
  pr: {
    id: number;
    title: string;
    body: string;
    head: string;
    base: string;
    labels: string[];
  };
}

export interface WebhookComment {
  type: 'comment';
  repo: string;
  issueId: number;
  comment: { body: string; author: string };
}

export interface WebhookUnknown {
  type: string;
  repo: string;
}

export type WebhookEvent = WebhookIssue | WebhookPR | WebhookComment | WebhookUnknown;

export interface CreatePROptions {
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface CreateRepoOptions {
  private?: boolean;
  description?: string;
}

export interface CreateWebhookOptions {
  url: string;
  secret?: string;
  events?: string[];
}

export interface ProtectBranchOptions {
  requiredApprovals?: number;
}

export interface GitProvider {
  readonly type: 'forgejo' | 'github';
  readonly baseUrl?: string;

  // Webhook
  verifyWebhook: (body: string | object, signature: string) => boolean;
  parseWebhook: (headers: IncomingHttpHeaders, body: Record<string, unknown>) => WebhookEvent;

  // REST (internal)
  _req: (method: string, path: string, body?: object | null, authToken?: string | null) => Promise<ApiResponse>;

  // Read operations
  getIssue: (repo: string, issueId: number) => Promise<Record<string, unknown>>;
  getIssueComments: (repo: string, issueId: number) => Promise<Record<string, unknown>[]>;
  addComment: (repo: string, issueId: number, body: string) => Promise<ApiResponse>;
  createPR: (repo: string, opts: CreatePROptions) => Promise<ApiResponse>;
  getPR: (repo: string, prId: number) => Promise<Record<string, unknown>>;
  getPRDiff: (repo: string, prId: number) => Promise<string>;
  listOpenIssues: (repo: string) => Promise<Record<string, unknown>[]>;
  listOpenPRs: (repo: string) => Promise<Record<string, unknown>[]>;
  setLabel: (repo: string, issueId: number, label: string) => Promise<void>;
  removeLabel: (repo: string, issueId: number, label: string) => Promise<void>;
  closeIssue: (repo: string, issueId: number) => Promise<ApiResponse>;
  getFileContent: (repo: string, path: string, ref?: string) => Promise<string | null>;
  listRepoFiles: (repo: string, ref?: string) => Promise<string[]>;
  cloneUrl: (repo: string) => string;

  // Worker operations
  createBranch: (repo: string, branch: string, fromRef?: string) => Promise<ApiResponse>;
  forkRepo: (repo: string) => Promise<Record<string, unknown>>;
  listBranches: (repo: string) => Promise<Record<string, unknown>[]>;

  // Privileged operations
  createRepo: (name: string, opts?: CreateRepoOptions) => Promise<Record<string, unknown>>;
  addCollaborator: (repo: string, username: string, permission?: string) => Promise<ApiResponse>;
  createWebhook: (repo: string, opts?: CreateWebhookOptions) => Promise<ApiResponse>;
  protectBranch: (repo: string, branch?: string, opts?: ProtectBranchOptions) => Promise<ApiResponse>;
  deleteBranch: (repo: string, branch: string) => Promise<ApiResponse>;
}
