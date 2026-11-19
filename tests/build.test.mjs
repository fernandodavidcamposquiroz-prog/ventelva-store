import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('El build reemplaza la salida y conserva solo los archivos públicos actuales', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'ventelva-build-'));
  try {
    await copyFile(new URL('../build.mjs', import.meta.url), join(fixture, 'build.mjs'));
    for (const directory of ['css', 'js', 'assets']) await mkdir(join(fixture, directory));
    await writeFile(join(fixture, 'index.html'), '<title>Ventelva</title>');
    await writeFile(join(fixture, '_routes.json'), '{}');
    await writeFile(join(fixture, 'js', 'retirado.js'), '');
    const build = () => execFileSync(process.execPath, [join(fixture, 'build.mjs')]);
    build();
    assert.deepEqual(await readdir(join(fixture, 'dist', 'js')), ['retirado.js']);
    await rm(join(fixture, 'js', 'retirado.js'));
    await writeFile(join(fixture, 'js', 'actual.js'), '/* actual */');
    await writeFile(join(fixture, 'dist', 'residual.txt'), '');
    build();
    assert.deepEqual((await readdir(join(fixture, 'dist'))).sort(), ['_routes.json', 'assets', 'css', 'index.html', 'js']);
    assert.deepEqual(await readdir(join(fixture, 'dist', 'js')), ['actual.js']);
    assert.equal(await readFile(join(fixture, 'dist', 'js', 'actual.js'), 'utf8'), '/* actual */');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
