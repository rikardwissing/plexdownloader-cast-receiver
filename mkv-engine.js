'use strict';
// MkvEngine — plays Matroska direct files through MSE, no server, no package.
//
// The shape mirrors the week's fMP4 lessons: demux the container in JS and
// feed each track its OWN SourceBuffer (the split topology every measured
// platform accepts — including Dolby on the Chromecast, where the muxed form
// is refused at every API layer). The demuxer reads EBML/Matroska; the muxer
// writes per-track fragmented MP4 with real timestamps (tfdt carries the
// file's own clock, so seeks need no timestampOffset games).
//
// Codec support is the platform's, not ours: h264/hevc video; AAC everywhere;
// AC-3/E-AC-3 where the device's MSE takes them (sample entries are written
// the mp4a+esds way Plex writes them — the form this platform measurably
// accepts). DTS/TrueHD have no MSE decoder anywhere: a chosen track we cannot
// carry fails loudly, per the house rule.
//
// Layering: MkvDemuxer and Fmp4Muxer are pure byte-in/byte-out (Node-tested
// against the repo's fixture corpus: h264/hevc video, aac/eac3 audio, all
// ffprobe frame-exact; playback proven in Chromium via MSE — load, seek,
// natural end). MkvEngine is the browser pump on top.
//
// NOT ES5: the pump uses async/await (Chrome 55+), so this file is for the
// CAST receiver (Chrome 92) and modern browsers only. Wiring it into the LAN
// page (2017 webOS parses the whole script or dies) needs an ES5 transform
// or a conditional loader first — do not add it to tv.html as-is.

/* eslint-disable no-bitwise */

// ---------------------------------------------------------------- EBML bits

function MkvByteReader(u8, baseOffset) {
  this.u8 = u8;                 // Uint8Array window
  this.base = baseOffset || 0;  // file offset of u8[0]
  this.pos = 0;                 // cursor within u8
}
MkvByteReader.prototype.remaining = function () { return this.u8.length - this.pos; };
MkvByteReader.prototype.fileOffset = function () { return this.base + this.pos; };
// EBML variable-length integer. keepMarker=true for element IDs.
MkvByteReader.prototype.readVint = function (keepMarker) {
  var first = this.u8[this.pos];
  if (first === undefined) return null;
  var length = 1;
  var mask = 0x80;
  while (length <= 8 && !(first & mask)) { mask >>= 1; length++; }
  if (length > 8 || this.remaining() < length) return null;
  var value = keepMarker ? first : (first & (mask - 1));
  for (var i = 1; i < length; i++) value = value * 256 + this.u8[this.pos + i];
  // All-ones size payload means "unknown size" (Segment/Cluster commonly).
  var unknown = false;
  if (!keepMarker) {
    var ones = (mask - 1);
    var allOnes = value === ones * Math.pow(256, length - 1) + (Math.pow(256, length - 1) - 1);
    if (length === 1 ? first === 0xFF : allOnes) unknown = true;
  }
  this.pos += length;
  return { value: value, length: length, unknown: unknown };
};
MkvByteReader.prototype.readUint = function (length) {
  var v = 0;
  for (var i = 0; i < length; i++) v = v * 256 + this.u8[this.pos + i];
  this.pos += length;
  return v;
};
MkvByteReader.prototype.readFloat = function (length) {
  var dv = new DataView(this.u8.buffer, this.u8.byteOffset + this.pos, length);
  this.pos += length;
  return length === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
};
MkvByteReader.prototype.readString = function (length) {
  var s = '';
  for (var i = 0; i < length; i++) s += String.fromCharCode(this.u8[this.pos + i]);
  this.pos += length;
  return s;
};
MkvByteReader.prototype.readBytes = function (length) {
  var out = this.u8.subarray(this.pos, this.pos + length);
  this.pos += length;
  return new Uint8Array(out);
};

var MKV_ID = {
  EBML: 0x1A45DFA3,
  Segment: 0x18538067,
  SeekHead: 0x114D9B74,
  Seek: 0x4DBB,
  SeekID: 0x53AB,
  SeekPosition: 0x53AC,
  Info: 0x1549A966,
  TimestampScale: 0x2AD7B1,
  Duration: 0x4489,
  Tracks: 0x1654AE6B,
  TrackEntry: 0xAE,
  TrackNumber: 0xD7,
  TrackType: 0x83,
  FlagDefault: 0x88,
  CodecID: 0x86,
  CodecPrivate: 0x63A2,
  DefaultDuration: 0x23E383,
  Language: 0x22B59C,
  Name: 0x536E,
  Video: 0xE0,
  PixelWidth: 0xB0,
  PixelHeight: 0xBA,
  Audio: 0xE1,
  SamplingFrequency: 0xB5,
  Channels: 0x9F,
  Cues: 0x1C53BB6B,
  CuePoint: 0xBB,
  CueTime: 0xB3,
  CueTrackPositions: 0xB7,
  CueClusterPosition: 0xF1,
  Cluster: 0x1F43B675,
  Timestamp: 0xE7,
  SimpleBlock: 0xA3,
  BlockGroup: 0xA0,
  Block: 0xA1,
};

// ------------------------------------------------------------- MkvDemuxer

function MkvDemuxer() {
  this.timestampScale = 1000000;   // ns per tick; default 1ms ticks
  this.durationTicks = 0;          // Info.Duration (in ticks)
  this.tracks = [];                // {number,type,codecId,codecPrivate,defaultDurationNs,video{},audio{},language}
  this.segmentStart = 0;           // file offset of the Segment payload
  this.cuesOffset = null;          // file offset of the Cues element (from SeekHead)
  this.cues = [];                  // {timeMs, clusterOffset(file abs)}
  this.firstClusterOffset = null;
}

