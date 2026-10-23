# UGME Social Wall

The storefront bundle for the **Social Wall** theme app extension (handle `ugme-canvas`): an explorable wall of customers' approved photos and videos. While shoppers pan and zoom, it only shows thumbnails. Tapping a video opens a player and starts it right away.

Based on [edoardolunardi/infinite-canvas](https://github.com/edoardolunardi/infinite-canvas) (MIT, see `LICENSE-infinite-canvas`).

## How the pieces fit

```
Theme editor → merchant adds "Social Wall" section, picks campaigns (app-owned metaobjects)
  └─ extensions/ugme-canvas/blocks/ugme-canvas.liquid   renders <div data-ugme-canvas data-campaigns="…">
       └─ assets/ugme-canvas-loader.js (≈1 KB)            lazy-loads the bundle when the block nears the viewport
            └─ assets/ugme-canvas.js  ← built from THIS package (React 19 + R3F + three, self-contained)
                 └─ GET /apps/ugme/canvas?campaigns=…    app proxy → app/utils/canvas.server.ts → approved R2 media
```

- This package has its own `package.json`, with React 19. It's built into one IIFE file, so it never touches the admin app's React 18 and Polaris.
- `app/utils/canvas.server.ts` syncs campaigns into the `$app:ugme_campaign` metaobject. That's what fills the **Campaigns** picker in the theme editor.

## Scripts (run from the repo root)

| Command | What it does |
| --- | --- |
| `npm run canvas:install` | Installs this package's dependencies |
| `npm run canvas:dev` | Opens a playground at http://localhost:5173 with sample media. `?endpoint=…&campaigns=…` hits a real endpoint |
| `npm run canvas:build` | Type-checks and builds `extensions/ugme-canvas/assets/ugme-canvas.js`. **Run after any change here, and commit the output** |
| `npm run canvas:set-app-id -- <id>` | One-time: puts the numeric app ID into the block's campaign picker |
| `npm run r2:cors` | One-time per bucket: allows the storefront to read R2 media as WebGL textures |

## Video playback and latency

- Tiles are 512px canvas textures, so videos are never decoded inside the 3D scene.
- Videos with no `thumbnailUrl` get a poster grabbed from their first frames in the browser, two at a time. Generating posters at approval time would be better; see TODOs.
- On desktop, hovering a video tile preloads it. On touch, the video nearest the centre preloads once the view stops moving. A `VideoPool` keeps up to three preloaded videos.
- Tapping calls `video.play()` immediately in the same handler, so phones allow sound. The tile's thumbnail is used as the poster until the video starts.

## TODO / next iterations

- At approval time, generate a 720p H.264 MP4 with `+faststart` and a WebP poster. Store `thumbnailUrl`, `width` and `height`, and serve them from a public/CDN path rather than presigned URLs.
- Merchant curation: a "Show on canvas" toggle per submission in the Library.
- Plan gating, if the canvas becomes a paid add-on.
- Scroll trapping: the canvas captures the wheel and touch while the pointer is over it. Consider "click to activate" on mobile.
