export const MAX_SEGMENT_MS = 15_000;
export const VAD_WARMUP_MS = 400;
export const PRE_ROLL_MS = 500;

export function pcmDurationMs({ bytes, sampleRate, bytesPerSample, channels = 1 }) {
  const bytesPerSecond = Number(sampleRate) * Number(bytesPerSample) * Number(channels);
  return bytesPerSecond > 0 ? Number(bytes) / bytesPerSecond * 1000 : 0;
}

export function pcmBytesForMs({ milliseconds, sampleRate, bytesPerSample, channels = 1 }) {
  return Math.round(Number(sampleRate) * Number(bytesPerSample) * Number(channels) * Number(milliseconds) / 1000);
}

export function maxSegmentBytes({ sampleRate, bytesPerSample, channels = 1 }) {
  return pcmBytesForMs({ milliseconds: MAX_SEGMENT_MS, sampleRate, bytesPerSample, channels });
}
