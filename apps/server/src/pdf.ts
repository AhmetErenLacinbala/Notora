import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OutlineItem, PageInfo, PageLink } from '../../../packages/shared/src/index.ts';

export interface ExtractedPdf {
  pages: PageInfo[];
  outline: OutlineItem[];
  links: PageLink[][];
}

export interface PdfTools {
  validate(source: string): Promise<void>;
  extract(source: string, pagesDir: string, withinBudget?: (outputBytes: number) => boolean): Promise<ExtractedPdf>;
}

const helper = fileURLToPath(new URL('../pdf_manifest.py', import.meta.url));

async function flatDirectoryBytes(path: string): Promise<number> {
  const files = await readdir(path);
  const sizes = await Promise.all(files.map(async name => (await stat(join(path, name))).size));
  return sizes.reduce((sum, size) => sum + size, 0);
}

function run(binary: string, args: string[], timeoutMs: number, allowedCodes = [0], withinBudget?: () => Promise<boolean>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: 'ignore', timeout: timeoutMs, windowsHide: true });
    let busy = false;
    let exceeded = false;
    const interval = withinBudget ? setInterval(async () => {
      if (busy || child.exitCode !== null || child.signalCode !== null) return;
      busy = true;
      try {
        if (!(await withinBudget())) {
          exceeded = true;
          child.kill('SIGTERM');
        }
      } catch {
        exceeded = true;
        child.kill('SIGTERM');
      } finally { busy = false; }
    }, 250) : undefined;
    child.once('error', error => { if (interval) clearInterval(interval); reject(error); });
    child.once('close', (code, signal) => {
      if (interval) clearInterval(interval);
      if (exceeded) { reject(new Error('PDF storage budget exceeded')); return; }
      if (code !== null && allowedCodes.includes(code)) resolve();
      else reject(new Error(signal ? 'PDF tool timed out' : `PDF tool exited with status ${code}`));
    });
  });
}

export function defaultPdfTools(): PdfTools {
  const qpdf = process.env.QPDF_BIN || 'qpdf';
  const python = process.env.PYTHON_BIN || 'python3';
  let previous: Promise<void> = Promise.resolve();
  const exclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    const before = previous;
    let release!: () => void;
    previous = new Promise<void>(resolve => { release = resolve; });
    await before;
    try { return await work(); } finally { release(); }
  };
  return {
    async validate(source) {
      // Status 3 means qpdf recovered from warnings. pypdf and split-pages
      // still have to parse the file before it can become ready.
      await exclusive(() => run(qpdf, ['--check', source], 180_000, [0, 3]));
    },
    async extract(source, pagesDir, withinBudget) {
      return exclusive(async () => {
        const extractedPath = join(pagesDir, `extract-${randomUUID()}.json`);
        try {
          await run(python, [helper, source, extractedPath], 300_000);
          const extracted = JSON.parse(await readFile(extractedPath, 'utf8')) as ExtractedPdf;
          if (!Array.isArray(extracted.pages) || !Array.isArray(extracted.links) || extracted.pages.length === 0 || extracted.pages.length !== extracted.links.length || !Array.isArray(extracted.outline)) {
            throw new Error('Invalid PDF extraction result');
          }
          // A single qpdf pass avoids reopening a large source PDF per page.
          // %d is replaced with a zero-padded ORIGINAL one-based page number.
          await run(qpdf, ['--split-pages', source, join(pagesDir, '%d.pdf')], 600_000, [0, 3],
            withinBudget ? async () => withinBudget(await flatDirectoryBytes(pagesDir)) : undefined);
          if (withinBudget && !withinBudget(await flatDirectoryBytes(pagesDir))) throw new Error('PDF storage budget exceeded');
          const files = (await readdir(pagesDir)).filter(name => /^\d+\.pdf$/.test(name));
          if (files.length !== extracted.pages.length) throw new Error('Page split count mismatch');
          for (const file of files) {
            const number = Number(file.slice(0, -4));
            if (!Number.isSafeInteger(number) || number < 1 || number > extracted.pages.length) throw new Error('Invalid split page number');
            const from = join(pagesDir, file);
            const to = join(pagesDir, `${number}.pdf`);
            if (from !== to) await rename(from, to);
            const handle = await open(to, 'r');
            try {
              if ((await stat(to)).size === 0) throw new Error('Empty extracted page');
              await handle.sync();
            } finally { await handle.close(); }
          }
          for (const page of extracted.pages) await stat(join(pagesDir, `${page.number}.pdf`));
          return extracted;
        } finally {
          await rm(extractedPath, { force: true });
        }
      });
    },
  };
}
