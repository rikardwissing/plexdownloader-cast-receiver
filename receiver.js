// PlexDownloader custom receiver.
//
// Default CAF playback for everything the default receiver handled (direct
// files, HLS packages), plus:
//  - a diagnostics channel: the sender can ask what THIS device's MSE
//    actually decodes (the per-device answer to every "does it support X?"
//    question);
//  - the MSE engine: progressive MP4s flagged by the sender are demuxed
//    in-browser (mp4box.js) and fed to MediaSource per-track, which is what
//    makes audio switching on a direct file possible at all — the sender
//    says "switch", the audio SourceBuffer is refilled from the live
//    position, video never reloads.
'use strict';

const NS = 'urn:x-cast:com.rikard.plexdownloader';
const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();

// ---------------------------------------------------------------- diagnostics

function mseSupport(type) {
  try { return !!window.MediaSource && MediaSource.isTypeSupported(type); }
  catch (e) { return false; }
}

function capabilities() {
  return {
    mse: !!window.MediaSource,
    mp4box: typeof MP4Box !== 'undefined',
    videoH264: mseSupport('video/mp4; codecs="avc1.640028"'),
    videoHEVC: mseSupport('video/mp4; codecs="hvc1.2.4.L120.90"'),
    audioAAC: mseSupport('audio/mp4; codecs="mp4a.40.2"'),
    audioAC3: mseSupport('audio/mp4; codecs="ac-3"'),
    audioEC3: mseSupport('audio/mp4; codecs="ec-3"'),
    userAgent: navigator.userAgent,
  };
}

// Receiver-side logging lands in the sender's diagnostics file (CASTLOG
// receiver message) — the only eyes we have on this code in the field.
function slog(msg) {
  try { context.sendCustomMessage(NS, undefined, { type: 'log', msg: String(msg) }); }
  catch (e) { /* no sender connected */ }
}

// ---------------------------------------------------------------- MSE engine

// One engine per load. Demuxes the served MP4 with mp4box.js and feeds two
// SourceBuffers. Every audio track is fragmented from the start (segments for
// unselected tracks are dropped as they arrive — demux cost only), so a
// switch needs no re-parse: flush the audio buffer, append the other track's
// init segment, and re-extract from the current position.
class MseEngine {
  constructor(url, audioTypeIndex) {
    this.url = url;
    this.wantAudioIndex = audioTypeIndex || 0;
    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.mp4 = MP4Box.createFile();
    this.buffers = {};        // 'video' | 'audio' → SourceBuffer
    this.queues = { video: [], audio: [] };
    this.initSegs = {};       // mp4 track id → init segment ArrayBuffer
    this.audioTracks = [];    // mp4box audio track infos, file order
    this.videoTrackId = null;
    this.audioTrackId = null;
    this.fetchOffset = 0;
    this.fetchGen = 0;        // bumped to cancel an in-flight pump
    this.dead = false;
    this.mediaSource.addEventListener('sourceopen', () => this.onSourceOpen());
  }

  onSourceOpen() {
    this.mp4.onError = (e) => slog('engine mp4box error: ' + e);
    this.mp4.onReady = (info) => this.onReady(info);
    this.mp4.onSegment = (id, user, buffer) => this.onSegment(id, buffer);
    this.pump(0);
  }

