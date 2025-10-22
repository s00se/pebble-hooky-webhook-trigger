#include <pebble.h>

#define KEY_TRIGGER 0

static Window *s_main_window;
static SimpleMenuLayer *s_menu_layer;
static SimpleMenuSection s_menu_section;
static SimpleMenuItem s_menu_items[1];

// sendet einfach das "Trigger"-Signal an JS
static void send_trigger() {
  DictionaryIterator *iter;
  app_message_outbox_begin(&iter);
  dict_write_uint8(iter, KEY_TRIGGER, 1);
  app_message_outbox_send();

  vibes_short_pulse();
}

static void menu_select_callback(int index, void *ctx) {
  send_trigger();
}

static void main_window_load(Window *window) {
  s_menu_items[0] = (SimpleMenuItem){
    .title = "Webhook auslösen",
    .subtitle = "Testaufruf senden",
    .callback = menu_select_callback
  };

  s_menu_section = (SimpleMenuSection){
    .title = "Aktionen",
    .num_items = 1,
    .items = s_menu_items
  };

  s_menu_layer = simple_menu_layer_create(layer_get_bounds(window_get_root_layer(window)),
                                          window,
                                          &s_menu_section,
                                          1,
                                          NULL);
  layer_add_child(window_get_root_layer(window), simple_menu_layer_get_layer(s_menu_layer));
}

static void main_window_unload(Window *window) {
  simple_menu_layer_destroy(s_menu_layer);
}

static void init(void) {
  app_message_open(256, 256);
  s_main_window = window_create();
  window_set_window_handlers(s_main_window, (WindowHandlers){
                                           .load = main_window_load,
                                           .unload = main_window_unload});
  window_stack_push(s_main_window, true);
}

static void deinit(void) {
  window_destroy(s_main_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
