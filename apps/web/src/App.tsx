import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { DocumentManifest, OwnedProject, Profile } from '../../../packages/shared/src/index';
import { getManifest } from './lib/api';
import { importLocalFile, resolveExistingUpload, uploadLocalDocument } from './lib/localDocuments';
import type { LocalPdfSource } from './lib/localPdf';
import { parseSharedView } from './lib/shareLink';
import { getLocalBlob, getLocalDocument, getOwnedProject, getProfile, listLocalDocuments, listOwnedProjects, saveOwnedProject, saveProfile, updateLocalManifest, type LocalDocumentRecord } from './lib/storage';

const Workspace = lazy(async () => ({ default: (await import('./components/Workspace')).Workspace }));

type Route = { kind: 'remote'; documentId: string; token: string } | { kind: 'local'; id: string } | null;
type Recent = { kind: 'local'; record: LocalDocumentRecord } | { kind: 'remote'; project: OwnedProject };

function currentRoute(): Route {
  const local = window.location.pathname.match(/^\/local\/(local-[a-f0-9]{64})\/?$/);
  if (local) return { kind: 'local', id: local[1] };
  const remote = window.location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)\/?$/);
  if (!remote) return null;
  let token = window.location.hash.slice(1);
  try { token = decodeURIComponent(token); } catch { /* API rejects malformed fragments */ }
  return { kind: 'remote', documentId: remote[1], token };
}