  onReady(info) {
    const video = info.videoTracks && info.videoTracks[0];
    this.audioTracks = info.audioTracks || [];
    const audio = this.audioTracks[this.wantAudioIndex] || this.audioTracks[0];
    if (!video || !audio) { slog('engine: missing tracks'); return; }
    this.videoTrackId = video.id;
    this.audioTrackId = audio.id;
    if (info.duration && info.timescale) {
      try { this.mediaSource.duration = info.duration / info.timescale; } catch (e) {}
    }
    const vMime = 'video/mp4; codecs="' + video.codec + '"';
    this.audioMimeFor = (t) => 'audio/mp4; codecs="' + t.codec + '"';
    try {
      this.buffers.video = this.mediaSource.addSourceBuffer(vMime);
      this.buffers.audio = this.mediaSource.addSourceBuffer(this.audioMimeFor(audio));
    } catch (e) { slog('engine addSourceBuffer failed: ' + e + ' ' + vMime); return; }
    for (const kind of ['video', 'audio']) {
      this.buffers[kind].addEventListener('updateend', () => this.drain(kind));
      this.buffers[kind].addEventListener('error', () => slog('engine ' + kind + ' buffer error'));
    }
    // Fragment video + EVERY audio track; unselected audio is dropped in
    // onSegment, so a later switch only needs a refill from the live position.
    this.mp4.setSegmentOptions(video.id, null, { nbSamples: 100 });
    for (const t of this.audioTracks) this.mp4.setSegmentOptions(t.id, null, { nbSamples: 100 });
    for (const seg of this.mp4.initializeSegmentation()) this.initSegs[seg.id] = seg.buffer;
    this.enqueue('video', this.initSegs[video.id]);
    this.enqueue('audio', this.initSegs[audio.id]);
    this.mp4.start();
    slog('engine ready: video ' + video.codec + ', audio [' +
         this.audioTracks.map((t) => t.codec + ':' + (t.language || '?')).join(', ') +
         '] playing #' + this.wantAudioIndex);
    // A moov-at-end file (no faststart) means the whole file streamed past
    // before the index was known — nothing was extracted. Either way, sample
    // extraction starts by seeking the demux back to the first frame's bytes.
    this.reposition(0);
  }

  onSegment(id, buffer) {
    if (id === this.videoTrackId) this.enqueue('video', buffer);
    else if (id === this.audioTrackId) this.enqueue('audio', buffer);
    // other audio tracks: demuxed and dropped
  }

  enqueue(kind, buffer) {
    if (!buffer) return;
    this.queues[kind].push(buffer);
    this.drain(kind);
  }

  drain(kind) {
    const sb = this.buffers[kind];
    if (this.dead || !sb || sb.updating || this.mediaSource.readyState !== 'open') return;
    const next = this.queues[kind].shift();
    if (!next) return;
    try {
      sb.appendBuffer(next);
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        this.queues[kind].unshift(next);
        this.evict(kind);
      } else {
        slog('engine append ' + kind + ' failed: ' + e);
      }
    }
  }

  evict(kind) {
    const sb = this.buffers[kind];
    const now = playerManager.getCurrentTimeSec() || 0;
    const keepFrom = Math.max(0, now - 20);
    try {
      if (!sb.updating && sb.buffered.length && sb.buffered.start(0) < keepFrom - 1) {
        sb.remove(0, keepFrom);   // updateend re-drains the queue
      }
    } catch (e) { slog('engine evict failed: ' + e); }
  }

  bufferedAheadSec() {
    const sb = this.buffers.video;
    if (!sb || !sb.buffered.length) return 0;
    const now = playerManager.getCurrentTimeSec() || 0;
    const end = sb.buffered.end(sb.buffered.length - 1);
    return Math.max(0, end - now);
  }

  // Sequential byte pump: fetch 2 MB ranges, hand them to mp4box (which
  // returns the next offset it wants), stall while >90s is buffered ahead,
  // trim behind playback as we go.
  async pump(offset) {
    const gen = ++this.fetchGen;
    const CHUNK = 2 * 1024 * 1024;
    this.fetchOffset = offset;
    while (!this.dead && gen === this.fetchGen) {
      if (this.bufferedAheadSec() > 90) {
        await new Promise((r) => setTimeout(r, 500));
        this.evict('video'); this.evict('audio');
        continue;
      }
      let buf;
      try {
        const resp = await fetch(this.url, { headers: { Range: 'bytes=' + this.fetchOffset + '-' + (this.fetchOffset + CHUNK - 1) } });
        if (resp.status === 416) {   // ranged past EOF — the file is done
          if (gen === this.fetchGen) { this.mp4.flush(); this.endStreamWhenDrained(gen); }
          return;
        }
        if (!resp.ok) { slog('engine fetch HTTP ' + resp.status + ' @' + this.fetchOffset); return; }
        buf = await resp.arrayBuffer();
      } catch (e) { slog('engine fetch failed @' + this.fetchOffset + ': ' + e); return; }
      if (this.dead || gen !== this.fetchGen) return;
      if (!buf.byteLength) { this.mp4.flush(); this.endStreamWhenDrained(gen); return; }
      buf.fileStart = this.fetchOffset;
      const next = this.mp4.appendBuffer(buf);
      // appendBuffer can fire onReady, whose reposition() supersedes THIS
      // pump — a moov-at-end file EOFs right here, and declaring end-of-
      // stream from the stale pump truncated playback to seconds.
      if (this.dead || gen !== this.fetchGen) return;
      const done = buf.byteLength < CHUNK;   // short read = EOF
      if (done) { this.mp4.flush(); this.endStreamWhenDrained(gen); return; }
      this.fetchOffset = (typeof next === 'number') ? next : this.fetchOffset + buf.byteLength;
    }
  }

  endStreamWhenDrained(gen) {
    const tryEnd = () => {
      // A reposition/seek since this EOF means more data is coming — bail.
      if (this.dead || gen !== this.fetchGen || this.mediaSource.readyState !== 'open') return;
      if (this.queues.video.length || this.queues.audio.length ||
          this.buffers.video.updating || this.buffers.audio.updating) {
        setTimeout(tryEnd, 200);
        return;
      }
      try { this.mediaSource.endOfStream(); } catch (e) {}
    };
    tryEnd();
  }

  // Reposition the demux (post-index start, sender seek, or audio-switch
  // refill). mp4box maps the time to the byte offset of the previous
  // keyframe; already-queued segments stay queued — re-extracted video just
  // overwrites itself in MSE, and clearing here would eat a freshly queued
  // init segment.
  reposition(timeSec) {
    let seek;
    try { seek = this.mp4.seek(Math.max(0, timeSec), true); }
    catch (e) { slog('engine seek failed: ' + e); return; }
    this.pump(seek.offset);
  }

  // The whole point of the engine: switch audio without touching video.
  setAudioTrack(index) {
    const track = this.audioTracks[index];
    if (!track || track.id === this.audioTrackId) return;
    const sb = this.buffers.audio;
    if (!sb) return;
    this.audioTrackId = track.id;
    this.wantAudioIndex = index;
    const swap = () => {
      if (sb.updating) { setTimeout(swap, 50); return; }
      try {
        if (sb.buffered.length) sb.remove(0, this.mediaSource.duration || 1e9);
      } catch (e) {}
      const append = () => {
        if (sb.updating) { setTimeout(append, 50); return; }
        try { if (sb.changeType) sb.changeType(this.audioMimeFor(track)); } catch (e) {}
        this.queues.audio = [this.initSegs[track.id]];
        this.drain('audio');
        this.reposition((playerManager.getCurrentTimeSec() || 0) - 0.5);
        slog('engine audio → #' + index + ' (' + (track.language || '?') + ')');
      };
      append();
    };
    swap();
  }

  destroy() {
    this.dead = true;
    this.fetchGen++;
    try { this.mp4.stop(); } catch (e) {}
    URL.revokeObjectURL(this.objectUrl);
  }
}

