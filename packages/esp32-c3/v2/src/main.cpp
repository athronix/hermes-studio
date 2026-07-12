#define HERMES_MCU_FIRMWARE_VERSION "v2"
#define HERMES_MCU_FIRMWARE_MANIFEST_PATH "/api/hermes/mcu/firmware/v2/manifest"
#define HERMES_PIN_BATTERY_ADC 2
#define HERMES_PIN_I2C_SDA 3
#define HERMES_PIN_I2C_SCL 4
#define HERMES_PIN_I2S_DOUT 5
#define HERMES_PIN_I2S_WS 6
#define HERMES_PIN_I2S_DIN 7
#define HERMES_PIN_I2S_BCK 8
#define HERMES_PIN_BOOT 9
#define HERMES_PIN_I2S_MCK 10
#define HERMES_PIN_PA_EN 11
#define HERMES_ES8311_DAC_VOLUME 0xBF
#define HERMES_DEFAULT_OUTPUT_VOLUME_PERCENT 100

// Keep PlatformIO's dependency scanner aware of the libraries used by the
// shared implementation included below.
#include <HTTPClient.h>
#include <Preferences.h>
#include <Update.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiUdp.h>
#include <Wire.h>

// Hardware v2 keeps the v1 application logic and only overrides board-specific
// constants here so the two firmware families cannot drift behaviorally.
#include "../../v1/src/main.cpp"
