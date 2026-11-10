import { cp, mkdir } from 'node:fs/promises';
const destination = process.argv.includes('--dev') ? 'apps/web/public/pdf-assets' : 'dist/web/pdf-assets';
for (const name of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  await mkdir(destination, { recursive: true });
  try { await cp(`node_modules/pdfjs-dist/${name}`, `${destination}/${name}`, { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
