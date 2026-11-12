import { monitorLiveSession } from "./live-monitor.js";
import { createStridewellStore } from "./stridewell-agent.js";

// Owns the sideband monitor and the demo store of each live session. Every session gets its
// own store, so one caller's holds and stock changes are never visible to another caller.
export function createSessionMonitors({
  apiKey,
  initialSpokenGreeting,
  logMessages = false,
  monitor = monitorLiveSession,
  createStore = createStridewellStore,
} = {}) {
  const active = new Map();

  return {
    monitorCall(sessionId) {
      if (active.has(sessionId)) return active.get(sessionId);
      const store = createStore();
      const sessionMonitor = monitor(sessionId, {
        apiKey,
        initialSpokenGreeting,
        toolExecutor: (name, args) => store.execute(name, args),
        logMessages,
        onClose: (closedMonitor) => {
          if (active.get(sessionId) === closedMonitor) active.delete(sessionId);
        },
      });
      active.set(sessionId, sessionMonitor);
      return sessionMonitor;
    },
    closeAll(closeOptions) {
      for (const sessionMonitor of [...active.values()]) sessionMonitor.close(closeOptions);
      active.clear();
    },
  };
}
