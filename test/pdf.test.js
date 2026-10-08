import test from 'node:test';
import assert from 'node:assert/strict';
import { imagenesDePdf, esPdf } from '../src/core/pdf.js';

// PDF mínimo como los de CamScanner: por página, una marca de agua chica y la captura.
function pdfDePrueba() {
  const jpeg = (n) => `\xff\xd8\xff\xe0FAKE${n}\xff\xd9`;
  const objs = [];
  const add = (n, body) => objs.push({ n, body });
  add(1, '<<\n/Type /Catalog\n/Pages 2 0 R\n>>');
  add(2, '<<\n/Type /Pages\n/Kids [ 4 0 R 20 0 R ]\n/Count 2\n>>');
  add(3, '<<\n/Title <FEFF005400450053005400200054004D002000500050004100590020004A006F007300E9>\n>>');
  // La página 2 está antes en el archivo: el orden sale del árbol de páginas.
  add(20, '<<\n/Type /Page\n/Resources <<\n/XObject <<\n/X1 7 0 R\n/X3 22 0 R\n>>\n>>\n/Parent 2 0 R\n>>');
  add(22, `<<\n/Length 23 0 R\n/Type /XObject\n/Subtype /Image\n/Height 1650\n/Width 720\n/Filter [ /DCTDecode ]\n>>\nstream\n${jpeg('B')}\nendstream`);
  add(23, String(jpeg('B').length));
  add(4, '<<\n/Type /Page\n/Resources <<\n/XObject <<\n/X1 7 0 R\n/X2 10 0 R\n>>\n>>\n/Parent 2 0 R\n>>');
  add(7, `<<\n/Length 8 0 R\n/Type /XObject\n/Subtype /Image\n/Height 48\n/Width 447\n/Filter [ /DCTDecode ]\n>>\nstream\n${jpeg('logo')}\nendstream`);
  add(8, String(jpeg('logo').length));
  add(10, `<<\n/Length 99\n/Type /XObject\n/Subtype /Image\n/Height 3736\n/Width 392\n/Filter [ /DCTDecode ]\n>>\nstream\n${jpeg('A')}\nendstream`);
  const txt = `%PDF-1.7\n${objs.map((o) => `${o.n} 0 obj\n${o.body}\nendobj\n`).join('')}trailer\n<<\n/Root 1 0 R\n/Info 3 0 R\n>>\n%%EOF\n`;
  return Uint8Array.from(txt, (c) => c.charCodeAt(0));
}

test('PDF: saca las capturas de cada página en orden, sin la marca de agua, y el título', () => {
  const b = pdfDePrueba();
  assert.ok(esPdf(b));
  const { titulo, imagenes } = imagenesDePdf(b);
  assert.equal(titulo, 'TEST TM PPAY José');
  assert.deepEqual(
    imagenes.map((i) => [i.pagina, i.ancho, i.alto, String.fromCharCode(...i.bytes)]),
    [
      [1, 392, 3736, '\xff\xd8\xff\xe0FAKEA\xff\xd9'],
      [2, 720, 1650, '\xff\xd8\xff\xe0FAKEB\xff\xd9'],
    ]
  );
  assert.ok(!esPdf(Uint8Array.from('ID Interno,Monto', (c) => c.charCodeAt(0))));
});
