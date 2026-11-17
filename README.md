# Alfa and Touch numbers

Compare Regular and Chrome numbers from the operators' booking services. The browser refreshes the active category every 30 seconds.

## Run locally

Use Node.js 22 or newer. Run `node numbers-server.js` and open `http://127.0.0.1:8101/`.

## Run on a VPS

1. In this directory, run `docker compose up -d --build`.
2. Check the listener with `curl -fsS http://127.0.0.1:8101/health`.
3. Include the contents of `nginx-numbers.conf` in the existing HTTPS server block for `iskndr.com`. Confirm that the server block does not already define the three locations. Run `sudo nginx -t` before `sudo systemctl reload nginx`.
4. Open `https://iskndr.com/numbers`. Check both categories and the last-check labels to verify the VPS can reach Alfa and Touch.

Docker binds the app to the VPS loopback interface. The named volume keeps Regular tracking state across container restarts. In public mode the service shares refreshes within a 10-second window per category. The public app requires outbound HTTPS access to the operators.

The GitHub repository contains the source. Live updates require the Node process described above.

The source contains no stored inventory. On first use the app loads the current lists and uses them as the baseline for later changes.
