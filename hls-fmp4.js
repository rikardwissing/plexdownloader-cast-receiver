'use strict';
// HlsFmp4Engine — plays Plex's muxed fMP4 HLS through DEMUXED SourceBuffers.
//
// Why this exists (all measured, 2026-08-21): this platform refuses Dolby in
// a muxed MSE buffer at every layer — isTypeSupported, canDisplayType, and
// addSourceBuffer itself — while accepting the identical codec in a separate
// audio/mp4 buffer (the cast packages play that way). Shaka 4.16 creates the
// split buffers but appends the muxed bytes unsplit (3014 append refusal), and
// its transmuxer only demuxes TS, not fMP4. So the receiver demuxes for real:
// mp4box (already aboard for the direct-file MSE engine) splits each fetched
// segment into per-track fragments, and each track feeds its own buffer.
//
// The engine owns a MediaSource behind a blob URL; CAF drives the media
// element exactly as it does for the MseEngine — play/pause/time are CAF's,
// seeks arrive via the SEEK interceptor calling reposition().
//
// Timeline: Plex opens transcode PTS at a lead (~10s, copyts) while the
// playlist's declared grid is absolute file time (segment N starts at N*10).
// The anchor reads the first segment's own sidx and sets timestampOffset so
// the element clock equals the declared grid — the same clock the phone and
// the browser receivers use, so positions survive handoffs.

const HLS_ENGINE_VERSION = '2026-08-23.6';

function HlsFmp4Engine(masterUrl, streamCodecs, getTime, log, startAt) {
  this.masterUrl = masterUrl;
  this.getTime = getTime || function () { return 0; };
  this.log = log || function () {};
  this.startAt = startAt || 0;
  this.videoCodec = null;
  this.audioCodec = null;
  const codecs = String(streamCodecs || '').split(',');
  for (let i = 0; i < codecs.length; i++) {
    const c = codecs[i].trim();
    if (!c) continue;
    if (/^(avc1|avc3|hvc1|hev1|vp9|av01)/.test(c)) this.videoCodec = c;
    else this.audioCodec = c;
  }
  this.mediaSource = new MediaSource();
  this.objectUrl = URL.createObjectURL(this.mediaSource);
  this.dead = false;
  this.generation = 0;
  this.buffers = [];            // [{sb, kind}]
  this.mp4box = null;
  this.nextFileStart = 0;
  this.initBytes = null;
  this.initUri = null;
  this.playlistUrl = null;
  this.mediaSequence = 0;
  this.segments = [];           // [{uri, duration}]
  this.segIndex = 0;
  this.ended = false;           // playlist carried EXT-X-ENDLIST
  // Rebasing, third iteration (each measured in the field): ONE offset per
  // RUN, computed from the run's first segment. A single global offset
  // strands later segments (declared 10s vs drifting real spans); rebasing
  // EVERY segment to its slot leaves sub-second gaps at boundaries whenever a
  // real span comes up short, and a raw element stalls on a gap forever
  // (field: t frozen at 738 inside window [730,800]). Source content is
  // contiguous, so within a run the jitter does not accumulate — anchoring
  // once keeps every boundary seamless, at the cost of a bounded (~2s) skew
  // against the declared grid.
  this.currentOffset = 0;
  this.runAnchored = false;
  this.findMedia = null;        // set by the page when the element is visible to JS
  this.lastNudge = 0;
  // The window of DECLARED time this generation has appended - the honest
  // basis for "did the playhead leave what we have", immune to read-ahead.
  this.windowLo = 0;
  this.windowHi = 0;
  // Seek settling: after a reposition the element takes a while to report the
  // new position, and the pump reading the OLD position must not "correct"
  // the seek away (field: reposition 1044 -> reposition 6 -> 1044, thrashing
  // the demuxer). No drift-triggered reposition inside the grace window.
  this.lastReposition = 0;
  this.quotaLogged = 0;
  this.appendsSinceEvict = 0;
  // Subtitles, browser-receiver style: the session is always built with the
  // chosen track as the manifest's one VTT rendition (external or embedded
  // alike), and the element is reachable from page JS (measured: el=yes) - so
  // the engine fetches the rendition's segments, concatenates the cues (their
  // LOCALs are absolute source time), and attaches ONE showing <track>. The
  // shift is fully measured, no constants: elementTime = rawPTS +
  // currentOffset and rawPTS = sourceTime + lead (from the segments' own
  // X-TIMESTAMP-MAP), so cues move by (lead + currentOffset) - recomputed
  // whenever a seek re-anchors the run. Picking a different track on the
  // phone restarts the session into a new rendition, same as everywhere else.
  this.wantSubtitle = false;    // set by the page from customData.subtitleActive
  this.subPlaylistUrl = null;
  this.subMediaSequence = 0;
  this.synthSegs = {};          // segment index -> stripped cue text
  this.synthLead = null;        // X-TIMESTAMP-MAP lead, constant per session
  this.synthShift = null;       // shift the current <track> was built with
  this.synthTrackEl = null;
  this.synthTimer = null;
  this.paintTimer = null;
  this.subDiagTimer = null;
  this.paintedOnce = false;
  this.onEngineFailed = null;
  const self = this;
  this.mediaSource.addEventListener('sourceopen', function onOpen() {
    self.mediaSource.removeEventListener('sourceopen', onOpen);
    self.start_();
  });
}

