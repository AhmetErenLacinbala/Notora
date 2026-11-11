import { DurableObject } from 'cloudflare:workers';
import { authorized, StorageGateway, type GatewayEnv } from './gateway';

interface QuotaNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
interface WorkerEnv extends GatewayEnv { QUOTA: QuotaNamespace }

// Keep this name stable across deployments. A different name creates a fresh
// SQLite ledger and must never be used against the same bucket.
const QUOTA_OBJECT_NAME = 'notora-storage-quota-v1';

export class StorageQuota extends DurableObject {
  private gateway: StorageGateway;

  constructor(ctx: any, env: GatewayEnv) {
    super(ctx, env);
    this.gateway = new StorageGateway(ctx.storage, env);
  }

  fetch(request: Request): Promise<Response> { return this.gateway.fetch(request); }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const error = (status: number, message: string) => Response.json({ error: message }, {
      status, headers: { 'cache-control': 'no-store' },
    });
    if (!env.GATEWAY_SECRET || env.GATEWAY_SECRET.length < 32) {
      return error(503, 'gateway configuration unavailable');
    }
    if (!authorized(request, env.GATEWAY_SECRET)) return error(401, 'unauthorized');
    try {
      return await env.QUOTA.get(env.QUOTA.idFromName(QUOTA_OBJECT_NAME)).fetch(request);
    } catch {
      return error(503, 'quota ledger unavailable');
    }
  },
};
