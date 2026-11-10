// The sync runner's round bookkeeping (src/index.js, SyncRunner). Pure, so it's tested
// without the Workers runtime.
/**
 * A round that started but never finished (killed at the alarm limit) is counted in
 * state.interrupted_rounds (shown in /status) when the safety alarm starts the next one.
 * Pure; tested.
 */
export function noteInterrupted(state) {
  if (state.round_open) {
    state.interrupted_rounds = [...(state.interrupted_rounds || []), { phase: state.phase, started_at: state.round_started_at }].slice(-10);
  }
  state.round_open = true;
  return state;
}
