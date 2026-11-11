import { useEffect, useState, type FormEvent } from 'react';
import type { DashboardDocument, DashboardDocumentsResponse, DashboardSession } from '../../../../packages/shared/src/index';

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

function documentsFrom(value: unknown): DashboardDocumentsResponse {
  if (!value || typeof value !== 'object' || !('documents' in value) || !Array.isArray(value.documents) ||
      !('total' in value) || !Number.isSafeInteger(value.total) || (value.total as number) < 0 ||
      !('offset' in value) || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0 ||
      !('limit' in value) || !Number.isSafeInteger(value.limit) || (value.limit as number) <= 0) {
    throw new Error('The dashboard returned an invalid file list. Please try again.');
  }
  if (value.documents.length > (value.limit as number) || value.documents.some((document: unknown) =>
    !document || typeof document !== 'object' ||
    !('id' in document) || typeof document.id !== 'string' ||
    !('title' in document) || typeof document.title !== 'string' ||
    !('hostName' in document) || (document.hostName !== null && typeof document.hostName !== 'string') ||
    !('uploadedAt' in document) || (document.uploadedAt !== null && !Number.isFinite(document.uploadedAt)) ||
    !('lastAccessedAt' in document) || (document.lastAccessedAt !== null && !Number.isFinite(document.lastAccessedAt)) ||
    !('status' in document) || !['processing', 'ready', 'error'].includes(String(document.status)))) {
    throw new Error('The dashboard returned an invalid file list. Please try again.');
  }
  return value as DashboardDocumentsResponse;
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

function statusLabel(status: DashboardDocument['status']): string | null {
  if (status === 'processing') return 'Processing';
  if (status === 'error') return 'Preparation failed';
  return null;
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
      setAuth({ kind: 'signedOut' });
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : 'Couldn’t sign out. Please try again.');
    } finally {
      setLogoutBusy(false);
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
      <div className="dashboard-heading"><div><h1>Uploaded files</h1><p>Times are shown in your local time zone.</p></div><button type="button" className="secondary-button" disabled={documents.kind === 'loading'} onClick={() => setRefreshKey(value => value + 1)}>Refresh</button></div>
      {logoutError && <p className="form-error" role="alert">{logoutError}</p>}
      {documents.kind === 'loading' && <p className="dashboard-message" role="status">Loading files…</p>}
      {documents.kind === 'error' && <div className="dashboard-message"><p role="alert">{documents.message}</p><button type="button" className="secondary-button" onClick={() => setRefreshKey(value => value + 1)}>Try again</button></div>}
      {documents.kind === 'ready' && (documents.value.total === 0 ? <p className="dashboard-message">No files uploaded yet.</p> : <>
        <div className="dashboard-table-wrap"><table className="dashboard-table"><caption className="visually-hidden">Uploaded PDFs</caption><thead><tr><th scope="col">File</th><th scope="col">Host</th><th scope="col">Uploaded</th><th scope="col">Last accessed</th></tr></thead><tbody>{documents.value.documents.map(document => <tr key={document.id}>
          <td><span className="dashboard-file-title">{document.title}</span>{statusLabel(document.status) && <span className="dashboard-file-status">{statusLabel(document.status)}</span>}</td>
          <td>{document.hostName || <span className="dashboard-unknown">Not recorded</span>}</td>
          <td><Timestamp value={document.uploadedAt} /></td><td><Timestamp value={document.lastAccessedAt} /></td>
        </tr>)}</tbody></table></div>
        <div className="dashboard-pagination"><span>{documents.value.offset + 1}–{documents.value.offset + documents.value.documents.length} of {documents.value.total}</span><div><button type="button" className="secondary-button" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - PAGE_SIZE))}>Previous</button><button type="button" className="secondary-button" disabled={offset + PAGE_SIZE >= documents.value.total} onClick={() => setOffset(value => value + PAGE_SIZE)}>Next</button></div></div>
      </>)}
    </main>}
  </div>;
}
