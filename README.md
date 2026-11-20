# NovaRace Backup Timing

A standalone web app for manual timing-point observations. Race control uploads the RACE RESULT SES snapshot, and volunteers use a phone or tablet to capture bib crossings even when the checkpoint goes offline.

## Start locally

Requires Node.js 22.13 or newer. The repository includes the SES parser under `vendor/studio/`.

```sh
npm install
read -rs 'TIMING_ADMIN_PASSWORD?Choose an admin password (12+ characters): '
export TIMING_ADMIN_PASSWORD
npm start
```

Open http://127.0.0.1:4420 and sign in as `admin`. The startup password initializes the first admin account. Set `TIMING_PORT`, `TIMING_HOST`, or `TIMING_DATA_DIR` to override the defaults. The timing app uses its own SQLite database under `backup-timing/data/`.

## Race day

1. Race control imports one exported SES snapshot and reviews the import findings. Identical uploads reopen the same event. A different SES snapshot creates a separate event, so distribute the intended event to volunteers before the race.
2. Race control creates volunteer accounts and shares credentials through its normal channel.
3. Serve the application over HTTPS on the hostname the volunteers will use. From that address, select the event in race control and use **Copy link**. Select a physical timing point first to include it in the link. The link preselects the assignment after sign-in. A plain HTTP LAN address will not install the offline service worker. Each volunteer signs in online, checks the event and checkpoint, then waits for **Ready to use offline** before leaving coverage.
4. On the keypad, check the active split, search by bib or filter by contest or SES age group, and tap each bib as it crosses. The keypad hides bibs you have recorded for that split, including captures saved offline. Switch splits explicitly at shared points. Use **Undo** to void the last capture and return its bib to the pending list.
5. Keep the app open or reopen it after reconnecting to sync buffered observations. Pending captures also appear in the volunteer's report. Keep the same browser profile and avoid clearing its storage until captures have synced.
6. On the keypad, open **Filters and tools** and choose **View recorded bibs** to see and print your report. Race control can use **Race-control report** in event setup. The print layout uses the browser or device print dialog and retains millisecond time of day, date, contest, split, volunteer, and correction status.

The device records epoch milliseconds at the tap and displays the event time zone when the SES supplies a recognized time zone, otherwise the device time zone. The online clock check reports the offset relative to the server. It does not change the timestamps or remove volunteer reaction time. Captures are manual observations and are stored independently of the official results and RFID data.

In **Filters and tools**, choose a **Gender** or switch **Recording mode** to **Top 10 men and women**. The keypad tracks progress per contest and active split using captures on that device. In **View recorded bibs** or the race-control report, choose **Top 10 men and women** to export only those ranked crossings with **Download CSV**. Rank uses the earliest valid crossing per runner within each contest, gender, checkpoint and split. For events imported before gender was included, upload the identical SES file again and reopen the event to refresh its roster.

`npm test` uses a synthetic SES database to check import, shared-point split selection, authorization, millisecond preservation, duplicate retries, and void corrections through the HTTP handlers.

## Cloudflare

Run the Node server on a computer or VM with persistent storage for `TIMING_DATA_DIR`. A Cloudflare Tunnel can publish that server at an HTTPS hostname by forwarding to `http://127.0.0.1:4420`. Start the server and tunnel on the same machine. Git-connected Cloudflare Pages and Workers require a port of the Node HTTP server and its local SQLite storage.
