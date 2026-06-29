var Clay = require('@rebble/clay');
var clayConfig = require('./clay-config.json');

// --- Helpers: persist and normalize
function normalizeConfig(raw) {
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
    console.log('Clay settings (normalized) saved:', JSON.stringify(flat));
  } catch (err) {
    console.log('Error saving Clay settings:', err);
  }
}

function loadPersistedSettings() {
  try {
    return JSON.parse(localStorage.getItem('clay-settings') || '{}');
  } catch (err) {
    return {};
  }
}

// --- Prepare Clay with defaults from persisted config
var persisted = loadPersistedSettings();
var clayConfigWithDefaults = JSON.parse(JSON.stringify(clayConfig));
clayConfigWithDefaults.forEach(function(section) {
  if (!section.items) return;
  section.items.forEach(function(item) {
    var key = item.messageKey;
    if (!key) return;
    if (typeof persisted[key] !== 'undefined') {
      item.defaultValue = persisted[key];
    }
  });
});
var clay = new Clay(clayConfigWithDefaults);

// --- Numeric keys (must match main.c)
var KEY_TRIGGER = 0;
var KEY_UPDATE = 1;
var KEY_STATUS = 2; // new: send status to watch
var KEY_NAME_BASE = 10;
var KEY_ENABLED_BASE = 20;
var KEY_AUTO_CLOSE = 30;
var KEY_SOUND_FEEDBACK = 40; // <-- NEU FÜR SOUND FEEDBACK

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

// --- Build the dictionary for enabled webhooks and send it to the watch
function buildDictForEnabled(settingsObjFlat) {
  var cfg = settingsObjFlat || persisted || {};
  var dict = {};
  
  // Update flag for the watch
  dict[KEY_UPDATE] = 1;

  var autoClose = asBool(cfg['KEY_AUTO_CLOSE']) ? 1 : 0;
  dict[KEY_AUTO_CLOSE] = autoClose; 

  var soundFeedback = asBool(cfg['KEY_SOUND_FEEDBACK']) ? 1 : 0;
  dict[KEY_SOUND_FEEDBACK] = soundFeedback;

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
    function(e) { console.log('Error sending settings to watch:', JSON.stringify(e)); }
  );
}

// --- Webview closed: normalize, persist, send to watch
Pebble.addEventListener('webviewclosed', function(e) {
  if (!e || !e.response) {
    console.log('webviewclosed without response');
    return;
  }
  try {
    var raw = JSON.parse(decodeURIComponent(e.response));
    var flat = normalizeConfig(raw);
    persistClaySettings(flat);
    persisted = flat;
    sendSettingsToWatch(flat);
    console.log('Received and normalized config from webview:', JSON.stringify(flat));
  } catch (err) {
    console.log('Error parsing/processing webview response:', err);
  }
});

// --- Ready: send current enabled entries to watch
Pebble.addEventListener('ready', function () {
  console.log('Pebble ready');
  try {
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

// --- AppMessage: receive trigger -> call webhook
Pebble.addEventListener('appmessage', function (e) {
  console.log('AppMessage received:', JSON.stringify(e.payload));

  // Determine trigger value
  var trigger = null;
  if (e && e.payload) {
    if (typeof e.payload[KEY_TRIGGER] !== 'undefined') trigger = e.payload[KEY_TRIGGER];
    else if (typeof e.payload.KEY_TRIGGER !== 'undefined') trigger = e.payload.KEY_TRIGGER;
  }

  if (!trigger && trigger !== 0) {
    console.log('No valid trigger in payload');
    return;
  }

  var index = parseInt(trigger, 10);
  if (!index || index < 1 || index > 5) {
    console.log('Invalid webhook index:', trigger);
    var errMsg = {}; errMsg[KEY_STATUS] = 0;
    Pebble.sendAppMessage(errMsg, function(){}, function(){});
    return;
  }

  console.log('Trigger detected for webhook', index);

  var cfg = persisted || {};
  try {
    var live = clay.getSettings ? normalizeConfig(clay.getSettings()) : {};
    if (Object.keys(live).length) cfg = Object.assign({}, cfg, live);
  } catch (err) { /* ignore */ }

  var enabledKey = 'enabled' + index;
  if (!asBool(cfg[enabledKey])) {
    console.log('Webhook ' + index + ' is disabled, aborting.');
    var infoMsg = {}; infoMsg[KEY_STATUS] = -2; // -2 = disabled
    Pebble.sendAppMessage(infoMsg, function(){}, function(){});
    return;
  }

  var webhookKey = 'webhook' + index;
  var clientidKey = 'clientid' + index;
  var clientsecretKey = 'clientsecret' + index;

  var WEBHOOK_URL = (cfg[webhookKey] || '').trim();
  var CLIENT_ID = (cfg[clientidKey] || '').trim();
  var CLIENT_SECRET = (cfg[clientsecretKey] || '').trim();

  if (!WEBHOOK_URL) {
    console.log('Missing WEBHOOK_URL for index', index);
    var missingMsg = {}; missingMsg[KEY_STATUS] = 0;
    Pebble.sendAppMessage(missingMsg, function(){}, function(){});
    return;
  }

  console.log('Sending webhook:', WEBHOOK_URL, 'Index:', index);
  console.log('CLIENT_ID:', CLIENT_ID ? '(set)' : '(empty)');
  console.log('CLIENT_SECRET:', CLIENT_SECRET ? '(set)' : '(empty)');

  try {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', WEBHOOK_URL, true);
    xhr.timeout = 10000;

    try {
      if (CLIENT_ID) xhr.setRequestHeader('CF-Access-Client-Id', CLIENT_ID);
      if (CLIENT_SECRET) xhr.setRequestHeader('CF-Access-Client-Secret', CLIENT_SECRET);
      console.log('Headers set');
    } catch (err) {
      console.log('Error setting headers, sending without:', err);
    }

    xhr.onreadystatechange = function () {
      console.log('XHR readyState:', xhr.readyState, 'status:', xhr.status || 'n/a');
    };

    xhr.onload = function () {
      console.log('Webhook response status:', xhr.status);
      try {
        var responseText = xhr.responseText || (xhr.responseXML ? xhr.responseXML.outerHTML : '');
        console.log('Response text:', responseText);
      } catch (err) {
        console.log('Could not read response text:', err);
      }
      var statusMsg = {};
      statusMsg[KEY_STATUS] = xhr.status;
      Pebble.sendAppMessage(statusMsg, function(){ console.log('Status sent to watch:', xhr.status); }, function(e){ console.log('Error sending status:', JSON.stringify(e)); });
    };

    xhr.onerror = function () {
      console.log('XHR error:', xhr.status);
      var errMsg = {}; errMsg[KEY_STATUS] = 0;
      Pebble.sendAppMessage(errMsg, function(){}, function(){});
    };

    xhr.ontimeout = function () {
      console.log('XHR timeout');
      var toMsg = {}; toMsg[KEY_STATUS] = -1;
      Pebble.sendAppMessage(toMsg, function(){}, function(){});
    };

    xhr.onabort = function () {
      console.log('XHR aborted');
    };

    xhr.send();
  } catch (err) {
    console.log('Error sending XHR:', err);
    var exMsg = {}; exMsg[KEY_STATUS] = 0;
    Pebble.sendAppMessage(exMsg, function(){}, function(){});
  }
});