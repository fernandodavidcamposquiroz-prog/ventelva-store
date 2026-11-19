import { lstatSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('./', import.meta.url);
const dist = fileURLToPath(new URL('dist', root));
const previous = lstatSync(dist, { throwIfNoEntry: false });
if (previous && !previous.isDirectory()) {
  throw new Error('dist debe ser un directorio local.');
}
await rm(dist, { recursive: true, force: true });
await mkdir(dist);
for (const entry of ['index.html', 'css', 'js', 'assets', '_routes.json']) {
  await cp(fileURLToPath(new URL(entry, root)), fileURLToPath(new URL('dist/' + entry, root)), { recursive: true });
}
