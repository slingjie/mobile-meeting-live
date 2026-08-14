import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmEnergyFramer } from '../public/lib/pcm-energy-framer.js';

function pcmFrame(value, samples = 800) {
  const data = new Int16Array(samples);
  data.fill(value);
  return new Uint8Array(data.buffer);
}

test('aggregates irregular Safari callbacks into exact 50ms energy frames', () => {
  const framer = new PcmEnergyFramer({ frameBytes: 1600, frameMs: 50 });
  const combined = new Uint8Array(3200);
  combined.set(pcmFrame(500), 0);
  combined.set(pcmFrame(-1000), 1600);
  const outputs = [
    ...framer.push(combined.subarray(0, 333)),
    ...framer.push(combined.subarray(333, 1110)),
    ...framer.push(combined.subarray(1110)),
  ];
  assert.deepEqual(outputs, [
    { energy: 500, frameMs: 50 },
    { energy: 1000, frameMs: 50 },
  ]);
  assert.equal(framer.bufferedBytes, 0);
});

test('reset drops only the unfinished analysis frame', () => {
  const framer = new PcmEnergyFramer({ frameBytes: 1600, frameMs: 50 });
  framer.push(pcmFrame(600).subarray(0, 400));
  framer.reset();
  assert.equal(framer.bufferedBytes, 0);
  assert.equal(framer.push(pcmFrame(700)).length, 1);
});
