# GLC mosaic (WinLGX PC)

The seven public GLC feeds composed into ONE 1920x1080 HLS stream, because the TVs
cannot decode seven videos at once. `/playout` on the automator plays it (config
`playout.mosaicUrl`, default `http://172.20.0.30:8088`; `""` = the seven separate
feeds; `?mosaic=0` on the URL does the same for one screen). Single view (click a tile
or `1`–`7`) still plays that channel's own feed, with audio.

- `mosaic.mjs`, no npm dependencies. One ffmpeg per feed (720x480 rendition → 640x360
  raw), Node paints the 3x3 grid at a fixed 30 fps (a dead feed only blanks its tile),
  one encoder `h264_qsv` 6 Mb/s → HLS 2 s segments in `out/`.
- HTTP `:8088`: `/mosaic.m3u8`, `/seg*.ts`, `/status.json` (per-feed live/down, read by
  the wall for its LIVE / NO SIGNAL labels). CORS `*`.
- Installed in `C:\glc-mosaic` (ffmpeg 9 static, gyan.dev essentials, in `bin\`).
  Scheduled task **GLC Mosaic** (SYSTEM, at startup, restart every minute on failure).
  Log `C:\glc-mosaic\mosaic.log`.
- Measured 2026-11-18 on the i7-6700 + HD 530: 6–27 % total CPU, ~120 MB node + 8 ffmpeg.

Update: `scp glc-wall/mosaic/mosaic.mjs lgx:C:/glc-mosaic/` then
`Stop-ScheduledTask "GLC Mosaic"; Get-Process ffmpeg | Stop-Process -Force; Start-ScheduledTask "GLC Mosaic"`.
Env overrides: `PORT`, `ENCODER` (`libx264` without Quick Sync), `BITRATE`, `FFMPEG`.