HlsFmp4Engine.prototype.destroy = function () {
  this.dead = true;
  this.generation++;
  if (this.synthTimer) { clearInterval(this.synthTimer); this.synthTimer = null; }
  if (this.paintTimer) { clearInterval(this.paintTimer); this.paintTimer = null; }
  if (this.subDiagTimer) { clearInterval(this.subDiagTimer); this.subDiagTimer = null; }
  if (this.synthTrackEl) {
    try { URL.revokeObjectURL(this.synthTrackEl.src); } catch (e) {}
    try { this.synthTrackEl.parentNode.removeChild(this.synthTrackEl); } catch (e) {}
    this.synthTrackEl = null;
  }
  const box = document.getElementById('hlsengine-captions');
  if (box) { try { box.innerHTML = ''; } catch (e) {} }
  try { URL.revokeObjectURL(this.objectUrl); } catch (e) {}
};

HlsFmp4Engine.prototype.fatal_ = function (reason) {
  if (this.dead) return;
  this.dead = true;
  this.log('hlsengine fatal: ' + reason);
  if (this.onEngineFailed) { try { this.onEngineFailed(reason); } catch (e) {} }
};

HlsFmp4Engine.prototype.sleep_ = function (ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
};

// A segment the server hasn't converted yet answers 404 — that is a "not
// yet", not an error; the caller retries. Anything else rejects.
HlsFmp4Engine.prototype.bytes_ = async function (url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.arrayBuffer();   // mp4box consumes ArrayBuffers carrying .fileStart
};
HlsFmp4Engine.prototype.text_ = async function (url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
};

HlsFmp4Engine.prototype.refreshPlaylist_ = async function () {
  const body = await this.text_(this.playlistUrl);
  const lines = body.split('\n');
  const segs = [];
  let duration = 10;
  this.ended = body.indexOf('#EXT-X-ENDLIST') >= 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) {
      this.mediaSequence = parseInt(line.slice(22), 10) || 0;
    } else if (line.indexOf('#EXT-X-MAP:') === 0) {
      const m = /URI="([^"]+)"/.exec(line);
      if (m) this.initUri = m[1];
    } else if (line.indexOf('#EXTINF:') === 0) {
      duration = parseFloat(line.slice(8)) || 10;
    } else if (line.charAt(0) !== '#') {
      segs.push({ uri: line, duration: duration });
    }
  }
  this.segments = segs;
};

