export async function waitForDrain({ hasPending, timeoutMs = 2000, pollMs = 25 }) {
  if (typeof hasPending !== 'function') throw new TypeError('hasPending must be a function');
  const deadline = Date.now() + timeoutMs;
  while (hasPending()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 'timeout';
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
  return 'drained';
}

export async function waitForMeetingDrain({
  hasLivePending,
  hasFinalPending,
  waitFor = waitForDrain,
  liveTimeoutMs = 2000,
  finalTimeoutMs = 21000,
}) {
  const live = await waitFor({ hasPending: hasLivePending, timeoutMs: liveTimeoutMs, pollMs: 25 });
  const final = await waitFor({ hasPending: hasFinalPending, timeoutMs: finalTimeoutMs, pollMs: 50 });
  return { live, final };
}
