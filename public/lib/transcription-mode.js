export function normalizeTranscriptMode(value) {
  return value === 'live' ? 'live' : 'accurate';
}

export function shouldRequestFinal(value) {
  return normalizeTranscriptMode(value) === 'accurate';
}
