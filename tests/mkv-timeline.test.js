'use strict';
const assert = require('node:assert/strict');
const { MkvTrackTimeline } = require('../mkv-engine.js');

const video = { type: 1, defaultDurationNs: 40000000 };
function run(blocks) {
  const timeline = new MkvTrackTimeline(video, 1000);
  const samples = [];
  let pending = [];
  const flush = () => { timeline.settle(pending); samples.push(...pending); pending = []; };
  blocks.forEach(([ptsMs, keyframe]) => {
    const raw = { ptsMs, keyframe: !!keyframe, data: new Uint8Array([ptsMs & 255]), laceCount: 1, laceIndex: 0 };
    if (raw.keyframe && pending.length) flush();
    if (timeline.isSecondField(raw) && pending.length) {
      const first = pending[pending.length - 1];
      first.data = Uint8Array.from([...first.data, ...raw.data]);
      return;
    }
    pending.push(timeline.convert(raw));
  });
  flush();
  return samples;
}

const broadcast = run([
  [1984, 1], [1824], [1744], [1704], [1784], [1904], [1864], [1944],
  [2304, 1], [2324], [2144], [2164], [2064], [2084], [2024], [2044], [2104], [2124], [2224], [2244], [2184], [2204], [2264], [2284],
  [2624, 1], [2464], [2384], [2344], [2424],
]);
assert.equal(broadcast.length, 21, 'each field pair is one sample');
assert.deepEqual(Array.from(broadcast[8].data), [2304 & 255, 2324 & 255]);
broadcast.forEach((s) => assert.ok(s.pts >= s.dts, `pts ${s.pts} before dts ${s.dts}`));
for (let i = 1; i < broadcast.length; i++) assert.ok(broadcast[i].dts > broadcast[i - 1].dts);
assert.equal(broadcast[1].dts - broadcast[0].dts, 40, 'a merged pair advances the decode clock by one frame');

const progressive = run([[0, 1], [120], [40], [80], [240], [160], [200], [280, 1], [400], [320], [360]]);
assert.equal(progressive.length, 11);
assert.equal(progressive[0].dts, 0);
assert.deepEqual(progressive.map((s) => s.dts), [0, 40, 80, 120, 160, 200, 240, 280, 320, 360, 400]);

console.log('mkv-timeline: ok');
