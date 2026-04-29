#include <pebble.h>

#define KEY_TRIGGER 0
#define KEY_UPDATE 1
#define KEY_STATUS 2
#define KEY_AUTO_CLOSE 30

#define KEY_NAME_BASE 10
#define KEY_ENABLED_BASE 20

#define MAX_WEBHOOKS 5

static Window *s_main_window;
static MenuLayer *s_menu_layer;
static Layer *s_header_layer; 

// State data for our menu
static char s_titles[MAX_WEBHOOKS][32];
static bool s_enabled[MAX_WEBHOOKS];
static bool s_auto_close_enabled = false; 

// Display data structure (pre-calculated for rendering)
static char s_display_titles[MAX_WEBHOOKS][32];
static char s_display_subtitles[MAX_WEBHOOKS][42];
static uint8_t s_display_map[MAX_WEBHOOKS];
static int s_display_count = 0;

static char s_time_text[8] = "00:00";

// transient popup
static Window *s_popup_window = NULL;
static TextLayer *s_popup_text = NULL;
static AppTimer *s_popup_timer = NULL;

static void auto_close_timer_cb(void *data) {
  window_stack_pop_all(true);
}

static void tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  strftime(s_time_text, sizeof(s_time_text), clock_is_24h_style() ? "%H:%M" : "%I:%M", tick_time);
  if (s_header_layer) {
    layer_mark_dirty(s_header_layer);
  }
}

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