// Parse the head of the file (EBML header + Segment children up to the first
// Cluster). `u8` starts at file offset 0. Returns false if more bytes are
// needed to reach Tracks + the first Cluster.
MkvDemuxer.prototype.parseHeader = function (u8) {
  var r = new MkvByteReader(u8, 0);
  var id = r.readVint(true);
  if (!id || id.value !== MKV_ID.EBML) throw new Error('not an EBML file');
  var size = r.readVint(false);
  if (!size) return false;
  r.pos += size.value;
  var segId = r.readVint(true);
  if (!segId || segId.value !== MKV_ID.Segment) throw new Error('no Segment');
  var segSize = r.readVint(false);
  if (!segSize) return false;
  this.segmentStart = r.fileOffset();
  for (;;) {
    if (r.remaining() < 12) return false;
    var childStart = r.fileOffset();
    var childId = r.readVint(true);
    var childSize = r.readVint(false);
    if (!childId || !childSize) return false;
    if (childId.value === MKV_ID.Cluster) {
      this.firstClusterOffset = childStart;
      return this.tracks.length > 0;
    }
    if (r.remaining() < childSize.value) return false;
    var body = new MkvByteReader(r.readBytes(childSize.value), childStart + childId.length + childSize.length);
    if (childId.value === MKV_ID.Info) this.parseInfo_(body);
    else if (childId.value === MKV_ID.Tracks) this.parseTracks_(body);
    else if (childId.value === MKV_ID.SeekHead) this.parseSeekHead_(body);
    else if (childId.value === MKV_ID.Cues) this.parseCues(body.u8);
  }
};

MkvDemuxer.prototype.parseInfo_ = function (r) {
  while (r.remaining() > 1) {
    var id = r.readVint(true); var size = r.readVint(false);
    if (!id || !size) break;
    if (id.value === MKV_ID.TimestampScale) this.timestampScale = r.readUint(size.value);
    else if (id.value === MKV_ID.Duration) this.durationTicks = r.readFloat(size.value);
    else r.pos += size.value;
  }
};

MkvDemuxer.prototype.parseSeekHead_ = function (r) {
  while (r.remaining() > 1) {
    var id = r.readVint(true); var size = r.readVint(false);
    if (!id || !size) break;
    if (id.value !== MKV_ID.Seek) { r.pos += size.value; continue; }
    var seek = new MkvByteReader(r.readBytes(size.value), 0);
    var target = null, position = null;
    while (seek.remaining() > 1) {
      var sid = seek.readVint(true); var ssize = seek.readVint(false);
      if (!sid || !ssize) break;
      if (sid.value === MKV_ID.SeekID) {
        target = 0;
        for (var i = 0; i < ssize.value; i++) target = target * 256 + seek.u8[seek.pos + i];
        seek.pos += ssize.value;
      } else if (sid.value === MKV_ID.SeekPosition) position = seek.readUint(ssize.value);
      else seek.pos += ssize.value;
    }
    if (target === MKV_ID.Cues && position != null) this.cuesOffset = this.segmentStart + position;
  }
};

MkvDemuxer.prototype.parseTracks_ = function (r) {
  while (r.remaining() > 1) {
    var id = r.readVint(true); var size = r.readVint(false);
    if (!id || !size) break;
    if (id.value !== MKV_ID.TrackEntry) { r.pos += size.value; continue; }
    var t = new MkvByteReader(r.readBytes(size.value), 0);
    var track = { number: 0, type: 0, codecId: '', codecPrivate: null,
                  defaultDurationNs: 0, language: 'und', name: '',
                  video: null, audio: null, isDefault: false };
    while (t.remaining() > 1) {
      var tid = t.readVint(true); var tsize = t.readVint(false);
      if (!tid || !tsize) break;
      switch (tid.value) {
        case MKV_ID.TrackNumber: track.number = t.readUint(tsize.value); break;
        case MKV_ID.TrackType: track.type = t.readUint(tsize.value); break;
        case MKV_ID.FlagDefault: track.isDefault = t.readUint(tsize.value) === 1; break;
        case MKV_ID.CodecID: track.codecId = t.readString(tsize.value).replace(/\0+$/, ''); break;
        case MKV_ID.CodecPrivate: track.codecPrivate = t.readBytes(tsize.value); break;
        case MKV_ID.DefaultDuration: track.defaultDurationNs = t.readUint(tsize.value); break;
        case MKV_ID.Language: track.language = t.readString(tsize.value).replace(/\0+$/, ''); break;
        case MKV_ID.Name: track.name = t.readString(tsize.value); break;
        case MKV_ID.Video: {
          var v = new MkvByteReader(t.readBytes(tsize.value), 0);
          track.video = { width: 0, height: 0 };
          while (v.remaining() > 1) {
            var vid = v.readVint(true); var vsize = v.readVint(false);
            if (!vid || !vsize) break;
            if (vid.value === MKV_ID.PixelWidth) track.video.width = v.readUint(vsize.value);
            else if (vid.value === MKV_ID.PixelHeight) track.video.height = v.readUint(vsize.value);
            else v.pos += vsize.value;
          }
          break;
        }
        case MKV_ID.Audio: {
          var a = new MkvByteReader(t.readBytes(tsize.value), 0);
          track.audio = { sampleRate: 8000, channels: 1 };
          while (a.remaining() > 1) {
            var aid = a.readVint(true); var asize = a.readVint(false);
            if (!aid || !asize) break;
            if (aid.value === MKV_ID.SamplingFrequency) track.audio.sampleRate = a.readFloat(asize.value);
            else if (aid.value === MKV_ID.Channels) track.audio.channels = a.readUint(asize.value);
            else a.pos += asize.value;
          }
          break;
        }
        default: t.pos += tsize.value;
      }
    }
    this.tracks.push(track);
  }
};