HlsFmp4Engine.prototype.start_ = async function () {
  try {
    const master = await this.text_(this.masterUrl);
    const variant = master.split('\n').map(function (l) { return l.trim(); })
      .find(function (l) { return l && l.charAt(0) !== '#'; });
    if (!variant) { this.fatal_('no variant in master'); return; }
    this.playlistUrl = new URL(variant, this.masterUrl).href;
    const subLine = master.split('\n').find(function (l) {
      return l.indexOf('#EXT-X-MEDIA:') === 0 && l.indexOf('TYPE=SUBTITLES') >= 0;
    });
    if (subLine) {
      const m = /URI="([^"]+)"/.exec(subLine);
      if (m) this.subPlaylistUrl = new URL(m[1], this.masterUrl).href;
    }
    await this.refreshPlaylist_();
    if (!this.initUri) { this.fatal_('no EXT-X-MAP in playlist'); return; }
    this.initBytes = await this.bytes_(new URL(this.initUri, this.playlistUrl).href);
    // Plex's playlist declares the whole film up front (segments materialise
    // as the encoder reaches them), so the duration is known immediately.
    let total = this.mediaSequence * 10;
    for (let i = 0; i < this.segments.length; i++) total += this.segments[i].duration;
    try { this.mediaSource.duration = total; } catch (e) {}
    // Start at the position CAF is about to play from, not at segment zero.
    const at = Math.max(this.getTime() || 0, this.startAt);
    this.segIndex = Math.min(
      Math.max(0, Math.floor(at / 10) - this.mediaSequence),
      Math.max(0, this.segments.length - 1));
    this.windowLo = (this.mediaSequence + this.segIndex) * 10;
    this.windowHi = this.windowLo;
    this.log('hlsengine ' + HLS_ENGINE_VERSION + ': start, sub=' +
             (this.wantSubtitle ? 'wanted' : 'off') +
             (this.subPlaylistUrl ? ' (rendition present)' : ' (no rendition)'));
    await this.createBuffers_();
    this.setupMp4box_();
    this.pump_();
    if (this.wantSubtitle && this.subPlaylistUrl) {
      const self = this;
      this.synthTimer = setInterval(function () { self.refreshSynth_(); }, 8000);
      this.refreshSynth_();
    } else if (this.wantSubtitle) {
      this.log('hlsengine: subtitle wanted but master has no rendition');
    }
  } catch (e) { this.fatal_('start: ' + e); }
};

HlsFmp4Engine.prototype.shiftTimestamp_ = function (ts, offset) {
  const parts = ts.split(':');
  let seconds = 0;
  for (let i = 0; i < parts.length; i++) seconds = seconds * 60 + parseFloat(parts[i]);
  seconds = Math.max(0, seconds + offset);
  const h = Math.floor(seconds / 3600), mn = Math.floor((seconds % 3600) / 60);
  let sc = (seconds % 60).toFixed(3);
  if (sc.length < 6) sc = '0' + sc;
  return (h < 10 ? '0' + h : h) + ':' + (mn < 10 ? '0' + mn : mn) + ':' + sc;
};

HlsFmp4Engine.prototype.stripVtt_ = function (text) {
  const map = /X-TIMESTAMP-MAP=LOCAL:([\d:.]+),MPEGTS:(\d+)/.exec(text);
  if (map) {
    let local = 0;
    const lp = map[1].split(':');
    for (let i = 0; i < lp.length; i++) local = local * 60 + parseFloat(lp[i]);
    this.synthLead = map[2] / 90000 - local;
  }
  return text.split('\n').filter(function (line) {
    return !/^WEBVTT/.test(line) && !/^X-TIMESTAMP-MAP/.test(line);
  }).join('\n').replace(/^\s+/, '').replace(/\s+$/, '');
};

HlsFmp4Engine.prototype.refreshSynth_ = async function () {
  if (this.dead) { if (this.synthTimer) clearInterval(this.synthTimer); return; }
  try {
    const pl = await this.text_(this.subPlaylistUrl);
    const lines = pl.split('\n');
    const segs = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) {
        this.subMediaSequence = parseInt(line.slice(22), 10) || 0;
      } else if (line.charAt(0) !== '#') {
        segs.push(line);
      }
    }
    // A window around the playhead: segments materialise as the encoder
    // reaches them, so a miss now is a hit on the next tick.
    const here = Math.max(0,
      Math.floor((this.getTime() || 0) / 10) - 3 - this.subMediaSequence);
    const last = Math.min(segs.length, here + 42);
    let fetched = false;
    for (let i = here; i < last; i++) {
      if (this.synthSegs[i] != null) continue;
      try {
        const t = await this.text_(new URL(segs[i], this.subPlaylistUrl).href);
        this.synthSegs[i] = this.stripVtt_(t);
        fetched = true;
      } catch (e) {}
    }
    const shift = (this.synthLead != null ? this.synthLead : 0) + this.currentOffset;
    const changed = this.synthShift == null || Math.abs(shift - this.synthShift) > 0.05;
    if ((fetched || changed) && Object.keys(this.synthSegs).length) {
      this.rebuildSynth_(shift);
    }
  } catch (e) {}
};

