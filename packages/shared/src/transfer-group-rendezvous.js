// packages/shared/src/transfer-group-rendezvous.js
//
// Pure coordinator that groups N incoming TRANSFER_REQUESTs (one per flow,
// sharing a groupId + flowIndex/flowCount) into a single "group ready" event,
// so the receiver prompts consent ONCE instead of once per flow.
//
// Runtime-agnostic: no electron/DOM/fs/WebRTC. Timers and flow-opening are
// injected so this can be unit-tested with a fake clock and fake flows.

/**
 * @param {object} deps
 * @param {(req: {sessionId: string, flowIndex: number, groupId?: string, linked?: boolean}) => any} deps.openFlow
 *   Opens one attaching worker for a flow and returns its handle. The handle
 *   is expected to (optionally) expose a `close()` method, called on cancel.
 * @param {(group: {groupId: string, flowCount: number, flows: any[]}) => void} deps.onGroupReady
 *   Fired exactly once per group. Flow 0 (the anchor, carrying the manifest
 *   OFFER) is mandatory to fire: once it has arrived, the group fires as soon
 *   as either all `flowCount` flows have arrived or the join window elapses
 *   (partial group OK, anchor present). If the join window elapses with flow
 *   0 still missing, firing is NOT aborted — a bounded `anchorWaitMs` grace is
 *   started instead: flow 0 arriving during the grace fires immediately, and
 *   the grace elapsing with flow 0 still missing fires an anchorless group
 *   (`flows` has no flowIndex-0 entry) for the caller to abort.
 * @param {number} [deps.joinWindowMs]
 * @param {number} [deps.anchorWaitMs]
 *   Bounded grace, started when the join window elapses with flow 0 still
 *   missing, to give the sender's supervisor time to (re-)dial the anchor
 *   flow before giving up. Default 20000ms.
 * @param {typeof setTimeout} [deps.setTimer]
 * @param {typeof clearTimeout} [deps.clearTimer]
 * @param {(handle: any, flowIndex: number) => void} [deps.onFlowJoin]
 *   Optional. Once a group has already fired, a later offer for the same
 *   groupId (a replacement flow re-dialed mid-transfer, or a brand-new
 *   flowIndex added late) opens a flow and delivers it here instead of being
 *   dropped. Does NOT touch group.flows/consent/onGroupReady. If omitted,
 *   post-ready offers are dropped (today's behavior).
 */
export function createGroupRendezvous({
  openFlow,
  onGroupReady,
  joinWindowMs = 8000,
  anchorWaitMs = 20000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onFlowJoin,
}) {
  /** @type {Map<string, {flowCount: number, flows: Map<number, any>, timer: any, fired: boolean, awaitingAnchor: boolean}>} */
  const groups = new Map();

  function fireReady(groupId, group) {
    if (group.fired) return;
    group.fired = true;
    if (group.timer != null) {
      clearTimer(group.timer);
      group.timer = null;
    }
    onGroupReady({
      groupId,
      flowCount: group.flowCount,
      flows: [...group.flows.values()],
    });
  }

  function offer(req) {
    const { sessionId, groupId, flowIndex, flowCount, linked } = req;

    // Legacy request: no groupId/flowCount -> immediate single-flow group.
    if (!groupId || !flowCount) {
      const handle = openFlow({ sessionId, flowIndex: flowIndex ?? 0, groupId, linked });
      onGroupReady({ groupId: groupId ?? sessionId, flowCount: 1, flows: [handle] });
      return;
    }

    let group = groups.get(groupId);
    if (!group) {
      group = { flowCount, flows: new Map(), timer: null, fired: false, awaitingAnchor: false };
      groups.set(groupId, group);
      group.timer = setTimer(() => {
        group.timer = null;
        if (group.flows.has(0)) { fireReady(groupId, group); return; } // anchor present → fire (partial OK)
        // No anchor yet: do NOT abort. Extend a bounded grace for flow 0 to (re-)dial —
        // the sender's supervisor re-dials terminal slots (Phase 3a). If it never comes,
        // fire an anchorless group; assembleReceiveGroup returns null → main aborts CLEAN + LOUD.
        group.awaitingAnchor = true;
        group.timer = setTimer(() => {
          group.timer = null;
          fireReady(groupId, group);
        }, anchorWaitMs);
      }, joinWindowMs);
    }

    if (group.fired) {
      // Group already resolved: a rolling-join offer (new flowIndex) or a
      // replacement offer (slot re-dial of an existing flowIndex). Either
      // way, open the flow and hand it off via onFlowJoin — never touch
      // group.flows/consent/onGroupReady for a fired group.
      if (onFlowJoin) {
        const handle = openFlow({ sessionId, flowIndex, groupId, linked });
        onFlowJoin(handle, flowIndex);
      }
      return;
    }
    if (group.flows.has(flowIndex)) return; // duplicate (groupId, flowIndex) — ignore

    const handle = openFlow({ sessionId, flowIndex, groupId, linked });
    group.flows.set(flowIndex, handle);

    const hasAnchor = group.flows.has(0);
    if (hasAnchor && (group.awaitingAnchor || group.flows.size >= group.flowCount)) {
      fireReady(groupId, group);
    }
  }

  function cancel(groupId) {
    const group = groups.get(groupId);
    if (!group) return;
    if (group.timer != null) {
      clearTimer(group.timer);
      group.timer = null;
    }
    // Once a group has fired, its flow handles have been handed off to the
    // receiver and may be mid-transfer — closing them would sever active
    // data channels. Only close flows for a group canceled BEFORE ready.
    if (!group.fired) {
      for (const handle of group.flows.values()) {
        if (handle && typeof handle.close === 'function') {
          handle.close();
        }
      }
    }
    groups.delete(groupId);
  }

  return { offer, cancel };
}