// Cues element payload → seek table.
MkvDemuxer.prototype.parseCues = function (u8) {
  var r = new MkvByteReader(u8, 0);
  // Accept either the raw payload or the full element (id+size prefix).
  var probe = new MkvByteReader(u8, 0);
  var maybeId = probe.readVint(true);
  if (maybeId && maybeId.value === MKV_ID.Cues) {
    var s = probe.readVint(false);
    r = new MkvByteReader(u8.subarray(probe.pos, probe.pos + s.value), 0);
  }
  while (r.remaining() > 1) {
    var id = r.readVint(true); var size = r.readVint(false);
    if (!id || !size) break;
    if (id.value !== MKV_ID.CuePoint) { r.pos += size.value; continue; }
    var c = new MkvByteReader(r.readBytes(size.value), 0);
    var timeTicks = null, cluster = null;
    while (c.remaining() > 1) {
      var cid = c.readVint(true); var csize = c.readVint(false);
      if (!cid || !csize) break;
      if (cid.value === MKV_ID.CueTime) timeTicks = c.readUint(csize.value);
      else if (cid.value === MKV_ID.CueTrackPositions) {
        var p = new MkvByteReader(c.readBytes(csize.value), 0);
        while (p.remaining() > 1) {
          var pid = p.readVint(true); var psize = p.readVint(false);
          if (!pid || !psize) break;
          if (pid.value === MKV_ID.CueClusterPosition) cluster = p.readUint(psize.value);
          else p.pos += psize.value;
        }
      } else c.pos += csize.value;
    }
    if (timeTicks != null && cluster != null) {
      this.cues.push({ timeMs: timeTicks * this.timestampScale / 1e6,
                       clusterOffset: this.segmentStart + cluster });
    }
  }
};

MkvDemuxer.prototype.durationMs = function () {
  return this.durationTicks * this.timestampScale / 1e6;
};

// Parse clusters found in `u8` (which begins at file offset `base`, aligned
// on a Cluster boundary). Emits samples via onSample(trackNumber, sample)
// where sample = {ptsMs, keyframe, data}. Returns the number of bytes fully
// consumed (always a whole number of clusters; a partial trailing cluster is
// left for the next call with more bytes).
MkvDemuxer.prototype.parseClusters = function (u8, base, onSample) {
  var r = new MkvByteReader(u8, base);
  var consumed = 0;
  for (;;) {
    var mark = r.pos;
    if (r.remaining() < 12) break;
    var id = r.readVint(true);
    var size = r.readVint(false);
    if (!id || !size) break;
    if (id.value !== MKV_ID.Cluster) {
      // Cues/Chapters/attachments after the last cluster — skip whole element.
      if (size.unknown || r.remaining() < size.value) break;
      r.pos += size.value;
      consumed = r.pos;
      continue;
    }
    if (size.unknown) throw new Error('unknown-size cluster unsupported');
    if (r.remaining() < size.value) break;   // partial cluster — wait for more
    var body = new MkvByteReader(r.readBytes(size.value), 0);
    this.parseClusterBody_(body, onSample);
    consumed = r.pos;
  }
  return consumed;
};

MkvDemuxer.prototype.parseClusterBody_ = function (r, onSample) {
  var clusterTicks = 0;
  while (r.remaining() > 1) {
    var id = r.readVint(true); var size = r.readVint(false);
    if (!id || !size || size.unknown || r.remaining() < size.value) break;
    if (id.value === MKV_ID.Timestamp) {
      clusterTicks = r.readUint(size.value);
    } else if (id.value === MKV_ID.SimpleBlock) {
      this.parseBlock_(r.readBytes(size.value), clusterTicks, null, onSample);
    } else if (id.value === MKV_ID.BlockGroup) {
      var g = new MkvByteReader(r.readBytes(size.value), 0);
      var blockBytes = null, hasReference = false;
      while (g.remaining() > 1) {
        var gid = g.readVint(true); var gsize = g.readVint(false);
        if (!gid || !gsize) break;
        if (gid.value === MKV_ID.Block) blockBytes = g.readBytes(gsize.value);
        else {
          if (gid.value === 0xFB) hasReference = true;   // ReferenceBlock
          g.pos += gsize.value;
        }
      }
      if (blockBytes) this.parseBlock_(blockBytes, clusterTicks, !hasReference, onSample);
    } else {
      r.pos += size.value;
    }
  }
};

