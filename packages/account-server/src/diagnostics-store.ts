// Persists uploaded diagnostic bundles to disk as gzipped JSON and prunes them
// after a TTL. All primitives injected (fs/gzip/clock/id) so it is unit-testable
// without disk. File name embeds the upload timestamp for TTL-based pruning.
export interface DiagFs {
  existsSync(p: string): boolean;
  mkdirSync(p: string, o?: { recursive: boolean }): void;
  writeFileSync(p: string, data: Buffer): void;
  readdirSync(p: string): string[];
  statSync(p: string): { isFile(): boolean };
  rmSync(p: string): void;
}
export interface DiagStoreOpts {
  dir: string;
  fs: DiagFs;
  gzipSync: (b: Buffer) => Buffer;
  now: () => number;
  ttlMs: number;
  randomId: () => string;
  // Optional structured logger (main.ts injects the server's JSON logger) so an
  // upload/prune is greppable in `docker logs`. Defaults to a no-op for tests.
  log?: (event: string, fields: Record<string, unknown>) => void;
}
export function createDiagnosticsStore(o: DiagStoreOpts) {
  const ensure = () => { if (!o.fs.existsSync(o.dir)) o.fs.mkdirSync(o.dir, { recursive: true }); };
  const join = (name: string) => `${o.dir}/${name}`;
  const log = o.log ?? (() => {});
  return {
    save({ userId, meta, files }: { userId: string; meta: unknown; files: Record<string, string> }): { id: string } {
      ensure();
      const id = o.randomId();
      const safeUser = String(userId).replace(/[^a-zA-Z0-9_-]/g, '');
      const name = `${safeUser}-${o.now()}-${id}.json.gz`;
      const gz = o.gzipSync(Buffer.from(JSON.stringify({ meta, files }), 'utf8'));
      o.fs.writeFileSync(join(name), gz);
      // Non-sensitive: reference id, owner id, file count, gzipped byte size —
      // never the log contents. Lets support correlate a user's DIAG code.
      log('diagnostics_saved', { id, userId: safeUser, files: Object.keys(files).length, bytes: gz.length });
      return { id };
    },
    prune(): { removed: number } {
      if (!o.fs.existsSync(o.dir)) return { removed: 0 };
      const cutoff = o.now() - o.ttlMs;
      let removed = 0;
      for (const name of o.fs.readdirSync(o.dir)) {
        const m = /^.+-(\d+)-[^.]+\.json\.gz$/.exec(name);
        if (!m) continue;
        if (Number(m[1]) < cutoff) { o.fs.rmSync(join(name)); removed += 1; }
      }
      log('diagnostics_pruned', { removed });
      return { removed };
    },
  };
}
