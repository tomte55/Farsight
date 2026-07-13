// packages/shared/src/log-file-sink.js
// A log sink that appends lines to a file and rotates it by size. fs is injected
// (existsSync, mkdirSync, statSync, appendFileSync, renameSync, rmSync) so
// rotation is unit-testable without touching disk. Windows-safe: renameSync
// throws if the destination exists, so the previous generation is removed first.
export function createFileSink({ filePath, fs, dirname, maxBytes = 2 * 1024 * 1024, maxFiles = 2 }) {
  let ensured = false;
  const ensureDir = () => {
    if (ensured) return;
    const dir = dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    ensured = true;
  };
  const rotate = () => {
    for (let i = maxFiles - 1; i >= 1; i--) {
      const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
      const dst = `${filePath}.${i}`;
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dst)) fs.rmSync(dst);   // Windows: rename won't overwrite
      fs.renameSync(src, dst);
    }
  };
  return (line) => {
    try {
      ensureDir();
      if (fs.existsSync(filePath) && fs.statSync(filePath).size >= maxBytes) rotate();
      fs.appendFileSync(filePath, line + '\n');
    } catch {
      // Logging must never crash the app; drop the line on fs failure.
    }
  };
}
