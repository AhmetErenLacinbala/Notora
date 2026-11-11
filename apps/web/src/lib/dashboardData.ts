import type { DashboardDocument, DashboardDocumentsResponse, StorageBudget } from '../../../../packages/shared/src/index';

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function validDocument(value: unknown): value is DashboardDocument {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<DashboardDocument>;
  if (typeof item.id !== 'string' || !item.id || typeof item.title !== 'string' ||
      !nullableString(item.hostName) ||
      !(item.uploadedAt === null || nonnegativeInteger(item.uploadedAt)) ||
      !(item.lastAccessedAt === null || nonnegativeInteger(item.lastAccessedAt)) ||
      !nonnegativeInteger(item.sizeBytes) || !nonnegativeInteger(item.pageCount) ||
      !['processing', 'ready', 'error'].includes(String(item.status))) return false;
  if (item.storageBytes !== undefined && !nonnegativeInteger(item.storageBytes)) return false;
  if (item.storagePrefix !== undefined && typeof item.storagePrefix !== 'string') return false;
  if (item.storageProvider !== undefined && !['local', 'r2'].includes(item.storageProvider)) return false;
  if (item.provenance !== undefined) {
    const source = item.provenance;
    if (!source || !nullableString(source.hostId) || !nullableString(source.ipAddress) ||
        !nullableString(source.countryCode) || !nullableString(source.userAgent)) return false;
  }
  return true;
}

function validStorage(value: unknown): value is StorageBudget {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<StorageBudget>;
  return (item.provider === 'local' || item.provider === 'r2') &&
    nonnegativeInteger(item.usedBytes) && nonnegativeInteger(item.reservedBytes) &&
    nonnegativeInteger(item.limitBytes) && nonnegativeInteger(item.classAUsed) &&
    nonnegativeInteger(item.classALimit) && nonnegativeInteger(item.classBUsed) &&
    nonnegativeInteger(item.classBLimit) && typeof item.month === 'string' &&
    typeof item.available === 'boolean' &&
    (item.classADailyUsed === undefined || nonnegativeInteger(item.classADailyUsed)) &&
    (item.classADailyLimit === undefined || nonnegativeInteger(item.classADailyLimit)) &&
    (item.classBDailyUsed === undefined || nonnegativeInteger(item.classBDailyUsed)) &&
    (item.classBDailyLimit === undefined || nonnegativeInteger(item.classBDailyLimit));
}

export function documentsFrom(value: unknown): DashboardDocumentsResponse {
  if (!value || typeof value !== 'object') throw new Error('The dashboard returned an invalid file list. Please try again.');
  const result = value as Partial<DashboardDocumentsResponse>;
  if (!Array.isArray(result.documents) || !nonnegativeInteger(result.total) ||
      !nonnegativeInteger(result.offset) || !nonnegativeInteger(result.limit) || result.limit === 0 ||
      result.documents.length > result.limit || result.documents.some(item => !validDocument(item)) ||
      (result.storage !== undefined && !validStorage(result.storage))) {
    throw new Error('The dashboard returned an invalid file list. Please try again.');
  }
  return result as DashboardDocumentsResponse;
}

export class DashboardRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'DashboardRequestError';
  }
}

export async function deleteDashboardDocument(id: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/dashboard/documents/${encodeURIComponent(id)}`, {
      method: 'DELETE', credentials: 'same-origin', cache: 'no-store',
    });
  } catch {
    throw new Error('Couldn’t confirm the deletion. Refresh the list before trying again.');
  }
  if (response.status === 204) return;
  if (response.status === 401) throw new DashboardRequestError('Your dashboard session expired. Sign in again.', 401);
  const payload: unknown = await response.json().catch(() => undefined);
  const detail = payload && typeof payload === 'object' && 'error' in payload &&
    typeof payload.error === 'string' && payload.error.trim().length <= 240 ? payload.error.trim() : '';
  const message = detail || (response.status === 404 ? 'This file is no longer available. Refresh the list.' :
    response.status === 409 ? 'This file is busy. Try again shortly.' :
      'Couldn’t delete this file. Please try again.');
  throw new DashboardRequestError(message, response.status);
}
