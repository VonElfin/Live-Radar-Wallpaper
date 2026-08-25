// ---------------------------------------------------------------------------
// CONFIG: defaults mirror project.json "general.properties" so the wallpaper
// looks and behaves the same in a plain browser (for testing) and inside
// Wallpaper Engine, where wallpaperPropertyListener overrides these live.
// ---------------------------------------------------------------------------
var CONFIG = {
  latitude: -22.908,
  longitude: -43.196,
  radius: 400,          // km

  hud: true,
  clock: true,
  format24h: true,
  utcoffset: 1,

  minalt: 0,
  maxalt: 50000,
  minspeed: 0,
  maxspeed: 1300,

  radarspeed: 25,       // RPM
  showlabels: true,
  showvectors: true,
  showrings: true,
  showmap: true,
  maplabels: true,

  autozoom: true,
  zoomoffset: 0,
  uiscale: 100,         // percent, on top of the automatic viewport scaling
  bottommargin: 60,     // px kept clear at the bottom for the taskbar
  showbuttons: true
};

// Keys Wallpaper Engine hands us as floats but that only make sense as integers.
var INT_KEYS = {
  utcoffset: 1, minalt: 1, maxalt: 1, minspeed: 1, maxspeed: 1,
  radius: 1, radarspeed: 1, zoomoffset: 1, uiscale: 1, bottommargin: 1
};

var CONFIG_LISTENERS = {};
function onConfigChange(key, fn) {
  (CONFIG_LISTENERS[key] = CONFIG_LISTENERS[key] || []).push(fn);
}
function fireConfigChange(key) {
  (CONFIG_LISTENERS[key] || []).forEach(function (fn) { fn(CONFIG[key]); });
}

function applyProps(properties) {
  Object.keys(properties).forEach(function (key) {
    if (!(key in CONFIG)) return;
    var prop = properties[key];
    if (!prop || prop.value === undefined) return;
    var raw = prop.value;
    var val;

    if (typeof CONFIG[key] === 'boolean') {
      val = (raw === true || raw === 'true' || raw === 1 || raw === '1');
    } else {
      // latitude/longitude arrive as free text - accept comma decimals too
      val = parseFloat(String(raw).replace(',', '.'));
      if (!isFinite(val)) return;              // keep last good value
      if (INT_KEYS[key]) val = Math.round(val);
    }

    if (CONFIG[key] === val) return;
    CONFIG[key] = val;
    fireConfigChange(key);
  });
}

window.wallpaperPropertyListener = {
  applyUserProperties: function (properties) {
    applyProps(properties);
  }
};
