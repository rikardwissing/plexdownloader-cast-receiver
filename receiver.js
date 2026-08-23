// Portage custom receiver.
//
// STOCK CAF playback UI (native controls — touch, remotes, and the default
// overlays all behave like any Cast app), with the app's branding on the
// idle and loading screens, plus:
//  - a diagnostics channel: the sender can ask what THIS device's MSE
//    actually decodes (the per-device answer to every "does it support X?"
//    question);
//  - the MSE engine: progressive MP4s flagged by the sender are demuxed
//    in-browser (mp4box.js) and fed to MediaSource per-track — audio
//    switches without the video reloading.
//
// ?preview=idle|loading renders those screens in a normal browser.
'use strict';

const NS = 'urn:x-cast:dev.rikard.portage';
const PREVIEW = new URLSearchParams(location.search).get('preview');

let context = null;
let playerManager = null;
if (!PREVIEW) {
  context = cast.framework.CastReceiverContext.getInstance();
  playerManager = context.getPlayerManager();
}

// ---------------------------------------------------------------- diagnostics

function mseSupport(type) {
  try { return !!window.MediaSource && MediaSource.isTypeSupported(type); }
  catch (e) { return false; }
}

// CAF's platform-aware capability check, beside the raw-MSE one above. It
// consults the actual device pipeline and the HDMI sink, and CAF's engines
// route their decisions through it - so a Google TV that decodes Dolby
// natively (proven: direct MP4+E-AC-3 plays with Atmos) can answer yes here
// while vanilla MediaSource.isTypeSupported says no. Whether the two DISAGREE
// on this device is exactly the question "could a Shaka HLS stream play AC-3".
function canDisplay(mime, codec) {
  try { return !!context.canDisplayType(mime, codec); } catch (e) { return false; }
}

// Whether addSourceBuffer ACCEPTS the muxed Dolby type that isTypeSupported
// and canDisplayType both refuse (measured). The two layers can disagree, and
// which one is telling the truth decides whether a capability shim can walk
// the muxed variant past Shaka's filter - or whether the only road is
// demuxing into the two-buffer topology this platform provably accepts.
// addSourceBuffer needs an OPEN MediaSource, so the probe is async; the pong
// reports 'pending' until it lands (milliseconds after page load).
let sbMuxedEC3 = 'pending';
(function probeAddSourceBuffer() {
  try {
    const ms = new MediaSource();
    const probeVideo = document.createElement('video');
    ms.addEventListener('sourceopen', () => {
      try {
        ms.addSourceBuffer('video/mp4; codecs="avc1.42E01E,ec-3"');
        sbMuxedEC3 = true;
      } catch (e) { sbMuxedEC3 = String((e && e.name) || e); }
      try { URL.revokeObjectURL(probeVideo.src); } catch (e) {}
    });
    probeVideo.src = URL.createObjectURL(ms);
  } catch (e) { sbMuxedEC3 = 'setup failed: ' + e; }
})();

