# GLC Monitor Wall

Mosaico tipo CCTV con las 7 señales públicas de GLC (`live.dreamtv.gy`), desplegado como
Cloudflare Worker con assets estáticos.
No indexable: `<meta name="robots">`, cabecera `X-Robots-Tag` (`public/_headers`) y `robots.txt`.

- `public/index.html` — el muro (hls.js; HLS nativo en Safari).
- `src/worker.js` — proxy HTTPS en `/hls/<canal>/<archivo>`. El CDN solo responde por http, y una página https
  no puede cargarlo (mixed content). Solo deja pasar las 7 claves de canal y archivos HLS.

## Desplegar

```sh
cd glc-wall
npx wrangler deploy
```

Con Workers Builds (Git): directorio raíz `glc-wall`, comando de deploy `npx wrangler deploy`.

Local: `npx wrangler dev` (o abrir `public/index.html` por http/file, que lee el CDN directo).

## Uso

Clic = audio de ese canal (solo uno a la vez) · doble clic o `1`–`7` = vista única · `Esc` volver ·
`F` pantalla completa · `M` silenciar todo. Una señal que se congela 25 s se reconecta sola.
