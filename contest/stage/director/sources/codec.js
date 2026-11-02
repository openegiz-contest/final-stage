// Replay snapshots as deltas. Recording every state.json in full would repeat the whole transcript hundreds
// of times (a real Final: tens of MB), so a record may be a delta against the previous state instead:
//
//   {"t":2.5,"delta":{"set":{"current":{…},"judges.2":{…}},"append":{"transcript":[…],"votes":[…]},"unset":["x"]}}
//
//   set      top-level key -> new value; "judges.<i>" replaces one element of the judges array
//   append   items added to the end of transcript / votes / placements (the engine only appends)
//   unset    top-level keys that disappeared
//
// A record with "state" is a full snapshot and starts over. tools/record.py writes the same format.

export const APPEND_KEYS = ["transcript", "votes", "placements"];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function encodeDelta(prev, next) {
  const set = {}, append = {}, unset = [];
  for (const key of new Set([...Object.keys(prev ?? {}), ...Object.keys(next)])) {
    const a = prev?.[key], b = next[key];
    if (!(key in next)) unset.push(key);
    else if (same(a, b)) continue;
    else if (APPEND_KEYS.includes(key) && Array.isArray(a) && Array.isArray(b) && b.length > a.length && same(a, b.slice(0, a.length))) append[key] = b.slice(a.length);
    else if (key === "judges" && Array.isArray(a) && Array.isArray(b) && a.length === b.length) b.forEach((j, i) => { if (!same(a[i], j)) set[`judges.${i}`] = j; });
    else set[key] = b;
  }
  const delta = {};
  if (Object.keys(set).length) delta.set = set;
  if (Object.keys(append).length) delta.append = append;
  if (unset.length) delta.unset = unset;
  return Object.keys(delta).length ? delta : null;
}

export function applyDelta(prev, delta) {
  const next = { ...prev };
  const copied = new Set();
  const own = (k) => {
    if (!copied.has(k)) { next[k] = [...(next[k] ?? [])]; copied.add(k); }
    return next[k];
  };
  for (const [path, value] of Object.entries(delta.set ?? {})) {
    const [k, i] = path.split(".");
    if (i === undefined) next[k] = value;
    else own(k)[Number(i)] = value;
  }
  for (const [k, items] of Object.entries(delta.append ?? {})) own(k).push(...items);
  for (const k of delta.unset ?? []) delete next[k];
  return next;
}
