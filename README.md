# File Converter

A drag-and-drop file converter that runs entirely in the browser. Files are never uploaded; every conversion happens on the visitor's own device.

| From | To |
|---|---|
| PNG, JPG, WEBP, GIF, BMP, SVG, AVIF, ICO | PNG, JPG, WEBP, BMP, PDF |
| PDF | PNG, JPG, WEBP (one per page), TXT |
| XLSX, XLS, ODS, CSV, TSV | CSV, XLSX, JSON, HTML, ODS, TSV |
| JSON | CSV, XLSX, HTML |
| DOCX | PDF, HTML, TXT, Markdown |
| TXT, Markdown | PDF, HTML |
| HTML | TXT, PDF |

## Run locally

```bash
npm install
npm start          # opens http://localhost:5173
```

On Windows you can also double-click `start.bat`.

## Deploy

`npm run build` writes a fully static site to `dist/`. There is no backend, so any static host works.

### GitHub Pages (automatic)

1. Push this repo to GitHub on the `main` branch.
2. In the repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The workflow in `.github/workflows/deploy.yml` builds and publishes on every push to `main`.

The site will be at `https://<user>.github.io/<repo>/`.

### Netlify, Vercel or Cloudflare Pages

Import the repo and use:

- **Build command:** `npm run build`
- **Output / publish directory:** `dist`

## Project layout

```
public/            App source (HTML, CSS, JS)
  converters.js    All conversion logic
  app.js           UI
server.js          Local dev server (serves public/ + libraries from node_modules)
scripts/build.js   Builds the static site into dist/
vendor.config.js   Which library files are shipped to the browser
```

Libraries used: [PDF.js](https://mozilla.github.io/pdf.js/), [SheetJS](https://sheetjs.com/), [jsPDF](https://github.com/parallax/jsPDF), [JSZip](https://stuk.github.io/jszip/), [mammoth.js](https://github.com/mwilliamson/mammoth.js), [marked](https://marked.js.org/).