function routeUrl(route: NonNullable<Route>): string {
  return route.kind === 'local' ? `/local/${route.id}` : `/r/${encodeURIComponent(route.documentId)}#${encodeURIComponent(route.token)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export default function App() {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [route, setRoute] = useState<Route>(currentRoute);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [homeError, setHomeError] = useState('');
  const [opening, setOpening] = useState(false);
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
    Promise.all([listLocalDocuments(), listOwnedProjects()]).then(([locals, owned]) => {
      if (!live) return;
      const localRemoteIds = new Set(locals.map(record => record.upload?.documentId).filter(Boolean));
      const items: Recent[] = [
        ...locals.map(record => ({ kind: 'local' as const, record })),
        ...owned.filter(project => !localRemoteIds.has(project.documentId)).map(project => ({ kind: 'remote' as const, project })),
      ];
      setRecent(items.sort((a, b) => (b.kind === 'local' ? b.record.lastOpenedAt : b.project.lastOpenedAt) - (a.kind === 'local' ? a.record.lastOpenedAt : a.project.lastOpenedAt)));
    }).catch(error => { if (live) setHomeError(errorText(error)); });
    return () => { live = false; };
  }, [profile, route]);

  const navigate = (next: Route) => {
    window.history.pushState(null, '', next ? routeUrl(next) : '/');
    setRoute(next);
  };

  const submitName = async (name: string) => {
    const next = { id: crypto.randomUUID(), name: name.trim().slice(0, 60) };
    await saveProfile(next);
    setProfile(next);
  };

  const openFile = async (file: File | undefined) => {
    if (!file || opening) return;
    setHomeError('');
    setOpening(true);
    try {
      const record = await importLocalFile(file);
      // A failed legacy check does not prevent local reading; Share retries it.
      await resolveExistingUpload(record).catch(() => record);
      navigate({ kind: 'local', id: record.id });
    } catch (error) {
      setHomeError(errorText(error));
    } finally {
      setOpening(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  if (profile === undefined) return <div className="app-loading" aria-label="Loading Notora">notora<span>.</span></div>;
  if (profile === null) return <NameGate onSubmit={submitName} initialError={homeError} />;
  if (route?.kind === 'remote') return <DocumentRoute key={`remote:${route.documentId}`} route={route} profile={profile} onHome={() => navigate(null)} />;
  if (route?.kind === 'local') return <LocalDocumentRoute key={`local:${route.id}`} id={route.id} profile={profile} onHome={() => navigate(null)} onRemote={result => navigate({ kind: 'remote', documentId: result.documentId, token: result.accessToken })} />;

  return <div className="home-shell">
    <header className="home-header"><span className="brand">notora<span>.</span></span><span className="home-profile">{profile.name}</span></header>
    <main className="home-main">
      <div className="home-intro"><h1>Open a PDF</h1><p>Read and write notes together, right on the page.</p></div>
      <input ref={fileInput} className="visually-hidden" type="file" accept="application/pdf,.pdf" aria-label="Choose a PDF" onChange={event => void openFile(event.target.files?.[0])} />
      <button className="primary-button open-button" type="button" disabled={opening} onClick={() => fileInput.current?.click()}><span className="button-plus" aria-hidden="true">+</span>{opening ? 'Opening PDF…' : 'Open a PDF'}</button>
      {homeError && <p className="form-error" role="alert">{homeError}</p>}
      {recent.length > 0 && <section className="recent-section" aria-labelledby="recent-title"><h2 id="recent-title">Recent</h2><div className="recent-list">{recent.map(item => {
        const title = item.kind === 'local' ? item.record.title : item.project.title;
        const lastOpenedAt = item.kind === 'local' ? item.record.lastOpenedAt : item.project.lastOpenedAt;
        const key = item.kind === 'local' ? item.record.id : item.project.documentId;
        return <button key={key} type="button" className="recent-item" onClick={() => navigate(item.kind === 'local' ? { kind: 'local', id: item.record.id } : { kind: 'remote', documentId: item.project.documentId, token: item.project.accessToken })}>
          <span className="recent-icon" aria-hidden="true">PDF</span><span className="recent-title">{title}</span><span className="recent-date">{new Date(lastOpenedAt).toLocaleDateString()}</span><span className="recent-arrow" aria-hidden="true">↗</span>
        </button>;
      })}</div></section>}
    </main>
  </div>;
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

function WaitPage({ onHome, title, message, retry }: { onHome: () => void; title: string; message: string; retry?: () => void }) {
  return <div className="document-wait"><header className="home-header"><button className="brand brand-button" type="button" onClick={onHome}>notora<span>.</span></button></header><main><div className="wait-mark" aria-hidden="true" /><h1>{title}</h1><p>{message}</p>{retry && <button type="button" className="secondary-button" onClick={retry}>Try again</button>}</main></div>;
}

function LocalDocumentRoute({ id, profile, onHome, onRemote }: { id: string; profile: Profile; onHome: () => void; onRemote: (result: { documentId: string; accessToken: string }) => void }) {
  const [record, setRecord] = useState<LocalDocumentRecord | null>(null);
  const [source, setSource] = useState<LocalPdfSource | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [uploadState, setUploadState] = useState<{ status: 'uploading' | 'processing'; progress: number } | null>(null);
  const [uploadError, setUploadError] = useState('');

  useEffect(() => {
    let live = true;
    let opened: LocalPdfSource | undefined;
    setRecord(null);
    setSource(null);
    setError('');
    const run = async () => {
      try {
        const local = await getLocalDocument(id);
        const blob = await getLocalBlob(id);
        if (!local || !blob) throw new Error('This PDF is no longer in browser storage.');
        const { openLocalPdf } = await import('./lib/localPdf');
        opened = await openLocalPdf(blob, local.id, local.title, local.contentHash, local.manifest);
        if (!live) { await opened.destroy(); return; }
        const updated = await updateLocalManifest(local.id, opened.manifest);
        if (!live) { await opened.destroy(); return; }
        setRecord(updated);
        setSource(opened);
      } catch (caught) { if (live) setError(errorText(caught)); }
    };
    void run();
    return () => { live = false; if (opened) void opened.destroy(); };
  }, [id, retry]);

  const share = async (beforeTransition?: () => Promise<void>) => {
    if (!record || uploadState) return;
    setUploadError('');
    setUploadState({ status: 'uploading', progress: 0 });
    try {
      const result = await uploadLocalDocument(id, progress => setUploadState({ status: 'uploading', progress }));
      setUploadState({ status: 'processing', progress: 100 });
      await beforeTransition?.();
      onRemote(result);
    } catch (caught) {
      setUploadError(errorText(caught));
      setUploadState(null);
      throw caught;
    }
  };

  if (!record || !source) return <WaitPage onHome={onHome} title={error ? 'Couldn’t open this PDF' : 'Opening your PDF'} message={error || 'Reading its pages and outline locally.'} retry={error ? () => setRetry(value => value + 1) : undefined} />;
  const manifest = record.upload ? { ...source.manifest, id: record.upload.documentId } : source.manifest;
  return <Suspense fallback={<div className="workspace-init" role="status">Opening workspace…</div>}><Workspace manifest={manifest} accessToken={record.upload?.accessToken ?? ''} ownerToken={record.upload?.ownerToken} profile={profile} onHome={onHome} storageId={record.storageId} localOnly={!record.upload} localPdf={source} onUpload={record.upload ? undefined : share} uploadState={uploadState} uploadError={uploadError} /></Suspense>;
}

function DocumentRoute({ route, profile, onHome }: { route: Extract<Route, { kind: 'remote' }>; profile: Profile; onHome: () => void }) {
  const [manifest, setManifest] = useState<DocumentManifest | null>(null);
  const [accessToken, setAccessToken] = useState(route.token);
  const [owned, setOwned] = useState<OwnedProject | undefined>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    setManifest(null);
    setError('');
    const run = async () => {
      try {
        const project = await getOwnedProject(route.documentId).catch(error => { if (!route.token) throw error; return undefined; });
        const token = route.token || project?.accessToken || '';
        if (!token) throw new Error('This link is missing its access token. Open the original share link.');
        if (!live) return;
        setAccessToken(token);
        setOwned(project?.accessToken === token ? project : undefined);
        const poll = async () => {
          try {
            const result = await getManifest(route.documentId, token);
            if (!live) return;
            setManifest(result);
            if (result.status === 'processing') timer = window.setTimeout(() => void poll(), 1800);
            else if (result.status === 'ready' && project) void saveOwnedProject({ ...project, title: result.title, lastOpenedAt: Date.now() });
          } catch (caught) { if (live) setError(errorText(caught)); }
        };
        await poll();
      } catch (caught) { if (live) setError(errorText(caught)); }
    };
    void run();
    return () => { live = false; if (timer) window.clearTimeout(timer); };
  }, [route.documentId, route.token, retry]);

  if (manifest?.status === 'ready' && accessToken) return <Suspense fallback={<div className="workspace-init" role="status">Opening workspace…</div>}><Workspace manifest={manifest} accessToken={accessToken} ownerToken={owned?.ownerToken} profile={profile} onHome={onHome} storageId={owned?.storageId} initialView={parseSharedView(window.location.search)} /></Suspense>;
  return <WaitPage onHome={onHome} title={error ? 'Couldn’t open this PDF' : manifest?.status === 'error' ? 'This PDF couldn’t be prepared' : 'Preparing your PDF'} message={error || manifest?.error || 'This can take a moment for a longer document.'} retry={error || manifest?.status === 'error' ? () => setRetry(value => value + 1) : undefined} />;
}