function capabilities() {
  return {
    mse: !!window.MediaSource,
    mp4box: typeof MP4Box !== 'undefined',
    videoH264: mseSupport('video/mp4; codecs="avc1.640028"'),
    videoHEVC: mseSupport('video/mp4; codecs="hvc1.2.4.L120.90"'),
    audioAAC: mseSupport('audio/mp4; codecs="mp4a.40.2"'),
    audioAC3: mseSupport('audio/mp4; codecs="ac-3"'),
    audioEC3: mseSupport('audio/mp4; codecs="ec-3"'),
    canDisplayAC3: canDisplay('audio/mp4', 'ac-3'),
    canDisplayEC3: canDisplay('audio/mp4', 'ec-3'),
    canDisplayHEVC: canDisplay('video/mp4', 'hvc1.2.4.L120.90'),
    // The COMBINED muxed-variant question, which the separate answers above
    // cannot settle: an HLS stream is one muxed variant, so Shaka's support
    // filter asks about video/mp4 with BOTH codecs at once - and a platform
    // can accept ec-3 alone yet refuse it inside a combined video query
    // (suspected cause of Shaka 4032 with an honest CODECS attribute).
    muxedH264EC3: mseSupport('video/mp4; codecs="avc1.42E01E,ec-3"'),
    muxedH264AC3: mseSupport('video/mp4; codecs="avc1.42E01E,ac-3"'),
    canDisplayMuxedH264EC3: canDisplay('video/mp4', 'avc1.42E01E,ec-3'),
    sbMuxedH264EC3: sbMuxedEC3,
    // Beyond AAC and Dolby: the sender used to demand EVERY audio track be AAC
    // before it would enable the engine, so a file carrying one FLAC track lost
    // track switching entirely — for nothing, since FLAC has no passthrough to
    // protect. It asks per codec now, and these are the answers it needs.
    audioFLAC: mseSupport('audio/mp4; codecs="flac"'),
    audioOpus: mseSupport('audio/mp4; codecs="opus"'),
    // Can this device switch MUXED audio natively, with no engine at all?
    // If it can, the whole MseEngine here is unnecessary: its only reason to
    // exist is audio switching on multi-audio direct MP4s (the sender gates it
    // on audioTracks.count >= 2 and nothing else), and a one-line
    // `audioTracks[i].enabled = true` would replace ~410 lines of demuxing on
    // the weakest device we cast to.
    // Chrome has never shipped AudioTrackList by default, and this box reports
    // Chrome 92 — so the honest expectation is false. Measured beats expected:
    // it rides the pong into the sender's diagnostics log either way.
    audioTracks: !!document.createElement('video').audioTracks,
    userAgent: navigator.userAgent,
  };
}

// Receiver-side logging lands in the sender's diagnostics file (CASTLOG
// receiver message) — the only eyes we have on this code in the field.
function slog(msg) {
  if (PREVIEW) { console.log(msg); return; }
  try { context.sendCustomMessage(NS, undefined, { type: 'log', msg: String(msg) }); }
  catch (e) { /* no sender connected */ }
}

// ------------------------------------------------------------ brand screens
// Idle and loading only — playback is entirely the stock player's.

const Screens = {
  els: {},
  errorTimer: null,
  boot() {
    this.els = {
      idle: document.querySelector('#idle'),
      loading: document.querySelector('#loading'),
      poster: document.querySelector('#loading .poster'),
      title: document.querySelector('#loading .title'),
      error: document.querySelector('#error'),
      errorHeadline: document.querySelector('#error .headline'),
      errorDetail: document.querySelector('#error .detail'),
    };
  },
  show(name) {
    clearTimeout(this.errorTimer);
    this.els.idle.style.display = name === 'idle' ? 'flex' : 'none';
    this.els.loading.style.display = name === 'loading' ? 'flex' : 'none';
    this.els.error.style.display = name === 'error' ? 'flex' : 'none';
  },
  // The failure screen names the likely cause, then falls back to idle —
  // unless a recovery load (the sender's convert-and-cast flow) replaces it
  // first via the LOAD interceptor.
  error(headline, detail) {
    this.els.errorHeadline.textContent = headline;
    this.els.errorDetail.textContent = detail || '';
    this.show('error');
    this.errorTimer = setTimeout(() => this.show('idle'), 12000);
  },
  loading(title, posterUrl) {
    this.els.title.textContent = title || '';
    if (posterUrl) {
      this.els.poster.src = posterUrl;
      this.els.poster.classList.remove('empty');
    } else {
      this.els.poster.removeAttribute('src');
      this.els.poster.classList.add('empty');
    }
    this.show('loading');
  },
};

document.addEventListener('DOMContentLoaded', () => {
  Screens.boot();
  Screens.show('idle');
  if (PREVIEW === 'loading') {
    Screens.loading('Bluey — S03E01 — Perfect',
                    'https://placehold.co/400x400/0b0d22/19d8e6?text=B');
  } else if (PREVIEW === 'error') {
    Screens.error("Can't play this video",
                  "This device can't decode the video or audio format.");
  }
});

// What to tell the room, per DetailedErrorCode family. 1xx are the media
// element's own failures (decode/format), 3xx segment/network, 4xx manifest.
function errorMessage(code) {
  if (code === 102 || code === 104 || code === 110) {
    return "This device can't decode the video or audio format.";
  }
  if (code === 103 || (code >= 300 && code < 400)) {
    return 'The stream could not be fetched from the sender.';
  }
  if (code >= 400 && code < 500) {
    return "The stream's playlist could not be read.";
  }
  return 'Something went wrong during playback.';
}

