// packages/shared/src/diagnostics-bundle.js
// Builds a redaction-safe { meta, files } bundle from the app's logs directory.
// Only *.log / *.log.N files are included (never config.json, tokens, keys).
// fs is injected so it is unit-testable. Caller supplies an already-safe `meta`.
const LOG_RE = /\.log(\.\d+)?$/i;
export function buildDiagnosticsBundle({ logsDir, fs, meta = {}, maxBytes = 4 * 1024 * 1024 }) {
  const files = {};
  if (fs.existsSync(logsDir)) {
    const names = fs.readdirSync(logsDir)
      .filter((n) => LOG_RE.test(n))
      .map((n) => {
        let stat;
        try { stat = fs.statSync(`${logsDir}/${n}`); } catch { stat = { mtimeMs: 0, size: 0 }; }
        return { n, m: stat.mtimeMs || 0, size: stat.size || 0 };
      })
      .sort((a, b) => b.m - a.m); // newest first
    let total = 0;
    for (const { n, size } of names) {
      if (total + size > maxBytes) break;
      let content = '';
      try { content = String(fs.readFileSync(`${logsDir}/${n}`)); } catch { continue; }
      total += size;
      files[n] = content;
    }
  }
  return { meta, files };
}