HlsFmp4Engine.prototype.rebuildSynth_ = function (shift) {
  let el = null;
  try { el = this.findMedia && this.findMedia(); } catch (e) {}
  if (!el) return;
  const keys = Object.keys(this.synthSegs).map(Number).sort(function (a, b) { return a - b; });
  const parts = [];
  for (let k = 0; k < keys.length; k++) {
    if (this.synthSegs[keys[k]]) parts.push(this.synthSegs[keys[k]]);
  }
  if (!parts.length) return;
  const self = this;
  let body = 'WEBVTT\n\n' + parts.join('\n\n') + '\n';
  if (Math.abs(shift) > 0.05) {
    body = body.split('\n').map(function (line) {
      if (line.indexOf('-->') < 0) return line;
      return line.replace(/([\d:.]+)(\s*-->\s*)([\d:.]+)/, function (_, a, arrow, b) {
        return self.shiftTimestamp_(a, shift) + arrow + self.shiftTimestamp_(b, shift);
      });
    }).join('\n');
  }
  if (this.synthTrackEl) {
    try { URL.revokeObjectURL(this.synthTrackEl.src); } catch (e) {}
    try { this.synthTrackEl.parentNode.removeChild(this.synthTrackEl); } catch (e) {}
  }
  const t = document.createElement('track');
  t.kind = 'subtitles';
  t.label = 'Subtitles';
  t.src = URL.createObjectURL(new Blob([body], { type: 'text/vtt' }));
  el.appendChild(t);
  this.synthTrackEl = t;
  // The cues fire, WE paint. mode='showing' produced no visible text on the
  // CAF element (field: track rebuilt with cues for minutes, nothing on
  // screen) — whether CAF knocks the mode or its layers cover the native
  // renderer, the fix is the same: keep the track hidden (cuechange still
  // fires) and draw the text in an overlay this page owns.
  try { t.track.mode = 'hidden'; } catch (e) {}
  // Painting is TIMER-driven, not event-driven: CAF can knock an element
  // track to 'disabled', which silences cuechange and nulls activeCues — a
  // poll that re-asserts the mode first survives that.
  if (!this.paintTimer) {
    this.paintTimer = setInterval(function () { self.paintCues_(); }, 400);
    this.subDiagTimer = setInterval(function () { self.subDiag_(); }, 5000);
  }
  this.paintCues_();
  this.synthShift = shift;
  this.log('hlsengine: synth track rebuilt, ' + parts.length +
           ' seg(s), shift ' + shift.toFixed(2) + 's');
};

HlsFmp4Engine.prototype.captionBox_ = function () {
  let box = document.getElementById('hlsengine-captions');
  if (!box) {
    box = document.createElement('div');
    box.id = 'hlsengine-captions';
    box.style.cssText =
      'position:absolute;left:10%;right:10%;bottom:8%;z-index:9999;' +
      'text-align:center;pointer-events:none;font-family:sans-serif;' +
      'font-size:4.2vh;line-height:1.35;color:#fff;' +
      'text-shadow:0 0 4px #000,0 2px 4px #000;';
    // Mount NEXT TO the media element, inside the player's shadow root: on a
    // TV compositor the video is a hardware plane, and a document.body
    // overlay can lose to it — CAF's own UI lives beside the element and
    // provably renders above the picture, so that is where captions go too.
    let host = null;
    try {
      const el = this.findMedia && this.findMedia();
      if (el && el.parentNode) host = el.parentNode;
    } catch (e) {}
    if (!host) {
      host = document.body;
      box.style.position = 'fixed';
    }
    host.appendChild(box);
    this.log('hlsengine: caption box mounted in ' +
             (host === document.body ? 'body' : 'player shadow'));
  }
  return box;
};

