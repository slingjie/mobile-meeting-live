export function formatSpeakerLabel(entry = {}) {
  if (!entry.speaker) return '';
  const match = /^S([1-6])$/.exec(String(entry.speaker));
  if (match) return `本段发言人${match[1]}${entry.speakerEstimated ? '（模型估计）' : ''}`;
  return '发言人未知';
}
