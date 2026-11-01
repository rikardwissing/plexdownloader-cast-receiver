'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../receiver.js'), 'utf8');
// Exercise the actual per-LOAD configuration with CAF stubbed at its boundary.
const start = source.indexOf('    const playbackConfig = new cast.framework.PlaybackConfig();');
const end = source.indexOf('    playerManager.setPlaybackConfig(playbackConfig);', start)
  + '    playerManager.setPlaybackConfig(playbackConfig);'.length;
assert.ok(start > 0 && end > start);
const mseCodecs = vm.runInNewContext(source.slice(source.indexOf('const MSE_AUDIO_NAMES'),
  source.indexOf('\n}\n', source.indexOf('function mseCodecs')) + 3) + 'mseCodecs;');
function load(url, custom) {
  let config;
  const window = { __fmp4SplitRegister() {} };
  vm.runInNewContext(source.slice(start, end), {
    media: { contentUrl: url }, custom, window,
    cast: { framework: { PlaybackConfig: class {} } },
    playerManager: { setPlaybackConfig(value) { config = value; } },
    slog() {}, dolbyFreeCodecs: (codecs) => codecs, mseCodecs,
  });
  return { config, window };
}
const local = 'http://192.168.1.2:8100/master.m3u8';
let result = load(local, { madeStream: true, streamContainer: 'mp4', streamCodecs: 'avc1.640028,ac-3' });
assert.equal(result.window.__dolbySplitActive, true);
assert.equal(result.config.shakaConfig.mediaSource.forceTransmux, true);
assert.equal(result.config.manifestHandler('#EXTM3U\nvideo.ts\n'), '#EXTM3U\nvideo.ts\n');
let request = { url: 'http://192.168.1.2:8100/video-0.m4s' };
result.config.segmentRequestHandler(request);
assert.equal(request.url, 'http://192.168.1.2:8100/video-0.m4s');
result = load(local, { madeStream: true, streamContainer: 'mp4', streamCodecs: 'avc1.640028,mp4a.40.2' });
assert.equal(result.window.__dolbySplitActive, false);
assert.equal(result.config.shakaConfig.mediaSource.forceTransmux, false);
// Existing server-built streams retain their rename/auth and Dolby paths.
result = load('http://plex/transcode/universal/start.m3u8?X-Plex-Token=abc', { streamCodecs: 'avc1.640028,ec-3' });
assert.equal(result.window.__dolbySplitActive, true);
assert.match(result.config.manifestHandler('#EXTM3U\nvideo.ts\n'), /video.ts.m4s/);
request = { url: 'http://plex/transcode/universal/video.ts.m4s' };
result.config.segmentRequestHandler(request);
assert.equal(request.url, 'http://plex/transcode/universal/video.ts?X-Plex-Token=abc');
// Old senders' packages/direct files retain their own CAF configuration.
result = load(local, {});
assert.equal(result.config.shakaConfig, undefined);
result = load(local, { madeStream: true, streamContainer: 'mp4', streamCodecs: 'hvc1.1.6.L120.B0,Opus' });
assert.equal(result.config.manifestHandler('#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="hvc1.1.6.L120.B0,Opus"\nmade.m3u8\n'),
  '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="hvc1.1.6.L120.B0,opus"\nmade.m3u8\n', 'Shaka gets the MSE spelling of Opus');
assert.equal(result.config.manifestHandler('#EXT-X-STREAM-INF:BANDWIDTH=1\nmade.m3u8\n'),
  '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="hvc1.1.6.L120.B0,opus"\nmade.m3u8\n');
assert.equal(mseCodecs('avc1.640028,fLaC'), 'avc1.640028,flac');
assert.equal(mseCodecs('avc1.640028,mp4a.40.2'), 'avc1.640028,mp4a.40.2');
console.log('made-stream receiver regressions passed');
const capabilityCode = source.slice(source.indexOf('function capabilities()'), source.indexOf('// Receiver-side logging'));
const queried = [];
const capabilityContext = {
  pictureHDR: {}, DISPLAY_SIZES: [{ width: 1920, height: 1080 }, { width: 3840, height: 2160 }],
  window: { MediaSource: {} }, document: { createElement() { return {}; } }, navigator: { userAgent: 'fixture' },
  mseSupport(type) { return type.includes('avc1.640028'); },
  canDisplaySize(codecs, width, height) { queried.push({ codecs, width, height }); return height === 1080; },
  canDisplay() { return false; }, canDisplayHeight() { return false; }, sbMuxedEC3: false,
};
vm.createContext(capabilityContext);
vm.runInContext(capabilityCode + '\nresult = capabilities();', capabilityContext);
assert.equal(capabilityContext.result.videoHEVC10, false);
assert.equal(capabilityContext.result.pictureH2641080, true);
assert.equal(capabilityContext.result.pictureH2642160, false);
assert.ok(queried.some((q) => q.codecs[0] === 'hev1.2.6.L150'));
assert.equal(capabilityContext.result.pictureHEVC10HDRPQ1080, true);
assert.equal(capabilityContext.result.pictureHEVC10HDRPQ2160, false);
console.log('capability measurement regressions passed');

const sizeQueries = [];
const sizeContext = {context: {canDisplayType(...args) { sizeQueries.push(args); return true; }}};
vm.createContext(sizeContext);
vm.runInContext(source.slice(source.indexOf('function canDisplaySize('), source.indexOf('const DISPLAY_SIZES')), sizeContext);
assert.equal(sizeContext.canDisplaySize(['avc1.640028'], 1920, 1080), true);
assert.equal(sizeQueries[0][4], 30, 'explicit 30fps answer bounds sender copy approval');
