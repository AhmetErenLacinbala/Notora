// Deterministic geometry/navigation fixture; --large adds 320 RGB image pages (~154 MB).
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
const large = process.argv.includes('--large');
const output = process.argv.find(v => v.endsWith('.pdf')) ?? 'work/notora-test-book.pdf';
const count = 320;
const objects = new Map();
const pageId = n => 6 + (n - 1) * 3;
objects.set(1, '<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R >>');
objects.set(2, `<< /Type /Pages /Count ${count} /Kids [${Array.from({ length: count }, (_, i) => `${pageId(i + 1)} 0 R`).join(' ')}] >>`);
objects.set(3, '<< /Type /Outlines /First 4 0 R /Last 4 0 R /Count 1 >>');
objects.set(4, `<< /Title (Chapter 37) /Parent 3 0 R /Dest [${pageId(37)} 0 R /XYZ 0 842 null] >>`);
objects.set(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
const annotationId = 6 + count * 3;
objects.set(annotationId, `<< /Type /Annot /Subtype /Link /Rect [40 670 250 710] /Border [0 0 0] /Dest [${pageId(37)} 0 R /XYZ 0 842 null] >>`);
for (let n = 1; n <= count; n++) {
  const id = pageId(n);
  const geometry = n === 2 ? '/Rotate 90' : n === 3 ? '/CropBox [20 30 575 810] /UserUnit 2' : '';
  const xobject = large ? `/XObject << /Image ${id + 2} 0 R >>` : '';
  objects.set(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ${geometry} /Resources << /Font << /F1 5 0 R >> ${xobject} >> /Contents ${id + 1} 0 R ${n === 1 ? `/Annots [${annotationId} 0 R]` : ''} >>`);
  const content = `BT /F1 24 Tf 40 770 Td (Notora - Page ${n}) Tj 0 -42 Td /F1 13 Tf (A test document for reading together.) Tj ${n === 1 ? '0 -42 Td (Click this area to open Chapter 37.) Tj' : ''} ET\n${large ? 'q 400 0 0 400 60 180 cm /Image Do Q\n' : ''}`;
  objects.set(id + 1, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  if (large) {
    const data = randomBytes(400 * 400 * 3);
    objects.set(id + 2, Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 400 /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]));
  } else objects.set(id + 2, 'null');
}
const chunks = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
let offset = chunks[0].length;
const offsets = [0];
for (let id = 1; id <= annotationId; id++) {
  offsets[id] = offset;
  const obj = Buffer.concat([Buffer.from(`${id} 0 obj\n`), Buffer.from(objects.get(id) ?? 'null'), Buffer.from('\nendobj\n')]);
  chunks.push(obj); offset += obj.length;
}
const xref = offset;
chunks.push(Buffer.from(`xref\n0 ${annotationId + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${annotationId + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, Buffer.concat(chunks));
console.log(`${output}: ${count} pages, ${chunks.reduce((sum, b) => sum + b.length, 0)} bytes`);
