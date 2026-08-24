// Manual allowlist of verified YouTube channels for the live-streaming
// source (src/liveTv.js). A YouTube video only counts as usable once its
// channel has been explicitly approved here.
//
// Why this exists: YouTube's public oEmbed endpoint tells us WHO uploaded a
// video (channel name/URL) — that's a real, verifiable fact. It does NOT
// tell us whether that channel is authorized to broadcast the content
// (oEmbed has no such field, and there isn't a reliable automated way to
// determine broadcast rights). So a video is only trusted once a human has
// looked at the channel and approved it — once per channel, not per video,
// so approving e.g. "Premier League" once covers every future video from
// that same channel automatically.

const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', 'data', 'youtube-channels.json');

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

let _store = loadStore();

function getChannelStatus(channelUrl) {
  return _store[channelUrl] || null; // null = never seen
}

// Records a channel the scraper encountered, without changing its status if
// already reviewed (so re-running the scraper never resets an approval).
function recordChannelSeen(channelUrl, channelName, exampleTitle) {
  if (_store[channelUrl]) return;
  _store[channelUrl] = {
    channelName,
    status: 'pending',
    exampleTitle,
    firstSeenAt: new Date().toISOString(),
  };
  saveStore(_store);
}

function setChannelStatus(channelUrl, status) {
  if (!['approved', 'rejected', 'pending'].includes(status)) return;
  if (!_store[channelUrl]) _store[channelUrl] = { channelName: channelUrl };
  _store[channelUrl].status = status;
  _store[channelUrl].updatedAt = new Date().toISOString();
  saveStore(_store);
}

function getAllChannels() {
  return _store;
}

function isApproved(channelUrl) {
  const entry = _store[channelUrl];
  return entry ? entry.status === 'approved' : false;
}

module.exports = { getChannelStatus, recordChannelSeen, setChannelStatus, getAllChannels, isApproved };