static void show_transient_popup(const char *message, GColor bg_color) {
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
  window_set_background_color(s_popup_window, bg_color);

  Layer *root = window_get_root_layer(s_popup_window);
  GRect bounds = layer_get_bounds(root);

  s_popup_text = text_layer_create(GRect(0, (bounds.size.h - 28) / 2, bounds.size.w, 28));
  text_layer_set_text_alignment(s_popup_text, GTextAlignmentCenter);
  text_layer_set_text_color(s_popup_text, GColorWhite);
  text_layer_set_background_color(s_popup_text, GColorClear);
  text_layer_set_font(s_popup_text, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text(s_popup_text, message);

  layer_add_child(root, text_layer_get_layer(s_popup_text));
  window_stack_push(s_popup_window, true);

  s_popup_timer = app_timer_register(1500, popup_timer_cb, NULL);
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

static void update_menu_data() {
  s_display_count = 0;
  for (int i = 0; i < MAX_WEBHOOKS; i++) {
    if (!s_enabled[i]) continue;
    strncpy(s_display_titles[s_display_count], s_titles[i], 32);
    snprintf(s_display_subtitles[s_display_count], 42, "Trigger Webhook %d", i + 1);
    s_display_map[s_display_count] = i + 1;
    s_display_count++;
  }

  if (s_display_count == 0) {
    strncpy(s_display_titles[0], "No webhooks", 32);
    strncpy(s_display_subtitles[0], "Please create one", 42);
    s_display_map[0] = 0;
    s_display_count = 1;
  }

  if (s_menu_layer) {
    menu_layer_reload_data(s_menu_layer);
  }
}

static void header_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  
  graphics_context_set_fill_color(ctx, GColorCobaltBlue);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  graphics_context_set_text_color(ctx, GColorWhite);

  #if defined(PBL_ROUND)
    graphics_draw_text(ctx, "Hooky", fonts_get_system_font(FONT_KEY_GOTHIC_14),
                       GRect(0, 4, bounds.size.w, 16), GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
    graphics_draw_text(ctx, s_time_text, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                       GRect(0, 20, bounds.size.w, 24), GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  #else
    graphics_draw_text(ctx, "Hooky", fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                       GRect(6, 0, bounds.size.w - 55, 24), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    graphics_draw_text(ctx, s_time_text, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                       GRect(bounds.size.w - 52, 0, 46, 24), GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
  #endif
}

static uint16_t menu_get_num_sections_callback(MenuLayer *menu_layer, void *data) {
  return 1;
}

static uint16_t menu_get_num_rows_callback(MenuLayer *menu_layer, uint16_t section_index, void *data) {
  return s_display_count;
}

static void menu_draw_row_callback(GContext* ctx, const Layer *cell_layer, MenuIndex *cell_index, void *data) {
  int idx = cell_index->row;
  menu_cell_basic_draw(ctx, cell_layer, s_display_titles[idx], s_display_subtitles[idx], NULL);
}

static void menu_select_callback(MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
  int idx = cell_index->row;
  if (s_display_map[idx] != 0) {
    send_trigger(s_display_map[idx]);
  }
}

static int32_t tuple_to_int32(const Tuple *t) {
  if (!t) return 0;
  switch (t->type) {
    case TUPLE_CSTRING:
      if (t->length > 0) return atoi(t->value->cstring);
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
  Tuple *t_autoclose = dict_find(iter, KEY_AUTO_CLOSE);
  if (t_autoclose) {
    s_auto_close_enabled = tuple_to_int32(t_autoclose) > 0;
    
    APP_LOG(APP_LOG_LEVEL_INFO, "Config-Update: Auto-Close is now %s", s_auto_close_enabled ? "ON" : "OFF");
  }

  Tuple *t_update = dict_find(iter, KEY_UPDATE);
  if (t_update) {
    for (int i = 0; i < MAX_WEBHOOKS; i++) {
      Tuple *tname = dict_find(iter, KEY_NAME_BASE + i);
      if (tname && tname->length > 0) {
        strncpy(s_titles[i], tname->value->cstring, sizeof(s_titles[i]) - 1);
        s_titles[i][sizeof(s_titles[i]) - 1] = '\0';
      } else {
        snprintf(s_titles[i], sizeof(s_titles[i]), "Webhook %d", i + 1);
      }
      Tuple *ten = dict_find(iter, KEY_ENABLED_BASE + i);
      s_enabled[i] = ten ? (ten->value->uint8 ? true : false) : false;
    }
    update_menu_data();
    return;
  }

  Tuple *tstatus = dict_find(iter, KEY_STATUS);
  if (tstatus) {
    int32_t status = tuple_to_int32(tstatus);
    static char buf[64];
    GColor popup_color = GColorBlack;

    // Loggen, ob der Status ankommt und was die Variable gerade sagt
    APP_LOG(APP_LOG_LEVEL_INFO, "Webhook Status %ld received. Auto-Close Variable is: %d", (long)status, s_auto_close_enabled);

    switch (status) {
      case 200:
        snprintf(buf, sizeof(buf), "Success");
        popup_color = GColorIslamicGreen;
        
        // 2. Timer starten, falls Auto-Close aktiv ist!
        if (s_auto_close_enabled) {
          APP_LOG(APP_LOG_LEVEL_INFO, "Start 5s Auto-Close Timer...");
          app_timer_register(5000, auto_close_timer_cb, NULL);
        } else {
          APP_LOG(APP_LOG_LEVEL_INFO, "Timer not started, because Auto-Close is off.");
        }
        break;
      case 0:
        snprintf(buf, sizeof(buf), "Error");
        popup_color = GColorRed;
        break;
      case -1:
        snprintf(buf, sizeof(buf), "Timeout");
        popup_color = GColorOrange;
        break;
      case -2:
        snprintf(buf, sizeof(buf), "Disabled");
        popup_color = GColorDarkGray; 
        break;
      default:
        snprintf(buf, sizeof(buf), "Status %ld", (long)status);
        popup_color = GColorRed;
        break;
    }

    show_transient_popup(buf, popup_color);
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
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  int16_t header_height = PBL_IF_ROUND_ELSE(46, 24);

  #if defined(PBL_ROUND)
    GRect menu_bounds = bounds;
  #else
    GRect menu_bounds = GRect(0, header_height, bounds.size.w, bounds.size.h - header_height);
  #endif

  s_menu_layer = menu_layer_create(menu_bounds);
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks){
    .get_num_sections = menu_get_num_sections_callback,
    .get_num_rows = menu_get_num_rows_callback,
    .draw_row = menu_draw_row_callback,
    .select_click = menu_select_callback,
  });

  menu_layer_set_click_config_onto_window(s_menu_layer, window);

  #if defined(PBL_COLOR)
  menu_layer_set_normal_colors(s_menu_layer, GColorWhite, GColorBlack);
  menu_layer_set_highlight_colors(s_menu_layer, GColorElectricBlue, GColorBlack);
  #endif

  layer_add_child(window_layer, menu_layer_get_layer(s_menu_layer));

  s_header_layer = layer_create(GRect(0, 0, bounds.size.w, header_height));
  layer_set_update_proc(s_header_layer, header_update_proc);
  
  layer_add_child(window_layer, s_header_layer);

  update_menu_data();

  time_t temp = time(NULL);
  struct tm *tick_time = localtime(&temp);
  tick_handler(tick_time, MINUTE_UNIT);
}

static void main_window_unload(Window *window) {
  if (s_menu_layer) {
    menu_layer_destroy(s_menu_layer);
    s_menu_layer = NULL;
  }
  if (s_header_layer) {
    layer_destroy(s_header_layer);
    s_header_layer = NULL;
  }
}

static void init(void) {
  init_settings_defaults();

  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_inbox_dropped(inbox_dropped_callback);
  app_message_open(1024, 1024);

  tick_timer_service_subscribe(MINUTE_UNIT, tick_handler);

  s_main_window = window_create();
  window_set_window_handlers(s_main_window, (WindowHandlers){
    .load = main_window_load,
    .unload = main_window_unload
  });
  window_stack_push(s_main_window, true);
}

static void deinit(void) {
  tick_timer_service_unsubscribe();
  window_destroy(s_main_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}