// The one log that names a subtitle failure: track state, cue counts, and
// the cue TIME RANGE against the element clock — a mismatch means timing, an
// empty cue list means loading, a knocked mode means CAF.
HlsFmp4Engine.prototype.subDiag_ = function () {
  if (this.dead) { if (this.subDiagTimer) clearInterval(this.subDiagTimer); return; }
  let line = 'subdiag: t=' + Math.round(this.getTime() || 0);
  try {
    const trackEl = this.synthTrackEl;
    const track = trackEl && trackEl.track;
    if (!track) { this.log(line + ' no track'); return; }
    line += ' mode=' + track.mode + ' ready=' + trackEl.readyState;
    const cues = track.cues;
    line += ' cues=' + (cues ? cues.length : 'null');
    if (cues && cues.length) {
      line += ' range=' + Math.round(cues[0].startTime) + '-' +
              Math.round(cues[cues.length - 1].endTime);
    }
    line += ' active=' + (track.activeCues ? track.activeCues.length : 'null');
  } catch (e) { line += ' err=' + e; }
  this.log(line);
};

HlsFmp4Engine.prototype.paintCues_ = function () {
  if (this.dead) return;
  const box = this.captionBox_();
  let text = '';
  try {
    const track = this.synthTrackEl && this.synthTrackEl.track;
    if (track && track.mode === 'disabled') track.mode = 'hidden';
    const cues = track && track.activeCues;
    if (cues) {
      for (let i = 0; i < cues.length; i++) {
        // VTT markup (<i>, <c.color>…) means nothing to a div — plain text.
        text += (i ? '\n' : '') + String(cues[i].text || '').replace(/<[^>]*>/g, '');
      }
    }
    if (text && !this.paintedOnce) {
      this.paintedOnce = true;
      this.log('hlsengine: first caption painted');
    }
  } catch (e) {}
  if (!text) { box.innerHTML = ''; return; }
  const lines = text.split('\n');
  let html = '';
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    html += '<div><span style="background:rgba(0,0,0,0.55);padding:0 0.35em;' +
            'border-radius:0.15em;box-decoration-break:clone;">' +
            lines[i].replace(/&/g, '&amp;').replace(/</g, '&lt;') +
            '</span></div>';
  }
  box.innerHTML = html;
};

// The buffers are created up front from the sender's codec strings — and a
// refusal is retried: the TV's Dolby MSE capability FLICKERS for a few
// seconds after the receiver boots (field: addSourceBuffer ec-3 threw
// NotSupportedError two seconds after launch and succeeded forty seconds
// later; the same call passed in every later pong). A transient no is not a
// fatal no.
HlsFmp4Engine.prototype.createBuffers_ = async function () {
  const wanted = [];
  if (this.videoCodec) wanted.push({ kind: 'video', mime: 'video/mp4; codecs="' + this.videoCodec + '"' });
  if (this.audioCodec) wanted.push({ kind: 'audio', mime: 'audio/mp4; codecs="' + this.audioCodec + '"' });
  for (let i = 0; i < wanted.length; i++) {
    const w = wanted[i];
    let attempt = 0;
    for (;;) {
      if (this.dead) return;
      try {
        const sb = this.mediaSource.addSourceBuffer(w.mime);
        const self = this;
        const entry = { sb: sb, kind: w.kind, queue: [] };
        sb.addEventListener('updateend', function () { self.drain_(entry); });
        sb.addEventListener('error', function () { self.fatal_('sourcebuffer error (' + entry.kind + ')'); });
        this.buffers.push(entry);
        this.log('hlsengine: buffer ' + w.mime +
                 (attempt ? ' (after ' + attempt + ' retries)' : ''));
        break;
      } catch (e) {
        // Field-measured outage: the refusals lasted ~28s across two loads
        // and cleared by ~47s after receiver launch — budget most of a
        // minute, and say what the capability APIs claim while it lasts.
        if (e && e.name === 'NotSupportedError' && attempt < 60) {
          if (attempt === 0 || attempt % 15 === 14) {
            let claims = '';
            try {
              claims = ' isTypeSupported=' + MediaSource.isTypeSupported(w.mime) +
                       ' canDisplayType=' + (window.cast && cast.framework &&
                         cast.framework.CastReceiverContext.getInstance()
                           .canDisplayType(w.mime));
            } catch (e2) {}
            this.log('hlsengine: ' + w.mime + ' refused (attempt ' +
                     (attempt + 1) + ')' + claims);
          }
          attempt++;
          await this.sleep_(750);
          continue;
        }
        throw e;
      }
    }
  }
};

