/* MSE engine (multi-audio direct MP4). Written in strict ES5 so it runs
   on 2017-era TV parsers too (webOS 3.x / Chromium 38) — their MSE
   handles fMP4 appends fine (proven by the hls.js fallback). Kept in its
   own script block as a quarantine boundary regardless: if anything
   modern ever slips in here, only this feature degrades, and the main
   block's typeof-MseEngine guard falls back to plain <video src>. */
(function(){
  var v=document.getElementById('v');
  /* The media element, for pages that don't have a #v to find.
     A Cast receiver's element belongs to CAF, not to us, so the Chromecast
     receiver hands over a stand-in before it builds an engine. The engine wants
     remarkably little from it — `currentTime` and `error`, nothing else; every
     buffered range it reasons about comes from the SourceBuffers — so a shim
     over playerManager is a faithful substitute rather than a fudge. */
  window.tvSetMediaElement=function(el){ if(el)v=el; };
  function trace(message){ if(window.tvReport){try{window.tvReport(message);return}catch(e){}} try{console.log('plexcast:',message)}catch(e2){} }
  /* Wall clock for the cost traces below. A trace emitted while the main thread
     is blocked cannot be SENT until the block ends, so timestamps on separate
     traces all bunch up at the end and lie about which call cost what. Measure
     with deltas and report in one line. */
  var nowMs=(window.performance&&window.performance.now)
    ? function(){return window.performance.now()}
    : function(){return (new Date()).getTime()};
  function ms(delta){ return Math.round(delta)+'ms'; }
  /* The codec gate and fatal-error surface live in the ES5 main block
     (tv-main.js), which parses everywhere and exports window.tvHelpers.
     Dereference at CALL time — this file executes before tv-main.js. */
  function playbackError(msg){ if(window.tvHelpers&&window.tvHelpers.playbackError){window.tvHelpers.playbackError(msg);} else {trace('fatal: '+msg);} }
  /* mp4box reports a track's codec as its ISO fourcc, and MSE does not always
     spell it the same way. FLAC's box type is `fLaC`; MediaSource wants `flac`,
     and isTypeSupported is case-sensitive, so asking it about `fLaC` gets a flat
     no for a codec the device plays perfectly well. Field-caught: a file with
     AC-3 + FLAC engaged the engine (the SENDER gates on ffprobe's `flac`, which
     matches) and then the engine refused its own audio, while the same FLAC as a
     single track played fine because one track never engages the engine at all.
     Opus has the same shape (`Opus`). Everything else passes through untouched —
     a blanket lowercase would corrupt `hvc1.2.4.L120.90`, where the capital L is
     load-bearing. */
  var MIME_CODEC={'flac':'flac','opus':'opus'};
  function mimeCodec(c){
    var key=String(c||'').toLowerCase();
    return Object.prototype.hasOwnProperty.call(MIME_CODEC,key)?MIME_CODEC[key]:c;
  }
  function canPlay(kind,codec){ return window.tvHelpers&&window.tvHelpers.canPlay?window.tvHelpers.canPlay(kind,codec):true; }
  function codecName(c){ return window.tvHelpers&&window.tvHelpers.codecName?window.tvHelpers.codecName(c):String(c||''); }
  function MseEngine(path,audioTypeIndex,fetcher){
    this.path=path; this.wantAudioIndex=audioTypeIndex||0;
    this.fetcher=fetcher||null;                              // null = XHR Range
    this.mediaSource=new MediaSource(); this.objectUrl=URL.createObjectURL(this.mediaSource);
    this.mp4=MP4Box.createFile(); this.buffers={}; this.queues={video:[],audio:[]};
    this.initSegs={}; this.audioTracks=[]; this.videoTrackId=null; this.audioTrackId=null;
    this.fetchOffset=0; this.fetchGen=0; this.inflight=null; this.totalBytes=null; this.dead=false;
    this.initRange=null;                                     // {start,length} from the load, when known
    window.__engine=this;                                    // QA/debug handle
    var self=this;
    this.mediaSource.addEventListener('sourceopen',function(){self.onSourceOpen()});
  }
  /* A fatal engine problem (mp4box parse bug, dead fetches) reports its
     stack through the trace pipe and hands control to onEngineFailed —
     the page falls back to plain <video src> at the live position, so an
     engine bug never blanks the screen (it just loses the memory-bounded
     streaming until we can patch the underlying cause). */
  MseEngine.prototype.fatal=function(reason){
    if(this.dead)return;
    trace('engine fatal: '+reason);
    this.dead=true;
    var handler=this.onEngineFailed;
    if(handler){ this.onEngineFailed=null; try{handler(reason)}catch(e){} }
  };
  MseEngine.prototype.onSourceOpen=function(){
    var self=this;
    this.mp4.onError=function(e){self.fatal('mp4box error: '+e)};
    this.mp4.onReady=function(info){self.onReady(info)};
    this.mp4.onSamples=function(id,kind,samples){self.onSamples(id,kind,samples)};
    /* Still from byte 0. Starting at the moov was tried and does NOT work:
       mp4box will not fire onReady from a moov alone — it needs a contiguous
       run from the start of the file, far enough to read the mdat header and
       learn to skip to the moov. Measured against real mp4box: moov alone, no
       ready; 40 bytes of head then moov, no ready; 64 KB of head then moov,
       ready with both tracks. So the probe stays, and what the sender's hint
       buys is the SIZE of the moov (see step below), not its position — the
       parse pointer already reports that correctly. */
    this.pump(0);
  };
  /* Byte-level box builders. u8 concat helper first: box('moov',a,b,...)
     returns [size]['moov']a b ... as one Uint8Array. */
  function bytes(){var n=0,i,out;for(i=0;i<arguments.length;i++)n+=arguments[i].length;out=new Uint8Array(n);n=0;for(i=0;i<arguments.length;i++){out.set(arguments[i],n);n+=arguments[i].length;}return out;}
  function u32a(){var out=new Uint8Array(arguments.length*4),dv=new DataView(out.buffer);for(var i=0;i<arguments.length;i++)dv.setUint32(i*4,arguments[i]);return out;}
  function u16a(){var out=new Uint8Array(arguments.length*2),dv=new DataView(out.buffer);for(var i=0;i<arguments.length;i++)dv.setUint16(i*2,arguments[i]);return out;}
  function fourcc(s){return new Uint8Array([s.charCodeAt(0),s.charCodeAt(1),s.charCodeAt(2),s.charCodeAt(3)]);}
  function mkbox(type){var body=[fourcc(type)];for(var i=1;i<arguments.length;i++)body.push(arguments[i]);var inner=bytes.apply(null,body);return bytes(u32a(inner.length+4),inner);}
  var UNITY_MATRIX=u32a(0x10000,0,0,0,0x10000,0,0,0,0x40000000);
  /* Media segments AND init segments are built by hand instead of using
     mp4box's writers. Two hard-won TV facts drive this:
     - mp4box's fragmenter can only emit one moof+mdat PER SAMPLE, and that
       per-frame moof flood is rejected with MEDIA_ERR_DECODE.
     - mp4box's init segments drag the source's moov furniture along
       (edts/elst, empty ctts, colr/pasp/btrt inside the sample entry,
       leftover sgpd/sbgp) — everything the TV never sees from hls.js.
     So mp4box stays the parser/extractor, and the appended stream is the
     exact minimal hls.js shape the TV has already proven it plays. */
  MseEngine.prototype.serializeEntry=function(entry){
    var ds=new DataStream();
    ds.endianness=DataStream.BIG_ENDIAN;
    entry.write(ds);
    return new Uint8Array(ds.buffer,0,entry.size);
  };
  /* Cleaned sample entry: keep the codec config plus the presentation
     boxes ffmpeg's TV-proven streams also carry (colr/pasp/btrt); drop
     anything else the source moov dragged in. */
  MseEngine.prototype.minimalEntry=function(entry,kind){
    var raw=this.serializeEntry(entry);
    var fixed=(kind==='video')?86:36;             // 8 hdr + 78 visual / 28 audio
    var keep={avcC:1,hvcC:1,esds:1,colr:1,pasp:1,btrt:1};
    var out=[raw.subarray(0,fixed)], p=fixed;
    while(p+8<=raw.length){
      var dv=new DataView(raw.buffer,raw.byteOffset+p);
      var size=dv.getUint32(0);
      var t=String.fromCharCode(raw[p+4],raw[p+5],raw[p+6],raw[p+7]);
      if(size<8||p+size>raw.length)break;
      if(keep[t])out.push(raw.subarray(p,p+size));
      p+=size;
    }
    var joined=bytes.apply(null,out);
    new DataView(joined.buffer).setUint32(0,joined.length);
    return joined;
  };
  MseEngine.prototype.buildInit=function(trackId,kind){
    var trak=this.mp4.getTrackById(trackId);
    var timescale=trak.mdia.mdhd.timescale;
    var entry=this.minimalEntry(trak.mdia.minf.stbl.stsd.entries[0],kind);
    var ftyp=mkbox('ftyp',fourcc('iso5'),u32a(0x200),fourcc('iso5'),fourcc('iso6'),fourcc('mp41'));
    var mvhd=mkbox('mvhd',u32a(0,0,0,1000,0,0x00010000),u16a(0x0100,0),u32a(0,0),UNITY_MATRIX,
                   u32a(0,0,0,0,0,0),u32a(0xFFFFFFFF));
    var tkhd=mkbox('tkhd',u32a(3,0,0,trackId,0,0,0,0),u16a(0,0,kind==='audio'?0x0100:0,0),UNITY_MATRIX,
                   u32a(trak.tkhd.width,trak.tkhd.height));
    var mdhd=mkbox('mdhd',u32a(0,0,0,timescale,0),u16a(0x55C4,0));
    var handlerName=kind==='video'?'VideoHandler':'SoundHandler';
    var nameBytes=new Uint8Array(handlerName.length+1);
    for(var hn=0;hn<handlerName.length;hn++)nameBytes[hn]=handlerName.charCodeAt(hn);
    var hdlr=mkbox('hdlr',u32a(0,0),fourcc(kind==='video'?'vide':'soun'),u32a(0,0,0),nameBytes);
    var header=(kind==='video')?mkbox('vmhd',u32a(1),u16a(0,0,0,0)):mkbox('smhd',u32a(0,0));
    var dinf=mkbox('dinf',mkbox('dref',u32a(0,1),mkbox('url ',u32a(1))));
    var stbl=mkbox('stbl',
      mkbox('stsd',u32a(0,1),entry),
      mkbox('stts',u32a(0,0)),mkbox('stsc',u32a(0,0)),mkbox('stsz',u32a(0,0,0)),mkbox('stco',u32a(0,0)));
    var trak8=mkbox('trak',tkhd,mkbox('mdia',mdhd,hdlr,mkbox('minf',header,dinf,stbl)));
    var mvex=mkbox('mvex',mkbox('trex',u32a(0,trackId,1,0,0,0)));
    return bytes(ftyp,mkbox('moov',mvhd,trak8,mvex)).buffer;
  };
  /* Field-for-field the shape of ffmpeg's fMP4 (the casthls packages this
     TV generation gets served): tfhd carries per-track defaults
     (flags 0x020038), tfdt is version 1, trun is v0/0xF01 multi-sample
     with unsigned cts. */
  MseEngine.prototype.buildSegment=function(trackId,samples){
    var n=samples.length, i, total=0;
    for(i=0;i<n;i++) total+=samples[i].data.byteLength;
    var baseDts=samples[0].dts;
    var isVideo=trackId===this.videoTrackId;
    /* mfhd sequence: per SourceBuffer, starting at 1, contiguous — the
       shape ffmpeg writes. A shared counter gives each buffer a gapped
       sequence starting past 1; desktop Chrome ignores mfhd entirely but
       a strict demuxer validating continuity rejects the stream. */
    var seqKey=isVideo?'video':'audio';
    this.seq[seqKey]=(this.seq[seqKey]||0)+1;
    var trunSize=20+16*n;
    var trafSize=8+28+20+trunSize;
    var moofSize=8+16+trafSize;
    var buf=new ArrayBuffer(moofSize+8+total);
    var view=new DataView(buf);
    var p=0;
    function u32(val){view.setUint32(p,val);p+=4;}
    function tag(s){for(var c=0;c<4;c++)view.setUint8(p+c,s.charCodeAt(c));p+=4;}
    u32(moofSize);tag('moof');
    u32(16);tag('mfhd');u32(0);u32(this.seq[seqKey]);
    u32(trafSize);tag('traf');
    u32(28);tag('tfhd');u32(0x020038);u32(trackId);          // base-is-moof + defaults
    u32(samples[0].duration);u32(samples[0].data.byteLength);
    u32(isVideo?0x01010000:0x02000000);
    u32(20);tag('tfdt');u32(0x01000000);                     // version 1, 64-bit
    u32(Math.floor(baseDts/4294967296));u32(baseDts>>>0);
    u32(trunSize);tag('trun');u32(0x000F01);u32(n);u32(moofSize+8);
    for(i=0;i<n;i++){
      var s=samples[i];
      u32(s.duration);
      u32(s.data.byteLength);
      u32(s.is_sync?0x02000000:0x01010000);                  // key / depends+non-sync
      var cts=s.cts-s.dts; u32(cts>0?cts:0);                 // trun v0: unsigned
    }
    u32(total+8);tag('mdat');
    var out=new Uint8Array(buf);
    for(i=0;i<n;i++){out.set(samples[i].data,p);p+=samples[i].data.byteLength;}
    return buf;
  };
  MseEngine.prototype.onReady=function(info){
    this.readyFired=true;
    var video=info.videoTracks&&info.videoTracks[0];
    this.audioTracks=info.audioTracks||[];
    var audio=this.audioTracks[this.wantAudioIndex]||this.audioTracks[0];
    if(!video||!audio){playbackError('This video is missing a track the player needs.');return;}
    if(!canPlay('video',mimeCodec(video.codec))){playbackError('This browser can’t decode the video: '+codecName(video.codec)+'.');return;}
    if(!canPlay('audio',mimeCodec(audio.codec))){playbackError('This browser can’t decode the audio: '+codecName(audio.codec)+'.');return;}
    this.videoTrackId=video.id; this.audioTrackId=audio.id;
    if(info.duration&&info.timescale){try{this.mediaSource.duration=info.duration/info.timescale}catch(e){}}
    var self=this;
    try{
      this.buffers.video=this.mediaSource.addSourceBuffer('video/mp4; codecs="'+mimeCodec(video.codec)+'"');
      this.buffers.audio=this.mediaSource.addSourceBuffer('audio/mp4; codecs="'+mimeCodec(audio.codec)+'"');
    }catch(e){playbackError('This browser can’t decode this format.');return;}
    ['video','audio'].forEach(function(kind){
      self.buffers[kind].addEventListener('updateend',function(){self.drain(kind)});
    });
    this.seq={video:0,audio:0};
    /* Phase costs, reported in one line below. onReady sits inside
       appendBuffer and its tail calls reposition, so 'engine ready' on its own
       said only that ~3.9 s had gone somewhere in here. */
    var tInit=nowMs();
    try{
      this.enqueue('video',this.buildInit(video.id,'video'));
      this.enqueue('audio',this.buildInit(audio.id,'audio'));
    }catch(eInit){playbackError('Could not prepare this video for streaming.');trace('engine init build failed: '+eInit);return;}
    var tExtract=nowMs();
    this.resetExtraction();
    var tStart=nowMs();
    this.mp4.start();
    var tDone=nowMs();
    /* Sample counts, because they are what makes the per-sample loops in
       releaseConsumed and mp4box's own seek expensive: a 70-minute film carries
       ~106k video frames and ~198k AAC frames. */
    var counts='';
    try{
      var vtrak=this.mp4.getTrackById(video.id), atrak=this.mp4.getTrackById(audio.id);
      counts=' samples=v'+((vtrak&&vtrak.samples)?vtrak.samples.length:'?')+
             '/a'+((atrak&&atrak.samples)?atrak.samples.length:'?');
    }catch(eCount){}
    trace('engine ready cost: buildInit='+ms(tExtract-tInit)+
          ' resetExtraction='+ms(tStart-tExtract)+
          ' mp4.start='+ms(tDone-tStart)+counts);
    trace('engine ready: video '+video.codec+', '+this.audioTracks.length+' audio, playing #'+this.wantAudioIndex);
    /* Where the viewer actually wants to be, not byte zero. The page sets
       v.currentTime from the load's startTime before the engine is ready, so
       repositioning to 0 aimed at the head of the file, issued a request, and was
       superseded microseconds later when the seek handler repositioned to the
       real start — one generation and one request thrown away on every resume,
       which is most casts. Reading v directly needs no new API: the page has
       already put the answer there. */
    this.reposition(v&&v.currentTime?v.currentTime:0);
  };
  /* (Re)register extraction with fresh accumulators. mp4box keeps a
     pending per-track batch between appends; releasing sample data or
     seeking while one is half-full would deliver stale null-data samples
     and duplicates, so reposition tears the registrations down and back up. */
  MseEngine.prototype.resetExtraction=function(){
    if(this.videoTrackId==null) return;
    this.pending={video:[],audio:[]};
    if(this.extractionActive){
      try{this.mp4.unsetExtractionOptions(this.videoTrackId)}catch(e){}
      try{this.mp4.unsetExtractionOptions(this.audioTrackId)}catch(e2){}
    }
    this.mp4.setExtractionOptions(this.videoTrackId,'video',{nbSamples:100});
    this.mp4.setExtractionOptions(this.audioTrackId,'audio',{nbSamples:100});
    this.extractionActive=true;
  };
  /* Fragments are cut at video keyframes, exactly like ffmpeg's
     frag_keyframe: old TV demuxers treat each moof as independently
     decodable, and a fragment starting mid-GOP (non-sync first sample)
     kills the decoder — the TV played precisely one GOP (~3s) of the
     fixed-100-sample cut before dying. Extraction batches are pooled
     per track and emitted [keyframe .. next keyframe); audio (every
     AAC frame is sync) keeps fixed batches. */
  MseEngine.prototype.onSamples=function(id,kind,samples){
    if(!samples||!samples.length) return;
    if(!this.pending)this.pending={video:[],audio:[]};
    var pool=this.pending[kind];
    for(var i=0;i<samples.length;i++)pool.push(samples[i]);
    this.emitFragments(id,kind,false);
  };
  MseEngine.prototype.emitFragments=function(id,kind,last){
    var pool=this.pending&&this.pending[kind];
    if(!pool||!pool.length) return;
    for(;;){
      var cut=-1;
      if(kind==='video'){
        for(var i=1;i<pool.length;i++){
          if(pool[i].is_sync){cut=i;break;}
          if(i>=600){cut=i;break;}                 // runaway-GOP safety valve
        }
      }else if(pool.length>=100)cut=100;
      if(cut<0){
        if(!last)return;
        cut=pool.length;                            // EOF: flush the tail
      }
      var chunk=pool.splice(0,cut);
      if(!chunk.length)return;
      var segment=null;
      try{ segment=this.buildSegment(id,chunk); }
      catch(e){ this.fatal('segment build failed: '+e); return; }
      if(kind!=='video'||!this.videoBuffered(chunk)) this.enqueue(kind,segment);
      try{ this.mp4.releaseUsedSamples(id,chunk[chunk.length-1].number); }catch(e2){}
      if(!pool.length)return;
    }
  };
  MseEngine.prototype.videoBuffered=function(samples){
    var sb=this.buffers.video;
    if(!sb||!sb.buffered.length) return false;
    var first=samples[0], last=samples[samples.length-1];
    if(!first.timescale) return false;
    var t0=first.cts/first.timescale, t1=last.cts/last.timescale;
    for(var i=0;i<sb.buffered.length;i++)
      if(sb.buffered.start(i)-.05<=t0&&t1<=sb.buffered.end(i)+.05) return true;
    return false;
  };
  MseEngine.prototype.enqueue=function(kind,buffer){if(!buffer)return;this.queues[kind].push(buffer);this.drain(kind)};
  MseEngine.prototype.drain=function(kind){
    var sb=this.buffers[kind];
    if(this.dead||!sb||sb.updating||this.mediaSource.readyState==='closed') return;
    var next=this.queues[kind].shift(); if(!next) return;
    try{sb.appendBuffer(next)}catch(e){
      if(e.name==='QuotaExceededError'){this.queues[kind].unshift(next);this.evict(kind)}
      else if(v.error){
        /* The element is fatally errored — every future append fails the
           same way, so hand straight off to the plain-playback fallback
           instead of retrying forever. */
        this.fatal('media element error code='+v.error.code+(v.error.message?' '+v.error.message:'')+' during '+kind+' append');
      }
      else trace('engine append '+kind+' failed: '+e);
    }
  };
  MseEngine.prototype.evict=function(kind){
    var sb=this.buffers[kind], now=v.currentTime||0, keepFrom=Math.max(0,now-20);
    try{if(!sb.updating&&sb.buffered.length&&sb.buffered.start(0)<keepFrom-1)sb.remove(0,keepFrom)}catch(e){}
  };
  MseEngine.prototype.aheadOf=function(kind){
    var sb=this.buffers[kind]; if(!sb||!sb.buffered.length)return 0;
    var now=v.currentTime||0;
    for(var i=0;i<sb.buffered.length;i++){
      if(sb.buffered.start(i)<=now&&now<=sb.buffered.end(i))return Math.max(0,sb.buffered.end(i)-now);
    }
    return 0;
  };
  MseEngine.prototype.bufferedAheadSec=function(){return Math.min(this.aheadOf('video'),this.aheadOf('audio'))};
  MseEngine.prototype.finish=function(gen){
    trace('engine finish gen='+gen+' @'+this.fetchOffset);
    this.mp4.flush();
    if(this.videoTrackId!=null)this.emitFragments(this.videoTrackId,'video',true);
    if(this.audioTrackId!=null)this.emitFragments(this.audioTrackId,'audio',true);
    this.endStreamWhenDrained(gen);
  };
  /* ES5 on purpose (XHR chain instead of async/fetch): since the TV's MSE
     proved capable via the hls.js fallback, the engine itself can run on
     2017-era parsers too — full multi-audio direct MP4 on old TVs.
     The byte source is pluggable so the same proven engine serves both
     receivers: HTTP Range on the LAN, WebRTC data channel when remote.
     A fetcher is fetch(path,start,endInclusive,cb) -> {abort:fn}, calling
     cb(err,{buffer,total,status}); xhr.abort() gives the default source the
     same .abort() surface reposition/destroy expect. */
  MseEngine.prototype.pump=function(offset){
    var self=this, gen=++this.fetchGen, CHUNK=2*1024*1024;
    /* One line per pump: healthy playback pumps once per seek; a pump storm
       IS the bug being hunted, and this makes it name its caller's cadence. */
    trace('engine pump @'+offset+' gen='+gen);
    /* The first probe of a moov-at-end file exists to read one number: where
       mp4box says to look next. It cost a full 2 MB chunk — 2-5s over a data
       channel — to learn it. 64 KB carries ftyp and the head of the next box,
       which is all the parse pointer needs. */
    var PROBE=64*1024;
    this.fetchOffset=offset;
    function step(){
      if(self.dead||gen!==self.fetchGen) return;
      if(self.bufferedAheadSec()>90){
        setTimeout(function(){
          if(self.dead||gen!==self.fetchGen) return;
          self.evict('video');self.evict('audio');step();
        },500);
        return;
      }
      if(self.totalBytes!=null&&self.fetchOffset>=self.totalBytes){self.finish(gen);return;}
      var start=self.fetchOffset;
      self.requestedStart=start;
      /* Small first look; full chunks once we know where we are going. `want`
         travels with the request so a short body isn't misread as EOF. */
      var want=(!self.readyFired&&start===0&&self.appendCount==null)?PROBE:CHUNK;
      /* Ask for the moov in ONE request of exactly its size.
         The probe already lands the parse pointer on the moov — what it cannot
         know is how big the box is, so the fetch fell back to blind 2 MB chunks
         and a 4.25 MB moov cost three round trips (measured: 792 ms + 1370 ms +
         150 ms) plus a short tail read. The sender reads the real length off
         local disk in a few 16-byte reads and sends it with the load. Worth more
         than the round trips it saves here: a long film's moov scales, and at
         2 MB a chunk a 20 MB header is ten serial round trips before anything
         decodes.
         Guarded on totalBytes so a stale or wrong hint can't ask past the end
         of the file. */
      var exact=false;
      if(!self.readyFired&&self.initRange&&self.initRange.length>0){
        var moovEnd=self.initRange.start+self.initRange.length;
        if(start>=self.initRange.start&&start<moovEnd&&
           (self.totalBytes==null||moovEnd<=self.totalBytes)){
          /* The whole moov in one request, and NOT capped at CHUNK.
             It was capped for one commit, on one sample: a 4.46 MB single
             request had measured 0.58 MB/s against 1.93 MB/s for the same bytes
             in 2 MB pieces, so request size looked like the culprit. The sender
             then reported where that time went — drain=1573ms of 1597ms, 98%
             spent waiting for the data channel to accept bytes — and a second
             run of the same single request managed 2.66 MB/s, FASTER than the
             2 MB requests after it in the same session (1.45 and 1.67 MB/s),
             with startup at 2.28 s against the chunked 3.27 s. The transport is
             the limit and it is variable; the request size was never the cause.
             So: one request, and reading past the moov's end is what the length
             prevents. */
          var remaining=moovEnd-start;
          want=remaining;
          exact=true;
        }
      }
      /* Shared by both byte sources: parse, append, trace, advance. */
      function consume(buf,status,rangeText){
        if(self.dead||gen!==self.fetchGen)return;
        if(!buf||!buf.byteLength){self.finish(gen);return;}
        buf.fileStart=start;
        var next, wasReady=self.readyFired, parseStart=nowMs(), parseMs=0;
        /* This one call is where the startup time hides. Measured on the TV, the
           append that completed the moov took 3.87 s between its fetch landing
           and 'engine ready' — and onReady runs INSIDE appendBuffer, which in
           turn calls reposition, so this number brackets mp4box's parse plus
           everything onReady and the first reposition do. The phase traces in
           onReady and reposition break down what is inside it. */
        try{ next=self.mp4.appendBuffer(buf); }
        catch(e){
          self.fatal('append failed @'+start+': '+e+(e&&e.stack?' | '+String(e.stack).slice(0,400):''));
          return;
        }
        parseMs=nowMs()-parseStart;
        /* Startup forensics: until onReady fires, record exactly what each
           append saw — a mis-ranged response (http 200, wrong length, or a
           head that isn't a box tag) is invisible after the fact otherwise. */
        /* This traced ONLY while !wasReady, and the failure that actually bites
           happens after onReady: a direct MP4 reaches "engine ready", appends
           one more buffer and reports nothing decoding — with no log line for
           that append, by construction. Post-ready appends trace too now,
           thinned so a 1 GB file can't drown the log. */
        self.appendCount=(self.appendCount||0)+1;
        /* Read by the page's stall watchdog: a transfer still moving must never
           be mistaken for one that has died. */
        self.bytesAppended=(self.bytesAppended||0)+buf.byteLength;
        /* THE append that discovered the moov: readyFired flipped during the
           appendBuffer above, and it landed past the start of the file — a
           moov-at-end layout. Remember the parsed tail so the post-ready
           sequential fetch neither re-downloads it nor runs past it.
           The test used to be `readyFired && start>0`, which is true of every
           post-ready sequential append; it escaped re-arming the "tail" on all
           of them only by sitting inside the thinned `loud` trace, and so still
           clobbered it every 32nd append. That IS the bogus tail the skip below
           has to bound against — fixed here rather than defended against there.
           Recorded BEFORE the generation handoff, because parsed bytes are a
           fact about the file whoever asked for them, and the discovering
           append is precisely the one onReady retires mid-call. */
        if(!wasReady&&self.readyFired&&start>0){
          self.parsedTail={start:start,end:start+buf.byteLength};
          trace('engine parsedTail armed @'+self.parsedTail.start+'-'+self.parsedTail.end+
                ' (total='+(self.totalBytes==null?'?':self.totalBytes)+')');
        }
        /* appendBuffer is RE-ENTRANT: mp4box fires onReady from inside it, and
           onReady repositions — retiring this generation and issuing the next
           request before the append above has even returned. Everything below
           belongs to a generation that no longer exists. Left to run it
           compared `start` against the NEW request's requestedStart and cried
           "RANGE MISMATCH: asked @65536 got @1128452362" — a phantom, logged
           3 ms after a pump it was nested inside, and read for a whole
           investigation as a data channel serving stale bodies. Worse, it
           armed parsedTail from the very append reposition had just finished
           dropping the tail for, and would have overwritten the fresh
           generation's fetchOffset. Hand off here; the new generation owns the
           cursor now. */
        if(self.dead||gen!==self.fetchGen){
          /* parse= belongs here above all: the append that completes the moov
             is exactly the one whose generation onReady retires, so reporting
             it only on the normal path below would drop the single number this
             instrumentation exists to capture. */
          trace('engine append @'+start+' len='+buf.byteLength+' parse='+ms(parseMs)+
                ': gen '+gen+' retired during append — handing off');
          return;
        }
        var loud=!wasReady||self.appendCount<=4||self.appendCount%32===0;
        if(self.requestedStart!=null&&self.requestedStart!==start){
          /* A byte source serving a range nobody asked for looks exactly like
             the cursor moving on its own, and those need different fixes. */
          trace('engine RANGE MISMATCH: asked @'+self.requestedStart+' got @'+start);
        }
        if(loud){
          var tag='';
          try{
            var dv=new DataView(buf);
            tag=String.fromCharCode(dv.getUint8(4),dv.getUint8(5),dv.getUint8(6),dv.getUint8(7));
          }catch(eTag){}
          trace('engine append #'+self.appendCount+' @'+start+' http='+status+
                ' len='+buf.byteLength+' box='+tag+' cr='+(rangeText||'none')+
                ' next='+next+' ready='+(self.readyFired?1:0)+
                ' want='+(self.requestedStart==null?'?':self.requestedStart)+
                ' parse='+ms(parseMs));
        }
        if(self.dead||gen!==self.fetchGen)return;
        if(buf.byteLength<want){
          /* A short read normally means end of file. Not for the exact-size moov
             request: there, short means the sender's hint disagreed with what the
             file served, and treating that as EOF would end the stream before
             anything decoded. Drop the hint and let the parse pointer carry on
             exactly as it did before hints existed. */
          if(!exact){self.finish(gen);return;}
          trace('engine init hint short: asked '+want+' got '+buf.byteLength+' — dropping hint');
          self.initRange=null;
        }
        if(!self.readyFired){
          /* Still hunting for the moov: follow mp4box's parse pointer — but
             never back INTO the window just appended. While a box is bigger
             than one chunk (a long movie's moov easily is), mp4box answers
             with the offset of the still-incomplete box, which is inside the
             bytes we just gave it; refetching from there re-feeds the same
             chunk and pins the engine in a hot loop on one range (observed
             live: the same 2 MB served 20×/second forever). Anything pointing
             back into this window means: keep reading forward — mp4box
             accumulates the partial box until it completes. */
          var jump=typeof next==='number'?next:start+buf.byteLength;
          if(jump>=start&&jump<start+buf.byteLength){
            trace('engine: parse pointer '+jump+' inside appended ['+start+'-'+(start+buf.byteLength)+') — reading on');
            jump=start+buf.byteLength;
          }
          self.fetchOffset=jump;
        }else{
          /* Extraction needs every mdat byte — mp4box's parse pointer would
             skip straight past unparsed sample data to EOF, ending the
             stream minutes early. Fetch sequentially instead. */
          var nextOff=start+buf.byteLength;
          /* Skip the tail only when the cursor lands INSIDE it. The old
             unbounded `nextOff >= tail.start` REWOUND any position past the
             tail back to tail.end — and when the moov spans a chunk boundary,
             ready fires mid-append and that ordinary chunk gets recorded as
             the "tail", so every advance past it snapped back: the same 2 MB
             range served ~370× in one sitting (the stall, caught in the
             sender log). Inside-only bounds keep the real moov-at-end skip
             and make the bogus-tail case harmless — skipping bytes that are
             genuinely already parsed. */
          if(self.parsedTail&&nextOff>=self.parsedTail.start&&nextOff<self.parsedTail.end){
            if(self.parsedTail.end>=(self.totalBytes||Infinity)){
              trace('engine finish: parsedTail reaches EOF @'+self.parsedTail.end);
              self.finish(gen);return;
            }
            trace('engine skip parsedTail: '+nextOff+' → '+self.parsedTail.end);
            nextOff=self.parsedTail.end;
          }
          self.fetchOffset=nextOff;
        }
        step();
      }
      /* The moov may already be arriving unasked. The sender starts pushing it
         when it sends the load, so by the time the probe has landed and the
         parse pointer points here, most or all of it is in hand — and on a
         cellular uplink that is two round trips of latency and the whole ramp-up
         of the session's biggest transfer, removed.
         `pending` must WAIT rather than fetch: re-requesting a 4.46 MB range
         already in flight would double someone's mobile data and, on one ordered
         channel, the duplicate would queue behind the original anyway. */
      if(exact&&self.pushedMoov){
        var pushed=self.pushedMoov(start,want);
        if(pushed&&pushed.data){
          /* An ArrayBuffer, exactly `want` long — consume() stamps fileStart on
             it and hands it to mp4box like any fetched window. */
          trace('engine moov from push: '+pushed.data.byteLength+' bytes @'+start+' (no request)');
          consume(pushed.data,206,'push');
          return;
        }
        if(pushed&&pushed.pending){
          self.pushWaitMs=(self.pushWaitMs||0)+100;
          if(self.pushWaitMs<20000){
            setTimeout(function(){ if(!self.dead&&gen===self.fetchGen)step(); },100);
            return;
          }
          trace('engine moov push did not finish in 20s — requesting it');
        }
      }
      /* Injected byte source (WebRTC data channel). Ranges are inclusive on
         both ends, matching the HTTP Range header the default source sends. */
      if(self.fetcher){
        var req=self.fetcher(self.path,start,start+want-1,function(err,res){
          if(self.inflight===req)self.inflight=null;
          if(self.dead||gen!==self.fetchGen)return;
          if(err){self.fatal('fetch failed @'+start+': '+(err&&err.message||err));return;}
          res=res||{};
          if(res.status===416){self.finish(gen);return;}
          if(res.total!=null)self.totalBytes=res.total;
          consume(res.buffer,res.status||206,res.total!=null?('bytes '+start+'-/'+res.total):'');
        });
        self.inflight=req;
        return;
      }
      var xhr=new XMLHttpRequest();
      self.inflight=xhr;
      xhr.open('GET',self.path,true);
      xhr.responseType='arraybuffer';
      xhr.setRequestHeader('Range','bytes='+start+'-'+(start+want-1));
      xhr.onload=function(){
        if(self.inflight===xhr)self.inflight=null;
        if(self.dead||gen!==self.fetchGen)return;
        if(xhr.status===416){self.finish(gen);return;}
        if(xhr.status<200||xhr.status>=300){self.fatal('fetch failed @'+start+': HTTP '+xhr.status);return;}
        var cr=xhr.getResponseHeader('Content-Range')||'', match=/\/(\d+)$/.exec(cr);
        if(match)self.totalBytes=parseInt(match[1],10);
        consume(xhr.response,xhr.status,cr);
      };
      xhr.onerror=function(){
        if(self.inflight===xhr)self.inflight=null;
        if(self.dead||gen!==self.fetchGen)return;
        self.fatal('fetch failed @'+start+': network error');
      };
      xhr.onabort=function(){ if(self.inflight===xhr)self.inflight=null; };
      xhr.send();
    }
    step();
  };
  MseEngine.prototype.endStreamWhenDrained=function(gen){
    var self=this;
    var tryEnd=function(){
      if(self.dead||gen!==self.fetchGen||self.mediaSource.readyState!=='open')return;
      if(self.queues.video.length||self.queues.audio.length||self.buffers.video.updating||self.buffers.audio.updating){setTimeout(tryEnd,200);return;}
      try{self.mediaSource.endOfStream()}catch(e){}
    };
    tryEnd();
  };
  MseEngine.prototype.releaseConsumed=function(){
    var ids=[this.videoTrackId];
    for(var a=0;a<this.audioTracks.length;a++)ids.push(this.audioTracks[a].id);
    /* STOP at the first unread sample instead of walking all of them.
       This loop ran to the end of every track to find the last sample already
       read, and on the TV that cost 3036 ms — to discover that 6 samples out of
       288,061 had been read. It was 35% of an 8.6 s startup, every reposition,
       with the main thread frozen throughout. A Node harness on a Mac timed the
       same loop at 7 ms and had me calling it exonerated; the device is 430×
       slower and the only measurement that counted was the one from the
       television.
       Breaking early is not an approximation: consumed samples form a prefix, so
       the last read sample is the one before the first unread one. Verified
       against real mp4box output — full scan and early exit agreed exactly
       (224 and 420 on a 70-minute file) while the exit cost 0.01 ms against
       2.6 ms. (The other candidate, a high-water mark from onSamples, did NOT
       agree — 200 against 224 — because mp4box reads bytes ahead of what it
       delivers. It would have quietly released less.)
       The one give: should mp4box ever read non-contiguously, after a
       discontinuous seek say, this returns a smaller `upto` and frees less than
       before. Worth it — every reposition observed released 6 samples, so the
       full scan was burning three seconds to free almost nothing, and the
       instrumentation below would show any divergence as a surprising
       `released=`. */
    var scanned=0, released=0, scanMs=0, freeMs=0, t;
    for(var k=0;k<ids.length;k++){
      var trak=this.mp4.getTrackById(ids[k]);if(!trak||!trak.samples)continue;
      var upto=0;
      t=nowMs();
      for(var i=0;i<trak.samples.length;i++){
        if(!(trak.samples[i].alreadyRead>0))break;
        upto=i+1;
      }
      scanMs+=nowMs()-t;
      scanned+=upto+1;   /* what the loop actually touched, not the track length */
      if(upto>0){
        released+=upto;trak.lastValidSample=0;
        t=nowMs();
        try{this.mp4.releaseUsedSamples(ids[k],upto)}catch(e){}
        freeMs+=nowMs()-t;
      }
    }
    this.lastReleaseStats='scan='+ms(scanMs)+' free='+ms(freeMs)+
                          ' touched='+scanned+' released='+released;
  };
  MseEngine.prototype.reposition=function(timeSec){
    /* Retire the current generation BEFORE aborting so a byte source that
       reports cancellation through its error path can't be mistaken for a
       real fetch failure (pump() takes the next generation below). */
    this.fetchGen++;
    if(this.inflight){try{this.inflight.abort()}catch(e){}this.inflight=null;}
    /* "dropping parsedTail=" it said, for months, while never assigning it —
       there is no writer here and never was. It is KEPT deliberately: the moov
       of a moov-at-end file stays parsed across a seek, and re-downloading it
       every reposition would be pure waste. Say what happens. */
    trace('engine reposition: keeping parsedTail='+
          (this.parsedTail?this.parsedTail.start+'-'+this.parsedTail.end:'none')+
          ' ready='+(this.readyFired?1:0));
    /* One line for three calls, deliberately. The FIRST reposition — the one
       onReady triggers — took 5.94 s on the TV while every later one took
       ~0.3 s, and from outside these three are indistinguishable. Separate
       traces could not tell them apart either: emitted while the main thread is
       blocked, none of them can be sent until the block ends, so their
       timestamps would all pile up at the far side. */
    var t0=nowMs();
    this.resetExtraction();
    var t1=nowMs();
    this.releaseConsumed();
    var t2=nowMs();
    var seek;try{seek=this.mp4.seek(Math.max(0,timeSec),true)}catch(e){trace('engine seek failed: '+e);return;}
    var t3=nowMs();
    trace('engine reposition cost: resetExtraction='+ms(t1-t0)+
          ' releaseConsumed='+ms(t2-t1)+' ('+(this.lastReleaseStats||'?')+')'+
          ' seek='+ms(t3-t2)+' total='+ms(t3-t0)+
          ' first='+(this.repositionCount?0:1));
    this.repositionCount=(this.repositionCount||0)+1;
    trace('engine reposition t='+(Math.round(timeSec*100)/100)+' → @'+seek.offset);
    this.pump(seek.offset);
  };
  MseEngine.prototype.setAudioTrack=function(index){
    if(!this.audioTracks[index]||index===this.wantAudioIndex)return;
    trace('engine audio → #'+index);
    if(this.onAudioSwitch)this.onAudioSwitch(index);
  };
  MseEngine.prototype.destroy=function(){
    this.dead=true;this.fetchGen++;
    if(this.inflight){try{this.inflight.abort()}catch(e){}this.inflight=null;}
    try{this.mp4.stop()}catch(e){}try{URL.revokeObjectURL(this.objectUrl)}catch(e){}
  };
  window.MseEngine=MseEngine;
})();