MkvDemuxer.prototype.parseBlock_ = function (u8, clusterTicks, keyOverride, onSample) {
  var r = new MkvByteReader(u8, 0);
  var trackNum = r.readVint(false);
  if (!trackNum) return;
  var rel = (r.u8[r.pos] << 8) | r.u8[r.pos + 1];
  if (rel & 0x8000) rel -= 0x10000;    // signed int16
  r.pos += 2;
  var flags = r.u8[r.pos]; r.pos += 1;
  var keyframe = keyOverride != null ? keyOverride : !!(flags & 0x80);
  var lacing = (flags >> 1) & 0x3;     // 0 none, 1 Xiph, 2 fixed, 3 EBML
  var ptsMs = (clusterTicks + rel) * this.timestampScale / 1e6;
  var frames = [];
  if (lacing === 0) {
    frames.push(r.readBytes(r.remaining()));
  } else {
    var count = r.u8[r.pos] + 1; r.pos += 1;
    var sizes = [];
    var i, total;
    if (lacing === 2) {                 // fixed
      total = r.remaining();
      for (i = 0; i < count; i++) sizes.push(total / count);
    } else if (lacing === 1) {          // Xiph
      for (i = 0; i < count - 1; i++) {
        var v = 0;
        for (;;) { var b = r.u8[r.pos]; r.pos += 1; v += b; if (b !== 255) break; }
        sizes.push(v);
      }
    } else {                            // EBML
      var first = r.readVint(false);
      sizes.push(first.value);
      var prev = first.value;
      for (i = 1; i < count - 1; i++) {
        var d = r.readVint(false);
        // signed vint: subtract midpoint of its range
        var range = Math.pow(2, 7 * d.length - 1) - 1;
        prev += d.value - range;
        sizes.push(prev);
      }
    }
    var used = 0;
    for (i = 0; i < sizes.length; i++) used += sizes[i];
    if (lacing !== 2) sizes.push(r.remaining() - used);
    for (i = 0; i < sizes.length; i++) frames.push(r.readBytes(sizes[i]));
  }
  // Laced frames share the block timestamp; audio decoders infer spacing from
  // the frame contents, and the muxer spaces them by the track's default
  // duration — so hand each frame an index for that.
  for (var f = 0; f < frames.length; f++) {
    onSample(trackNum.value, { ptsMs: ptsMs, laceIndex: f, laceCount: frames.length,
                               keyframe: keyframe, data: frames[f] });
  }
};

// ------------------------------------------------------------- Fmp4Muxer

function mkvWriteU32(arr, v) { arr.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); }
function mkvWriteU16(arr, v) { arr.push((v >>> 8) & 255, v & 255); }
function mkvBox(type) {
  var payload = [];
  for (var i = 1; i < arguments.length; i++) {
    var a = arguments[i];
    for (var j = 0; j < a.length; j++) payload.push(a[j]);
  }
  var out = [];
  mkvWriteU32(out, payload.length + 8);
  for (var c = 0; c < 4; c++) out.push(type.charCodeAt(c));
  return out.concat(payload);
}
function mkvFull(type, version, flags) {
  var head = [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255];
  var args = [type, head];
  for (var i = 3; i < arguments.length; i++) args.push(arguments[i]);
  return mkvBox.apply(null, args);
}

// One muxer per TRACK: init segment + sequential media fragments carrying the
// file's own timestamps (tfdt = decode time on the track's timescale).
function Fmp4Muxer(track, timescale) {
  this.track = track;              // demuxer track entry
  this.timescale = timescale;
  this.seq = 0;
}

Fmp4Muxer.prototype.codecString = function () {
  var cp = this.track.codecPrivate;
  var id = this.track.codecId;
  if (id === 'V_MPEG4/ISO/AVC' && cp && cp.length >= 4) {
    var hex = function (b) { return (b < 16 ? '0' : '') + b.toString(16).toUpperCase(); };
    return 'avc1.' + hex(cp[1]) + hex(cp[2]) + hex(cp[3]);
  }
  if (id === 'V_MPEGH/ISO/HEVC' && cp && cp.length >= 13) {
    var b1 = cp[1];
    var space = b1 >> 6, tier = (b1 >> 5) & 1, profile = b1 & 0x1F;
    var level = cp[12];
    var compat = (cp[2] << 24 >>> 0) + (cp[3] << 16) + (cp[4] << 8) + cp[5];
    // RFC 6381: compat flags bit-reversed, hex, no leading zeros.
    var rev = 0;
    for (var i = 0; i < 32; i++) { rev = (rev << 1) | ((compat >>> i) & 1); }
    return 'hvc1.' + (space ? String.fromCharCode(64 + space) : '') + profile +
           '.' + (rev >>> 0).toString(16).toUpperCase() +
           '.' + (tier ? 'H' : 'L') + level + '.B0';
  }
  if (id === 'A_AAC' && cp && cp.length >= 1) {
    return 'mp4a.40.' + (cp[0] >> 3);
  }
  if (id === 'A_AC3') return 'ac-3';
  if (id === 'A_EAC3') return 'ec-3';
  return null;
};

Fmp4Muxer.prototype.contentType = function () {
  var kind = this.track.type === 1 ? 'video' : 'audio';
  return kind + '/mp4; codecs="' + this.codecString() + '"';
};

