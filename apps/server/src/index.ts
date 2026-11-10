import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { defaultPdfTools, type PdfTools } from './pdf.ts';
import { attachRelay } from './relay.ts';
import { DocumentStore, UploadError } from './store.ts';

interface Options {
  dataDir?: string;
  webDir?: string;
  maxUploadMb?: number;
  storageBudgetMb?: number;
  revision?: string;
  pdfTools?: PdfTools;
}

function positiveMegabytes(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback * 1024 * 1024;
  if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid server size limit');
  return Math.floor(value * 1024 * 1024);
}

function bearer(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_-]{1,512})$/.exec(header);
  return match?.[1] ?? null;
}

function routeError(error: unknown): { statusCode: number; message: string } {
  if (error instanceof UploadError) return { statusCode: error.statusCode, message: error.message };
  const code = (error as { code?: string }).code;
  if (code === 'FST_REQ_FILE_TOO_LARGE') return { statusCode: 413, message: 'PDF exceeds upload limit' };
  if (code === 'FST_FILES_LIMIT' || code === 'FST_FIELDS_LIMIT' || code === 'FST_PARTS_LIMIT') {
    return { statusCode: 400, message: 'Upload one PDF file' };
  }
  return { statusCode: 500, message: 'Upload failed' };
}

export async function createServer(options: Options = {}): Promise<{ app: FastifyInstance; store: DocumentStore }> {
  const dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? './data');
  const webDir = resolve(options.webDir ?? fileURLToPath(new URL('../../../dist/web', import.meta.url)));
  const maxUploadBytes = positiveMegabytes(options.maxUploadMb ?? Number(process.env.MAX_UPLOAD_MB || 256), 256);
  const storageBudgetBytes = positiveMegabytes(options.storageBudgetMb ?? Number(process.env.MAX_STORAGE_MB || 2048), 2048);
  const revision = options.revision ?? process.env.REVISION ?? 'dev';
  const store = new DocumentStore(dataDir, maxUploadBytes, storageBudgetBytes, options.pdfTools ?? defaultPdfTools());
  await store.initialize();
  const app = Fastify({ logger: false });

  await app.register(multipart, {
    limits: { fileSize: maxUploadBytes, files: 1, fields: 0, parts: 1 },
    throwFileSizeLimit: true,
  });

  app.get('/healthz', async () => ({ status: 'ok', revision }));

  app.post('/api/documents', async (request, reply) => {
    if (!request.isMultipart()) return reply.code(415).send({ error: 'Upload a PDF file' });
    try {
      let result;
      let count = 0;
      for await (const part of request.parts()) {
        if (part.type !== 'file' || part.fieldname !== 'file' || count !== 0) {
          throw new UploadError(400, 'Upload one PDF file');
        }
        count += 1;
        result = await store.upload(part.file, part.filename, () => {
          if (part.file.truncated) throw new UploadError(413, 'PDF exceeds upload limit');
        });
      }
      if (!result || count !== 1) throw new UploadError(400, 'Upload one PDF file');
      return reply.code(202).send(result);
    } catch (error) {
      const response = routeError(error);
      return reply.code(response.statusCode).send({ error: response.message });
    }
  });

  const authorized = (id: string, authorization: unknown) => {
    const token = bearer(authorization);
    if (!token) return { status: 401 as const };
    const auth = store.authorize(id, token);
    if (!auth) return { status: 404 as const };
    return { status: 200 as const, record: auth.record };
  };

  app.get<{ Params: { id: string } }>('/api/documents/:id', async (request, reply) => {
    const auth = authorized(request.params.id, request.headers.authorization);
    if (auth.status !== 200) return reply.code(auth.status).send({ error: 'Document unavailable' });
    return reply.header('Cache-Control', 'private, no-store').send(auth.record.manifest);
  });

  app.get<{ Params: { id: string; number: string }; Querystring: { v?: string } }>(
    '/api/documents/:id/pages/:number.pdf', async (request, reply) => {
      const auth = authorized(request.params.id, request.headers.authorization);
      if (auth.status !== 200) return reply.code(auth.status).send({ error: 'Document unavailable' });
      const { manifest } = auth.record;
      const number = Number(request.params.number);
      if (manifest.status !== 'ready' || !/^[1-9]\d*$/.test(request.params.number)
        || number > manifest.pageCount || (request.query.v !== undefined && request.query.v !== manifest.version)) {
        return reply.code(404).send({ error: 'Page unavailable' });
      }
      const path = store.pagePath(manifest.id, manifest.version, number);
      let size: number;
      try { size = (await stat(path)).size; } catch { return reply.code(404).send({ error: 'Page unavailable' }); }
      const etag = `"${manifest.version}-${number}"`;
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Length', size);
      reply.header('Cache-Control', 'private, max-age=31536000, immutable');
      reply.header('ETag', etag);
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply.send(createReadStream(path));
    },
  );

  app.get<{ Params: { id: string; number: string } }>(
    '/api/documents/:id/pages/:number/links', async (request, reply) => {
      const auth = authorized(request.params.id, request.headers.authorization);
      if (auth.status !== 200) return reply.code(auth.status).send({ error: 'Document unavailable' });
      const { manifest } = auth.record;
      const number = Number(request.params.number);
      if (manifest.status !== 'ready' || !/^[1-9]\d*$/.test(request.params.number) || number > manifest.pageCount) {
        return reply.code(404).send({ error: 'Page unavailable' });
      }
      try {
        const links = await store.pageLinks(manifest.id, manifest.version, number);
        return reply.header('Cache-Control', 'private, max-age=31536000, immutable').send(links);
      } catch { return reply.code(404).send({ error: 'Page unavailable' }); }
    },
  );

  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/', wildcard: false });
    app.get<{ Params: { documentId: string } }>('/r/:documentId', async (_request, reply) => reply.sendFile('index.html'));
  }

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'Not found' }));
  attachRelay(app, store);
  return { app, store };
}

export async function buildServer(options: Options = {}): Promise<FastifyInstance> {
  return (await createServer(options)).app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await buildServer();
  const port = Number(process.env.PORT || 3000);
  await app.listen({ port, host: '0.0.0.0' });
  process.stdout.write(`Notora listening on ${port}\n`);
}