let engine = null;

function teardownEngine() {
  if (engine) { engine.destroy(); engine = null; }
}

// ---------------------------------------------------------------- CAF wiring

// LOAD: media the sender flagged (customData.mseEngine) plays through the
// engine — CAF just sees a blob URL and drives play/pause/time as usual.
// Everything else (packages, Dolby direct files) keeps default playback.
playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.LOAD, (request) => {
    teardownEngine();
    const media = request.media || {};
    const custom = media.customData || {};
    if (custom.mseEngine && window.MediaSource && typeof MP4Box !== 'undefined') {
      const url = media.contentUrl || media.contentId;
      engine = new MseEngine(url, custom.audioTypeIndex || 0);
      media.contentUrl = engine.objectUrl;
      media.contentId = engine.objectUrl;
      media.contentType = 'video/mp4';
      slog('engine load: ' + url + ' audio#' + (custom.audioTypeIndex || 0));
    }
    return request;
  });

// SEEK: CAF moves the media element; the engine must move the demux too.
playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.SEEK, (request) => {
    if (engine && typeof request.currentTime === 'number') {
      engine.reposition(request.currentTime);
    }
    return request;
  });

// No teardown on MEDIA_FINISHED: casting into a live session fires the OLD
// media's finish while the new engine is loading (that killed the first
// engine cast in the field). The LOAD interceptor is the teardown point.

context.addCustomMessageListener(NS, (event) => {
  const msg = event.data || {};
  if (msg.type === 'ping') {
    context.sendCustomMessage(NS, event.senderId,
                              { type: 'pong', capabilities: capabilities() });
  } else if (msg.type === 'setAudioTrack' && engine) {
    engine.setAudioTrack(msg.audioTypeIndex || 0);
  }
});

context.start();
