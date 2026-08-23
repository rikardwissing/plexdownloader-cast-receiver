'use strict';
// Fmp4SplitTransmuxer — the piece Shaka is missing for muxed fMP4.
//
// Shaka's muxed-HLS design (proven by its TS path): both synthetic streams
// point at the SAME segments, and each buffer's TRANSMUXER extracts its own
// track. For MPEG-TS Shaka ships extractors; for muxed fMP4 it ships none, so
// the muxed bytes hit single-codec SourceBuffers raw and this platform's
// strict demuxer refuses them (measured: 3014/3016). This plugin registers
// through the OFFICIAL TransmuxerEngine API and does the missing extraction
// with mp4box (already aboard): fed the muxed init + segments, it returns the
// single wanted track per contentType. With it, Shaka handles the whole
// muxed-Dolby stream natively — timeline, buffering, seeks, and the subtitle
// rendition through CAF's own renderer.
//
// Routed only where needed: the sender's Dolby stream loads set
// mediaSource.forceTransmux, which consults transmuxers even for
// MSE-supported types (the avc1-only video stream is supported, but its
// muxed payload still needs the split). Other loads never set the flag, so
// packages and AAC streams are untouched.

(function () {
  function log(msg) {
    try {
      if (window.__fmp4SplitLog) window.__fmp4SplitLog(msg);
    } catch (e) {}
  }

  const VIDEO_CODEC = /^(avc1|avc3|hvc1|hev1|vp9|av01)/i;
  const DOLBY_CODEC = /^(ec-3|ac-3)/i;

  function codecList(mimeType) {
    const m = /codecs="([^"]*)"/i.exec(String(mimeType || ''));
    if (!m) return [];
    return m[1].split(',').map(function (c) { return c.trim(); }).filter(Boolean);
  }

  class Fmp4SplitTransmuxer {
    constructor(mimeType) {
      this.originalMimeType_ = mimeType;
      this.box_ = null;
      this.initBytes_ = null;     // the muxed init, cached for resets
      this.nextFileStart_ = 0;
      this.pending_ = [];         // wanted-track fragments since last transmux
      this.trackInit_ = null;     // the wanted track's generated init segment
      this.initReady_ = null;     // promise resolving when trackInit_ exists
      this.lastEnd_ = null;       // last media reference's endTime, for resets
      this.contentType_ = null;
    }

    destroy() {
      this.box_ = null;
      this.pending_ = [];
      this.initBytes_ = null;
      this.trackInit_ = null;
    }

    isSupported(mimeType, contentType) {
      const mt = String(mimeType || '').toLowerCase();
      let answer = false;
      if (mt.indexOf('mp4') >= 0 &&
          typeof MP4Box !== 'undefined' && window.MediaSource) {
        const codecs = codecList(mt);
        const hasVideo = codecs.some(function (c) { return VIDEO_CODEC.test(c); });
        const hasDolby = codecs.some(function (c) { return DOLBY_CODEC.test(c); });
        // Claim the audio side of a muxed variant (a Dolby codec riding any
        // mp4 mimetype) AND the lone-video side (its muxed payload needs the
        // split; the isTypeSupported gate is what sent it here). contentType
        // is UNDEFINED in most call sites (measured — mse.js passes one arg),
        // so it cannot gate anything.
        answer = codecs.length > 0 && (hasDolby || hasVideo);
      }
      log('fmp4split: isSupported(' + mimeType + ', ' + contentType + ') = ' + answer);
      return answer;
    }

    convertCodecs(contentType, mimeType) {
      log('fmp4split: convertCodecs(' + contentType + ', ' + mimeType + ')');
      const codecs = codecList(mimeType);
      let picked = null;
      for (let i = 0; i < codecs.length; i++) {
        const isVideo = VIDEO_CODEC.test(codecs[i]);
        if ((contentType === 'video') === isVideo) { picked = codecs[i]; break; }
      }
      if (!picked) picked = codecs[0] || '';
      // Strip the routing marker the manifest wears (see receiver.js): its
      // whole job was to walk this stream into the transmuxer path — the
      // real codec is what the SourceBuffer must hear.
      picked = picked.replace(/\.pdl$/i, '');
      return contentType + '/mp4; codecs="' + picked + '"';
    }

    getOriginalMimeType() {
      return this.originalMimeType_;
    }

    // (Re)create the demux context and feed the cached init. mp4box only
    // consumes a contiguous byte stream, so every discontinuity is a reset.
    setupBox_(contentType) {
      const self = this;
      const box = MP4Box.createFile();
      this.box_ = box;
      this.nextFileStart_ = 0;
      this.trackInit_ = null;
      this.initReady_ = new Promise(function (resolve, reject) {
        box.onError = function (e) { reject(new Error('mp4box: ' + e)); };
        box.onReady = function (info) {
          try {
            for (let i = 0; i < info.tracks.length; i++) {
              const t = info.tracks[i];
              const isVideo = !!t.video;
              const keep = (contentType === 'video') === isVideo;
              // Segment BOTH tracks so mp4box releases every sample (only
              // segmenting one leaks the other's samples); discard the
              // unwanted output in onSegment.
              box.setSegmentOptions(t.id, { keep: keep }, { nbSamples: 50 });
            }
            const inits = box.initializeSegmentation();
            for (let i = 0; i < inits.length; i++) {
              if (inits[i].user && inits[i].user.keep) {
                self.trackInit_ = new Uint8Array(inits[i].buffer);
              }
            }
            box.start();
            if (self.trackInit_) resolve(self.trackInit_);
            else reject(new Error('no ' + contentType + ' track in init'));
          } catch (e) { reject(e); }
        };
      });
      box.onSegment = function (id, user, buffer) {
        if (user && user.keep) self.pending_.push(new Uint8Array(buffer));
      };
      const init = this.initBytes_.slice(0);
      init.fileStart = 0;
      this.nextFileStart_ = box.appendBuffer(init);
    }

    async transmux(data, stream, reference, duration, contentType) {
      if (reference == null || !this.loggedMedia_) {
        this.loggedMedia_ = reference != null;
        log('fmp4split: transmux ' + contentType +
            (reference == null ? ' INIT' : ' first media') +
            ' (' + (data.byteLength || 0) + 'b)');
      }
      this.contentType_ = contentType;
      let bytes = data instanceof ArrayBuffer
        ? data
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      if (reference == null) {
        // The muxed init segment: build a fresh demux context around it and
        // answer with the wanted track's own init.
        this.initBytes_ = bytes;
        this.setupBox_(contentType);
        const trackInit = await this.initReady_;
        log('fmp4split: ' + contentType + ' init ready (' + trackInit.byteLength + 'b)');
        return trackInit;
      }
      if (!this.box_) {
        if (!this.initBytes_) throw new Error('media before init');
        this.setupBox_(contentType);
        await this.initReady_;
      }
      // A seek lands segments discontinuous with the last append — reset the
      // demux context (Shaka re-appends the init around seeks, but not always
      // before the first jumped segment).
      if (this.lastEnd_ != null && reference.startTime != null &&
          Math.abs(reference.startTime - this.lastEnd_) > 0.75) {
        this.pending_ = [];
        this.setupBox_(contentType);
        await this.initReady_;
      }
      this.lastEnd_ = reference.endTime != null ? reference.endTime : null;
      bytes = bytes.slice(0);
      bytes.fileStart = this.nextFileStart_;
      this.nextFileStart_ = this.box_.appendBuffer(bytes);
      // Everything the demuxer emitted for our track so far; leftovers of a
      // partial fragment roll into the next call in order.
      const parts = this.pending_;
      this.pending_ = [];
      let total = 0;
      for (let i = 0; i < parts.length; i++) total += parts[i].byteLength;
      const out = new Uint8Array(total);
      let off = 0;
      for (let i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].byteLength; }
      return out;
    }
  }

  let registered = false;
  function register() {
    if (registered) return true;
    if (!window.shaka || !shaka.transmuxer || !shaka.transmuxer.TransmuxerEngine) {
      return false;
    }
    const engine = shaka.transmuxer.TransmuxerEngine;
    const priority = engine.PluginPriority.APPLICATION;
    engine.registerTransmuxer('video/mp4',
      function () { return new Fmp4SplitTransmuxer('video/mp4'); }, priority);
    engine.registerTransmuxer('audio/mp4',
      function () { return new Fmp4SplitTransmuxer('audio/mp4'); }, priority);
    registered = true;
    log('fmp4split: registered with shaka ' +
        (shaka.Player && shaka.Player.version ? shaka.Player.version : '?'));
    return true;
  }

  // CAF loads Shaka lazily at the first HLS load; register the moment the
  // global appears, and let the page nudge again at every LOAD.
  window.__fmp4SplitRegister = register;
  const poll = setInterval(function () {
    if (register()) clearInterval(poll);
  }, 100);
})();
