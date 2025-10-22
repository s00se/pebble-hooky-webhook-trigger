#include <pebble.h>

#define KEY_TRIGGER 0
#define KEY_UPDATE 1
#define KEY_STATUS 2

#define KEY_NAME_BASE 10
#define KEY_ENABLED_BASE 20

#define MAX_WEBHOOKS 5

static Window *s_main_window;
static SimpleMenuLayer *s_menu_layer;
static SimpleMenuSection s_menu_section;
static SimpleMenuItem s_menu_items[MAX_WEBHOOKS];
static char s_titles[MAX_WEBHOOKS][32];
static char s_subtitles[MAX_WEBHOOKS][42];
static bool s_enabled[MAX_WEBHOOKS];
static uint8_t s_index_map[MAX_WEBHOOKS];
static int s_display_count = 0;

// transient popup
static Window *s_popup_window = NULL;
static TextLayer *s_popup_text = NULL;
static AppTimer *s_popup_timer = NULL;

static void popup_timer_cb(void *data) {
  if (s_popup_window) {
    window_stack_remove(s_popup_window, true);
    if (s_popup_text) {
      text_layer_destroy(s_popup_text);
      s_popup_text = NULL;
    }
    window_destroy(s_popup_window);
    s_popup_window = NULL;
  }
  s_popup_timer = NULL;
}

