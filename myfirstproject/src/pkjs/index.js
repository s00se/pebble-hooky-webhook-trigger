var Clay = require('pebble-clay');
var clayConfig = require('./clay-config.json');

// --- Helpers: persistieren und Normalisieren
function normalizeConfig(raw) {
  // raw ist das decodeURIComponent(e.response) geparste Objekt oder persisted aus localStorage
  // Wir erzeugen ein flaches Objekt: key -> primitive (string / boolean / number)
  var out = {};
  if (!raw || typeof raw !== 'object') return out;
  Object.keys(raw).forEach(function(k) {
    var v = raw[k];
    if (v === null || typeof v === 'undefined') {
      out[k] = v;
    } else if (typeof v === 'object' && typeof v.value !== 'undefined') {
      out[k] = v.value;
    } else {
      out[k] = v;
    }
  });
  return out;
}

function persistClaySettings(rawConfig) {
  try {
    var flat = normalizeConfig(rawConfig);
    localStorage.setItem('clay-settings', JSON.stringify(flat));
    console.log('Clay settings (normalized) gespeichert:', JSON.stringify(flat));
  } catch (err) {
    console.log('Fehler beim Speichern der Clay settings:', err);
  }
}

function loadPersistedSettings() {
  try {
    return JSON.parse(localStorage.getItem('clay-settings') || '{}');
  } catch (err) {
    return {};
  }
}

// --- Prepare Clay with defaults from persisted (flat) config
var persisted = loadPersistedSettings();
var clayConfigWithDefaults = JSON.parse(JSON.stringify(clayConfig));
clayConfigWithDefaults.forEach(function(section) {
  if (!section.items) return;
  section.items.forEach(function(item) {
    var key = item.messageKey;
    if (!key) return;
    if (typeof persisted[key] !== 'undefined') {
      // Persisted is already flat primitive; set defaultValue accordingly
      item.defaultValue = persisted[key];
    }
  });
});
var clay = new Clay(clayConfigWithDefaults);

// --- Numeric keys (muss mit main.c übereinstimmen)
var KEY_TRIGGER = 0;
var KEY_UPDATE = 1;
var KEY_NAME_BASE = 10;
var KEY_ENABLED_BASE = 20;

// --- Utility
function asString(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return '';
}
function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return !!v;
  if (typeof v === 'string') return (v === 'true' || v === '1');
  return false;
}

// --- Baut das Dictionary für aktivierte Webhooks und sendet es an die Uhr
function buildDictForEnabled(settingsObjFlat) {
  var cfg = settingsObjFlat || persisted || {};
  var dict = {};
  dict[KEY_UPDATE] = 1;
  for (var i = 1; i <= 5; i++) {
    var nameKey = 'name' + i;
    var enabledKey = 'enabled' + i;
    var enabled = asBool(cfg[enabledKey]) ? 1 : 0;
    var nameVal = '';
    if (enabled) {
      var nv = cfg[nameKey];
      if (typeof nv === 'undefined' || nv === null || nv === '') nv = 'Webhook ' + i;
      nameVal = asString(nv);
    }
    dict[KEY_NAME_BASE + (i - 1)] = nameVal;
    dict[KEY_ENABLED_BASE + (i - 1)] = enabled;
  }
  return dict;
}

function sendSettingsToWatch(flatSettings) {
  var dict = buildDictForEnabled(flatSettings || {});
  Pebble.sendAppMessage(dict,
    function() { console.log('Settings sent to watch:', JSON.stringify(dict)); },
    function(e) { console.log('Fehler beim Senden der Settings an Uhr:', JSON.stringify(e)); }
  );
}

// --- Webview geschlossen: normalize, persist, send to watch
Pebble.addEventListener('webviewclosed', function(e) {
  if (!e || !e.response) {
    console.log('webviewclosed ohne response');
    return;
  }
  try {
    var raw = JSON.parse(decodeURIComponent(e.response));
    // raw enthält oft { key: { value: "..." } } oder flat values depending on Clay version
    var flat = normalizeConfig(raw);
    persistClaySettings(flat);
    persisted = flat;
    sendSettingsToWatch(flat);
    console.log('Empfangene und normalisierte Config aus Webview:', JSON.stringify(flat));
  } catch (err) {
    console.log('Fehler beim Parsen/Verarbeiten der Webview response:', err);
  }
});

// --- Ready: sende aktuelle aktivierten Einträge an die Uhr
Pebble.addEventListener('ready', function () {
  console.log('Pebble ready');
  try {
    // clay.getSettings() kann entweder flach oder verschachtelt liefern; normalize ebenfalls
    var s = {};
    try { s = clay.getSettings ? clay.getSettings() : {}; } catch (e) { s = {}; }
    var flatFromClay = normalizeConfig(s);
    var toSend = (Object.keys(flatFromClay).length) ? flatFromClay : persisted;
    sendSettingsToWatch(toSend);
  } catch (err) {
    sendSettingsToWatch(persisted);
  }
  console.log('Persisted settings (on ready):', JSON.stringify(persisted));
});

