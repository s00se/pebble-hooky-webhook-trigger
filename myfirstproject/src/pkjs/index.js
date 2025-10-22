var Clay = require('pebble-clay');
var clayConfig = require('./clay-config.json');
var clay = new Clay(clayConfig);

/**
 * Persistenz-Helper
 */
function persistClaySettings(configObj) {
  try {
    localStorage.setItem('clay-settings', JSON.stringify(configObj));
    console.log('Clay settings gespeichert:', JSON.stringify(configObj));
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

/**
 * Clay-Konfiguration vor dem Init dynamisch anpassen,
 * damit die Webview die gespeicherten Strings korrekt zeigt
 */
var persisted = loadPersistedSettings();

// Clone, damit das Original nicht verändert wird
var clayConfigWithDefaults = JSON.parse(JSON.stringify(clayConfig));

clayConfigWithDefaults.forEach(function(section) {
  if (section.items && section.items.length) {
    section.items.forEach(function(item) {
      var key = item.messageKey;
      if (persisted[key] && persisted[key].value) {
        item.defaultValue = persisted[key].value; // flach als String
      }
    });
  }
});

// Clay initialisieren mit angepassten Defaults
var clay = new Clay(clayConfigWithDefaults);

/**
 * Pebble ready
 */
Pebble.addEventListener('ready', function () {
  console.log('Pebble Webhook bereit');
  try {
    console.log('Clay getSettings():', JSON.stringify(clay.getSettings() || {}));
  } catch (err) {
    console.log('clay.getSettings() nicht verfügbar:', err);
  }
  console.log('Persisted settings:', JSON.stringify(loadPersistedSettings()));
});

/**
 * Webview geschlossen
 */
Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) {
    console.log('webviewclosed ohne response');
    return;
  }
  try {
    var config = JSON.parse(decodeURIComponent(e.response));

    // Persistieren
    persistClaySettings(config);

    console.log('Empfangene Config aus Webview:', JSON.stringify(config));
  } catch (err) {
    console.log('Fehler beim Parsen/Verarbeiten der Webview response:', err);
  }
});

/**
 * AppMessage: Webhook auslösen
 */
Pebble.addEventListener('appmessage', function (e) {
  console.log('AppMessage empfangen:', JSON.stringify(e.payload));

  if (!(e.payload && e.payload.KEY_TRIGGER === 1)) {
    console.log('Kein gültiger Trigger im Payload');
    return;
  }

  console.log('Trigger erkannt, verwende aktuelle Clay-Einstellungen');

  // Clay-Settings laden + Backup aus persistierten Settings
  var settings = {};
  try {
    settings = clay.getSettings() || {};
  } catch (err) {
    settings = {};
  }

  var persisted = loadPersistedSettings();
  ['webhook', 'clientid', 'clientsecret'].forEach(function (key) {
    if (!settings[key] && persisted[key] && persisted[key].value) {
      settings[key] = persisted[key];
    }
  });

  // Werte extrahieren
  var WEBHOOK_URL = (settings.webhook && settings.webhook.value) ? settings.webhook.value.trim() : '';
  var CLIENT_ID = (settings.clientid && settings.clientid.value) ? settings.clientid.value.trim() : '';
  var CLIENT_SECRET = (settings.clientsecret && settings.clientsecret.value) ? settings.clientsecret.value.trim() : '';

  if (!WEBHOOK_URL) {
    console.log('Fehlende WEBHOOK_URL:', JSON.stringify(settings));
    Pebble.showSimpleNotificationOnPebble('Fehler', 'Webhook-URL fehlt!');
    return;
  }

  console.log('WEBHOOK_URL:', WEBHOOK_URL);
  console.log('CLIENT_ID:', CLIENT_ID ? '(vorhanden)' : '(leer)');
  console.log('CLIENT_SECRET:', CLIENT_SECRET ? '(vorhanden)' : '(leer)');

  // Webhook Request
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
      console.log('Antworttext (HTML/JSON):', responseText);
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

  try {
    xhr.send();
  } catch (err) {
    console.log('Fehler beim Senden des XHR:', err);
  }
});
