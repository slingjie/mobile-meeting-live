export function applyFinalResult(store, segmentId, result) {
  if (Array.isArray(result?.utterances) && result.utterances.length) {
    return store.applyFinalUtterances(segmentId, result);
  }
  return store.applyFinal(segmentId, result || {});
}