Fmp4Muxer.prototype.sampleEntry_ = function () {
  var t = this.track;
  if (t.type === 1) {
    var isAvc = t.codecId === 'V_MPEG4/ISO/AVC';
    var body = [];
    for (var i = 0; i < 6; i++) body.push(0);          // reserved
    mkvWriteU16(body, 1);                              // data_reference_index
    for (i = 0; i < 16; i++) body.push(0);             // pre_defined/reserved
    mkvWriteU16(body, t.video.width);
    mkvWriteU16(body, t.video.height);
    mkvWriteU32(body, 0x00480000);                     // 72dpi
    mkvWriteU32(body, 0x00480000);
    mkvWriteU32(body, 0);
    mkvWriteU16(body, 1);                              // frame_count
    for (i = 0; i < 32; i++) body.push(0);             // compressorname
    mkvWriteU16(body, 0x0018);                         // depth
    mkvWriteU16(body, 0xFFFF);                         // pre_defined
    var config = mkvBox(isAvc ? 'avcC' : 'hvcC', t.codecPrivate);
    return mkvBox(isAvc ? 'avc1' : 'hvc1', body, config);
  }
  // Audio: the mp4a+esds form for everything — including AC-3/E-AC-3 via
  // objectTypeIndication (0xA5/0xA6), the exact shape Plex writes and this
  // platform measurably accepts.
  var a = [];
  for (var j = 0; j < 6; j++) a.push(0);
  mkvWriteU16(a, 1);                                   // data_reference_index
  mkvWriteU32(a, 0); mkvWriteU32(a, 0);                // reserved
  mkvWriteU16(a, t.audio.channels);
  mkvWriteU16(a, 16);                                  // samplesize
  mkvWriteU32(a, 0);                                   // pre_defined/reserved
  mkvWriteU32(a, Math.round(t.audio.sampleRate) << 16 >>> 0);
  var oti = t.codecId === 'A_AAC' ? 0x40 : (t.codecId === 'A_AC3' ? 0xA5 : 0xA6);
  var dsi = (t.codecId === 'A_AAC' && t.codecPrivate) ? t.codecPrivate : new Uint8Array(0);
  // ES_Descriptor(3) { ES_ID, flags, DecoderConfig(4) { oti, streamType,
  // buffer, rates, DecSpecific(5){asc} }, SLConfig(6){2} }
  var dec = [oti, 0x15, 0, 0, 0, 0, 0x01, 0xF4, 0x00, 0x00, 0x01, 0xF4, 0x00];
  if (dsi.length) {
    dec.push(5, dsi.length);
    for (var d = 0; d < dsi.length; d++) dec.push(dsi[d]);
  }
  var es = [0, 0, 0];                                  // ES_ID=0, flags=0
  es.push(4, dec.length);
  es = es.concat(dec);
  es.push(6, 1, 2);                                    // SLConfig
  var esds = mkvFull('esds', 0, 0, [3, es.length].concat(es));
  return mkvBox('mp4a', a, esds);
};

Fmp4Muxer.prototype.initSegment = function (durationMs) {
  var ts = this.timescale;
  var t = this.track;
  var mvhd = [];
  mkvWriteU32(mvhd, 0); mkvWriteU32(mvhd, 0);          // times
  mkvWriteU32(mvhd, 1000);                             // movie timescale
  mkvWriteU32(mvhd, Math.round(durationMs));
  mkvWriteU32(mvhd, 0x00010000); mkvWriteU16(mvhd, 0x0100); mkvWriteU16(mvhd, 0);
  mkvWriteU32(mvhd, 0); mkvWriteU32(mvhd, 0);
  var unity = [0x00,0x01,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0x00,0x01,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0x40,0,0,0];
  for (var i = 0; i < unity.length; i++) mvhd.push(unity[i]);
  for (i = 0; i < 24; i++) mvhd.push(0);               // pre_defined
  mkvWriteU32(mvhd, 2);                                // next_track_ID

  var tkhd = [];
  mkvWriteU32(tkhd, 0); mkvWriteU32(tkhd, 0);
  mkvWriteU32(tkhd, 1);                                // track id (always 1: one track per file)
  mkvWriteU32(tkhd, 0);
  mkvWriteU32(tkhd, 0);                                // duration (fragments define it)
  mkvWriteU32(tkhd, 0); mkvWriteU32(tkhd, 0);
  mkvWriteU16(tkhd, 0); mkvWriteU16(tkhd, 0);
  mkvWriteU16(tkhd, t.type === 2 ? 0x0100 : 0); mkvWriteU16(tkhd, 0);
  for (i = 0; i < unity.length; i++) tkhd.push(unity[i]);
  mkvWriteU32(tkhd, t.type === 1 ? (t.video.width << 16 >>> 0) : 0);
  mkvWriteU32(tkhd, t.type === 1 ? (t.video.height << 16 >>> 0) : 0);

  var mdhd = [];
  mkvWriteU32(mdhd, 0); mkvWriteU32(mdhd, 0);
  mkvWriteU32(mdhd, ts);
  mkvWriteU32(mdhd, 0);
  mkvWriteU16(mdhd, 0x55C4); mkvWriteU16(mdhd, 0);     // language 'und'

  var hdlrName = t.type === 1 ? 'VideoHandler' : 'SoundHandler';
  var hdlr = [0, 0, 0, 0];
  var kind = t.type === 1 ? 'vide' : 'soun';
  for (i = 0; i < 4; i++) hdlr.push(kind.charCodeAt(i));
  for (i = 0; i < 12; i++) hdlr.push(0);
  for (i = 0; i < hdlrName.length; i++) hdlr.push(hdlrName.charCodeAt(i));
  hdlr.push(0);

  var mhd = t.type === 1
    ? mkvFull('vmhd', 0, 1, [0, 0, 0, 0, 0, 0, 0, 0])
    : mkvFull('smhd', 0, 0, [0, 0, 0, 0]);

  var dref = mkvFull('dref', 0, 0, [0, 0, 0, 1], mkvFull('url ', 0, 1));
  var stbl = mkvBox('stbl',
    mkvFull('stsd', 0, 0, [0, 0, 0, 1], this.sampleEntry_()),
    mkvFull('stts', 0, 0, [0, 0, 0, 0]),
    mkvFull('stsc', 0, 0, [0, 0, 0, 0]),
    mkvFull('stsz', 0, 0, [0, 0, 0, 0, 0, 0, 0, 0]),
    mkvFull('stco', 0, 0, [0, 0, 0, 0]));
  var minf = mkvBox('minf', mhd, mkvBox('dinf', dref), stbl);
  var mdia = mkvBox('mdia', mkvFull('mdhd', 0, 0, mdhd), mkvFull('hdlr', 0, 0, hdlr), minf);
  var trak = mkvBox('trak', mkvFull('tkhd', 0, 7, tkhd), mdia);
  var trex = [];
  mkvWriteU32(trex, 1);                                // track id
  mkvWriteU32(trex, 1);                                // default sample description
  mkvWriteU32(trex, 0); mkvWriteU32(trex, 0); mkvWriteU32(trex, 0);
  var moov = mkvBox('moov', mkvFull('mvhd', 0, 0, mvhd), trak,
                    mkvBox('mvex', mkvFull('trex', 0, 0, trex)));
  var ftyp = mkvBox('ftyp',
    [0x69, 0x73, 0x6F, 0x35, 0, 0, 2, 0,               // iso5, minor
     0x69, 0x73, 0x6F, 0x35, 0x69, 0x73, 0x6F, 0x36,   // iso5 iso6
     0x6D, 0x70, 0x34, 0x31]);                         // mp41
  return new Uint8Array(ftyp.concat(moov));
};

