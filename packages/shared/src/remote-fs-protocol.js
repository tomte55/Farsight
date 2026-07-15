// Pure validation for the SP3 remote-FS RPC (spec §8), own-fleet only. Bytes go
// through the transfer engine; this covers metadata + mutation ops. NO fs here.

export const FS_OPS = ['list', 'stat', 'mkdir', 'rename', 'move', 'delete'];
export const FS_ENTRY_TYPES = ['file', 'dir', 'symlink'];

function isStr(x) { return typeof x === 'string' && x.length > 0; }
function nn(x) { return Number.isInteger(x) && x >= 0; }

export function isFsOp(op) { return FS_OPS.includes(op); }

export function validateFsReq(req) {
  if (!req || typeof req !== 'object') return false;
  if (!nn(req.reqId) || !isFsOp(req.op)) return false;
  const a = req.args;
  if (!a || typeof a !== 'object') return false;
  switch (req.op) {
    case 'list':
      return isStr(a.path) && (a.cursor == null || typeof a.cursor === 'string')
        && Number.isInteger(a.limit) && a.limit > 0;
    case 'stat': return isStr(a.path);
    case 'mkdir': return isStr(a.path);
    case 'rename': return isStr(a.path) && isStr(a.newName) && !/[\\/]/.test(a.newName);
    case 'move': return isStr(a.from) && isStr(a.to);
    case 'delete': return isStr(a.path) && typeof a.recursive === 'boolean';
    default: return false;
  }
}

export function validateFsRes(res) {
  if (!res || typeof res !== 'object') return false;
  if (!nn(res.reqId) || typeof res.ok !== 'boolean') return false;
  if (!res.ok) return !!res.error && isStr(res.error.code);
  return true;
}

export function validateDirEntry(e) {
  if (!e || typeof e !== 'object') return false;
  if (!isStr(e.name)) return false;
  if (!FS_ENTRY_TYPES.includes(e.type)) return false;
  if (!nn(e.size)) return false;
  if (typeof e.mtime !== 'number' || !Number.isFinite(e.mtime)) return false;
  return true;
}
