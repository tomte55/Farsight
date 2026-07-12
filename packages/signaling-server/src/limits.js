// packages/signaling-server/src/limits.js
// R-2: cheap per-IP counters to blunt connection/registration floods. Paired
// with a socket maxPayload and an idle-socket timeout in server.js.
export function createConnectionLimits({ maxPerIp = 20, maxRegPerIp = 3 } = {}) {
  const conns = new Map(); const regs = new Map();
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const dec = (m, k) => { const n = (m.get(k) || 1) - 1; if (n <= 0) m.delete(k); else m.set(k, n); };
  return {
    canConnect: (ip) => (conns.get(ip) || 0) < maxPerIp,
    addConn: (ip) => inc(conns, ip),
    removeConn: (ip) => dec(conns, ip),
    canRegister: (ip) => (regs.get(ip) || 0) < maxRegPerIp,
    addReg: (ip) => inc(regs, ip),
    removeReg: (ip) => dec(regs, ip),
  };
}