// --- AppMessage: Trigger empfangen -> Webhook auslösen
Pebble.addEventListener('appmessage', function (e) {
  console.log('AppMessage empfangen:', JSON.stringify(e.payload));

  // Ermittle Trigger-Wert: numeric key 0 oder KEY_TRIGGER property
  var trigger = null;
  if (e && e.payload) {
    if (typeof e.payload[KEY_TRIGGER] !== 'undefined') trigger = e.payload[KEY_TRIGGER];
    else if (typeof e.payload.KEY_TRIGGER !== 'undefined') trigger = e.payload.KEY_TRIGGER;
  }

  if (!trigger && trigger !== 0) {
    console.log('Kein gültiger Trigger im Payload');
    return;
  }

  var index = parseInt(trigger, 10);
  if (!index || index < 1 || index > 5) {
    console.log('Ungültiger Webhook-Index:', trigger);
    Pebble.showSimpleNotificationOnPebble('Fehler', 'Ungültiger Webhook-Index!');
    return;
  }

  console.log('Trigger erkannt für Webhook', index);

  // Nutze die persistierte, normalisierte config (die ist flach primitives)
  var cfg = persisted || {};
  // Versuche zusätzlich Clay-Live-Werte (normalize)
  try {
    var live = clay.getSettings ? normalizeConfig(clay.getSettings()) : {};
    if (Object.keys(live).length) cfg = Object.assign({}, cfg, live);
  } catch (err) { /* ignore */ }

  // Prüfe ob aktiviert
  var enabledKey = 'enabled' + index;
  if (!asBool(cfg[enabledKey])) {
    console.log('Webhook ' + index + ' ist deaktiviert, brich ab.');
    Pebble.showSimpleNotificationOnPebble('Info', 'Webhook deaktiviert');
    return;
  }

  // Lese URL und Header nur wenn aktiviert
  var webhookKey = 'webhook' + index;
  var clientidKey = 'clientid' + index;
  var clientsecretKey = 'clientsecret' + index;

  var WEBHOOK_URL = (cfg[webhookKey] || '').trim();
  var CLIENT_ID = (cfg[clientidKey] || '').trim();
  var CLIENT_SECRET = (cfg[clientsecretKey] || '').trim();

  if (!WEBHOOK_URL) {
    console.log('Fehlende WEBHOOK_URL für Index', index);
    Pebble.showSimpleNotificationOnPebble('Fehler', 'Webhook-URL fehlt!');
    return;
  }

  console.log('Sende Webhook:', WEBHOOK_URL, 'Index:', index);
  console.log('CLIENT_ID:', CLIENT_ID ? '(vorhanden)' : '(leer)');
  console.log('CLIENT_SECRET:', CLIENT_SECRET ? '(vorhanden)' : '(leer)');

  // XMLHttpRequest ausführen
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', WEBHOOK_URL, true);
    xhr.timeout = 10000;

    try {
      if (CLIENT_ID) xhr.setRequestHeader('CF-Access-Client-Id', CLIENT_ID);
      if (CLIENT_SECRET) xhr.setRequestHeader('CF-Access-Client-Secret', CLIENT_SECRET);
      console.log('Header gesetzt');
    } catch (err) {
      console.log('Fehler beim Setzen der Header, sende ohne Header:', err);
    }

    xhr.onreadystatechange = function () {
      console.log('XHR readyState:', xhr.readyState, 'status:', xhr.status || 'n/a');
    };

    xhr.onload = function () {
      console.log('Webhook Antwortstatus:', xhr.status);
      try {
        var responseText = xhr.responseText || (xhr.responseXML ? xhr.responseXML.outerHTML : '');
        console.log('Antworttext:', responseText);
      } catch (err) {
        console.log('Antworttext konnte nicht gelesen werden:', err);
      }
      Pebble.showSimpleNotificationOnPebble('Webhook', 'Status ' + xhr.status);
    };

    xhr.onerror = function () {
      console.log('XHR Fehler:', xhr.status);
      Pebble.showSimpleNotificationOnPebble('Fehler', 'Webhook fehlgeschlagen!');
    };

    xhr.ontimeout = function () {
      console.log('XHR Timeout');
      Pebble.showSimpleNotificationOnPebble('Fehler', 'Webhook Timeout!');
    };

    xhr.onabort = function () {
      console.log('XHR abgebrochen');
    };

    xhr.send();
  } catch (err) {
    console.log('Fehler beim Senden des XHR:', err);
    Pebble.showSimpleNotificationOnPebble('Fehler', 'XHR Fehler');
  }
});
