import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAudioCaptureMode,
  getAudioConstraints,
  formatTrackSettings,
  getAudioModeLabel
} from '../public/lib/audio-capture-mode.js';

test('normalizeAudioCaptureMode defaults to table mode', () => {
  assert.equal(normalizeAudioCaptureMode(undefined), 'table');
  assert.equal(normalizeAudioCaptureMode(null), 'table');
  assert.equal(normalizeAudioCaptureMode('unknown'), 'table');
  assert.equal(normalizeAudioCaptureMode('table'), 'table');
  assert.equal(normalizeAudioCaptureMode('remote'), 'remote');
});

test('getAudioConstraints returns correct constraints for table and remote modes', () => {
  const tableConstraints = getAudioConstraints('table');
  assert.deepEqual(tableConstraints, {
    channelCount: 1,
    sampleRate: 16000,
    echoCancellation: false,
    autoGainControl: true,
    noiseSuppression: true
  });

  const remoteConstraints = getAudioConstraints('remote');
  assert.deepEqual(remoteConstraints, {
    channelCount: 1,
    sampleRate: 16000,
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression: true
  });
});

test('getAudioModeLabel returns human-readable labels', () => {
  assert.equal(getAudioModeLabel('table'), '线下圆桌会议');
  assert.equal(getAudioModeLabel('remote'), '远程/免提混合');
});

test('formatTrackSettings handles actual track settings gracefully', () => {
  const empty = formatTrackSettings(null);
  assert.equal(empty, '未知采音状态');

  const formattedTable = formatTrackSettings({
    echoCancellation: false,
    autoGainControl: true,
    noiseSuppression: true,
    sampleRate: 16000
  }, 'table');
  assert.equal(formattedTable, '线下圆桌 (AEC: 关 | AGC: 开 | 降噪: 开 | 16kHz)');

  const formattedRemote = formatTrackSettings({
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression: true,
    sampleRate: 48000
  }, 'remote');
  assert.equal(formattedRemote, '远程混合 (AEC: 开 | AGC: 开 | 降噪: 开 | 48kHz)');
});
