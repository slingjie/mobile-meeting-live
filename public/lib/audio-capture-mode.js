export function normalizeAudioCaptureMode(value) {
  return value === 'remote' ? 'remote' : 'table';
}

export function getAudioModeLabel(mode) {
  const normalized = normalizeAudioCaptureMode(mode);
  return normalized === 'remote' ? '远程/免提混合' : '线下圆桌会议';
}

export function getAudioConstraints(mode) {
  const normalized = normalizeAudioCaptureMode(mode);
  return {
    channelCount: 1,
    sampleRate: 16000,
    echoCancellation: normalized === 'remote',
    autoGainControl: true,
    noiseSuppression: true
  };
}

export function formatTrackSettings(settings, mode) {
  if (!settings || typeof settings !== 'object') {
    return '未知采音状态';
  }

  const normalizedMode = normalizeAudioCaptureMode(mode);
  const modePrefix = normalizedMode === 'remote' ? '远程混合' : '线下圆桌';

  const aec = settings.echoCancellation === true ? 'AEC: 开' : (settings.echoCancellation === false ? 'AEC: 关' : 'AEC: -');
  const agc = settings.autoGainControl === true ? 'AGC: 开' : (settings.autoGainControl === false ? 'AGC: 关' : 'AGC: -');
  const ns = settings.noiseSuppression === true ? '降噪: 开' : (settings.noiseSuppression === false ? '降噪: 关' : '降噪: -');

  const rate = typeof settings.sampleRate === 'number' && Number.isFinite(settings.sampleRate)
    ? `${Math.round(settings.sampleRate / 1000)}kHz`
    : '16kHz';

  return `${modePrefix} (${aec} | ${agc} | ${ns} | ${rate})`;
}
