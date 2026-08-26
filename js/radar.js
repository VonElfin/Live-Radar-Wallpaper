(function () {
  'use strict';

  // -------------------------------------------------------------------
  // ADS-B data providers, all serving the same free "v2/point" JSON shape
  // ({ ac: [...], now, total }). We stay on whichever one answered last and
  // only rotate when a request actually fails, so one provider rate-limiting
  // us doesn't turn into a stampede across all three.
  // -------------------------------------------------------------------
  var PROVIDERS = [
    { name: 'ADSB.one', url: function (lat, lon, nm) { return 'https://api.adsb.one/v2/point/' + lat + '/' + lon + '/' + nm; } },
    { name: 'adsb.lol', url: function (lat, lon, nm) { return 'https://api.adsb.lol/v2/point/' + lat + '/' + lon + '/' + nm; } },
    { name: 'adsb.fi', url: function (lat, lon, nm) { return 'https://opendata.adsb.fi/api/v2/point/' + lat + '/' + lon + '/' + nm; } }
  ];
  var providerIndex = 0;
  var FETCH_INTERVAL = 3000;   // ms, comfortably under the ~1 req/s limits
  var REQUEST_TIMEOUT = 8000;  // ms before we give up on a hung request
  var STALE_AFTER = 12000;     // ms without fresh data -> flag the HUD
  var DROP_AFTER = 90000;      // ms without fresh data -> stop drawing ghosts
  var EMERGENCY_SQUAWKS = { '7500': 1, '7600': 1, '7700': 1 };
  var TRACKS_MAX = 6;

  var TILES = {
    labels: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    plain: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png'
  };

  var map, tileLayer, canvas, ctx;
  var scale = 1;
  var sweepAngle = 0;
  var lastTs = null;

  var lastAircraft = [];       // contacts currently drawn, each carries ._pt
  // hex -> timestamp of the last beam hit. Kept outside the aircraft objects
  // because every fetch replaces those wholesale, which would reset the glow.
  var litAt = Object.create(null);
  var lastRawData = null;
  var lastGoodAt = 0;
  var currentSource = PROVIDERS[0].name;
  var haveData = false;

  var LABEL_NEVER = 0, LABEL_HOVER = 1, LABEL_ALWAYS = 2;
  var REVEAL_SWEEP = 1;

  var tracks = [];             // pinned targets shown in the TRACKS panel
  var selectedHex = null;
  var hoveredHex = null;
  var followMode = false;
  var manualView = false;      // user drove the view; stop auto-recentering
  var fetchTimer = null;
  var toastTimer = null;

  // ------------------------------- helpers -------------------------------
  function pad(n) { return String(n).padStart(2, '0'); }
  function $(id) { return document.getElementById(id); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function callsignOf(ac) {
    return (ac.flight && ac.flight.trim()) ? ac.flight.trim() : ac.hex.toUpperCase();
  }
  function altLabel(ac) {
    return ac._ground ? 'GND' : Math.round(ac._alt).toLocaleString('en-US') + 'ft';
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function bearingLabel(deg) {
    var dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  }

  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 1800);
  }

  // ------------------------------- layout -------------------------------
  // One scale factor drives every HUD dimension (CSS via --s, canvas via the
  // `scale` variable) so the wallpaper reads the same on a 768p laptop, a 4K
  // panel, and a rotated 1080x2560 portrait monitor.
  function recomputeScale() {
    var base = Math.min(window.innerWidth, window.innerHeight) / 1080;
    scale = clamp(base, 0.6, 2.5) * (CONFIG.uiscale / 100);
    document.documentElement.style.setProperty('--s', scale.toFixed(3));
  }

  function applyBottomMargin() {
    document.documentElement.style.setProperty('--bm', Math.round(CONFIG.bottommargin) + 'px');
  }

  // The info and tracks panels share the top row. On a narrow screen - a
  // portrait monitor, or any resolution once UI Scale is cranked up - they stop
  // fitting side by side, so tracks moves under the info panel instead. Docking
  // it to the bottom would collide with the clock.
  function layoutPanels() {
    var info = $('hud-info'), tracks = $('hud-tracks');
    var btns = $('hud-buttons'), clock = $('hud-clock');
    var edge = 14 * scale, gap = 10 * scale;

    // top row: info (left) + tracks (right)
    if (CONFIG.hud) {
      tracks.style.left = '';
      tracks.style.right = '';
      tracks.style.top = '';
      if (edge + info.offsetWidth + gap + tracks.offsetWidth + edge > window.innerWidth) {
        tracks.style.left = edge + 'px';
        tracks.style.right = 'auto';
        tracks.style.top = (info.offsetTop + info.offsetHeight + gap) + 'px';
      }
    }

    // bottom row: buttons (left) + clock (right). The buttons stay pinned above
    // the taskbar, so when the row overflows it's the clock that moves up.
    clock.style.bottom = '';
    if (CONFIG.clock && CONFIG.showbuttons &&
        edge + btns.offsetWidth + gap + clock.offsetWidth + edge > window.innerWidth) {
      clock.style.bottom = (CONFIG.bottommargin + 16 * scale + btns.offsetHeight + gap) + 'px';
    }
  }

  function scheduleLayout() {
    requestAnimationFrame(layoutPanels);
  }

  function computeHomeZoom() {
    var lat = CONFIG.latitude;
    // fit the outer range ring inside the smaller screen dimension
    var desiredPx = Math.min(window.innerWidth, window.innerHeight) * 0.42;
    var metersPerPx = (CONFIG.radius * 1000) / desiredPx;
    var z = Math.log2(156543.03392 * Math.cos(lat * Math.PI / 180) / metersPerPx);
    return clamp(z + CONFIG.zoomoffset, 3, 12);
  }

  function pxPerKmAt(latlng) {
    var p1 = map.latLngToContainerPoint(latlng);
    var probe = L.latLng(latlng.lat + 0.5, latlng.lng);
    var p2 = map.latLngToContainerPoint(probe);
    var pxDist = p1.distanceTo(p2) || 0.0001;
    var meters = map.distance(latlng, probe) || 0.0001;
    return 1000 / (meters / pxDist);
  }

  // ------------------------------- map -------------------------------
  function initMap() {
    map = L.map('map', {
      zoomControl: false,
      attributionControl: true,
      worldCopyJump: true,
      fadeAnimation: false,
      zoomSnap: 0.25
    }).setView([CONFIG.latitude, CONFIG.longitude], computeHomeZoom());

    setTileLayer();

    canvas = $('overlay');
    ctx = canvas.getContext('2d');
    resizeCanvas();

    window.addEventListener('resize', function () {
      recomputeScale();
      resizeCanvas();
      scheduleLayout();
      map.invalidateSize();
      if (!manualView) applyHomeView();
    });

    // dragging the map counts as taking manual control
    map.on('dragstart', function () { manualView = true; });
    map.on('click', handleMapClick);
    map.on('mousemove', handleMapHover);
    map.on('mouseout', function () {
      hoveredHex = null;
      $('tooltip').classList.add('hidden');
    });
  }

  function setTileLayer() {
    if (tileLayer) map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(CONFIG.maplabels ? TILES.labels : TILES.plain, {
      subdomains: 'abcd',
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap &copy; CARTO'
    }).addTo(map);
  }

  function resizeCanvas() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function applyHomeView() {
    map.setView([CONFIG.latitude, CONFIG.longitude], computeHomeZoom(), { animate: false });
  }

  function onLocationChanged() {
    if (!manualView) applyHomeView();
    updateStaticHud();
    fetchOnce();
  }

  // ------------------------------- drawing -------------------------------
  function draw(ts) {
    if (lastTs == null) lastTs = ts;
    var dt = (ts - lastTs) / 1000;
    lastTs = ts;

    var prevSweep = sweepAngle;
    sweepAngle = (sweepAngle + CONFIG.radarspeed * 6 * dt) % 360;

    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    var homeLatLng = L.latLng(CONFIG.latitude, CONFIG.longitude);
    var homePt = map.latLngToContainerPoint(homeLatLng);
    var outerRingPx = Math.max(40, pxPerKmAt(homeLatLng) * CONFIG.radius);

    drawSweep(homePt, outerRingPx);
    if (CONFIG.showrings) drawRings(homePt, outerRingPx);
    drawHomeMark(homePt);
    drawAircraft(homePt, ts, prevSweep);

    $('hud-azimuth').textContent = Math.round(sweepAngle) + '°';
    requestAnimationFrame(draw);
  }

  function drawSweep(homePt, outerRingPx) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(homePt.x, homePt.y, outerRingPx, 0, Math.PI * 2);
    ctx.clip();

    ctx.translate(homePt.x, homePt.y);
    var rad = sweepAngle * Math.PI / 180;
    var sweepR = outerRingPx * 1.05;

    if (ctx.createConicGradient) {
      var grad = ctx.createConicGradient(rad, 0, 0);
      grad.addColorStop(0, 'rgba(60,255,140,0.32)');
      grad.addColorStop(0.16, 'rgba(60,255,140,0)');
      grad.addColorStop(1, 'rgba(60,255,140,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, sweepR, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.rotate(rad);
    ctx.strokeStyle = '#5dffa8';
    ctx.shadowColor = '#5dffa8';
    ctx.shadowBlur = 8 * scale;
    ctx.lineWidth = 1.5 * scale;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(sweepR, 0);
    ctx.stroke();
    ctx.restore();
  }

  function drawRings(homePt, outerRingPx) {
    ctx.save();
    ctx.strokeStyle = 'rgba(55,224,122,0.35)';
    ctx.setLineDash([4 * scale, 6 * scale]);
    ctx.lineWidth = 1 * scale;
    [1 / 3, 2 / 3, 1].forEach(function (frac) {
      ctx.beginPath();
      ctx.arc(homePt.x, homePt.y, outerRingPx * frac, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.restore();
  }

  function drawHomeMark(homePt) {
    var r = 7 * scale;
    ctx.save();
    ctx.strokeStyle = 'rgba(55,224,122,0.6)';
    ctx.lineWidth = 1 * scale;
    ctx.beginPath();
    ctx.moveTo(homePt.x - r, homePt.y);
    ctx.lineTo(homePt.x + r, homePt.y);
    ctx.moveTo(homePt.x, homePt.y - r);
    ctx.lineTo(homePt.x, homePt.y + r);
    ctx.stroke();
    ctx.restore();
  }

  // Did the beam pass over `ang` between the previous frame and this one?
  // The sweep wraps 360 -> 0, so that case is the arc split in two.
  function sweptPast(ang, prev, cur) {
    if (cur >= prev) return ang > prev && ang <= cur;
    return ang > prev || ang <= cur;
  }

  // Screen-space angle of a contact measured from the radar origin, in the same
  // convention the beam is drawn with (0 = +x, growing clockwise).
  function screenAngle(homePt, pt) {
    var a = Math.atan2(pt.y - homePt.y, pt.x - homePt.x) * 180 / Math.PI;
    return (a + 360) % 360;
  }

  function drawAircraft(homePt, nowTs, prevSweep) {
    var w = window.innerWidth, h = window.innerHeight;
    var margin = 60 * scale;
    var sweepReveal = CONFIG.revealmode === REVEAL_SWEEP;
    // a contact stays lit for this long after the beam hits it
    var fadeMs = (60000 / CONFIG.radarspeed) * (CONFIG.blippersist / 100);

    lastAircraft.forEach(function (ac) {
      var pt = map.latLngToContainerPoint(L.latLng(ac.lat, ac.lon));
      ac._pt = pt;
      if (pt.x < -margin || pt.y < -margin || pt.x > w + margin || pt.y > h + margin) return;

      var isSel = (ac.hex === selectedHex);
      var isHov = (ac.hex === hoveredHex);

      if (sweptPast(screenAngle(homePt, pt), prevSweep, sweepAngle)) litAt[ac.hex] = nowTs;

      // Phosphor persistence: full brightness at the moment of the hit, decaying
      // to nothing by the time the beam comes back around.
      var alpha = 1;
      if (sweepReveal) {
        var lit = litAt[ac.hex];
        var age = (lit == null) ? Infinity : nowTs - lit;
        alpha = age >= fadeMs ? 0 : Math.pow(1 - age / fadeMs, 1.1);
        // things you're actively watching shouldn't blink out on you
        if (isSel || isHov) alpha = 1;
        else if (ac._emergency) alpha = Math.max(alpha, 0.55);
        if (alpha <= 0.01) return;
      }

      var color = ac._emergency ? '#ff3b3b' : (ac._unknown ? '#9aa0a6' : '#37e07a');
      if (isSel) color = '#8dffc0';
      var heading = (typeof ac.track === 'number') ? ac.track : 0;

      if (isSel) drawReticle(pt);

      if (CONFIG.showvectors) {
        var len = (14 + Math.min(1, (ac.gs || 0) / 500) * 34) * scale;
        var rad = heading * Math.PI / 180;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = (isSel ? 0.9 : 0.55) * alpha;
        ctx.lineWidth = (isSel ? 1.6 : 1) * scale;
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(pt.x + Math.sin(rad) * len, pt.y - Math.cos(rad) * len);
        ctx.stroke();
        ctx.restore();
      }

      var size = (isSel ? 7.5 : 6) * scale;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(pt.x, pt.y);
      ctx.rotate(heading * Math.PI / 180);
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = (ac._emergency || isSel ? 14 : 6) * scale;
      ctx.beginPath();
      ctx.moveTo(0, -size);
      ctx.lineTo(size * 0.66, size * 0.83);
      ctx.lineTo(-size * 0.66, size * 0.83);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // In sweep mode the readout rides along with the blip, so the data shows
      // up exactly when the beam paints the contact and fades out with it.
      var showLabel = isSel ||
        CONFIG.labelmode === LABEL_ALWAYS ||
        (CONFIG.labelmode === LABEL_HOVER && (isHov || ac._emergency));

      if (showLabel) {
        var dx = 9 * scale;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = 'bold ' + (10 * scale).toFixed(1) + 'px Consolas, monospace';
        ctx.fillStyle = color;
        ctx.fillText(ac._unknown ? 'UNKN' : callsignOf(ac), pt.x + dx, pt.y - 4 * scale);
        ctx.font = (10 * scale).toFixed(1) + 'px Consolas, monospace';
        ctx.fillStyle = 'rgba(150,255,190,0.78)';
        ctx.fillText(altLabel(ac) + (ac.gs ? ' · ' + Math.round(ac.gs) + 'kt' : ''), pt.x + dx, pt.y + 7 * scale);
        ctx.restore();
      }
    });
  }

  function drawReticle(pt) {
    var r = 15 * scale;
    ctx.save();
    ctx.strokeStyle = '#8dffc0';
    ctx.lineWidth = 1.2 * scale;
    ctx.shadowColor = '#8dffc0';
    ctx.shadowBlur = 8 * scale;
    ctx.setLineDash([3 * scale, 4 * scale]);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.setLineDash([]);
    var t = r + 5 * scale, i = r - 3 * scale;
    [[0, -1], [0, 1], [-1, 0], [1, 0]].forEach(function (d) {
      ctx.beginPath();
      ctx.moveTo(pt.x + d[0] * i, pt.y + d[1] * i);
      ctx.lineTo(pt.x + d[0] * t, pt.y + d[1] * t);
      ctx.stroke();
    });
    ctx.restore();
  }

  // ------------------------------- data -------------------------------
  function classify(ac) {
    var altRaw = (ac.alt_baro != null) ? ac.alt_baro : ac.alt_geom;
    ac._ground = (altRaw === 'ground');
    ac._alt = ac._ground ? 0 : (Number(altRaw) || 0);
    ac._unknown = !(ac.flight && ac.flight.trim());
    ac._emergency = !!((ac.emergency && ac.emergency !== 'none') || EMERGENCY_SQUAWKS[String(ac.squawk || '')]);
    ac._hasPos = typeof ac.lat === 'number' && typeof ac.lon === 'number';

    var inRange = ac._alt >= CONFIG.minalt && ac._alt <= CONFIG.maxalt &&
      (ac.gs || 0) >= CONFIG.minspeed && (ac.gs || 0) <= CONFIG.maxspeed;
    // emergencies are never filtered out - that's the whole point of the row
    ac._pass = ac._hasPos && (inRange || ac._emergency);
    return ac;
  }

  function onData(data, sourceName, latencyMs) {
    lastRawData = data;
    currentSource = sourceName;
    lastGoodAt = Date.now();
    haveData = true;

    var raw = (data && data.ac) || [];
    raw.forEach(classify);

    var withPos = raw.filter(function (ac) { return ac._hasPos; });
    var rendered = withPos.filter(function (ac) { return ac._pass; });
    lastAircraft = rendered;

    // drop glow timestamps for contacts that left the area
    var present = Object.create(null);
    rendered.forEach(function (ac) { present[ac.hex] = 1; });
    Object.keys(litAt).forEach(function (hex) {
      if (!present[hex]) delete litAt[hex];
    });

    $('hud-contacts').textContent = rendered.length;
    $('hud-unknowns').textContent = rendered.filter(function (a) { return a._unknown; }).length;
    $('hud-filtered').textContent = withPos.length - rendered.length;

    var emergency = rendered.filter(function (a) { return a._emergency; }).length;
    $('hud-emergency').textContent = emergency;
    $('hud-emergency').classList.toggle('active', emergency > 0);

    if (latencyMs != null) $('hud-latency').innerHTML = latencyMs + '<i>ms</i>';
    $('hud-source').textContent = sourceName;
    setStatus('LIVE', '');

    refreshTracks();
    if (followMode) followSelected();
  }

  function setStatus(text, cls) {
    var el = $('radar-status');
    el.textContent = text;
    el.className = cls;
  }

  function onFetchFailed() {
    if (!haveData) {
      setStatus('NO SIGNAL', 'down');
      $('hud-latency').innerHTML = '--<i>ms</i>';
      return;
    }
    var age = Date.now() - lastGoodAt;
    if (age > DROP_AFTER) {
      // contacts this old are fiction - drop them rather than draw ghosts
      lastAircraft = [];
      haveData = false;
      setStatus('NO SIGNAL', 'down');
      ['hud-contacts', 'hud-unknowns', 'hud-filtered', 'hud-emergency'].forEach(function (id) {
        $(id).textContent = '0';
      });
      $('hud-emergency').classList.remove('active');
      $('hud-latency').innerHTML = '--<i>ms</i>';
      refreshTracks();
    } else if (age > STALE_AFTER) {
      setStatus('STALE ' + Math.round(age / 1000) + 's', 'stale');
    }
  }

  function reFilterFromCache() {
    if (lastRawData) onData(lastRawData, currentSource, null);
  }

  function fetchWithTimeout(url) {
    if (typeof AbortController === 'undefined') return fetch(url, { cache: 'no-store' });
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT);
    return fetch(url, { cache: 'no-store', signal: ctrl.signal })
      .finally(function () { clearTimeout(timer); });
  }

  async function fetchOnce() {
    var lat = Number(CONFIG.latitude).toFixed(4);
    var lon = Number(CONFIG.longitude).toFixed(4);
    var nm = clamp(Math.round(CONFIG.radius / 1.852), 5, 250);

    // While we already have contacts, poke only the provider that works. On a
    // cold start (or after everything died) sweep the list to find a live one.
    var attempts = haveData ? 1 : PROVIDERS.length;

    for (var i = 0; i < attempts; i++) {
      var provider = PROVIDERS[providerIndex];
      var t0 = performance.now();
      try {
        var res = await fetchWithTimeout(provider.url(lat, lon, nm));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();
        onData(data, provider.name, Math.round(performance.now() - t0));
        return;
      } catch (err) {
        providerIndex = (providerIndex + 1) % PROVIDERS.length;
      }
    }
    onFetchFailed();
  }

  function scheduleFetchLoop() {
    clearTimeout(fetchTimer);
    fetchOnce().finally(function () {
      fetchTimer = setTimeout(scheduleFetchLoop, FETCH_INTERVAL);
    });
  }

  // ------------------------------- targets -------------------------------
  function findByHex(hex) {
    for (var i = 0; i < lastAircraft.length; i++) {
      if (lastAircraft[i].hex === hex) return lastAircraft[i];
    }
    return null;
  }

  function nearestAircraft(containerPoint, thresholdPx) {
    var best = null, bestDist = thresholdPx * scale;
    lastAircraft.forEach(function (ac) {
      if (!ac._pt) return;
      var d = Math.hypot(ac._pt.x - containerPoint.x, ac._pt.y - containerPoint.y);
      if (d < bestDist) { bestDist = d; best = ac; }
    });
    return best;
  }

  function handleMapClick(e) {
    var ac = nearestAircraft(e.containerPoint, 18);
    if (ac) {
      selectAircraft(ac);
    } else if (selectedHex) {
      selectedHex = null;
      followMode = false;
      syncFollowButton();
      refreshTracks();
    }
  }

  // Clicking a contact does three things at once: centre the map on it, pin it
  // to the TRACKS panel, and start following it as new positions arrive.
  function selectAircraft(ac) {
    selectedHex = ac.hex;
    followMode = true;
    manualView = true;
    syncFollowButton();

    pinTrack(ac);
    map.setView([ac.lat, ac.lon], Math.max(map.getZoom(), 8), { animate: true });
    refreshTracks();
    toast('TRACKING ' + callsignOf(ac));
  }

  function pinTrack(ac) {
    tracks = tracks.filter(function (h) { return h !== ac.hex; });
    tracks.unshift(ac.hex);
    if (tracks.length > TRACKS_MAX) tracks.length = TRACKS_MAX;
  }

  function followSelected() {
    var ac = findByHex(selectedHex);
    if (ac) map.panTo([ac.lat, ac.lon], { animate: true, duration: 0.6 });
  }

  function refreshTracks() {
    renderDetail();
    renderTrackList();
    scheduleLayout();
  }

  function renderDetail() {
    var el = $('track-detail');
    var ac = selectedHex ? findByHex(selectedHex) : null;
    if (!ac) { el.classList.add('hidden'); return; }

    var dist = haversineKm(CONFIG.latitude, CONFIG.longitude, ac.lat, ac.lon);
    var trk = (typeof ac.track === 'number') ? Math.round(ac.track) : null;
    var rows = [
      ['ALT', altLabel(ac)],
      ['SPEED', Math.round(ac.gs || 0) + ' kt'],
      ['HEADING', trk == null ? '--' : pad(trk) + '° ' + bearingLabel(trk)],
      ['DIST', dist.toFixed(1) + ' km'],
      ['SQUAWK', ac.squawk || '----']
    ];
    if (ac.t) rows.push(['TYPE', ac.t]);

    el.innerHTML =
      '<div class="td-call">' + callsignOf(ac) +
      '<span class="hexid">' + ac.hex.toUpperCase() + '</span></div>' +
      '<div class="td-grid">' +
      rows.map(function (r) { return '<span>' + r[0] + '</span><span>' + r[1] + '</span>'; }).join('') +
      '</div>' +
      (ac._emergency ? '<div class="td-em">! EMERGENCY ' + (ac.squawk || '') + '</div>' : '');
    el.classList.remove('hidden');
  }

  function renderTrackList() {
    var el = $('tracks-list');
    var others = tracks.filter(function (h) { return h !== selectedHex; });

    if (!others.length) {
      el.className = 'tracks-empty';
      el.textContent = selectedHex ? 'click another aircraft to pin it' : 'click an aircraft to track';
      return;
    }

    el.className = '';
    el.innerHTML = others.map(function (hex) {
      var ac = findByHex(hex);
      if (!ac) {
        return '<div class="track-item lost"><span class="cs">' + hex.toUpperCase() +
          '</span><span class="meta">lost</span></div>';
      }
      return '<div class="track-item"><span class="cs">' + callsignOf(ac) +
        '</span><span class="meta">' + altLabel(ac) + ' · ' + Math.round(ac.gs || 0) + 'kt</span></div>';
    }).join('');
  }

  function handleMapHover(e) {
    var ac = nearestAircraft(e.containerPoint, 16);
    var tooltip = $('tooltip');
    hoveredHex = ac ? ac.hex : null;
    map.getContainer().style.cursor = ac ? 'pointer' : '';

    // In hover mode the canvas label is already the reveal, so the tooltip
    // would just repeat it next to itself.
    if (!ac || CONFIG.labelmode === LABEL_HOVER) { tooltip.classList.add('hidden'); return; }

    tooltip.classList.remove('hidden');
    tooltip.style.left = e.containerPoint.x + 'px';
    tooltip.style.top = e.containerPoint.y + 'px';
    tooltip.textContent = (ac._unknown ? 'UNKNOWN' : callsignOf(ac)) +
      ' · ' + altLabel(ac) + ' · ' + Math.round(ac.gs || 0) + 'kt';
  }

  // ------------------------------- buttons -------------------------------
  function zoomBy(delta) {
    manualView = true;
    map.setZoom(clamp(map.getZoom() + delta, map.getMinZoom(), map.getMaxZoom()));
  }

  function syncFollowButton() {
    var btn = $('btn-follow');
    btn.classList.toggle('active', followMode && !!selectedHex);
    btn.disabled = !selectedHex;
  }

  function wireButtons() {
    $('btn-zoomin').addEventListener('click', function () { zoomBy(1); });
    $('btn-zoomout').addEventListener('click', function () { zoomBy(-1); });

    $('btn-follow').addEventListener('click', function () {
      if (!selectedHex) { toast('NO TARGET SELECTED'); return; }
      followMode = !followMode;
      syncFollowButton();
      if (followMode) { followSelected(); toast('FOLLOWING'); }
      else toast('FOLLOW OFF');
    });

    $('btn-reset').addEventListener('click', function () {
      manualView = false;
      followMode = false;
      syncFollowButton();
      applyHomeView();
      toast('VIEW RESET');
    });

    $('btn-clear').addEventListener('click', function () {
      tracks = [];
      selectedHex = null;
      followMode = false;
      syncFollowButton();
      refreshTracks();
      toast('TARGETS CLEARED');
    });
  }

  // ------------------------------- clock -------------------------------
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  function offsetLabel(hours) {
    var sign = hours < 0 ? '-' : '+';
    var abs = Math.abs(hours);
    var whole = Math.floor(abs);
    var mins = Math.round((abs - whole) * 60);
    return 'UTC' + sign + whole + (mins ? ':' + pad(mins) : '');
  }

  function updateClock() {
    var now = new Date();
    var h, mi, se, dow, dom, mon, yr, tz;

    if (CONFIG.usesystemtime) {
      h = now.getHours(); mi = now.getMinutes(); se = now.getSeconds();
      dow = now.getDay(); dom = now.getDate(); mon = now.getMonth(); yr = now.getFullYear();
      tz = offsetLabel(-now.getTimezoneOffset() / 60);
    } else {
      var shifted = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + CONFIG.utcoffset * 3600000);
      h = shifted.getUTCHours(); mi = shifted.getUTCMinutes(); se = shifted.getUTCSeconds();
      dow = shifted.getUTCDay(); dom = shifted.getUTCDate();
      mon = shifted.getUTCMonth(); yr = shifted.getUTCFullYear();
      tz = offsetLabel(CONFIG.utcoffset);
    }

    var suffix = '';
    if (!CONFIG.format24h) {
      suffix = h >= 12 ? ' PM' : ' AM';
      h = h % 12 || 12;
    }
    $('clock-time').textContent = pad(h) + ' ' + pad(mi) + ' ' + pad(se) + suffix;
    $('clock-date').textContent = DAYS[dow] + ', ' + dom + ' ' + MONTHS[mon] + ' ' + yr;
    $('clock-tz').textContent = tz;

    if (haveData && Date.now() - lastGoodAt > STALE_AFTER) onFetchFailed();
  }

  // ------------------------------- config wiring -------------------------------
  function updateStaticHud() {
    $('hud-range').innerHTML = Math.round(CONFIG.radius) + '<i>km</i>';
  }

  function syncVisibility() {
    $('hud-info').classList.toggle('hidden', !CONFIG.hud);
    $('hud-tracks').classList.toggle('hidden', !CONFIG.hud);
    $('hud-clock').classList.toggle('hidden', !CONFIG.clock);
    $('hud-buttons').classList.toggle('hidden', !CONFIG.showbuttons);
    $('map').classList.toggle('hidden', !CONFIG.showmap);
    scheduleLayout();
  }

  function wireConfig() {
    ['hud', 'clock', 'showbuttons', 'showmap'].forEach(function (k) {
      onConfigChange(k, syncVisibility);
    });
    ['latitude', 'longitude', 'radius'].forEach(function (k) {
      onConfigChange(k, onLocationChanged);
    });
    ['minalt', 'maxalt', 'minspeed', 'maxspeed'].forEach(function (k) {
      onConfigChange(k, reFilterFromCache);
    });

    onConfigChange('maplabels', setTileLayer);
    onConfigChange('zoomoffset', function () { manualView = false; applyHomeView(); });
    onConfigChange('autozoom', function (v) { if (v) { manualView = false; applyHomeView(); } });
    onConfigChange('uiscale', function () { recomputeScale(); scheduleLayout(); });
    onConfigChange('bottommargin', function () { applyBottomMargin(); scheduleLayout(); });
  }

  // ------------------------------- bootstrap -------------------------------
  function start() {
    recomputeScale();
    applyBottomMargin();
    initMap();
    wireButtons();
    wireConfig();
    syncVisibility();
    syncFollowButton();
    updateStaticHud();
    refreshTracks();
    scheduleLayout();
    updateClock();
    setInterval(updateClock, 1000);
    scheduleFetchLoop();
    requestAnimationFrame(draw);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
