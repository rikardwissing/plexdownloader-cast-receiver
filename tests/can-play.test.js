'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

global.MediaSource = function () {};
global.MediaSource.isTypeSupported = () => true;
const { Fmp4Muxer, MkvEngine } = require('../mkv-engine.js');

const receiver = read('receiver.js');
const start = receiver.indexOf('function canPlayType(config)');
const end = receiver.indexOf('// Receiver-side logging');
assert.ok(start > 0 && end > start);
function ask(msg, platform) {
  let sent;
  const logs = [];
  vm.runInNewContext(receiver.slice(start, end) + '\nanswerCanPlay(msg, "sender-1");', {
    msg, NS: 'urn:x-cast:dev.rikard.portage', Fmp4Muxer,
    mseSupport: (type) => platform.mse(type),
    slog: (line) => logs.push(line),
    document: { createElement: () => ({ canPlayType: (type) => platform.canPlayType(type) }) },
    cast: { framework: { system: { DeviceCapabilities: { IS_HDR_SUPPORTED: 'is_hdr_supported', IS_DV_SUPPORTED: 'is_dv_supported' } } } },
    context: {
      canDisplayType: (...args) => platform.display(...args),
      getDeviceCapabilities: () => ({ is_hdr_supported: false, is_dv_supported: false }),
      sendCustomMessage: (ns, sender, message) => { sent = JSON.parse(JSON.stringify(message)); },
    },
  });
  return { sent, logs };
}

const livingRoom = {
  mse: (type) => !/x-matroska|avc1\.64003[23]|ec-3/.test(type),
  display: (mime, codecs) => mime !== 'video/x-matroska' && !/avc1\.64003[23]/.test(codecs || ''),
  canPlayType: (type) => (/x-matroska/.test(type) ? 'maybe' : 'probably'),
};
let result = ask({
  type: 'canPlay', id: 'q1',
  configs: [
    { kind: 'video', mime: 'video/mp4', codecs: 'avc1.640028', width: 1920, height: 1080, framerate: 24 },
    { kind: 'audio', mime: 'audio/mp4', codecs: 'ec-3' },
  ],
  containers: [
    { mime: 'video/x-matroska', codecs: 'avc1.640028,ec-3' },
    { mime: 'video/x-matroska', codecs: 'avc1.640028,opus' },
    { mime: 'video/mp2t', codecs: 'avc1.640028,mp4a.40.2' },
  ],
}, livingRoom);
assert.equal(result.sent.type, 'canPlayAnswer');
assert.equal(result.sent.id, 'q1');
assert.deepEqual(result.sent.answers, [{ display: true, mse: true }, { display: true, mse: false }]);
assert.deepEqual(result.sent.containers[0], { canPlayType: 'maybe', display: false, packs: true });
assert.equal(result.sent.containers[1].packs, false, 'the packer has no Opus');
assert.deepEqual(result.sent.containers[2], { canPlayType: 'probably', display: true, packs: false });
assert.equal(result.sent.device.IS_HDR_SUPPORTED, false);
assert.equal(result.sent.device.IS_DV_SUPPORTED, false);
assert.ok(result.logs.some((line) => line.includes('video/x-matroska; codecs="avc1.640028,ec-3"') && line.includes('canPlayType="maybe"')));

result = ask({ type: 'canPlay', id: 'q2', configs: [{ kind: 'video', codecs: 'avc1.640033', width: 1920, height: 1080, framerate: 30 }] }, livingRoom);
assert.deepEqual(result.sent.answers, [{ display: false, mse: false }]);
assert.deepEqual(result.sent.containers, []);

const avcC = new Uint8Array([1, 0x64, 0x00, 0x33, 0xff, 0xe1]);
const video = { type: 1, codecId: 'V_MPEG4/ISO/AVC', codecPrivate: avcC };
let muxer = new Fmp4Muxer(video, 90000);
assert.equal(muxer.codecString(), 'avc1.640033');
muxer.declared = 'avc1.640028';
assert.equal(muxer.contentType(), 'video/mp4; codecs="avc1.640028"');
muxer.declared = 'hvc1.1.6.L120.90';
assert.equal(muxer.codecString(), 'avc1.640033', 'a declared string for another codec is ignored');
const audio = { type: 2, codecId: 'A_EAC3', audio: { sampleRate: 48000 } };
muxer = MkvEngine.prototype.muxer_.call({ videoCodec: 'avc1.640028' }, audio, 48000);
assert.equal(muxer.codecString(), 'ec-3');
assert.equal(MkvEngine.prototype.muxer_.call({ videoCodec: 'avc1.640028' }, video, 90000).codecString(), 'avc1.640028');
assert.equal(MkvEngine.prototype.muxer_.call({ videoCodec: null }, video, 90000).codecString(), 'avc1.640033');

const page = { MediaSource: global.MediaSource };
page.window = page;
page.document = { getElementById: () => ({}) };
vm.runInNewContext(read('tv-mse.js'), page);
const videoType = page.MseEngine.prototype.videoType;
assert.equal(videoType.call({ videoCodec: 'avc1.640028' }, 'avc1.640033'), 'avc1.640028');
assert.equal(videoType.call({ videoCodec: 'avc1.640028' }, 'hvc1.2.4.L153.B0'), 'hvc1.2.4.L153.B0');
assert.equal(videoType.call({}, 'avc1.640033'), 'avc1.640033');

assert.match(receiver, /engine\.videoCodec = custom\.videoCodec/);
assert.match(receiver, /videoCodec: custom\.videoCodec,/);
console.log('can-play tests passed');