// samples: [{dts, pts, duration, keyframe, data}] on this.timescale.
Fmp4Muxer.prototype.fragment = function (samples) {
  this.seq++;
  var trun = [];
  mkvWriteU32(trun, samples.length);
  mkvWriteU32(trun, 0);                                // data_offset placeholder
  var mdatSize = 0;
  var i, s;
  for (i = 0; i < samples.length; i++) {
    s = samples[i];
    mkvWriteU32(trun, s.duration);
    mkvWriteU32(trun, s.data.length);
    mkvWriteU32(trun, s.keyframe ? 0x02000000 : 0x01010000);
    var cts = s.pts - s.dts;
    mkvWriteU32(trun, cts < 0 ? (cts >>> 0) : cts);    // v1: signed
    mdatSize += s.data.length;
  }
  var trunBox = mkvFull('trun', 1, 0x000F01, trun);
  var tfhd = [];
  mkvWriteU32(tfhd, 1);                                // track id
  var tfhdBox = mkvFull('tfhd', 0, 0x020000, tfhd);    // default-base-is-moof
  var baseDts = samples[0].dts;
  var tfdt = [];
  mkvWriteU32(tfdt, Math.floor(baseDts / 4294967296));
  mkvWriteU32(tfdt, baseDts >>> 0);
  var tfdtBox = mkvFull('tfdt', 1, 0, tfdt);
  var mfhd = [];
  mkvWriteU32(mfhd, this.seq);
  var traf = mkvBox('traf', tfhdBox, tfdtBox, trunBox);
  var moof = mkvBox('moof', mkvFull('mfhd', 0, 0, mfhd), traf);
  // Patch trun data_offset: moof size + mdat header. The field sits at
  // trunBox start + 8 (box header) + 4 (version/flags) + 4 (sample_count).
  var offsetIndex = moof.length - trunBox.length + 16;
  var dataOffset = moof.length + 8;
  moof[offsetIndex] = (dataOffset >>> 24) & 255;
  moof[offsetIndex + 1] = (dataOffset >>> 16) & 255;
  moof[offsetIndex + 2] = (dataOffset >>> 8) & 255;
  moof[offsetIndex + 3] = dataOffset & 255;
  var out = new Uint8Array(moof.length + 8 + mdatSize);
  out.set(moof, 0);
  var dv = new DataView(out.buffer);
  dv.setUint32(moof.length, 8 + mdatSize);
  out[moof.length + 4] = 0x6D; out[moof.length + 5] = 0x64;
  out[moof.length + 6] = 0x61; out[moof.length + 7] = 0x74;
  var off = moof.length + 8;
  for (i = 0; i < samples.length; i++) {
    out.set(samples[i].data, off);
    off += samples[i].data.length;
  }
  return out;
};

// ------------------------------------------------- sample timing assembly

// Turns demuxer samples for ONE track into muxer samples with synthesized
// DTS (storage order IS decode order in Matroska; block timestamps are PTS —
// the classic B-frame situation the app's FFmpeg engine documents). DTS runs
// on a monotonic grid from the first sample; CTS offsets absorb reordering.
function MkvTrackTimeline(track, timescale) {
  this.track = track;
  this.timescale = timescale;
  this.frameTicks = track.defaultDurationNs
    ? Math.round(track.defaultDurationNs * timescale / 1e9) : 0;
  // Audio tracks routinely omit DefaultDuration, and laced frames share one
  // block timestamp — the codec defines the spacing: 1024 samples per AAC
  // frame, 1536 per (E-)AC-3 frame, on the sample-rate timescale.
  if (!this.frameTicks && track.type === 2) {
    var samplesPerFrame = track.codecId === 'A_AAC' ? 1024 : 1536;
    this.frameTicks = Math.round(samplesPerFrame * timescale / track.audio.sampleRate);
  }
  this.nextDts = null;
  this.prevPts = null;
}
MkvTrackTimeline.prototype.reset = function () { this.nextDts = null; this.prevPts = null; };
MkvTrackTimeline.prototype.convert = function (raw) {
  var pts = Math.round(raw.ptsMs * this.timescale / 1000);
  var dur = this.frameTicks;
  if (raw.laceCount > 1 && dur) pts += raw.laceIndex * dur;
  if (!dur) {
    dur = this.prevPts != null && pts > this.prevPts
      ? (pts - this.prevPts) : Math.round(this.timescale / 30);
  }
  if (this.nextDts == null) this.nextDts = pts;
  var dts = this.nextDts;
  this.nextDts += dur;
  this.prevPts = pts;
  return { dts: dts, pts: pts, duration: dur, keyframe: raw.keyframe, data: raw.data };
};

