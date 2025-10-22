// Fix definierte Webhook-URL (zum Testen)
const WEBHOOK_URL = "https://webhook.site/c4748972-b018-4851-b739-19b259932c00";

Pebble.addEventListener("ready", function () {
  console.log("Pebble Webhook Test JS ready");
});

Pebble.addEventListener("appmessage", function (e) {
  console.log("AppMessage empfangen:", JSON.stringify(e.payload));

  // Korrekte Prüfung auf KEY_TRIGGER
  if (e.payload && e.payload.KEY_TRIGGER === 1) {
    console.log("Trigger erkannt, sende Webhook...");

    var xhr = new XMLHttpRequest();
    xhr.open("GET", WEBHOOK_URL, true);
    xhr.onload = function () {
      console.log("Webhook Antwortstatus:", xhr.status);
      Pebble.showSimpleNotificationOnPebble("Webhook", "Status " + xhr.status);
    };
    xhr.onerror = function () {
      console.log("Fehler beim Webhook-Aufruf");
      Pebble.showSimpleNotificationOnPebble("Fehler", "Webhook fehlgeschlagen!");
    };
    xhr.send();
  } else {
    console.log("Kein gültiger Trigger im Payload");
  }
});