// A fresh demux context, wired to the (possibly pre-existing) SourceBuffers.
// Called at start and again on every seek: mp4box only consumes a contiguous
// byte stream, so a jump means a new file fed init-first.
HlsFmp4Engine.prototype.setupMp4box_ = function () {
  const self = this;
  const box = MP4Box.createFile();
  this.mp4box = box;
  this.nextFileStart = 0;
  box.onError = function (e) { self.fatal_('mp4box: ' + e); };
  box.onReady = function (info) {
    try {
      for (let i = 0; i < info.tracks.length; i++) {
        const t = info.tracks[i];
        const isVideo = !!t.video;
        // The SENDER's codec strings, not mp4box's: Plex writes E-AC-3 as
        // mp4a+esds and mp4box would echo "mp4a.a6", which this platform
        // rejects — the honest RFC6381 name is what addSourceBuffer needs.
        const codec = isVideo ? (self.videoCodec || t.codec)
                              : (self.audioCodec || t.codec);
        let entry = null;
        for (let j = 0; j < self.buffers.length; j++) {
          if (self.buffers[j].kind === (isVideo ? 'video' : 'audio')) entry = self.buffers[j];
        }
        if (!entry) {
          const mime = (isVideo ? 'video' : 'audio') + '/mp4; codecs="' + codec + '"';
          const sb = self.mediaSource.addSourceBuffer(mime);
          entry = { sb: sb, kind: isVideo ? 'video' : 'audio', queue: [] };
          sb.addEventListener('updateend', function () { self.drain_(entry); });
          sb.addEventListener('error', function () { self.fatal_('sourcebuffer error (' + entry.kind + ')'); });
          self.buffers.push(entry);
          self.log('hlsengine: buffer ' + mime);
        }
        box.setSegmentOptions(t.id, entry, { nbSamples: 100 });
      }
      const inits = box.initializeSegmentation();
      for (let i = 0; i < inits.length; i++) {
        self.enqueue_(inits[i].user, inits[i].buffer);
      }
      box.start();
    } catch (e) { self.fatal_('buffers: ' + e); }
  };
  box.onSegment = function (id, entry, buffer) { self.enqueue_(entry, buffer); };
  const init = this.initBytes.slice(0);
  init.fileStart = 0;
  this.nextFileStart = box.appendBuffer(init);
};

HlsFmp4Engine.prototype.enqueue_ = function (entry, buffer) {
  entry.queue.push({ buf: buffer, offset: this.currentOffset });
  this.drain_(entry);
};

HlsFmp4Engine.prototype.drain_ = function (entry) {
  if (this.dead || entry.sb.updating || !entry.queue.length) return;
  if (this.mediaSource.readyState !== 'open') return;
  try {
    // Each fragment carries the offset of the SEGMENT it came from, applied
    // just before its append (setting timestampOffset while updating throws).
    const item = entry.queue.shift();
    if (entry.sb.timestampOffset !== item.offset) {
      entry.sb.timestampOffset = item.offset;
    }
    entry.sb.appendBuffer(item.buf);
  } catch (e) {
    if (e && e.name === 'QuotaExceededError') {
      // Put the fragment BACK (losing it left a gap the element stalled on),
      // evict what playback has left behind, and retry on the next drain.
      entry.queue.unshift(item);
      const now = this.getTime() || 0;
      if (Date.now() - this.quotaLogged > 60000) {
        this.quotaLogged = Date.now();
        this.log('hlsengine: quota hit, evicting behind ' + Math.round(now - 30) + 's');
      }
      try { entry.sb.remove(0, Math.max(0.1, now - 30)); } catch (e2) {}
      return;
    }
    this.fatal_('append: ' + e);
  }
};

