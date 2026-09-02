var CONFIG = {
  latitude: -22.908,
  longitude: -43.196,
  radius: 400,
  sourcemode: 0,

  hud: true,
  clock: true,
  usesystemtime: true,
  format24h: true,
  utcoffset: 0,

  minalt: 0,
  maxalt: 50000,
  minspeed: 0,
  maxspeed: 1300,
  flighttype: 0,

  radarspeed: 25,
  revealmode: 1,
  blippersist: 100,
  labelmode: 2,
  showvectors: true,
  showrings: true,
  showmap: true,
  maplabels: true,

  autozoom: true,
  zoomoffset: 0,
  uiscale: 100,
  bottommargin: 60,
  showbuttons: true
};

var INT_KEYS = {
  utcoffset: 1, minalt: 1, maxalt: 1, minspeed: 1, maxspeed: 1,
  radius: 1, radarspeed: 1, zoomoffset: 1, uiscale: 1, bottommargin: 1,
  labelmode: 1, revealmode: 1, blippersist: 1, sourcemode: 1, flighttype: 1
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
      val = parseFloat(String(raw).replace(',', '.'));
      if (!isFinite(val)) return;
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