// ---------------------------------------------------------------- MSE engine
//
// The engine is tv-mse.js, shared verbatim with the WebRTC and LAN receivers.
// There used to be a second implementation here — ~410 lines, its own bugs, its
// own fixes — and keeping two meant every engine improvement had to be reasoned
// about twice and usually reached only one of them. It is also LIGHTER on this
// device: it extracts video plus the SELECTED audio track, where the old one
// fragmented all of them up front (eight tracks on a 7-audio file) to make an
// in-place switch possible.
//
// The trade that buys: switching audio reloads at the live position instead of
// refilling in place. The in-place refill was tried on the shared engine and
// abandoned, and on this hardware its advantage was theoretical anyway — a
// field log showed an in-place switch followed by ~75 s of buffering and then a
// full reload regardless.
//
// tv-mse.js wants three things from its host, so give them to it before any
// engine exists: somewhere to trace, a codec/error surface, and a media element.
// It asks remarkably little of that element — currentTime and error — because
// every buffered range it reasons about comes from the SourceBuffers, so
// playerManager stands in for it faithfully.
window.tvReport = slog;
window.tvHelpers = {
  canPlay: (kind, codec) => mseSupport(kind + '/mp4; codecs="' + codec + '"'),
  codecName: (c) => String(c || ''),
  playbackError: (msg) => Screens.error("Can't play this video", msg),
  // Survivable trouble. NOT Screens.error, which replaces playback with an error
  // card: the point is that the viewer keeps watching and can still pick a track
  // that works. It rides slog into the sender's diagnostics instead.
  playbackNotice: (msg) => slog('notice: ' + msg),
};
window.tvSetMediaElement({
  get currentTime() { return playerManager.getCurrentTimeSec() || 0; },
  error: null,
});

let engine = null;
// The load as the SENDER sent it — the interceptor rewrites contentUrl to a blob,
// so the original has to be kept to re-issue it.
let lastLoad = null;

function teardownEngine() {
  if (engine) { try { engine.destroy(); } catch (e) {} engine = null; }
}

// Re-issue the current media at the live position. Used for an audio switch
// (the shared engine reloads rather than refilling in place) and as the escape
// hatch when the engine fails — dropping `mseEngine` falls back to CAF's own
// pipeline instead of leaving a dead screen, which the old engine had no answer
// for.
function reissue({ audioTypeIndex, withEngine = true }) {
  if (!lastLoad) return;
  const at = playerManager.getCurrentTimeSec() || 0;
  const custom = Object.assign({}, lastLoad.custom);
  if (typeof audioTypeIndex === 'number') custom.audioTypeIndex = audioTypeIndex;
  if (!withEngine) delete custom.mseEngine;
  const media = Object.assign({}, lastLoad.media, {
    contentUrl: lastLoad.url, contentId: lastLoad.url, customData: custom,
  });
  const request = new cast.framework.messages.LoadRequestData();
  request.media = media;
  request.currentTime = at;
  slog('reissue at ' + Math.round(at) + 's audio#' +
       (custom.audioTypeIndex || 0) + (withEngine ? '' : ' (no engine)'));
  playerManager.load(request);
}

// ---------------------------------------------------------------- CAF wiring