// Where a segment's content REALLY starts, from its own sidx (raw PTS =
// source + Plex's copyts lead). null when no sidx is found.
HlsFmp4Engine.prototype.sidxStart_ = function (bytes) {
  try {
    const dv = new DataView(bytes);
    let off = 0;
    while (off + 8 <= dv.byteLength) {
      const size = dv.getUint32(off);
      const type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5),
                                       dv.getUint8(off + 6), dv.getUint8(off + 7));
      if (type === 'sidx') {
        const version = dv.getUint8(off + 8);
        const timescale = dv.getUint32(off + 16);
        const ept = version === 0
          ? dv.getUint32(off + 20)
          : dv.getUint32(off + 20) * 4294967296 + dv.getUint32(off + 24);
        return ept / timescale;
      }
      if (!size) break;
      off += size;
    }
  } catch (e) {}
  return null;
};

HlsFmp4Engine.prototype.pump_ = async function () {
  const gen = ++this.generation;
  let lastBeat = 0;
  while (!this.dead && gen === this.generation) {
    if (Date.now() - lastBeat > 30000) {
      lastBeat = Date.now();
      let queues = '', ranges = '';
      for (let i = 0; i < this.buffers.length; i++) {
        queues += (i ? '/' : '') + this.buffers[i].queue.length;
        try {
          const b = this.buffers[i].sb.buffered;
          let r = '';
          for (let j = 0; j < b.length; j++) {
            r += (j ? ' ' : '') + Math.round(b.start(j)) + '-' + Math.round(b.end(j));
          }
          ranges += (i ? ' | ' : '') + r;
        } catch (e) {}
      }
      let el = 'no-probe';
      if (this.findMedia) {
        try { el = this.findMedia() ? 'yes' : 'no'; } catch (e) { el = 'err'; }
      }
      let sub = 'none';
      try {
        const st = this.synthTrackEl && this.synthTrackEl.track;
        if (st) {
          sub = 'mode=' + st.mode +
                ' ready=' + this.synthTrackEl.readyState +
                ' cues=' + (st.cues ? st.cues.length : '?') +
                ' active=' + (st.activeCues ? st.activeCues.length : '?');
        }
      } catch (e) { sub = 'err'; }
      this.log('hlsengine: t=' + Math.round(this.getTime() || 0) +
               ' window=[' + Math.round(this.windowLo) + ',' + Math.round(this.windowHi) +
               '] seg=' + (this.mediaSequence + this.segIndex) + ' q=' + queues +
               ' buf=' + ranges + ' el=' + el + ' sub[' + sub + ']');
    }
    this.nudgeIfStalled_();
    if (this.segIndex >= this.segments.length) {
      if (this.ended) { this.finish_(); return; }
      await this.sleep_(3000);
      try { await this.refreshPlaylist_(); } catch (e) {}
      continue;
    }
    const declaredStart = (this.mediaSequence + this.segIndex) * 10;
    const now = this.getTime() || 0;
    // A sender seek moves the element outside what this generation has
    // APPENDED — follow it. Judged against the appended window, never the
    // fetch head: read-ahead is normal, not a seek.
    if (now > 1 && (now < this.windowLo - 10 || now > this.windowHi + 40) &&
        Date.now() - this.lastReposition > 8000) {
      this.reposition(now);
      return;
    }
    // Backpressure: a minute ahead is plenty, and stays under quota.
    if (declaredStart - now > 60) { await this.sleep_(1000); continue; }
    const seg = this.segments[this.segIndex];
    let bytes;
    try {
      bytes = await this.bytes_(new URL(seg.uri, this.playlistUrl).href);
    } catch (e) {
      await this.sleep_(1500);   // still converting — a 404 now is a hit later
      continue;
    }
    if (gen !== this.generation || this.dead) return;
    // Anchor once per run: the run's first segment fixes the offset, and the
    // contiguous source keeps every later boundary seamless.
    if (!this.runAnchored) {
      const raw = this.sidxStart_(bytes);
      if (raw != null) {
        this.currentOffset = declaredStart - raw;
        this.runAnchored = true;
        this.log('hlsengine: run anchor raw=' + raw.toFixed(2) +
                 ' declared=' + declaredStart +
                 ' offset=' + this.currentOffset.toFixed(2));
      }
    }
    bytes.fileStart = this.nextFileStart;
    try { this.nextFileStart = this.mp4box.appendBuffer(bytes); }
    catch (e) { this.fatal_('demux: ' + e); return; }
    this.windowHi = declaredStart + (seg.duration || 10);
    this.segIndex++;
    // Keep quota pressure off before it bites: every few segments, drop what
    // playback has left well behind (opportunistic - skipped while updating).
    if (++this.appendsSinceEvict >= 6) {
      this.appendsSinceEvict = 0;
      const behind = (this.getTime() || 0) - 40;
      if (behind > this.windowLo) {
        this.windowLo = behind;
        for (let i = 0; i < this.buffers.length; i++) {
          const sb = this.buffers[i].sb;
          if (!sb.updating) { try { sb.remove(0, behind); } catch (e) {} }
        }
      }
    }
  }
};

