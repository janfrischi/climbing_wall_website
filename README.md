# ADC Sensor Platform — Short Readme

Quick summary
- Visualizes force sensor data read from a serial device (Web Serial API) and rendered with Chart.js.
- Main UI and data pipeline: [src/components/sensor-dashboard.tsx](src/components/sensor-dashboard.tsx).

Run (dev)
1. Install: npm install
2. Start: npm run dev
(see [package.json](package.json))

How to use
- Open the app in the browser, click "Connect Device" and then "Start" to begin collection.
- Use Settings to change sample window (Display Samples) and Y-axis.

Where data is read & shown
- Serial read loop: [`readSerialData`](src/components/sensor-dashboard.tsx) → decodes chunks and calls [`processSerialData`](src/components/sensor-dashboard.tsx).
- Line parsing → adds samples via [`addSensorReading`](src/components/sensor-dashboard.tsx).
- Charts render from React state [`displayData`](src/components/sensor-dashboard.tsx) using helpers like [`getSensorData`](src/components/sensor-dashboard.tsx).

Troubleshooting (visualization lag)
- Reduce displayed points (Settings → Display Samples) or enable throttling/batching of incoming samples.
- For quick local tests use mock data (auto-enabled when no device): [`startMockData`](src/components/sensor-dashboard.tsx).
- If needed, throttle writes to state in [`addSensorReading`](src/components/sensor-dashboard.tsx).

Useful actions
- Export CSV: top-right "Export CSV" button (exports `allSensorData`).
- Calibrate / Jump test: buttons in the UI trigger serial commands.

License / notes
- Small demo app; see source at [src/components/sensor-dashboard.tsx](src/components/sensor-dashboard.tsx) for details.