// packages/signaling-server/src/registry.js
export function createRegistry() {
  const map = new Map();
  return {
    add: (id, socket) => map.set(id, socket),
    remove: (id) => map.delete(id),
    get: (id) => map.get(id),
    has: (id) => map.has(id),
  };
}
