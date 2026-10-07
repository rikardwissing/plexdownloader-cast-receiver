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
// ?preview=idle|loading|error|upnext renders those screens in a normal browser.
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

function canDisplaySize(codecs, width, height) {
  return codecs.some((codec) => {
    try { return !!context.canDisplayType('video/mp4', codec, width, height); } catch (e) { return false; }
  });
}

const DISPLAY_SIZES = [
  { height: 2160, width: 3840, codecs: ['hvc1.1.6.L150.90', 'avc1.640033'] },
  { height: 1080, width: 1920, codecs: ['avc1.640028', 'hvc1.1.6.L120.90'] },
  { height: 720, width: 1280, codecs: ['avc1.64001F'] },
];

function canDisplayHeight(height) {
  const size = DISPLAY_SIZES.find((s) => s.height === height);
  return canDisplaySize(size.codecs, size.width, size.height);
}

function maxDisplayHeight() {
  const fit = DISPLAY_SIZES.find((s) => canDisplaySize(s.codecs, s.width, s.height));
  return fit ? fit.height : 480;
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
    display720: canDisplayHeight(720),
    display1080: canDisplayHeight(1080),
    display2160: canDisplayHeight(2160),
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

function reportLoadFailed(reason, detail) {
  if (PREVIEW) return;
  const message = Object.assign({ type: 'loadFailed', reason: String(reason) }, detail || {});
  try { context.sendCustomMessage(NS, undefined, message); } catch (e) {}
}

const CODEC_NAMES = { 'ec-3': 'Dolby Digital Plus', 'ac-3': 'Dolby Digital', 'A_DTS': 'DTS',
                      'A_TRUEHD': 'Dolby TrueHD', 'A_EAC3': 'Dolby Digital Plus', 'A_AC3': 'Dolby Digital' };
function codecLabel(codec) {
  const c = String(codec || '');
  if (CODEC_NAMES[c]) return CODEC_NAMES[c];
  if (/^(hvc1|hev1)/.test(c)) return 'HEVC';
  if (/^(avc1|avc3)/.test(c)) return 'H.264';
  if (/^vp09/.test(c)) return 'VP9';
  if (/^av01/.test(c)) return 'AV1';
  return c.replace(/^[AV]_/, '');
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
    const subs = document.getElementById('subs');
    if (subs) subs.style.visibility = name === 'playback' ? '' : 'hidden';
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

const UpNext = {
  show(m) {
    document.getElementById('un-label').textContent = m.label || 'Up next';
    document.getElementById('un-title').textContent = m.title || '';
    const sub = document.getElementById('un-sub');
    sub.textContent = m.subtitle || '';
    sub.style.display = m.subtitle ? '' : 'none';
    const img = document.getElementById('un-img');
    if (m.art) img.src = m.art; else img.removeAttribute('src');
    img.parentNode.className = m.art ? 'un-art' : 'un-art noart';
    document.getElementById('upnext').classList.add('show');
    this.ring(m.endsIn, m.total);
  },
  ring(endsIn, total) {
    const ring = document.getElementById('un-ring');
    if (endsIn == null || !total) { ring.style.display = 'none'; return; }
    ring.style.display = '';
    const length = ring.getTotalLength();
    ring.style.transition = 'none';
    ring.style.strokeDasharray = length + ' ' + length;
    ring.style.strokeDashoffset = String(length * Math.max(0, Math.min(1, endsIn / total)));
    ring.getBoundingClientRect();
    ring.style.transition = 'stroke-dashoffset ' + endsIn + 's linear';
    ring.style.strokeDashoffset = '0';
  },
  hide() {
    const box = document.getElementById('upnext');
    if (box) box.classList.remove('show');
  },
};

function broadcast(msg) {
  if (PREVIEW) return;
  try { context.sendCustomMessage(NS, undefined, msg); } catch (e) {}
}

function fillTemplate(text, values) {
  return String(text).replace(/\{(state|ms|ticks|paused)\}/g, (_, key) => String(values[key]));
}

function fireRequest(request, values, what) {
  if (!request || !request.url) return;
  const init = { method: request.method || 'GET', credentials: 'omit', keepalive: true };
  if (request.body) {
    init.body = fillTemplate(request.body, values);
    init.headers = { 'Content-Type': 'application/json' };
  }
  fetch(fillTemplate(request.url, values), init)
    .then((r) => { if (!r.ok) slog('report ' + what + ' answered ' + r.status); })
    .catch((e) => slog('report ' + what + ' failed: ' + e));
}

const Report = {
  info: null,
  position: 0,
  state: null,
  sentAt: 0,
  timer: null,
  begin(info) {
    if (info && this.info && info.key === this.info.key) return;
    this.end();
    if (!info) return;
    this.info = info;
    this.position = 0;
    this.state = null;
    this.sentAt = 0;
    this.timer = setInterval(() => this.tick(), 1000);
  },
  tick() {
    if (!this.info || PREVIEW) return;
    let state = null;
    try { state = playerManager.getPlayerState(); } catch (e) {}
    const states = cast.framework.messages.PlayerState;
    if (state !== states.PLAYING && state !== states.PAUSED) return;
    this.position = playerManager.getCurrentTimeSec() || this.position;
    const next = state === states.PLAYING ? 'playing' : 'paused';
    if (next !== this.state || Date.now() - this.sentAt >= 10000) this.send(next);
  },
  values(state) {
    const ms = Math.max(0, Math.round(this.position * 1000));
    return { state, ms, ticks: ms * 10000, paused: state === 'paused' };
  },
  send(state) {
    if (!this.info) return;
    this.state = state;
    this.sentAt = Date.now();
    fireRequest(this.info.progress, this.values(state), state);
  },
  end() {
    const info = this.info;
    if (!info) return;
    clearInterval(this.timer);
    this.timer = null;
    this.info = null;
    const values = this.values('stopped');
    fireRequest(info.stopped || info.progress, values, 'stopped');
    const watched = info.durationMs > 0 && values.ms >= info.durationMs * 0.9;
    if (watched) fireRequest(info.watched, values, 'watched');
    fireRequest(info.stop, values, 'session stop');
    slog('report end ' + info.key + ' at ' + Math.round(values.ms / 1000) + 's' + (watched ? ' (watched)' : ''));
  },
};

const Playing = { contentId: null, title: null };

const Queue = {
  items: [],
  countdownSeconds: 10,
  countdown: null,
  advancing: null,
  asking: null,
  get active() { return this.items.length > 0 || !!this.countdown || !!this.asking; },
  set(msg) {
    this.items = Array.isArray(msg.items) ? msg.items : [];
    if (typeof msg.countdown === 'number') this.countdownSeconds = msg.countdown;
    if (msg.current && msg.current.report) Report.begin(msg.current.report);
    slog('queue: ' + this.items.length + ' ahead');
  },
  clear() {
    this.items = [];
    this.advancing = null;
    this.asking = null;
    if (this.countdown) { clearTimeout(this.countdown); this.countdown = null; }
  },
  ended() {
    Report.end();
    const next = this.items[0];
    if (!next) return false;
    if (next.autoplay === false) {
      this.load(this.items.shift());
      return true;
    }
    const card = next.card || {};
    UpNext.show({ label: card.label, title: card.title, subtitle: card.subtitle, art: card.art,
                  endsIn: this.countdownSeconds, total: this.countdownSeconds });
    this.countdown = setTimeout(() => {
      this.countdown = null;
      const item = this.items.shift();
      if (item) this.load(item);
    }, this.countdownSeconds * 1000);
    return true;
  },
  load(item) {
    this.advancing = item.key;
    this.asking = item.autoplay === false ? (item.card || {}) : null;
    const request = new cast.framework.messages.LoadRequestData();
    request.media = item.media;
    request.autoplay = item.autoplay !== false;
    request.currentTime = item.startAt || 0;
    slog('queue advance: ' + item.key + (this.asking ? ' (asks first)' : ''));
    broadcast({ type: 'queueAdvanced', key: item.key, asks: !!this.asking });
    playerManager.load(request);
  },
  loaded() {
    if (!this.asking) return;
    UpNext.show({ label: 'Still watching?', title: this.asking.title,
                  subtitle: this.asking.subtitle, art: this.asking.art });
  },
  playing() {
    if (!this.asking) return;
    this.asking = null;
    UpNext.hide();
    broadcast({ type: 'stillWatchingAnswered' });
  },
};

function vttSeconds(stamp) {
  const parts = stamp.replace(',', '.').split(':').map(Number);
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}

function parseVtt(text) {
  const cues = [];
  for (const block of String(text).replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((line) => line.indexOf('-->') >= 0);
    if (at < 0) continue;
    const m = lines[at].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    if (!m) continue;
    const body = Subs.clean(lines.slice(at + 1).join('\n'));
    if (body) cues.push({ s: vttSeconds(m[1]), e: vttSeconds(m[2]), text: body });
  }
  return cues;
}

const Subs = {
  key: null,
  tracks: {},
  engineToType: {},
  active: -1,
  shown: '',
  timer: null,
  load(url, custom) {
    if (url !== this.key) { this.key = url; this.tracks = {}; }
    this.engineToType = {};
    const list = Array.isArray(custom.subtitles) ? custom.subtitles : [];
    for (const sub of list) {
      const track = this.tracks[sub.typeIndex] ||
        (this.tracks[sub.typeIndex] = { cues: [], seen: {}, url: null, fetched: false });
      if (typeof sub.engineIndex === 'number') this.engineToType[sub.engineIndex] = sub.typeIndex;
      if (sub.url) track.url = sub.url;
    }
    this.select(typeof custom.subtitleTypeIndex === 'number' ? custom.subtitleTypeIndex : -1);
  },
  clear() {
    this.key = null;
    this.tracks = {};
    this.engineToType = {};
    this.select(-1);
  },
  engineCue(engineIndex, startMs, endMs, text) {
    const track = this.tracks[this.engineToType[engineIndex]];
    if (!track) return;
    const seenKey = Math.round(startMs) + '|' + text;
    if (track.seen[seenKey]) return;
    track.seen[seenKey] = 1;
    const body = this.clean(text);
    if (body) track.cues.push({ s: startMs / 1000, e: endMs / 1000, text: body });
  },
  select(typeIndex) {
    this.active = typeIndex;
    if (lastLoad && lastLoad.url === this.key && lastLoad.custom) lastLoad.custom.subtitleTypeIndex = typeIndex;
    const track = this.tracks[typeIndex];
    if (track && track.url && !track.fetched) {
      track.fetched = true;
      fetch(track.url)
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then((vtt) => {
          track.cues = track.cues.concat(parseVtt(vtt));
          slog('subtitles: ' + track.cues.length + ' cues from sidecar #' + typeIndex);
        })
        .catch((e) => { track.fetched = false; slog('subtitle sidecar #' + typeIndex + ' failed: ' + e); });
    }
    clearInterval(this.timer);
    this.timer = null;
    if (typeIndex >= 0 && playerManager) this.timer = setInterval(() => this.tick(), 200);
    this.paint('');
  },
  tick() {
    const track = this.tracks[this.active];
    if (!track) { this.paint(''); return; }
    const now = playerManager.getCurrentTimeSec() || 0;
    const lines = [];
    for (const cue of track.cues) if (cue.s <= now && now < cue.e) lines.push(cue.text);
    this.paint(lines.join('\n'));
  },
  paint(text) {
    if (text === this.shown) return;
    this.shown = text;
    const box = document.getElementById('subs');
    if (!box) return;
    box.textContent = '';
    if (!text) return;
    const line = document.createElement('span');
    line.textContent = text;
    box.appendChild(line);
  },
  clean(text) {
    return String(text).replace(/<[^>]+>/g, '').replace(/\\N/g, '\n').trim();
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
  } else if (PREVIEW === 'subtitles') {
    Screens.show('playback');
    Subs.paint("We'll need to see the receipts.\nAll of them.");
  } else if (PREVIEW === 'upnext') {
    Screens.show('playback');
    UpNext.show({ label: 'We suggest', title: 'S01E02 · The Big Actor', subtitle: 'Dragnet (1951)',
                  art: null, endsIn: 7, total: 10 });
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
let reissuing = false;

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
  reissuing = true;
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
      reportLoadFailed('the stream never started (still ' + state + ' after 45s)', { track: 'stream' });
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
    const isReissue = reissuing;
    reissuing = false;
    const videoHeight = Number(custom.videoHeight) || 0;
    const displayHeight = videoHeight > 0 ? maxDisplayHeight() : 0;
    if (videoHeight > displayHeight) {
      slog('load refused: ' + videoHeight + 'p video, the display plays up to ' + displayHeight + 'p');
      clearLoadWatch();
      Subs.clear();
      Screens.error("Can't play this video", 'This screen plays video up to ' + displayHeight + 'p.');
      reportLoadFailed('display', { track: 'video', maxHeight: displayHeight });
      try { playerManager.stop(); } catch (e) {}
      return null;
    }
    const ownAdvance = !!custom.queueKey && custom.queueKey === Queue.advancing;
    const sameItem = !!custom.report && !!Report.info && custom.report.key === Report.info.key;
    if (!ownAdvance && !sameItem && !isReissue) Queue.clear();
    Queue.advancing = null;
    if (!Queue.asking) UpNext.hide();
    if (!isReissue) {
      Report.begin(custom.report);
      Playing.contentId = media.contentId || media.contentUrl || null;
      Playing.title = (media.metadata && media.metadata.title) || null;
    }
    if (Array.isArray(custom.subtitles)) Subs.load(media.contentUrl || media.contentId || '', custom);
    else Subs.clear();
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
    window.__dolbySplitActive = false;   // set again below for Dolby streams
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
      // Honest codecs only — the split is routed by the isTypeSupported gate
      // in index.html instead (the marker approach died in Shaka's codec
      // normalizer, measured: avc1.42E01E.pdl -> avc1.2a0NaN).
      const codecsAttr = streamCodecs;
      window.__dolbySplitActive = !!dolby;
      // Plex writes NO token into playlist URIs, and relative resolution
      // drops the master's query — so the media playlist, the fMP4
      // EXT-X-MAP init ("base/header") and every segment go out tokenless.
      // PMS answers tokenless requests with Access-Control-Allow-Origin
      // pinned to app.plex.tv instead of reflecting this origin (measured
      // 2026-08-27), which Shaka surfaces as error 1002 on the first init
      // fetch. Auth never needed the token — CORS does. Re-attach it to
      // everything under the transcode session.
      const tokenMatch = /[?&]X-Plex-Token=([^&]+)/.exec(url);
      const plexToken = tokenMatch ? tokenMatch[1] : '';
      const withToken = (u) => {
        if (!plexToken || u.indexOf('/transcode/universal/') < 0 ||
            u.indexOf('X-Plex-Token=') >= 0) return u;
        return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'X-Plex-Token=' + plexToken;
      };
      playbackConfig.manifestHandler = (manifest) => {
        let out = manifest.replace(/^(.+\.ts)(\s*)$/gm, '$1.m4s$2');
        if (codecsAttr && out.indexOf('#EXT-X-STREAM-INF') >= 0 &&
            out.indexOf('CODECS=') < 0) {
          out = out.replace(/^#EXT-X-STREAM-INF:(.*)$/gm,
            '#EXT-X-STREAM-INF:$1,CODECS="' + codecsAttr + '"');
        }
        return out;
      };
      playbackConfig.manifestRequestHandler = (request2) => {
        request2.url = withToken(request2.url);
      };
      playbackConfig.segmentRequestHandler = (request2) => {
        request2.url = withToken(request2.url.replace('.ts.m4s', '.ts'));
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
    } else if (custom.mkvEngine && window.MediaSource && typeof MkvEngine !== 'undefined') {
      // A Matroska direct file: demuxed in page JS (mkv-engine.js) into the
      // split per-track buffers every measured platform accepts — Dolby
      // included on this device. CAF drives the blob exactly like the MSE
      // engine's; subtitles arrive as the sender's sidecar tracks and render
      // natively. Seeks ride the SEEK interceptor into engine.reposition.
      const mkvUrl = media.contentUrl || media.contentId;
      lastLoad = { url: mkvUrl, media: Object.assign({}, media), custom };
      engine = new MkvEngine(mkvUrl, custom.audioTypeIndex || 0, {
        getTime: () => playerManager.getCurrentTimeSec() || 0,
        seekTo: (s) => { try { playerManager.seek(s); } catch (e) {} },
        log: slog,
        startAt: request.currentTime || 0,
        onSubtitleTracks: (list) => slog('mkv engine: ' + list.length + ' embedded text subtitle tracks'),
        onCue: (index, startMs, endMs, text) => Subs.engineCue(index, startMs, endMs, text),
      });
      engine.onEngineFailed = (reason, detail) => {
        slog('mkv engine failed: ' + reason);
        clearLoadWatch();
        teardownEngine();
        Subs.clear();
        const names = detail && detail.codecs ? detail.codecs.map(codecLabel).join(', ') : '';
        Screens.error("Can't play this video", detail && names
          ? 'This device can\'t play ' + names + ' ' + detail.track + '.'
          : String(reason));
        reportLoadFailed(reason, detail);
        try { playerManager.stop(); } catch (e) {}
      };
      media.contentUrl = engine.objectUrl;
      media.contentId = engine.objectUrl;
      media.contentType = 'video/mp4';
      slog('mkv engine load: audio#' + (custom.audioTypeIndex || 0));
    }
    return request;
  });

  // STOP: the engine used to survive this and idle on the platform's Dolby
  // decoder until the next LOAD - and a dead receiver instance still holding
  // the decoder is exactly what a freshly launched one trips over (the
  // demux-error-on-immediate-recast pattern). Release at the moment playback
  // actually ends.
  playerManager.setMessageInterceptor(messages.MessageType.STOP, (request) => {
    UpNext.hide();
    Queue.clear();
    Report.end();
    teardownEngine();
    Subs.clear();
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
  playerManager.addEventListener(events.EventType.PLAYING, () => Queue.playing());
  playerManager.addEventListener(events.EventType.PLAYER_LOAD_COMPLETE, () => {
    clearLoadWatch();
    Screens.show('playback');
    Queue.loaded();
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
  playerManager.addEventListener(events.EventType.MEDIA_FINISHED, (e) => {
    const reason = e && e.endedReason;
    if (reason === events.EndedReason.END_OF_STREAM && Queue.ended()) return;
    if (reason !== events.EndedReason.INTERRUPTED) Report.end();
    Screens.show('idle');
  });
  playerManager.addEventListener(events.EventType.ERROR, (e) => {
    clearLoadWatch();
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
    } else if (msg.type === 'upNext') {
      if (Queue.active) return;
      if (msg.hide) UpNext.hide(); else UpNext.show(msg);
    } else if (msg.type === 'queue') {
      Queue.set(msg);
    } else if (msg.type === 'queueState') {
      let position = 0;
      try { position = playerManager.getCurrentTimeSec() || 0; } catch (e) {}
      context.sendCustomMessage(NS, event.senderId, {
        type: 'queueState', current: Report.info ? Report.info.key : null,
        contentId: Report.info ? Playing.contentId : null, title: Report.info ? Playing.title : null,
        position, items: Queue.items.map((item) => item.key), asking: !!Queue.asking,
      });
    } else if (msg.type === 'setSubtitle') {
      Subs.select(typeof msg.typeIndex === 'number' ? msg.typeIndex : -1);
    } else if (msg.type === 'setAudioTrack' && engine) {
      if (typeof engine.setAudioTrack === 'function') {
        engine.setAudioTrack(msg.audioTypeIndex || 0);
      } else if (lastLoad) {
        // The MkvEngine switches audio the reissue way: reload the same media
        // at the live position with the new track in customData - the LOAD
        // interceptor builds a fresh engine around it.
        reissue({ audioTypeIndex: msg.audioTypeIndex || 0 });
      }
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
