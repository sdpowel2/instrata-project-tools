/**
 * Per-user Procore REST client. Constructed with a userId + ProcoreSession so
 * every call fetches a fresh token for THAT user and injects Procore-Company-Id.
 * This is the only place tools reach Procore, so per-user isolation lives here.
 */
import { config } from '../config.js';
import type { ProcoreSession } from '../auth/procoreSession.js';
import { limiterFor, procoreFetch } from './rateLimit.js';
import { ForbiddenError, NotFoundError, ReconnectRequiredError } from '../errors.js';

export type RequestOpts = {
  /** Value for the Procore-Company-Id header (required by most project endpoints). */
  companyId?: number | string;
  /** Query params; undefined values are omitted. */
  query?: Record<string, string | number | boolean | undefined>;
};

export class ProcoreClient {
  constructor(
    private readonly userId: string,
    private readonly session: ProcoreSession,
  ) {}

  /** GET returning the parsed JSON body. */
  async get<T>(path: string, opts: RequestOpts = {}): Promise<T> {
    const { body } = await this.getRaw<T>(path, opts);
    return body;
  }

  /** GET returning the parsed body plus the Response (for pagination headers). */
  async getRaw<T>(path: string, opts: RequestOpts = {}): Promise<{ res: Response; body: T }> {
    const token = await this.session.accessTokenFor(this.userId);
    const url = new URL(path.startsWith('http') ? path : `${config.procoreBaseUrl}${path}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    if (opts.companyId !== undefined) headers['Procore-Company-Id'] = String(opts.companyId);

    const release = await limiterFor(this.userId, config.procoreMaxConcurrency).acquire();
    try {
      const res = await procoreFetch(url.href, { headers });
      if (!res.ok) await this.raise(res, path);
      const body = (await res.json()) as T;
      return { res, body };
    } finally {
      release();
    }
  }

  /** Map an unsuccessful response to a typed error (spec §7). Never returns. */
  private async raise(res: Response, path: string): Promise<never> {
    if (res.status === 401) throw new ReconnectRequiredError();
    const detail = (await res.text().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ').trim();
    if (res.status === 403) throw new ForbiddenError(path, detail || undefined);
    if (res.status === 404) throw new NotFoundError(path, detail || undefined);
    throw new Error(`Procore request failed (${res.status}) for ${path}: ${detail}`);
  }
}
