# Starlink Monitor

A small, self-hosted dashboard for a Starlink dish. It polls the dish's local gRPC API, keeps a week of history on disk, and serves a live web dashboard. No cloud account or database is needed.

It runs as a single Node process (pm2-friendly) with one dependency, Chart.js.

## Features

- **Live status tiles**: download and upload throughput, latency, ping drop, % obstructed, uptime and boot count, power draw, GPS satellites, signal quality, and active alerts. Tiles change colour when something looks wrong.
- **Last 15 minutes at 1-second resolution**, read straight from the dish's own history buffer: throughput, latency and ping drop.
- **History charts** built from 1-minute samples, for 1 h, 6 h, 24 h or 7 d: average and peak throughput, latency, ping drop and power draw. Periods when the dish is unreachable show as gaps, not zeros.
- **Outage and event log** (30 days): short outages such as `NO_PINGS` or `NO_DOWNLINK`, plus dish events like update reboots, with start times and durations.
- **Obstruction map**: the dish's view of the sky, with obstructed patches in red, plus actual and ideal pointing (tilt, azimuth, elevation).
- **Router and connected clients** (Starlink Gen 2/3 router, same local API on `192.168.1.1:9000`): router firmware, uptime and last boot reason, internet / PoP / dish ping, public and WAN IP, PoE power, alerts; and every connected device with its IP, band (2.4 GHz, 5 GHz, 5 GHz high, Ethernet), signal and SNR, link rates, current throughput, data used and connected time. The 1-minute samples also keep the client count and the router's internet ping. MAC addresses come from the router partly masked (`ac:eb:e6:XX:XX:XX`). The server names itself in the list when the router has no host name for it.
- **Device info**: software and hardware version, Ethernet link speed, update state, bandwidth-restriction reason and the scheduled update-reboot hour.
- **JSON API** for other dashboards (Homepage, Home Assistant, etc.).

## Requirements

- **Node.js 18+**
- **[grpcurl](https://github.com/fullstorydev/grpcurl)**. The dish API uses gRPC server reflection, and grpcurl is the simplest reliable client for it.
- Network access to the dish at `192.168.100.1:9200`. Check this with:

  ```bash
  grpcurl -plaintext -d '{"get_status":{}}' 192.168.100.1:9200 SpaceX.API.Device.Device/Handle
  ```

  If that fails from your server, you may need a static route to `192.168.100.0/24` through your router's WAN side. That's common when using a third-party router or bypass mode.

## Install

```bash
git clone https://github.com/jchisholm59/starlink-monitor.git
cd starlink-monitor
npm install
npm start            # http://localhost:7000
```

### Run in Docker

For a host without Node or grpcurl (the image downloads grpcurl): `docker compose up -d --build`. Set `DISH` / `ROUTER`
in `docker-compose.yml`; data stays in `./data`.

### Run under pm2

```bash
pm2 start ecosystem.config.js
pm2 save             # survive reboots (with `pm2 startup` configured)
```

## Configuration

Set these as environment variables, or in `ecosystem.config.js`:

| Variable  | Default                   | Purpose                  |
|-----------|---------------------------|--------------------------|
| `PORT`    | `7000`                    | HTTP port                |
| `DISH`    | `192.168.100.1:9200`      | Dish gRPC address        |
| `ROUTER`  | `192.168.1.1:9000`        | Starlink router gRPC address; empty to turn the router section off (e.g. bypass mode with no Starlink router) |
| `GRPCURL` | `/usr/local/bin/grpcurl`  | Path to the grpcurl binary |
| `SITES`   | (none)                    | Other monitors to pass through, `name=http://host:port`, comma-separated: each one's dashboard and API at `/sites/<name>/` (e.g. a second property's dish reached over Tailscale) |

## How it works

| What                    | How often    | Kept for |
|-------------------------|--------------|----------|
| Status + 15-min history | every 10 s   | memory (live view) |
| 1-minute sample         | every 60 s   | 7 days, in `data/samples.jsonl` |
| Router status + clients | every 15 s   | memory (`/api/router`) |
| Outages & events        | every 10 s   | 30 days, in `data/outages.json` |
| Dish and router reboots | on each poll | kept, in `data/reboots.json` |
| Obstruction map         | every 10 min | memory |

Each 1-minute sample averages the last 60 seconds of the dish's per-second history, so short bursts still count toward throughput. The peak is kept separately. The sample file is append-only and gets trimmed back to 7 days every 6 hours.

Some quirks of the dish API that this app handles:

- `get_history` is a **900-slot ring buffer** with a running `current` counter. The app unrolls it into time order.
- The **`outages` timestamps are GPS-epoch nanoseconds**, while `eventLog` timestamps are Unix nanoseconds. Both are converted to Unix time.
- grpcurl emits bare **`NaN`**, which isn't valid JSON. It's replaced with `null` before parsing.
- Latency is blanked for seconds where every ping dropped, so outages show as gaps instead of fake zero-millisecond readings.

## API

All endpoints return JSON, with `Access-Control-Allow-Origin: *` so other dashboards (such as the Home Assistant card in `jchisholm59/ha-cards`) can read them from their own pages.

| Endpoint                   | Returns |
|----------------------------|---------|
| `GET /api/live`            | Current status summary and the unrolled 15-minute per-second history |
| `GET /api/samples?hours=N` | 1-minute samples for the last `N` hours (1–168), downsampled to at most 720 points |
| `GET /api/outages`         | Outages and events for the last 30 days, newest first |
| `GET /api/obstruction`     | Obstruction map: `rows`, `cols`, and a flat `snr` array (−1 = no data, 0–1 = signal quality) |
| `GET /api/router`          | Starlink router status and connected clients (`enabled: false` when `ROUTER` is empty) |
| `GET /api/reboots`         | Dish and router boots, newest first: `device`, `at` (Unix s, from uptime), `reason` (e.g. `SOFTWARE_UPDATE`), `softwareVersion`, `previousVersion`, `bootcount` |

Example: current download speed for a dashboard widget:

```bash
curl -s http://localhost:7000/api/live | jq '.status.downMbps'
```

## Files

```
server.js             poller, storage and HTTP server
public/index.html     dashboard layout and styles
public/app.js         charts and live updates
ecosystem.config.js   pm2 config
data/                 runtime data (git-ignored)
```

## Notes

- The dish reboots itself to install updates at the hour shown in the **Uptime** tile (its `swupdateRebootHour`). These reboots appear in the outage log as `Outage booting`, usually 30–60 seconds each.
- This app only reads from the dish. It never changes settings, stows the dish or reboots it.

## License

MIT
