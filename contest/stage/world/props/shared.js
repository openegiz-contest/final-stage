// What the world's modules share within a frame. stage.js calls the pit's update(t) first in every
// frame; the pit sets clock.t and runs the hooks, so props without an update call of their own
// (the dispatch board's truck markers) move on the same show clock.
export const clock = { t: 0, hooks: [] };
/** Run fn(t) every frame, before the scene's matrices are updated. */
export const onFrame = (fn) => clock.hooks.push(fn);
