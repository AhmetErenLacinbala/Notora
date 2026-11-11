import { useEffect, useState, type FormEvent } from 'react';
import type { DashboardDocument, DashboardDocumentsResponse, DashboardSession, StorageBudget } from '../../../../packages/shared/src/index';
import { DashboardRequestError, deleteDashboardDocument, documentsFrom } from '../lib/dashboardData';

const PAGE_SIZE = 50;
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

type Auth = { kind: 'checking' } | { kind: 'signedOut' } | { kind: 'signedIn'; username: string } | { kind: 'error'; message: string };
type Documents = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; value: DashboardDocumentsResponse };

function sessionFrom(value: unknown): DashboardSession {
  if (!value || typeof value !== 'object' || !('username' in value) || typeof value.username !== 'string') {
    throw new Error('The dashboard returned an invalid session. Please try again.');
  }
  return { username: value.username };
}

function timestamp(value: number | null): { label: string; iso: string } | null {
  if (value === null || !Number.isFinite(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return { label: dateFormatter.format(date), iso: date.toISOString() };
}

function Timestamp({ value }: { value: number | null }) {
  const formatted = timestamp(value);
  return formatted ? <time dateTime={formatted.iso}>{formatted.label}</time> : <span className="dashboard-unknown">Not recorded</span>;
}

function statusLabel(status: DashboardDocument['status']): string {
  if (status === 'processing') return 'Processing';
  if (status === 'error') return 'Preparation failed';
  return 'Ready';
}

function bytes(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)} GB`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} kB`;
  return `${value} B`;
}

function Recorded({ value }: { value: string | null | undefined }) {
  return value ? <span>{value}</span> : <span className="dashboard-unknown">Not recorded</span>;
}

function StorageSummary({ storage }: { storage: StorageBudget }) {
  const remaining = Math.max(0, storage.limitBytes - storage.usedBytes - storage.reservedBytes);
  return <section className="dashboard-storage" aria-label="Storage budget">
    <div className="dashboard-storage-main"><div><span className="dashboard-eyebrow">Storage budget</span><strong>{storage.available ? `${bytes(storage.usedBytes)} used` : 'Usage unavailable'} <span>/ {bytes(storage.limitBytes)} limit</span></strong></div><span className={`dashboard-availability${storage.available ? '' : ' is-unavailable'}`}>{storage.available ? 'Available' : 'Unavailable'}</span></div>
    <div className="dashboard-storage-detail"><span>Provider: <strong>{storage.provider === 'r2' ? 'Cloudflare R2' : 'Local'}</strong></span>{storage.available && <><span>Reserved: <strong>{bytes(storage.reservedBytes)}</strong></span><span>Remaining: <strong>{bytes(remaining)}</strong></span></>}
      {storage.classADailyLimit !== undefined && storage.classADailyLimit > 0 && <span>Class A today (UTC): <strong>{storage.available && storage.classADailyUsed !== undefined ? `${storage.classADailyUsed.toLocaleString()} / ` : 'Cap '}{storage.classADailyLimit.toLocaleString()}</strong></span>}
      {storage.classBDailyLimit !== undefined && storage.classBDailyLimit > 0 && <span>Class B today (UTC): <strong>{storage.available && storage.classBDailyUsed !== undefined ? `${storage.classBDailyUsed.toLocaleString()} / ` : 'Cap '}{storage.classBDailyLimit.toLocaleString()}</strong></span>}
      {storage.classALimit > 0 && <span>Class A {storage.month}: <strong>{storage.available ? `${storage.classAUsed.toLocaleString()} / ` : 'Cap '}{storage.classALimit.toLocaleString()}</strong></span>}
      {storage.classBLimit > 0 && <span>Class B {storage.month}: <strong>{storage.available ? `${storage.classBUsed.toLocaleString()} / ` : 'Cap '}{storage.classBLimit.toLocaleString()}</strong></span>}
    </div>
  </section>;
}