// The safety net for any gap that still slips through (a seek junction
// between two runs, an eviction edge): when the element sits just before a
// buffered range for several ticks, hop over the hole. Needs the element —
// only possible where the page can see it (findMedia); logged either way.
HlsFmp4Engine.prototype.nudgeIfStalled_ = function () {
  if (!this.findMedia || Date.now() - this.lastNudge < 5000) return;
  let el = null;
  try { el = this.findMedia(); } catch (e) {}
  if (!el || el.paused || el.readyState >= 3) return;
  const t = el.currentTime || 0;
  let jumpTo = null;
  try {
    const b = el.buffered;
    for (let j = 0; j < b.length; j++) {
      if (b.start(j) > t && b.start(j) - t < 3 && b.end(j) - b.start(j) > 1) {
        jumpTo = b.start(j) + 0.1;
        break;
      }
    }
  } catch (e) {}
  if (jumpTo == null) return;
  this.lastNudge = Date.now();
  this.log('hlsengine: gap at ' + t.toFixed(2) + ', hopping to ' + jumpTo.toFixed(2));
  try { el.currentTime = jumpTo; } catch (e) {}
};

HlsFmp4Engine.prototype.finish_ = function () {
  const self = this;
  const wait = function () {
    if (self.dead) return;
    for (let i = 0; i < self.buffers.length; i++) {
      if (self.buffers[i].queue.length || self.buffers[i].sb.updating) {
        setTimeout(wait, 250);
        return;
      }
    }
    try { self.mp4box.flush(); } catch (e) {}
    try { self.mediaSource.endOfStream(); } catch (e) {}
  };
  wait();
};

HlsFmp4Engine.prototype.reposition = function (time) {
  if (this.dead) return;
  // A seek INTO what is already appended needs no demuxer reset - the data is
  // there and resetting is itself a stall. Only leave the window for real.
  if (time >= this.windowLo - 5 && time <= this.windowHi + 5) {
    this.lastReposition = Date.now();
    return;
  }
  this.lastReposition = Date.now();
  const sn = Math.max(this.mediaSequence, Math.floor(Math.max(0, time) / 10));
  this.segIndex = Math.min(
    Math.max(0, sn - this.mediaSequence),
    Math.max(0, this.segments.length - 1));
  this.log('hlsengine: reposition ' + Math.round(time) + 's -> segment ' + sn);
  this.windowLo = sn * 10;
  this.windowHi = this.windowLo;
  this.runAnchored = false;
  for (let i = 0; i < this.buffers.length; i++) this.buffers[i].queue = [];
  try { this.mp4box.stop(); } catch (e) {}
  this.setupMp4box_();
  this.pump_();
};
