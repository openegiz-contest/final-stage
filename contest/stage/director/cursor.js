// The resume cursor: how many beats of the show are done. After a Stage reload the director starts from it
// and plays nothing already shown (a beat that was still playing at the reload plays again from its start).
//
//   ?from=<n>        explicit; wins over the stored value (?from=0 plays everything again)
//   localStorage     "stage.cursor.<run key>" -> n, written when a beat ends

export function cursorFromLocation(location = globalThis.location) {
  const v = location ? new URLSearchParams(location.search).get("from") : null;
  return v !== null && /^\d+$/.test(v) ? Number(v) : null;
}

export function localStorageStore(storage = globalThis.localStorage) {
  if (!storage) return null;
  return {
    get: (key) => {
      try {
        const v = storage.getItem(key);
        return v === null ? null : Number(v);
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        storage.setItem(key, String(value));
      } catch {}
    },
  };
}

export function memoryStore(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => void m.set(k, v), map: m };
}
