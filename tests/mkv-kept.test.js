'use strict';
const assert = require('node:assert/strict');
globalThis.MediaSource = globalThis.MediaSource || function () {};
const { MkvEngine } = require('../mkv-engine.js');

function engine() {
  const failures = [];
  return {
    failures,
    trackCodec_: () => 'avc1.640028',
    fatal_: (reason, detail) => failures.push({ reason, detail }),
  };
}
function lane(type, ranges) {
  return { track: { type }, sb: { buffered: { length: ranges } } };
}
function appended(e, l) {
  l.appendingMedia = true;
  MkvEngine.prototype.checkKept_.call(e, l);
}

const kept = engine();
const empty = lane(1, 0);
for (let i = 0; i < 3; i++) appended(kept, empty);
assert.equal(kept.failures.length, 0, 'three empty appends are not yet a verdict');
appended(kept, empty);
assert.equal(kept.failures.length, 1);
assert.deepEqual(kept.failures[0].detail, { track: 'video' });

const playing = engine();
const video = lane(1, 0);
appended(playing, video);
appended(playing, video);
video.sb.buffered.length = 1;
for (let i = 0; i < 6; i++) appended(playing, video);
assert.equal(playing.failures.length, 0, 'a lane that keeps frames is never failed');

const audio = engine();
const sound = lane(2, 0);
for (let i = 0; i < 6; i++) appended(audio, sound);
assert.equal(audio.failures.length, 0, 'only the picture lane is judged');

const init = engine();
const first = lane(1, 0);
for (let i = 0; i < 6; i++) MkvEngine.prototype.checkKept_.call(init, first);
assert.equal(init.failures.length, 0, 'removes and the init segment are not counted');

console.log('mkv-kept: ok');
