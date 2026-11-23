#!/usr/bin/env node
/** Test-only read-only source world. Run in a separate container with no project mounts.
 * It never serves user files. RPC targets are opaque and all bytes come from a
 * fresh fixture root. Control endpoints only change this fixture's read ACL.
 */
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readlink, lstat, readdir, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

const token = process.env.ENSEMBLE_SOURCE_TEST_TOKEN;
if (!token || token.length < 24) throw new Error('a test-only token of at least 24 characters is required');
const port = Number(process.env.ENSEMBLE_SOURCE_TEST_PORT ?? '18743');
const root = await mkdtemp(join(tmpdir(), 'ensemble-source-world-'));
const world = randomUUID();
await writeFile(join(root, 'note.md'), '# Container-only evidence\nOriginal source bytes stay here.\n');
await writeFile(join(root, 'binary.dat'), Buffer.from([0, 255, 254, 128, 13, 10, 65, 0]));
await mkdir(join(root, 'directory'));
await writeFile(join(root, 'directory', 'unknown.custom'), 'unknown format, retained verbatim\n');
await symlink('/etc/passwd', join(root, 'untrusted-link'));
const targets = new Map();
const keys = new Map();
let readable = true;
let reads = 0;
const failure = (code, message) => Object.assign(new Error(message), { code });
function pathOf(raw) {
  if (typeof raw !== 'string' || raw.includes('\0') || raw.includes('\\') || raw.split('/').includes('..')) throw failure('FS_SANDBOX_DENIED', 'invalid source path');
  const path = posix.normalize(raw.startsWith('/') ? raw : `/source/${raw}`);
  if (path !== '/source' && !path.startsWith('/source/')) throw failure('FS_SANDBOX_DENIED', 'outside source world');
  return path;
}
function target(path) {
  if (!keys.has(path)) { const key = randomUUID(); keys.set(path, key); targets.set(key, path); }
  return { targetKey: keys.get(path), displayPath: path };
}
function targetPath(value) {
  const path = targets.get(value?.targetKey);
  if (!path) throw failure('FS_SANDBOX_DENIED', 'unknown or foreign target');
  return path;
}
async function disk(path, allowFinalLink = false) {
  let current = root;
  const parts = path.slice('/source'.length).split('/').filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() && !(allowFinalLink && index === parts.length - 1)) throw failure('FS_SANDBOX_DENIED', 'source symlink traversal denied');
  }
  return current;
}
function metadata(info) {
  return { version: `${info.ino}:${info.mtimeMs}:${info.size}`, type: info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.size };
}
async function rpc(body) {
  if (!readable) throw failure('FS_PERMISSION_DENIED', 'source read permission revoked');
  switch (body.method) {
    case 'resolve': { const path = pathOf(body.path); await disk(path); return target(path); }
    case 'processPath': return targetPath(body.target);
    case 'contains': { const parent = targetPath(body.root); const child = targetPath(body.target); return parent === child || child.startsWith(`${parent}/`); }
    case 'lstat': { const path = pathOf(body.path); return metadata(await lstat(await disk(path, true))); }
    case 'readLink': return readlink(await disk(pathOf(body.path), true));
    case 'stat': return metadata(await lstat(await disk(targetPath(body.target))));
    case 'listDir': {
      const path = targetPath(body.target); const directory = await disk(path);
      return Promise.all((await readdir(directory)).sort().map(async name => {
        const info = metadata(await lstat(join(directory, name)));
        return { name, ...info, type: info.type === 'symlink' ? 'other' : info.type, target: target(`${path}/${name}`) };
      }));
    }
    case 'readBytes': {
      const path = await disk(targetPath(body.target)); const info = await lstat(path);
      if (!info.isFile()) throw failure('FS_NOT_REGULAR_FILE', 'not a regular source file');
      const max = body.maxBytes ?? 1048576;
      if (!Number.isSafeInteger(max) || max < 0 || max > 1048576 || info.size > max) throw failure('FS_TOO_LARGE', 'source byte budget exceeded');
      const bytes = await readFile(path);
      if (bytes.byteLength > max) throw failure('FS_TOO_LARGE', 'source changed beyond byte budget');
      reads++; return { base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    default: throw failure('FS_SANDBOX_DENIED', 'only read operations are available');
  }
}
const server = createServer(async (request, response) => {
  const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
  if (request.headers.authorization !== `Bearer ${token}`) { request.resume(); send(403, { ok: false, code: 'FS_PERMISSION_DENIED' }); return; }
  try {
    if (request.method === 'GET' && request.url === '/health') { send(200, { ok: true, world, readable, reads }); return; }
    // The identity of this world, for a caller that must verify the bytes it reads
    // really live somewhere else. `root` is the real directory this process serves
    // from; it is generated here by `mkdtemp`, never taken from the environment, so
    // a caller cannot talk this endpoint into naming a path of its choosing.
    //
    // A caller proves "not on my filesystem" by stating this exact `root` locally
    // and getting ENOENT. That is a measurement it performs itself; this endpoint
    // only supplies the value. It deliberately does not claim to be in another
    // container: a process on the caller's own filesystem answers identically, and
    // the caller is what distinguishes the two.
    if (request.method === 'GET' && request.url === '/fixture/identity') {
      send(200, { ok: true, fixture: 'source-world', world, root, port, pid: process.pid });
      return;
    }
    if (request.method !== 'POST') throw failure('FS_SANDBOX_DENIED', 'POST required');
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 16384) throw failure('FS_TOO_LARGE', 'request budget exceeded'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (request.url === '/fixture/access' && typeof body.readable === 'boolean') { readable = body.readable; send(200, { ok: true, readable }); return; }
    if (request.url !== '/fs') throw failure('FS_SANDBOX_DENIED', 'unknown fixture route');
    send(200, { ok: true, value: await rpc(body) });
  } catch (error) {
    send(400, { ok: false, code: error.code === 'ENOENT' ? 'FS_NOT_FOUND' : error.code ?? 'FS_IO_ERROR', message: error.message });
  }
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ fixture: 'source-world', world, port, root, pid: process.pid })));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
