# ESP32-C3 Firmware v2

PlatformIO project for the 16MB ESP32-C3 hardware revision. Firmware v2 uses
the same application logic as v1 and overrides only version and board-specific
constants through `src/main.cpp`.

## Hardware

- Chip: ESP32-C3, 16MB flash
- I2C: SDA GPIO3, SCL GPIO4
- Battery ADC: GPIO2
- I2S: DOUT GPIO5, WS GPIO6, DIN GPIO7, BCK GPIO8, MCLK GPIO10
- BOOT button: GPIO9
- Power amplifier enable: GPIO11
- ES8311 address: `0x18`
- ES8311 DAC volume register: `0xBF` (0dB)
- Default playback volume: 100%
- OLED address: `0x3C` or `0x3D`

The custom partition table intentionally retains v1's proven 4MB dual-OTA
layout. The remaining physical flash is left unused until a larger storage or
OTA layout is explicitly required.

## Commands

```bash
cd packages/esp32-c3/v2
pio run
pio run -t upload
pio device monitor
```

From the repository root, build, erase, and upload v2 with:

```bash
npm run mcu:v2:flash:clean
```

After `pio run`, `npm run build` copies the firmware into
`packages/esp32-c3/release/v2/firmware.bin` and `dist/mcu/v2/firmware.bin`.
Firmware v2 checks only the version-isolated v2 OTA manifest and cannot consume
v1 updates.