export function Dashboard() {
  const [auth, setAuth] = useState<Auth>({ kind: 'checking' });
  const [sessionRetry, setSessionRetry] = useState(0);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [offset, setOffset] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [documents, setDocuments] = useState<Documents>({ kind: 'loading' });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setAuth({ kind: 'checking' });
    void (async () => {
      try {
        const response = await fetch('/api/dashboard/session', {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        });
        if (response.status === 401) { setAuth({ kind: 'signedOut' }); return; }
        if (response.status === 503) throw new Error('Dashboard sign in is unavailable. Please try again later.');
        if (!response.ok) throw new Error('Couldn’t check your dashboard session. Please try again.');
        const session = sessionFrom(await response.json() as unknown);
        setAuth({ kind: 'signedIn', username: session.username });
      } catch (error) {
        if (controller.signal.aborted) return;
        setAuth({ kind: 'error', message: error instanceof Error ? error.message : 'Couldn’t check your dashboard session. Please try again.' });
      }
    })();
    return () => controller.abort();
  }, [sessionRetry]);

  useEffect(() => {
    if (auth.kind !== 'signedIn') return;
    const controller = new AbortController();
    setDocuments({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetch(`/api/dashboard/documents?offset=${offset}&limit=${PAGE_SIZE}`, {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        });
        if (response.status === 401) {
          setDocuments({ kind: 'loading' });
          setOffset(0);
          setAuth({ kind: 'signedOut' });
          return;
        }
        if (response.status === 503) throw new Error('The dashboard is unavailable right now. Please try again later.');
        if (!response.ok) throw new Error('Couldn’t load files. Please try again.');
        const result = documentsFrom(await response.json() as unknown);
        if (offset > 0 && offset >= result.total) {
          setOffset(result.total === 0 ? 0 : Math.floor((result.total - 1) / PAGE_SIZE) * PAGE_SIZE);
          return;
        }
        setDocuments({ kind: 'ready', value: result });
      } catch (error) {
        if (controller.signal.aborted) return;
        setDocuments({ kind: 'error', message: error instanceof Error ? error.message : 'Couldn’t load files. Please try again.' });
      }
    })();
    return () => controller.abort();
  }, [auth, offset, refreshKey]);

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loginBusy || !username.trim() || !password) return;
    setLoginBusy(true);
    setLoginError('');
    try {
      const response = await fetch('/api/dashboard/login', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (response.status === 401) throw new Error('Incorrect username or password.');
      if (response.status === 429) throw new Error('Too many sign-in attempts. Please try again later.');
      if (response.status === 503) throw new Error('Dashboard sign in is unavailable. Please try again later.');
      if (!response.ok) throw new Error('Couldn’t sign in. Please try again.');
      const session = sessionFrom(await response.json() as unknown);
      setOffset(0);
      setDeleteError('');
      setAuth({ kind: 'signedIn', username: session.username });
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Couldn’t sign in. Please try again.');
    } finally {
      setPassword('');
      setLoginBusy(false);
    }
  };

  const logout = async () => {
    if (logoutBusy) return;
    setLogoutBusy(true);
    setLogoutError('');
    try {
      const response = await fetch('/api/dashboard/logout', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (response.status !== 204 && response.status !== 401) throw new Error('Couldn’t sign out. Please try again.');
      setDocuments({ kind: 'loading' });
      setOffset(0);
      setDeleteError('');
      setAuth({ kind: 'signedOut' });
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : 'Couldn’t sign out. Please try again.');
    } finally {
      setLogoutBusy(false);
    }
  };

  const remove = async (document: DashboardDocument) => {
    if (deletingId) return;
    const confirmed = window.confirm(`Permanently delete “${document.title}” (ID ${document.id}) from hosted storage? Its shared PDF and prepared pages will be removed, and its share links will stop working. This cannot be undone.`);
    if (!confirmed) return;
    setDeletingId(document.id);
    setDeleteError('');
    try {
      await deleteDashboardDocument(document.id);
      setRefreshKey(value => value + 1);
    } catch (error) {
      if (error instanceof DashboardRequestError && error.status === 401) {
        setDocuments({ kind: 'loading' });
        setOffset(0);
        setAuth({ kind: 'signedOut' });
      } else {
        setDeleteError(error instanceof Error ? error.message : 'Couldn’t delete this file. Please try again.');
      }
    } finally {
      setDeletingId(null);
    }
  };

  return <div className="dashboard-shell">
    <header className="home-header dashboard-header">
      <span className="brand">notora<span>.</span></span>
      {auth.kind === 'signedIn' && <div className="dashboard-account"><span>{auth.username}</span><button type="button" className="secondary-button" disabled={logoutBusy} onClick={() => void logout()}>{logoutBusy ? 'Signing out…' : 'Sign out'}</button></div>}
    </header>
    {auth.kind === 'checking' && <main className="dashboard-centered" role="status">Checking dashboard session…</main>}
    {auth.kind === 'error' && <main className="dashboard-centered"><h1>Dashboard unavailable</h1><p role="alert">{auth.message}</p><button type="button" className="secondary-button" onClick={() => setSessionRetry(value => value + 1)}>Try again</button></main>}
    {auth.kind === 'signedOut' && <main className="dashboard-login"><h1>Dashboard sign in</h1><p>Sign in to view uploaded PDFs.</p><form onSubmit={event => void login(event)}>
      <label htmlFor="dashboard-username">Username</label><input id="dashboard-username" name="username" autoComplete="username" required value={username} onChange={event => setUsername(event.target.value)} />
      <label htmlFor="dashboard-password">Password</label><input id="dashboard-password" name="password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} />
      <button type="submit" className="primary-button" disabled={loginBusy || !username.trim() || !password}>{loginBusy ? 'Signing in…' : 'Sign in'}</button>
    </form>{loginError && <p className="form-error" role="alert">{loginError}</p>}</main>}
    {auth.kind === 'signedIn' && <main className="dashboard-main">
      <div className="dashboard-heading"><div><h1>Uploaded files</h1><p>Times are shown in your local time zone.</p></div><button type="button" className="secondary-button" disabled={documents.kind === 'loading' || !!deletingId} onClick={() => { setDeleteError(''); setRefreshKey(value => value + 1); }}>Refresh</button></div>
      {logoutError && <p className="form-error" role="alert">{logoutError}</p>}
      {deleteError && <p className="form-error dashboard-delete-error" role="alert">{deleteError}</p>}
      {documents.kind === 'loading' && <p className="dashboard-message" role="status">Loading files…</p>}
      {documents.kind === 'error' && <div className="dashboard-message"><p role="alert">{documents.message}</p><button type="button" className="secondary-button" onClick={() => setRefreshKey(value => value + 1)}>Try again</button></div>}
      {documents.kind === 'ready' && <>{documents.value.storage && <StorageSummary storage={documents.value.storage} />}{documents.value.total === 0 ? <p className="dashboard-message">No files uploaded yet.</p> : <>
        <div className="dashboard-table-wrap"><table className="dashboard-table"><caption className="visually-hidden">Uploaded PDFs and storage details</caption><thead><tr><th scope="col">File</th><th scope="col">Size and storage</th><th scope="col">Host</th><th scope="col">Request source</th><th scope="col">Activity</th><th scope="col">Action</th></tr></thead><tbody>{documents.value.documents.map(document => <tr key={document.id}>
          <td><span className="dashboard-file-title">{document.title}</span><span className={`dashboard-file-status status-${document.status}`}>{statusLabel(document.status)}</span><span className="dashboard-field"><span>ID</span><code>{document.id}</code></span><span className="dashboard-field"><span>Prefix</span>{document.storagePrefix ? <code>{document.storagePrefix}</code> : <Recorded value={null} />}</span></td>
          <td><span className="dashboard-field"><span>Original</span>{bytes(document.sizeBytes)}</span><span className="dashboard-field"><span>Stored</span>{document.storageBytes === undefined ? <Recorded value={null} /> : bytes(document.storageBytes)}</span><span className="dashboard-field"><span>Provider</span><Recorded value={document.storageProvider === 'r2' ? 'Cloudflare R2' : document.storageProvider === 'local' ? 'Local' : null} /></span></td>
          <td><span className="dashboard-field"><span>Name</span><Recorded value={document.hostName} /></span><span className="dashboard-field"><span>Profile ID</span><Recorded value={document.provenance?.hostId} /></span></td>
          <td><span className="dashboard-field"><span>IP</span><Recorded value={document.provenance?.ipAddress} /></span><span className="dashboard-field"><span>Country</span><Recorded value={document.provenance?.countryCode} /></span><details className="dashboard-user-agent"><summary>User agent</summary><Recorded value={document.provenance?.userAgent} /></details></td>
          <td><span className="dashboard-field"><span>Uploaded</span><Timestamp value={document.uploadedAt} /></span><span className="dashboard-field"><span>Last access</span><Timestamp value={document.lastAccessedAt} /></span></td>
          <td><button type="button" className="secondary-button dashboard-delete" disabled={!!deletingId} onClick={() => void remove(document)} aria-label={`Delete ${document.title}`}>{deletingId === document.id ? 'Deleting…' : 'Delete'}</button></td>
        </tr>)}</tbody></table></div>
        <div className="dashboard-pagination"><span>{documents.value.offset + 1}–{documents.value.offset + documents.value.documents.length} of {documents.value.total}</span><div><button type="button" className="secondary-button" disabled={offset === 0 || !!deletingId} onClick={() => setOffset(value => Math.max(0, value - PAGE_SIZE))}>Previous</button><button type="button" className="secondary-button" disabled={offset + PAGE_SIZE >= documents.value.total || !!deletingId} onClick={() => setOffset(value => value + PAGE_SIZE)}>Next</button></div></div>
      </>}</>}
    </main>}
  </div>;
}
