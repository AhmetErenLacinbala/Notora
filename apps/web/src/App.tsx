import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { DocumentManifest, OwnedProject, Profile } from '../../../packages/shared/src/index';
import { getManifest, uploadPdf } from './lib/api';
import { getOwnedProject, getProfile, listOwnedProjects, saveOwnedProject, saveProfile } from './lib/storage';

const Workspace = lazy(async () => ({ default: (await import('./components/Workspace')).Workspace }));

type Route = { documentId: string; token: string } | null;

function currentRoute(): Route {
  const match = window.location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)\/?$/);
  if (!match) return null;
  let token = window.location.hash.slice(1);
  try { token = decodeURIComponent(token); } catch { /* malformed fragments are rejected by the API */ }
  return { documentId: match[1], token };
}

function documentUrl(documentId: string, accessToken: string): string {
  return `/r/${encodeURIComponent(documentId)}#${encodeURIComponent(accessToken)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export default function App() {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [route, setRoute] = useState<Route>(currentRoute);
  const [owned, setOwned] = useState<OwnedProject[]>([]);
  const [homeError, setHomeError] = useState('');
  const [uploadState, setUploadState] = useState<'idle' | 'uploading'>('idle');
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    getProfile().then(value => { if (live) setProfile(value); }).catch(error => {
      if (live) { setProfile(null); setHomeError(errorText(error)); }
    });
    const updateRoute = () => setRoute(currentRoute());
    window.addEventListener('popstate', updateRoute);
    window.addEventListener('hashchange', updateRoute);
    return () => {
      live = false;
      window.removeEventListener('popstate', updateRoute);
      window.removeEventListener('hashchange', updateRoute);
    };
  }, []);

  useEffect(() => {
    if (!profile || route) return;
    let live = true;
    listOwnedProjects().then(projects => {
      if (live) setOwned([...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt));
    }).catch(error => { if (live) setHomeError(errorText(error)); });
    return () => { live = false; };
  }, [profile, route]);

  const navigate = (next: Route) => {
    window.history.pushState(null, '', next ? documentUrl(next.documentId, next.token) : '/');
    setRoute(next);
  };

  const submitName = async (name: string) => {
    const next = { id: crypto.randomUUID(), name: name.trim().slice(0, 60) };
    await saveProfile(next);
    setProfile(next);
  };

  const openFile = async (file: File | undefined) => {
    if (!file || uploadState !== 'idle') return;
    setHomeError('');
    setUploadProgress(0);
    setUploadState('uploading');
    try {
      const result = await uploadPdf(file, setUploadProgress);
      const now = Date.now();
      const project: OwnedProject = {
        ...result,
        title: file.name.replace(/\.pdf$/i, '') || 'Untitled PDF',
        createdAt: now,
        lastOpenedAt: now,
      };
      await saveOwnedProject(project);
      navigate({ documentId: result.documentId, token: result.accessToken });
    } catch (error) {
      setHomeError(errorText(error));
    } finally {
      setUploadState('idle');
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  if (profile === undefined) return <div className="app-loading" aria-label="Loading Notora">notora<span>.</span></div>;
  if (profile === null) return <NameGate onSubmit={submitName} initialError={homeError} />;
  if (route) return <DocumentRoute key={route.documentId} route={route} profile={profile} onHome={() => navigate(null)} />;

  return (
    <div className="home-shell">
      <header className="home-header"><span className="brand">notora<span>.</span></span><span className="home-profile">{profile.name}</span></header>
      <main className="home-main">
        <div className="home-intro"><h1>Open a PDF</h1><p>Read and write notes together, right on the page.</p></div>
        <input ref={fileInput} className="visually-hidden" type="file" accept="application/pdf,.pdf" aria-label="Choose a PDF" onChange={event => void openFile(event.target.files?.[0])} />
        <button className="primary-button open-button" type="button" disabled={uploadState !== 'idle'} onClick={() => fileInput.current?.click()}>
          <span className="button-plus" aria-hidden="true">+</span>{uploadState === 'uploading' ? 'Uploading PDF…' : 'Open a PDF'}
        </button>
        {uploadState === 'uploading' && <div className="upload-progress" role="status" aria-live="polite"><div className="upload-track"><div style={{ width: `${uploadProgress}%` }} /></div><span>{uploadProgress < 100 ? `${uploadProgress}%` : 'Preparing document…'}</span></div>}
        {homeError && <p className="form-error" role="alert">{homeError}</p>}
        {owned.length > 0 && <section className="recent-section" aria-labelledby="recent-title"><h2 id="recent-title">Recent</h2><div className="recent-list">{owned.map(project => (
          <button key={project.documentId} type="button" className="recent-item" onClick={() => navigate({ documentId: project.documentId, token: project.accessToken })}>
            <span className="recent-icon" aria-hidden="true">PDF</span><span className="recent-title">{project.title}</span><span className="recent-date">{new Date(project.lastOpenedAt).toLocaleDateString()}</span><span className="recent-arrow" aria-hidden="true">↗</span>
          </button>
        ))}</div></section>}
      </main>
    </div>
  );
}

function NameGate({ onSubmit, initialError }: { onSubmit: (name: string) => Promise<void>; initialError: string }) {
  const [name, setName] = useState('');
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    try { await onSubmit(name); } catch (caught) { setError(errorText(caught)); setBusy(false); }
  };
  return <div className="name-shell"><div className="name-panel"><span className="brand">notora<span>.</span></span><h1>What should we call you?</h1><p>Your name appears beside your cursor when you work with others.</p><form onSubmit={event => void submit(event)}><label htmlFor="display-name">Your name</label><input id="display-name" autoFocus autoComplete="name" maxLength={60} value={name} onChange={event => setName(event.target.value)} placeholder="Name" /><button type="submit" className="primary-button" disabled={!name.trim() || busy}>Continue</button></form>{error && <p className="form-error" role="alert">{error}</p>}</div></div>;
}

function DocumentRoute({ route, profile, onHome }: { route: NonNullable<Route>; profile: Profile; onHome: () => void }) {
  const [manifest, setManifest] = useState<DocumentManifest | null>(null);
  const [accessToken, setAccessToken] = useState(route.token);
  const [ownerToken, setOwnerToken] = useState<string | undefined>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    setManifest(null);
    setError('');
    const run = async () => {
      try {
        const owned = await getOwnedProject(route.documentId).catch(error => {
          if (!route.token) throw error;
          return undefined;
        });
        const token = route.token || owned?.accessToken || '';
        if (!token) throw new Error('This link is missing its access token. Open the original share link.');
        if (!live) return;
        setAccessToken(token);
        setOwnerToken(owned?.accessToken === token ? owned.ownerToken : undefined);
        const poll = async () => {
          try {
            const result = await getManifest(route.documentId, token);
            if (!live) return;
            setManifest(result);
            if (result.status === 'processing') timer = window.setTimeout(() => void poll(), 1800);
            else if (result.status === 'ready' && owned) {
              void saveOwnedProject({ ...owned, title: result.title, lastOpenedAt: Date.now() });
            }
          } catch (caught) { if (live) setError(errorText(caught)); }
        };
        await poll();
      } catch (caught) { if (live) setError(errorText(caught)); }
    };
    void run();
    return () => { live = false; if (timer) window.clearTimeout(timer); };
  }, [route.documentId, route.token, retry]);

  if (manifest?.status === 'ready' && accessToken) return <Suspense fallback={<div className="workspace-init" role="status">Opening workspace…</div>}><Workspace manifest={manifest} accessToken={accessToken} ownerToken={ownerToken} profile={profile} onHome={onHome} /></Suspense>;
  return <div className="document-wait"><header className="home-header"><button className="brand brand-button" type="button" onClick={onHome}>notora<span>.</span></button></header><main><div className="wait-mark" aria-hidden="true" /><h1>{error ? 'Couldn’t open this PDF' : manifest?.status === 'error' ? 'This PDF couldn’t be prepared' : 'Preparing your PDF'}</h1><p>{error || manifest?.error || 'This can take a moment for a longer document.'}</p>{(error || manifest?.status === 'error') && <button type="button" className="secondary-button" onClick={() => setRetry(value => value + 1)}>Try again</button>}</main></div>;
}
