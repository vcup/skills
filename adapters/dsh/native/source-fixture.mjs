/** Acceptance-only FileSystem provider. RPC runs in a separate source container. */
export async function sourceFilesystemClass(require) {
  const { FileSystem, FsError } = await import(require.resolve('@deepseek-ai/dsh-fs'));
  return class SourceWorldFileSystem extends FileSystem {
    #targets = new Map();
    constructor(ctx, config) { super(ctx); this.config = config; }
    async rpc(method, args = {}, signal) {
      const response = await fetch(`${this.config.endpoint}/fs`, { method: 'POST', headers: { authorization: `Bearer ${this.config.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, ...args }), signal });
      const answer = await response.json();
      if (!answer.ok) throw new FsError(answer.code, answer.message ?? 'source permission refused');
      return answer.value;
    }
    #remember(target) { this.#targets.set(target.targetKey, target.displayPath); return Object.freeze(target); }
    processPath(target) { const path = this.#targets.get(target.targetKey); if (!path) throw new FsError('FS_SANDBOX_DENIED', 'foreign source target'); return path; }
    fileUrl(target) { return `file://${this.processPath(target)}`; }
    contains(root, child) { const parent = this.processPath(root), path = this.processPath(child); return path === parent || path.startsWith(`${parent}/`); }
    async resolve(path, options = {}) { const absolute = path.startsWith('/') ? path : `${options.cwd ?? '/source'}/${path}`; return this.#remember(await this.rpc('resolve', { path: absolute }, options.signal)); }
    stat(target, signal) { return this.rpc('stat', { target }, signal); }
    lstat(path, options = {}, signal) { return this.rpc('lstat', { path: path.startsWith('/') ? path : `${options.cwd ?? '/source'}/${path}` }, signal); }
    async listDir(target, signal) { return (await this.rpc('listDir', { target }, signal)).map(entry => ({ ...entry, target: this.#remember(entry.target) })); }
    async readBytes(target, signal, maxBytes) { const value = await this.rpc('readBytes', { target, maxBytes: Math.min(maxBytes, 1048576) }, signal); return new Uint8Array(Buffer.from(value.base64, 'base64')); }
    async readText(target, signal) { return new TextDecoder('utf-8', { fatal: true }).decode(await this.readBytes(target, signal, 1048576)); }
    async streamText(target, signal) { const text = await this.readText(target, signal); return (async function* () { yield text; })(); }
    async readByteRange(target, range, signal) { return (await this.readBytes(target, signal, 1048576)).slice(range.offset, range.offset + range.length); }
    readLink(path, signal) { return this.rpc('readLink', { path }, signal); }
    writeText() { throw new FsError('FS_PERMISSION_DENIED', 'source is read-only'); }
    editText() { throw new FsError('FS_PERMISSION_DENIED', 'source is read-only'); }
    patchText() { throw new FsError('FS_PERMISSION_DENIED', 'source is read-only'); }
    deleteFile() { throw new FsError('FS_PERMISSION_DENIED', 'source is read-only'); }
    moveFile() { throw new FsError('FS_PERMISSION_DENIED', 'source is read-only'); }
    watch() { throw new FsError('FS_SANDBOX_DENIED', 'fixture does not implement watching'); }
  };
}