static void show_transient_popup(const char *message_ms) {
  if (s_popup_window) {
    if (s_popup_timer) {
      app_timer_cancel(s_popup_timer);
      s_popup_timer = NULL;
    }
    window_stack_remove(s_popup_window, false);
    if (s_popup_text) {
      text_layer_destroy(s_popup_text);
      s_popup_text = NULL;
    }
    window_destroy(s_popup_window);
    s_popup_window = NULL;
  }

  s_popup_window = window_create();
  window_set_background_color(s_popup_window, GColorBlack);

  Layer *root = window_get_root_layer(s_popup_window);
  GRect bounds = layer_get_bounds(root);

  s_popup_text = text_layer_create(GRect(6, (bounds.size.h - 28) / 2, bounds.size.w - 12, 28));
  text_layer_set_text_alignment(s_popup_text, GTextAlignmentCenter);
  text_layer_set_text_color(s_popup_text, GColorWhite);
  text_layer_set_background_color(s_popup_text, GColorClear);
  text_layer_set_font(s_popup_text, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text(s_popup_text, message_ms);

  layer_add_child(root, text_layer_get_layer(s_popup_text));
  window_stack_push(s_popup_window, true);

  s_popup_timer = app_timer_register(1000, popup_timer_cb, NULL);
}

static void send_trigger(uint8_t webhook_index) {
  DictionaryIterator *iter;
  AppMessageResult res = app_message_outbox_begin(&iter);
  if (res != APP_MSG_OK || !iter) {
    vibes_short_pulse();
    return;
  }
  dict_write_uint8(iter, KEY_TRIGGER, webhook_index);
  app_message_outbox_send();
  vibes_short_pulse();
}

static void menu_select_callback(int index, void *ctx) {
  if (index < 0 || index >= s_display_count) return;
  uint8_t original_index = s_index_map[index];
  send_trigger(original_index);
}

static void build_menu_layer(Window *window) {
  if (s_menu_layer) {
    layer_remove_from_parent(simple_menu_layer_get_layer(s_menu_layer));
    simple_menu_layer_destroy(s_menu_layer);
    s_menu_layer = NULL;
  }

  s_display_count = 0;
  for (int i = 0; i < MAX_WEBHOOKS; i++) {
    if (!s_enabled[i]) continue;
    snprintf(s_subtitles[i], sizeof(s_subtitles[i]), "Webhook %d ausloesen", i + 1);
    s_menu_items[s_display_count] = (SimpleMenuItem){
      .title = s_titles[i],
      .subtitle = s_subtitles[i],
      .callback = menu_select_callback
    };
    s_index_map[s_display_count] = (uint8_t)(i + 1);
    s_display_count++;
  }

  if (s_display_count == 0) {
    static char no_title[32];
    static char no_sub[42];
    snprintf(no_title, sizeof(no_title), "Keine Webhooks aktiviert");
    snprintf(no_sub, sizeof(no_sub), "Bitte in den Einstellungen aktivieren");
    s_menu_items[0] = (SimpleMenuItem){
      .title = no_title,
      .subtitle = no_sub,
      .callback = NULL
    };
    s_display_count = 1;
  }

  s_menu_section = (SimpleMenuSection){
    .title = "Aktionen",
    .num_items = s_display_count,
    .items = s_menu_items
  };

  s_menu_layer = simple_menu_layer_create(layer_get_bounds(window_get_root_layer(window)),
                                          window,
                                          &s_menu_section,
                                          1,
                                          NULL);
  layer_add_child(window_get_root_layer(window), simple_menu_layer_get_layer(s_menu_layer));
}

static int32_t tuple_to_int32(const Tuple *t) {
  if (!t) return 0;
  switch (t->type) {
    case TUPLE_CSTRING:
      if (t->value && t->value->cstring) return atoi(t->value->cstring);
      return 0;
    case TUPLE_INT:
      return t->value->int32;
    case TUPLE_UINT:
      return (int32_t)t->value->uint32;
    default:
      return 0;
  }
}

static void inbox_received_callback(DictionaryIterator *iter, void *context) {
  Tuple *t_update = dict_find(iter, KEY_UPDATE);
  if (t_update) {
    for (int i = 0; i < MAX_WEBHOOKS; i++) {
      Tuple *tname = dict_find(iter, KEY_NAME_BASE + i);
      if (tname && tname->value && tname->length > 0) {
        strncpy(s_titles[i], tname->value->cstring, sizeof(s_titles[i]) - 1);
        s_titles[i][sizeof(s_titles[i]) - 1] = '\0';
      } else {
        snprintf(s_titles[i], sizeof(s_titles[i]), "Webhook %d", i + 1);
      }
      Tuple *ten = dict_find(iter, KEY_ENABLED_BASE + i);
      s_enabled[i] = ten ? (ten->value->uint8 ? true : false) : false;
    }
    build_menu_layer(s_main_window);
    return;
  }

  Tuple *tstatus = dict_find(iter, KEY_STATUS);
  if (tstatus) {
    int32_t status = tuple_to_int32(tstatus);
    static char buf[64];

    switch (status) {
      case 200:
        snprintf(buf, sizeof(buf), "Erfolgreich");
        break;
      case 0:
        snprintf(buf, sizeof(buf), "Fehler");
        break;
      case -1:
        snprintf(buf, sizeof(buf), "Timeout");
        break;
      case -2:
        snprintf(buf, sizeof(buf), "Webhook deaktiviert");
        break;
      default:
        snprintf(buf, sizeof(buf), "Status %ld", (long)status);
        break;
    }

    show_transient_popup(buf);
    return;
  }
}

static void inbox_dropped_callback(AppMessageResult reason, void *context) {
  (void)reason;
  (void)context;
}

static void init_settings_defaults() {
  for (int i = 0; i < MAX_WEBHOOKS; i++) {
    snprintf(s_titles[i], sizeof(s_titles[i]), "Webhook %d", i + 1);
    s_enabled[i] = false;
  }
}

static void main_window_load(Window *window) {
  build_menu_layer(window);
}

static void main_window_unload(Window *window) {
  if (s_menu_layer) {
    simple_menu_layer_destroy(s_menu_layer);
    s_menu_layer = NULL;
  }
}

static void init(void) {
  init_settings_defaults();

  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_inbox_dropped(inbox_dropped_callback);
  app_message_open(1024, 1024);

  s_main_window = window_create();
  window_set_window_handlers(s_main_window, (WindowHandlers){
    .load = main_window_load,
    .unload = main_window_unload
  });
  window_stack_push(s_main_window, true);
}

static void deinit(void) {
  if (s_menu_layer) simple_menu_layer_destroy(s_menu_layer);
  window_destroy(s_main_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
