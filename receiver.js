// PlexDownloader custom receiver — phase 0.
//
// Default CAF playback for everything the default receiver handled (direct
// files, HLS packages), plus a diagnostics channel: the sender can ask what
// THIS device's MSE actually decodes (the per-device answer to every
// "does it support X?" question), and phase 1 adds progressive-MP4 audio
// switching via in-browser demux (mp4box.js → MSE).
'use strict';

const NS = 'urn:x-cast:com.rikard.plexdownloader';
const context = cast.framework.CastReceiverContext.getInstance();

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

context.addCustomMessageListener(NS, (event) => {
  const msg = event.data || {};
  if (msg.type === 'ping') {
    context.sendCustomMessage(NS, event.senderId,
                              { type: 'pong', capabilities: capabilities() });
  }
});

context.start();