// ------------------------------------------------------------- MkvEngine
// The browser pump: byte-range fetches in, MSE buffers out. Interface mirrors
// the MseEngine so receivers wire it identically: objectUrl to hand the
// element/CAF, reposition() for seeks, destroy(), onEngineFailed(reason).

function MkvEngine(url, audioTypeIndex, opts) {
  opts = opts || {};
  var self = this;
  this.url = url;
  this.audioTypeIndex = audioTypeIndex || 0;
  this.fetcher = opts.fetcher || function (start, end) {
    return fetch(url, { headers: { Range: 'bytes=' + start + '-' + end } })
      .then(function (r) {
        if (r.status !== 206 && r.status !== 200) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      });
  };
  this.getTime = opts.getTime || function () { return 0; };
  this.log = opts.log || function () {};
  this.startAt = opts.startAt || 0;
  this.mediaSource = new MediaSource();
  this.objectUrl = URL.createObjectURL(this.mediaSource);
  this.dead = false;
  this.generation = 0;
  this.demux = new MkvDemuxer();
  this.lanes = {};              // trackNumber -> {muxer,timeline,sb,queue,pending,pendingMs,initSent}
  this.onEngineFailed = null;
  this.appendedMs = 0;          // furthest pts appended (ms)
  this.lastReposition = 0;
  this.evictCountdown = 0;
  this.mediaSource.addEventListener('sourceopen', function onOpen() {
    self.mediaSource.removeEventListener('sourceopen', onOpen);
    self.start_();
  });
}

MkvEngine.prototype.destroy = function () {
  this.dead = true;
  this.generation++;
  try {
    if (this.mediaSource.readyState === 'open') {
      for (var k in this.lanes) {
        if (this.lanes[k].sb) { try { this.mediaSource.removeSourceBuffer(this.lanes[k].sb); } catch (e) {} }
      }
    }
  } catch (e) {}
  try { URL.revokeObjectURL(this.objectUrl); } catch (e) {}
};

MkvEngine.prototype.fatal_ = function (reason) {
  if (this.dead) return;
  this.dead = true;
  this.log('mkvengine fatal: ' + reason);
  if (this.onEngineFailed) { try { this.onEngineFailed(String(reason)); } catch (e) {} }
};

MkvEngine.prototype.sleep_ = function (ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
};

MkvEngine.prototype.start_ = async function () {
  try {
    // Grow the header window until Tracks and the first Cluster are visible.
    var window_ = 256 * 1024;
    var head = null;
    for (;;) {
      head = new Uint8Array(await this.fetcher(0, window_ - 1));
      var ok = false;
      try { ok = this.demux.parseHeader(head); } catch (e) { this.fatal_(e); return; }
      if (ok) break;
      if (window_ >= 8 * 1024 * 1024) { this.fatal_('no tracks in first 8MB'); return; }
      window_ *= 2;
    }
    if (this.demux.cuesOffset != null && !this.demux.cues.length) {
      try {
        var cuesBytes = new Uint8Array(
          await this.fetcher(this.demux.cuesOffset, this.demux.cuesOffset + 512 * 1024 - 1));
        this.demux.parseCues(cuesBytes);
      } catch (e) {}
    }
    // Choose tracks: the video track, and the audioTypeIndex-th audio track.
    var video = null, audio = null, audioSeen = 0;
    for (var i = 0; i < this.demux.tracks.length; i++) {
      var t = this.demux.tracks[i];
      if (t.type === 1 && !video) video = t;
      if (t.type === 2) {
        if (audioSeen === this.audioTypeIndex) audio = t;
        audioSeen++;
      }
    }
    if (!audio) {
      audioSeen = 0;
      for (i = 0; i < this.demux.tracks.length; i++) {
        if (this.demux.tracks[i].type === 2) { audio = this.demux.tracks[i]; break; }
      }
    }
    var chosen = [];
    if (video) chosen.push(video);
    if (audio) chosen.push(audio);
    if (!chosen.length) { this.fatal_('no playable tracks'); return; }
    for (i = 0; i < chosen.length; i++) {
      var track = chosen[i];
      var timescale = track.type === 1 ? 90000 : Math.round(track.audio.sampleRate);
      var muxer = new Fmp4Muxer(track, timescale);
      var codec = muxer.codecString();
      if (!codec) { this.fatal_('unsupported codec ' + track.codecId); return; }
      var mime = muxer.contentType();
      if (!MediaSource.isTypeSupported(mime)) {
        this.fatal_('this device cannot decode ' + codec);
        return;
      }
      var sb = this.mediaSource.addSourceBuffer(mime);
      var lane = { muxer: muxer, timeline: new MkvTrackTimeline(track, timescale),
                   sb: sb, queue: [], pending: [], pendingSinceMs: null, track: track };
      (function (self2, lane2) {
        sb.addEventListener('updateend', function () { self2.drain_(lane2); });
        sb.addEventListener('error', function () { self2.fatal_('sourcebuffer error (' + lane2.track.codecId + ')'); });
      })(this, lane);
      this.lanes[track.number] = lane;
      this.log('mkvengine: lane ' + track.number + ' ' + mime);
      lane.queue.push(muxer.initSegment(this.demux.durationMs()));
      this.drain_(lane);
    }
    try { this.mediaSource.duration = this.demux.durationMs() / 1000; } catch (e) {}
    var at = Math.max(this.getTime() * 1000 || 0, this.startAt * 1000);
    this.pump_(this.offsetForMs_(at));
  } catch (e) { this.fatal_('start: ' + e); }
};