if (!PREVIEW) {
  const messages = cast.framework.messages;
  const events = cast.framework.events;

  // Diagnostic eyes for the silent-load mystery: between LOAD and the first
  // PLAYING, report every CORE and DEBUG player event (deduped, capped) into
  // the sender's diagnostics. MPL - CAF's default HLS stack - failed a Dolby
  // stream with no ERROR on our listeners; this is how we learn what, if
  // anything, it says instead.
  const loadEyes = { active: false, count: 0, last: '' };
  function slogEvent(e) {
    if (!loadEyes.active || loadEyes.count >= 40) return;
    let line = 'ev ' + (e && e.type);
    try {
      if (e && e.detailedErrorCode != null) line += ' code=' + e.detailedErrorCode;
      if (e && e.error) line += ' err=' + JSON.stringify(e.error).slice(0, 140);
      if (e && e.mediaStatus && e.mediaStatus.playerState) {
        line += ' state=' + e.mediaStatus.playerState;
        if (e.mediaStatus.idleReason) line += ' idle=' + e.mediaStatus.idleReason;
      }
      if (e && e.reason) line += ' reason=' + e.reason;
    } catch (err) {}
    if (line === loadEyes.last) return;
    loadEyes.last = line;
    loadEyes.count++;
    slog(line);
  }
  playerManager.addEventListener(events.category.CORE, slogEvent);
  playerManager.addEventListener(events.category.DEBUG, slogEvent);
  playerManager.addEventListener(events.EventType.PLAYING, () => {
    loadEyes.active = false;
    if (window.__sbRelabels && window.__sbRelabels.length) {
      slog('sb relabels: ' + window.__sbRelabels.join(' | '));
      window.__sbRelabels = [];
    }
  });

  // A load that never finishes gets a verdict, not an eternal spinner. CAF
  // errors loudly on a package it can't play (Shaka gates the manifest), but a
  // default HLS load whose audio can't open — field case: an original-quality
  // stream carrying AC-3, which no Cast receiver plays in HLS — just sits in
  // "loading" forever with no ERROR event. The budget is generous because a
  // still-converting server can honestly take a while to produce first bytes.
  let loadWatch = null;
  function clearLoadWatch() { if (loadWatch) { clearTimeout(loadWatch); loadWatch = null; } }
  function armLoadWatch() {
    clearLoadWatch();
    loadWatch = setTimeout(() => {
      loadWatch = null;
      let state = 'unknown';
      try { state = playerManager.getPlayerState(); } catch (e) {}
      if (state === messages.PlayerState.PLAYING ||
          state === messages.PlayerState.PAUSED) return;
      slog('load watchdog: still ' + state + ' after 45s - giving up');
      Screens.error("Can't play this video",
        'The stream never started. Its audio or video is likely a format ' +
        'this TV can\'t play in a stream - Dolby audio only plays from a ' +
        'direct file.');
      try { playerManager.stop(); } catch (e) {}
    }, 45000);
  }

  // LOAD: brand loading screen while the stream spins up, and route flagged
  // media through the MSE engine — CAF just sees a blob URL and drives
  // play/pause/time as usual. Everything else (packages, Dolby direct files)
  // keeps default playback.
  playerManager.setMessageInterceptor(messages.MessageType.LOAD, (request) => {
    teardownEngine();
    const media = request.media || {};
    const custom = media.customData || {};
    // A Plex HLS stream's segments are fMP4 (measured: ftyp iso5/dby1 brands,
    // sidx-opening) but NAMED ".ts", and the manifest declares no CODECS - so
    // Shaka guesses MPEG-TS from the extension and pushes fMP4 bytes through
    // the TS transmuxer (Shaka error 3018). Rename the segments in the
    // MANIFEST Shaka reads, and rename them back on each request so Plex
    // (which serves strictly by name - measured 404 on .m4s) still answers.
    // Per-load config: package manifests name their segments honestly and
    // must pass through untouched.
    const playbackConfig = new cast.framework.PlaybackConfig();
    const url = media.contentUrl || media.contentId || '';
    const isUniversal = url.indexOf('/transcode/universal/') >= 0;
    const streamCodecs = (typeof custom.streamCodecs === 'string' && custom.streamCodecs)
      ? custom.streamCodecs : null;
    // A stream session built WITH a subtitle carries it as the manifest's one
    // rendition — but it never surfaces into GCK media status (measured:
    // tracks text=[] on every stream load), so the sender cannot activate it,
    // and CAF never self-activates text. Remember the wish; the LOAD_COMPLETE
    // handler flips it on through CAF's own TextTracksManager.
    wantStreamSubtitle = isUniversal && custom.subtitleActive === true;
    const dolbyStream = isUniversal && streamCodecs &&
      /(^|,)\s*(ec-3|ac-3)\s*($|,)/.test(streamCodecs);
    const container = (typeof custom.streamContainer === 'string')
      ? custom.streamContainer : null;
    if (isUniversal) {
      // ONE path for every stream: Shaka. Dolby streams ride the
      // Fmp4SplitTransmuxer (fmp4-split.js) registered through Shaka's own
      // plugin API — it extracts each track from the muxed segments with
      // mp4box, which is the only demux this platform accepts for Dolby
      // (single-buffer muxed refused at every API layer, measured). Shaka
      // then owns the timeline, buffering, seeks — and the subtitle rendition
      // flows through CAF's native renderer. forceTransmux is what routes
      // even the MSE-supported avc1 video stream through the splitter (its
      // muxed payload needs extraction too); only these loads set it.
      // The rename and CODECS are the same measured requirements as always:
      // Plex names fMP4 ".ts" and declares no codecs.
      const dolby = streamCodecs && /(^|,)\s*(ec-3|ac-3)\s*($|,)/.test(streamCodecs);
      window.__fmp4SplitLog = slog;
      if (window.__fmp4SplitRegister) window.__fmp4SplitRegister();
      // Shaka 4.16 splits muxed content NATIVELY (needSplitMuxedContent_,
      // read from its source): the variant's unsupported combined type
      // recurses into per-codec buffers — but the recursed VIDEO type is
      // MSE-supported on its own, so Shaka appends the muxed bytes raw
      // (measured: audio split by our plugin, video 3014). forceTransmux was
      // set and provably did not land through CAF. The lever we DO control is
      // the CODECS attribute: a ".pdl" marker on the video codec makes
      // isTypeSupported reject it, which walks the video buffer into the
      // transmuxer path naturally; the plugin's convertCodecs strips the
      // marker so the real codec reaches addSourceBuffer.
      let codecsAttr = streamCodecs;
      if (dolby && streamCodecs) {
        codecsAttr = streamCodecs.split(',').map((c) => {
          c = c.trim();
          return /^(avc1|avc3|hvc1|hev1)/i.test(c) ? c + '.pdl' : c;
        }).join(',');
      }
      playbackConfig.manifestHandler = (manifest) => {
        let out = manifest.replace(/^(.+\.ts)(\s*)$/gm, '$1.m4s$2');
        if (codecsAttr && out.indexOf('#EXT-X-STREAM-INF') >= 0 &&
            out.indexOf('CODECS=') < 0) {
          out = out.replace(/^#EXT-X-STREAM-INF:(.*)$/gm,
            '#EXT-X-STREAM-INF:$1,CODECS="' + codecsAttr + '"');
        }
        return out;
      };
      playbackConfig.segmentRequestHandler = (request2) => {
        request2.url = request2.url.replace('.ts.m4s', '.ts');
      };
      if (dolby) {
        playbackConfig.shakaConfig = { mediaSource: { forceTransmux: true } };
      } else if (!streamCodecs) {
        playbackConfig.shakaConfig = { manifest: { hls: { disableCodecGuessing: true } } };
      }
      slog('plex stream load: shaka' + (dolby ? ' + fmp4-split' : '') +
           (codecsAttr ? (', CODECS="' + codecsAttr + '"') : ', codecs from init'));
    }
    playerManager.setPlaybackConfig(playbackConfig);
    const meta = media.metadata || {};
    const poster = (meta.images && meta.images[0] && meta.images[0].url) || null;
    Screens.loading(meta.title || '', poster);
    armLoadWatch();
    loadEyes.active = true; loadEyes.count = 0; loadEyes.last = '';
    if (custom.mseEngine && window.MediaSource && typeof MP4Box !== 'undefined') {
      const url = media.contentUrl || media.contentId;
      lastLoad = { url, media: Object.assign({}, media), custom };
      // null fetcher = plain HTTP Range, which is what this receiver has always
      // used; the WebRTC receiver injects a data-channel source instead.
      engine = new window.MseEngine(url, custom.audioTypeIndex || 0, null);
      engine.onAudioSwitch = (index) => reissue({ audioTypeIndex: index });
      engine.onEngineFailed = (reason) => {
        slog('engine failed, falling back to default playback: ' + reason);
        teardownEngine();
        reissue({ withEngine: false });
      };
      media.contentUrl = engine.objectUrl;
      media.contentId = engine.objectUrl;
      media.contentType = 'video/mp4';
      slog('engine load: ' + url + ' audio#' + (custom.audioTypeIndex || 0));
    }
    return request;
  });

  // STOP: the engine used to survive this and idle on the platform's Dolby
  // decoder until the next LOAD - and a dead receiver instance still holding
  // the decoder is exactly what a freshly launched one trips over (the
  // demux-error-on-immediate-recast pattern). Release at the moment playback
  // actually ends.
  playerManager.setMessageInterceptor(messages.MessageType.STOP, (request) => {
    teardownEngine();
    return request;
  });

  // SEEK: CAF moves the media element; the engine must move the demux too.
  playerManager.setMessageInterceptor(messages.MessageType.SEEK, (request) => {
    if (engine && typeof request.currentTime === 'number') {
      engine.reposition(request.currentTime);
    }
    return request;
  });

  // No teardown on MEDIA_FINISHED: casting into a live session fires the OLD
  // media's finish while the new engine is loading (that killed the first
  // engine cast in the field). The LOAD interceptor is the teardown point.

  let wantStreamSubtitle = false;
  playerManager.addEventListener(events.EventType.PLAYER_LOAD_COMPLETE, () => {
    clearLoadWatch();
    Screens.show('playback');
    if (wantStreamSubtitle) {
      try {
        const ttMgr = playerManager.getTextTracksManager();
        const tracks = ttMgr.getTracks() || [];
        if (tracks.length) {
          ttMgr.setActiveByIds([tracks[0].trackId]);
          slog('stream subtitle activated: track ' + tracks[0].trackId);
        } else {
          slog('stream subtitle wanted but no text tracks visible');
        }
      } catch (e) { slog('stream subtitle activation failed: ' + e); }
    }
  });
  playerManager.addEventListener(events.EventType.MEDIA_FINISHED,
                                 () => Screens.show('idle'));
  playerManager.addEventListener(events.EventType.ERROR, (e) => {
    clearLoadWatch();
    if (window.__sbRelabels && window.__sbRelabels.length) {
      slog('sb relabels before error: ' + window.__sbRelabels.join(' | '));
      window.__sbRelabels = [];
    }
    const code = (e && e.detailedErrorCode) || 0;
    slog('player error: detailedErrorCode=' + code +
         (e && e.error ? ' ' + JSON.stringify(e.error) : ''));
    Screens.error("Can't play this video", errorMessage(code));
  });

  context.addCustomMessageListener(NS, (event) => {
    const msg = event.data || {};
    if (msg.type === 'ping') {
      context.sendCustomMessage(NS, event.senderId,
                                { type: 'pong', capabilities: capabilities() });
    } else if (msg.type === 'setAudioTrack' && engine) {
      engine.setAudioTrack(msg.audioTypeIndex || 0);
    }
  });

  // Shaka for HLS instead of MPL, CAF's legacy default. Measured 2026-08-21
  // on the Google TV: MPL stalled a Dolby fMP4 stream in BUFFERING forever
  // (events stop after DURATION_CHANGE, no error) and 411'd a Dolby package
  // at the master manifest - while BOTH capability APIs (raw MSE and
  // canDisplayType) answered yes to ac-3/ec-3, and the same device plays
  // MP4+E-AC-3 direct files with Atmos. Shaka handles fMP4 HLS properly and
  // consults the platform-aware canDisplayType, so both cases have a real
  // chance of simply playing. Revert this option if package casts regress.
  const startOptions = new cast.framework.CastReceiverOptions();
  startOptions.useShakaForHls = true;
  // The device firmware's CAF defaulted to Shaka 4.9.2-caf2 (seen in error
  // stacks) - years behind the documented 4.15.56 default, and Google's own
  // migration guide says Shaka-for-HLS should pin >=4.15.56. 4.16.45 is the
  // newest 4.x LTS inside the supported range (>=2.5.6 <5.0.0) and carries
  // the mediaCapabilities-based variant filtering that judges a muxed
  // variant's audio and video SEPARATELY - the exact check our muxed Dolby
  // stream failed under 4.9's combined-string logic (Shaka 4032).
  startOptions.shakaVersion = '4.16.45';
  context.start(startOptions);
}
