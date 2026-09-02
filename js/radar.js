(function () {
  'use strict';

  // -------------------------------------------------------------------
  // ADS-B data providers, all serving the same free "v2/point" JSON shape
  // ({ ac: [...], now, total }). We stay on whichever one answered last and
  // only rotate when a request actually fails, so one provider rate-limiting
  // us doesn't turn into a stampede across all three.
  // -------------------------------------------------------------------
  // Every one of these is a separate volunteer receiver network with worldwide
  // but uneven coverage - a plane one of them misses another often has. We query
  // them together and merge by ICAO hex instead of failing over between them.
  // (airplanes.live is deliberately absent: its API requires prior written
  // permission, so shipping it in a public wallpaper would abuse their service.)
  var PROVIDERS = [
    { name: 'adsb.one', url: function (lat, lon, nm) { return 'https://api.adsb.one/v2/point/' + lat + '/' + lon + '/' + nm; } },
    { name: 'adsb.lol', url: function (lat, lon, nm) { return 'https://api.adsb.lol/v2/point/' + lat + '/' + lon + '/' + nm; } },
    { name: 'adsb.fi', url: function (lat, lon, nm) { return 'https://opendata.adsb.fi/api/v2/lat/' + lat + '/lon/' + lon + '/dist/' + nm; } }
  ];
  var FETCH_INTERVAL = 3000;   // ms, comfortably under the ~1 req/s limits
  var REQUEST_TIMEOUT = 8000;  // ms before we give up on a hung request
  var STALE_AFTER = 12000;     // ms without fresh data -> flag the HUD
  var DROP_AFTER = 90000;      // ms without fresh data -> stop drawing ghosts
  // A contact survives this long after its last sighting. Providers drop in and
  // out constantly (rate limits, feeder gaps); without this grace window an
  // aircraft only one network can see blinks out every time that one hiccups.
  var CONTACT_TTL = 25000;
  var ROUTE_API = 'https://api.adsb.lol/api/0/routeset';
  var ROUTE_CDN = 'https://vrs-standing-data.adsb.lol/routes/';
  var ROUTE_BATCH = 100;          // the routeset endpoint rejects more than this
  var ROUTE_CDN_PER_CYCLE = 8;
  var ROUTE_API_COOLDOWN = 120000;
  // Every one of these networks caps a point query at 250 nm; 400 nm is a hard
  // HTTP 400. The range ring can be opened wider than that for framing, but no
  // aircraft will ever exist beyond this distance.
  var DATA_MAX_NM = 250;
  var DATA_MAX_KM = DATA_MAX_NM * 1.852;
  // Both cooldowns stay under CONTACT_TTL on purpose: a rested network is
  // retried before the aircraft only it can see age out of the pool.
  var COOLDOWN_RATELIMIT = 20000;
  var COOLDOWN_ERROR = 10000;
  var EMERGENCY_SQUAWKS = { '7500': 1, '7600': 1, '7700': 1 };
  var TRACKS_MAX = 6;

  // CARTO's free basemaps.cartocdn.com tiles started requiring a signup-gated
  // API key; without one every tile now renders with an "API KEY REQUIRED"
  // watermark baked into the image. Esri's Dark Gray Canvas is genuinely free,
  // no key, no quota - just attribution - so that's the base layer now. It's a
  // medium gray rather than near-black, which the CSS filter in style.css
  // corrects. Labels are Esri's separate "Reference" layer (transparent PNG)
  // so "Map City Labels" can toggle them without reloading the base tiles.
  var TILE_BASE = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
  var TILE_LABELS = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}';
  var TILE_ATTRIBUTION = '&copy; Esri, HERE, Garmin, OpenStreetMap contributors';

  var map, tileLayer, labelLayer, canvas, ctx;
  var scale = 1;
  var sweepAngle = 0;
  var lastTs = null;

  var lastAircraft = [];       // contacts currently drawn, each carries ._pt
  // hex -> timestamp of the last beam hit. Kept outside the aircraft objects
  // because every fetch replaces those wholesale, which would reset the glow.
  var litAt = Object.create(null);
  // hex -> latest known record for that aircraft, pooled across providers AND
  // across polls so a single missed reply can't erase anyone.
  var contacts = Object.create(null);
  var providerCooldown = Object.create(null);
  // callsign -> route verdict, or null once we've asked and found nothing
  var routeCache = Object.create(null);
  var routePending = Object.create(null);
  var routeApiCooldown = 0;
  var lastSources = [];
  var lastGoodAt = 0;
  var haveData = false;
  var fetchGen = 0;            // bumped on every poll so stale replies can't land
  var locationTimer = null;

  var LABEL_NEVER = 0, LABEL_HOVER = 1, LABEL_ALWAYS = 2;
  var REVEAL_SWEEP = 1;
  var FLIGHT_ALL = 0, FLIGHT_DOM = 1, FLIGHT_INT = 2;

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
    if (!tileLayer) {
      tileLayer = L.tileLayer(TILE_BASE, { maxZoom: 16, attribution: TILE_ATTRIBUTION }).addTo(map);
    }
    if (CONFIG.maplabels && !labelLayer) {
      labelLayer = L.tileLayer(TILE_LABELS, { maxZoom: 16 }).addTo(map);
    } else if (!CONFIG.maplabels && labelLayer) {
      map.removeLayer(labelLayer);
      labelLayer = null;
    }
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

  // The lat/lon boxes emit a property update on every keystroke and the radius
  // slider on every drag step, so settle first instead of firing a poll per
  // character and getting rate-limited by the providers.
  function onLocationChanged() {
    // The old area's contacts are wrong the instant the coordinates move, so
    // drop them on the first keystroke rather than after the debounce.
    if (!locationTimer) clearContacts('ACQUIRING');
    clearTimeout(locationTimer);
    locationTimer = setTimeout(commitLocation, 400);
  }

  function commitLocation() {
    locationTimer = null;
    if (!manualView) applyHomeView();
    updateStaticHud();
    scheduleFetchLoop();
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
    if (CONFIG.radius > DATA_MAX_KM + 20) {
      drawCoverageRing(homePt, outerRingPx * (DATA_MAX_KM / CONFIG.radius));
    }
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
      // The conic gradient runs clockwise from the beam, which is the direction
      // the beam travels - so the wash has to sit at the far end of the sweep
      // (just counter-clockwise of the line) to read as a trail behind it.
      var grad = ctx.createConicGradient(rad, 0, 0);
      grad.addColorStop(0, 'rgba(60,255,140,0)');
      grad.addColorStop(0.80, 'rgba(60,255,140,0)');
      grad.addColorStop(1, 'rgba(60,255,140,0.085)');
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

  // Every provider caps a single point query at DATA_MAX_KM, so past that ring
  // coverage comes from several overlapping off-centre queries (see
  // queryPoints()) instead of one clean disc - real, but patchier at the seams.
  function drawCoverageRing(homePt, r) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,206,61,0.30)';
    ctx.setLineDash([2 * scale, 5 * scale]);
    ctx.lineWidth = 1 * scale;
    ctx.beginPath();
    ctx.arc(homePt.x, homePt.y, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.font = (9 * scale).toFixed(1) + 'px Consolas, monospace';
    ctx.fillStyle = 'rgba(255,206,61,0.45)';
    ctx.fillText('MULTI-QUERY BEYOND ' + Math.round(DATA_MAX_KM) + 'km', homePt.x + 6 * scale, homePt.y - r - 5 * scale);
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

    var route = routeOf(ac);
    ac._route = route || null;
    ac._ftype = route ? route.type : 'UNK';

    var inRange = ac._alt >= CONFIG.minalt && ac._alt <= CONFIG.maxalt &&
      (ac.gs || 0) >= CONFIG.minspeed && (ac.gs || 0) <= CONFIG.maxspeed;

    // Flights whose route we haven't resolved stay hidden while a specific type
    // is selected - we can't honestly call them domestic or international.
    var typeOk = CONFIG.flighttype === FLIGHT_ALL ||
      (CONFIG.flighttype === FLIGHT_DOM && ac._ftype === 'DOM') ||
      (CONFIG.flighttype === FLIGHT_INT && ac._ftype === 'INT');

    // emergencies are never filtered out - that's the whole point of the row
    ac._pass = ac._hasPos && ((inRange && typeOk) || ac._emergency);
    return ac;
  }

  // The networks disagree on the array's name: adsb.one and adsb.lol return
  // "ac", adsb.fi returns "aircraft". Reading only "ac" silently treated every
  // adsb.fi reply as an empty sky.
  function aircraftOf(data) {
    if (!data) return [];
    if (Array.isArray(data.ac)) return data.ac;
    if (Array.isArray(data.aircraft)) return data.aircraft;
    return [];
  }

  // ---------------------------- flight routes ----------------------------
  // ADS-B carries no origin/destination, so domestic vs international has to
  // come from a route database keyed by callsign. adsb.lol resolves a batch in
  // one POST; the VRS static files are the fallback when that API is unhappy.
  function routeOf(ac) {
    var cs = (ac.flight || '').trim();
    return cs ? routeCache[cs] : null;
  }

  function classifyRoute(entry) {
    var airports = (entry && entry._airports) || [];
    // one airport alone says nothing - we need both ends to judge the route
    if (airports.length < 2) return null;

    var countries = [];
    airports.forEach(function (a) {
      if (a.countryiso2 && countries.indexOf(a.countryiso2) === -1) countries.push(a.countryiso2);
    });
    if (!countries.length) return null;

    return {
      type: countries.length === 1 ? 'DOM' : 'INT',
      countries: countries,
      pair: airports.map(function (a) { return a.iata || a.icao || '?'; }).join('→')
    };
  }

  function storeRoutes(entries) {
    var changed = false;
    entries.forEach(function (e) {
      if (!e || !e.callsign) return;
      var cs = e.callsign.trim();
      delete routePending[cs];
      // null means "asked and there is nothing" - stops us asking again forever
      routeCache[cs] = classifyRoute(e);
      changed = true;
    });
    if (changed) render();
  }

  function refreshRoutes() {
    var need = [];
    lastAircraft.forEach(function (ac) {
      var cs = (ac.flight || '').trim();
      if (!cs || routeCache[cs] !== undefined || routePending[cs]) return;
      need.push({ callsign: cs, lat: ac.lat, lng: ac.lon });
    });
    if (!need.length) return;

    need = need.slice(0, ROUTE_BATCH);
    need.forEach(function (p) { routePending[p.callsign] = 1; });

    if (Date.now() < routeApiCooldown) { routesFromCdn(need); return; }

    fetchWithTimeout(ROUTE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planes: need })
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (list) { storeRoutes(Array.isArray(list) ? list : []); })
      .catch(function () {
        routeApiCooldown = Date.now() + ROUTE_API_COOLDOWN;
        routesFromCdn(need);
      });
  }

  // Static per-callsign JSON, CORS-open and cacheable. One request each, so we
  // trickle rather than fire off dozens at once.
  function routesFromCdn(need) {
    need.slice(0, ROUTE_CDN_PER_CYCLE).forEach(function (p) {
      var cs = p.callsign;
      fetchWithTimeout(ROUTE_CDN + cs.slice(0, 2) + '/' + cs + '.json', { cache: 'default' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (entry) { storeRoutes([entry || { callsign: cs }]); })
        .catch(function () { delete routePending[cs]; });
    });
    // anything we didn't get to this pass is retried on the next poll
    need.slice(ROUTE_CDN_PER_CYCLE).forEach(function (p) { delete routePending[p.callsign]; });
  }

  // Same aircraft seen by several networks: keep the record with an actual
  // position, and among those the most recently received fix.
  function betterRecord(a, b) {
    var aPos = typeof a.lat === 'number', bPos = typeof b.lat === 'number';
    if (aPos !== bPos) return aPos;
    var aSeen = (a.seen == null) ? 1e9 : a.seen;
    var bSeen = (b.seen == null) ? 1e9 : b.seen;
    return aSeen < bSeen;
  }

  // Fold this poll's replies into the rolling contact pool, then expire anyone
  // nobody has reported for a while.
  function ingest(results, nowMs) {
    var sources = [];

    results.forEach(function (r) {
      sources.push(r.name);
      aircraftOf(r.data).forEach(function (ac) {
        if (!ac || !ac.hex) return;
        var prev = contacts[ac.hex];

        if (prev && prev._pollAt === nowMs) {
          // two networks reported it in this same poll - keep the better fix
          if (!betterRecord(ac, prev)) return;
        } else if (prev && typeof ac.lat !== 'number' && typeof prev.lat === 'number') {
          // positionless update: refresh the timer but hang on to the last fix
          prev._seenAt = nowMs;
          return;
        }

        ac._pollAt = nowMs;
        ac._seenAt = nowMs;
        contacts[ac.hex] = ac;
      });
    });

    Object.keys(contacts).forEach(function (hex) {
      if (nowMs - contacts[hex]._seenAt > CONTACT_TTL) {
        delete contacts[hex];
        delete litAt[hex];
      }
    });

    return sources;
  }

  function onData(sources, latencyMs) {
    lastSources = sources;
    lastGoodAt = Date.now();
    haveData = true;

    if (latencyMs != null) $('hud-latency').innerHTML = latencyMs + '<i>ms</i>';
    $('hud-source').textContent = sources.length > 1
      ? sources.length + ' of ' + activeProviderCount() + ' nets'
      : (sources[0] || '--');
    setStatus('LIVE', '');

    render();
    refreshRoutes();
  }

  // Rebuild the drawn set and the counters from the contact pool. Kept separate
  // from onData so a filter change or a late route lookup can refresh the screen
  // without pretending fresh telemetry arrived.
  function render() {
    var raw = Object.keys(contacts).map(function (k) { return contacts[k]; });
    raw.forEach(classify);

    var withPos = raw.filter(function (ac) { return ac._hasPos; });
    var rendered = withPos.filter(function (ac) { return ac._pass; });
    lastAircraft = rendered;

    $('hud-contacts').textContent = rendered.length;
    $('hud-unknowns').textContent = rendered.filter(function (a) { return a._unknown; }).length;
    $('hud-filtered').textContent = withPos.length - rendered.length;
    $('hud-domestic').textContent = rendered.filter(function (a) { return a._ftype === 'DOM'; }).length;
    $('hud-intl').textContent = rendered.filter(function (a) { return a._ftype === 'INT'; }).length;

    var emergency = rendered.filter(function (a) { return a._emergency; }).length;
    $('hud-emergency').textContent = emergency;
    $('hud-emergency').classList.toggle('active', emergency > 0);

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
      clearContacts('NO SIGNAL', 'down');
    } else if (age > STALE_AFTER) {
      setStatus('STALE ' + Math.round(age / 1000) + 's', 'stale');
    }
  }

  function reFilterFromCache() {
    if (haveData) render();
  }

  function selectedProviders() {
    var pick = PROVIDERS[CONFIG.sourcemode - 1];
    return pick ? [pick] : PROVIDERS;
  }
  function activeProviderCount() { return selectedProviders().length; }

  // A network that just rate-limited us gets rested rather than hammered every
  // 3 seconds - but we never let the list go empty.
  function activeProviders() {
    var now = Date.now();
    var all = selectedProviders();
    var ready = all.filter(function (p) { return !(providerCooldown[p.name] > now); });
    return ready.length ? ready : all;
  }

  function benchProvider(name, status) {
    providerCooldown[name] = Date.now() +
      (status === 429 ? COOLDOWN_RATELIMIT : COOLDOWN_ERROR);
  }

  // Wipe the board right away. Without this the previous location's contacts
  // keep blinking under the sweep until the first poll for the new spot lands.
  function clearContacts(statusText, statusClass) {
    lastAircraft = [];
    contacts = Object.create(null);
    litAt = Object.create(null);
    lastSources = [];
    haveData = false;
    ['hud-contacts', 'hud-unknowns', 'hud-filtered', 'hud-emergency'].forEach(function (id) {
      $(id).textContent = '0';
    });
    $('hud-emergency').classList.remove('active');
    $('hud-latency').innerHTML = '--<i>ms</i>';
    setStatus(statusText, statusClass || 'stale');
    refreshTracks();
  }

  function fetchWithTimeout(url, opts) {
    opts = opts || {};
    if (!opts.cache) opts.cache = 'no-store';   // routes pass 'default' to reuse the HTTP cache
    if (typeof AbortController === 'undefined') return fetch(url, opts);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT);
    opts.signal = ctrl.signal;
    return fetch(url, opts).finally(function () { clearTimeout(timer); });
  }

  // A point+radius query is capped at DATA_MAX_KM by every network, but nothing
  // stops us asking at several overlapping points to reconstruct a bigger disc.
  // One offset point per direction, placed so its DATA_MAX_KM circle laps over
  // its neighbours' - dedupe in ingest() (by hex) collapses anyone seen twice.
  function queryPoints() {
    var home = { lat: CONFIG.latitude, lon: CONFIG.longitude, nm: DATA_MAX_NM };
    if (CONFIG.radius <= DATA_MAX_KM + 20) return [home];

    var ringCount = CONFIG.radius > DATA_MAX_KM * 1.8 ? 8 : 6;
    // 90% of the theoretical minimum spacing, trading a little reach at the
    // outer edge for a comfortable overlap margin between neighbouring discs.
    var offsetKm = (CONFIG.radius - DATA_MAX_KM) * 0.9;
    var latRad = CONFIG.latitude * Math.PI / 180;
    var kmPerDegLat = 111.32;
    var kmPerDegLon = 111.32 * Math.cos(latRad) || 0.01;

    var points = [home];
    for (var i = 0; i < ringCount; i++) {
      var theta = (i / ringCount) * 2 * Math.PI;
      points.push({
        lat: CONFIG.latitude + (offsetKm * Math.cos(theta)) / kmPerDegLat,
        lon: CONFIG.longitude + (offsetKm * Math.sin(theta)) / kmPerDegLon,
        nm: DATA_MAX_NM
      });
    }
    return points;
  }

  async function fetchOnce() {
    var gen = ++fetchGen;
    var points = queryPoints();
    var t0 = performance.now();

    // Every point against every active provider, all in parallel - a slow or
    // dead combination costs us nothing but itself.
    var jobs = [];
    points.forEach(function (pt) {
      activeProviders().forEach(function (p) {
        jobs.push(
          fetchWithTimeout(p.url(pt.lat.toFixed(4), pt.lon.toFixed(4), pt.nm))
            .then(function (res) {
              if (!res.ok) { benchProvider(p.name, res.status); return null; }
              return res.json().then(function (data) { return { name: p.name, data: data }; });
            })
            .catch(function () { benchProvider(p.name, 0); return null; })
        );
      });
    });
    var settled = await Promise.all(jobs);

    // A newer poll (usually a location change) started while we were waiting -
    // its answer is the current one, so drop this now-stale batch.
    if (gen !== fetchGen) return;

    var ok = settled.filter(Boolean);
    if (!ok.length) { onFetchFailed(); return; }

    onData(ingest(ok, Date.now()), Math.round(performance.now() - t0));
  }

  function scheduleFetchLoop() {
    clearTimeout(fetchTimer);
    fetchOnce().finally(function () {
      // Tiled polling fans out to several points per provider; backing off the
      // interval keeps the aggregate request rate reasonable when it's active.
      var interval = CONFIG.radius > DATA_MAX_KM + 20 ? FETCH_INTERVAL * 2 : FETCH_INTERVAL;
      fetchTimer = setTimeout(scheduleFetchLoop, interval);
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
    if (ac._route) {
      rows.push(['ROUTE', ac._route.pair]);
      rows.push(['FLIGHT', ac._route.type === 'DOM'
        ? 'DOMESTIC ' + ac._route.countries[0]
        : 'INTL ' + ac._route.countries.join('-')]);
    }

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
      (ac._route ? ' · ' + ac._route.pair : '') +
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
    var r = Math.round(CONFIG.radius);
    // Past a single query's cap, coverage comes from queryPoints()' overlapping
    // grid rather than one clean disc - flag that in the readout too.
    $('hud-range').innerHTML = (r > DATA_MAX_KM + 20)
      ? r + '<i>km·tiled</i>'
      : r + '<i>km</i>';
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
    ['minalt', 'maxalt', 'minspeed', 'maxspeed', 'flighttype'].forEach(function (k) {
      onConfigChange(k, reFilterFromCache);
    });
    onConfigChange('sourcemode', function () {
      clearContacts('ACQUIRING');
      scheduleFetchLoop();
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