MkvEngine.prototype.offsetForMs_ = function (ms) {
  var offset = this.demux.firstClusterOffset;
  for (var i = 0; i < this.demux.cues.length; i++) {
    if (this.demux.cues[i].timeMs <= ms) offset = this.demux.cues[i].clusterOffset;
    else break;
  }
  return offset;
};

MkvEngine.prototype.drain_ = function (lane) {
  if (this.dead || !lane.sb || lane.sb.updating || !lane.queue.length) return;
  if (this.mediaSource.readyState !== 'open') return;
  try {
    lane.sb.appendBuffer(lane.queue.shift());
  } catch (e) {
    if (e && e.name === 'QuotaExceededError') {
      lane.queue.unshift(lane.queue.shift());
      var now = this.getTime() || 0;
      try { lane.sb.remove(0, Math.max(0.1, now - 30)); } catch (e2) {}
      return;
    }
    this.fatal_('append: ' + e);
  }
};

MkvEngine.prototype.flushLane_ = function (lane) {
  if (!lane.pending.length) return;
  lane.queue.push(lane.muxer.fragment(lane.pending));
  lane.pending = [];
  lane.pendingSinceMs = null;
  this.drain_(lane);
};

MkvEngine.prototype.reposition = function (seconds) {
  if (this.dead) return;
  var ms = Math.max(0, seconds * 1000);
  // In-window seeks play from what is buffered; only leave for real jumps.
  if (Date.now() - this.lastReposition < 4000) return;
  this.lastReposition = Date.now();
  this.generation++;
  for (var k in this.lanes) {
    var lane = this.lanes[k];
    lane.pending = [];
    lane.pendingSinceMs = null;
    lane.timeline.reset();
  }
  this.log('mkvengine: reposition ' + Math.round(seconds) + 's');
  this.pump_(this.offsetForMs_(ms));
};

MkvEngine.prototype.pump_ = async function (startOffset) {
  var gen = ++this.generation;
  var offset = startOffset;
  var carry = null;               // partial trailing cluster from last window
  var carryBase = 0;
  var WINDOW = 2 * 1024 * 1024;
  var self = this;
  var sawEnd = false;
  while (!this.dead && gen === this.generation) {
    // Backpressure: a minute of media ahead of the playhead is plenty.
    var nowMs = (this.getTime() || 0) * 1000;
    if (this.appendedMs - nowMs > 60000) { await this.sleep_(1000); continue; }
    var bytes;
    try {
      bytes = new Uint8Array(await this.fetcher(offset, offset + WINDOW - 1));
    } catch (e) { this.fatal_('fetch@' + offset + ': ' + e); return; }
    if (gen !== this.generation || this.dead) return;
    if (!bytes.length) sawEnd = true;
    var chunk, base;
    if (carry && carry.length) {
      chunk = new Uint8Array(carry.length + bytes.length);
      chunk.set(carry, 0); chunk.set(bytes, carry.length);
      base = carryBase;
    } else { chunk = bytes; base = offset; }
    var consumed = 0;
    try {
      consumed = this.demux.parseClusters(chunk, base, function (trackNum, raw) {
        var lane = self.lanes[trackNum];
        if (!lane) return;
        var sample = lane.timeline.convert(raw);
        lane.pending.push(sample);
        if (lane.pendingSinceMs == null) lane.pendingSinceMs = raw.ptsMs;
        if (raw.ptsMs > self.appendedMs) self.appendedMs = raw.ptsMs;
        // ~1 second per fragment, and video fragments begin on keyframes when
        // the source has them (cleaner random access for the element).
        if (raw.ptsMs - lane.pendingSinceMs >= 1000) self.flushLane_(lane);
      });
    } catch (e) { this.fatal_('demux@' + base + ': ' + e); return; }
    if (bytes.length < WINDOW) sawEnd = true;
    if (consumed === 0 && sawEnd) break;
    if (consumed === 0 && chunk.length > 32 * 1024 * 1024) {
      this.fatal_('cluster larger than 32MB'); return;
    }
    if (consumed > 0) {
      carry = chunk.subarray(consumed);
      carryBase = base + consumed;
      offset = carryBase + carry.length;
    } else {
      carry = chunk;
      carryBase = base;
      offset = base + chunk.length;
    }
    if (sawEnd && (!carry || !carry.length)) break;
    if (sawEnd) { /* one more parse attempt happened; nothing left to fetch */ break; }
    // Opportunistic eviction keeps quota honest on long plays.
    if (++this.evictCountdown >= 8) {
      this.evictCountdown = 0;
      var behind = (this.getTime() || 0) - 40;
      if (behind > 0) {
        for (var k in this.lanes) {
          var sb = this.lanes[k].sb;
          if (sb && !sb.updating) { try { sb.remove(0, behind); } catch (e2) {} }
        }
      }
    }
  }
  if (this.dead || gen !== this.generation) return;
  for (var k2 in this.lanes) this.flushLane_(this.lanes[k2]);
  var self3 = this;
  var wait = function () {
    if (self3.dead || gen !== self3.generation) return;
    for (var k3 in self3.lanes) {
      var lane = self3.lanes[k3];
      if (lane.queue.length || (lane.sb && lane.sb.updating)) { setTimeout(wait, 200); return; }
    }
    try { self3.mediaSource.endOfStream(); } catch (e) {}
  };
  wait();
};

// ------------------------------------------------------------- exports

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MkvDemuxer: MkvDemuxer,
    Fmp4Muxer: Fmp4Muxer,
    MkvTrackTimeline: MkvTrackTimeline,
    MkvEngine: typeof MediaSource !== 'undefined' ? MkvEngine : null,
  };
}
