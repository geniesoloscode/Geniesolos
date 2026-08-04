# Business Card — GenieSolos

Front uses the site's light "sunroom" theme, back uses the dark cyber theme.

```
index.html                     source — open in a browser to preview or print
qr.js                          hand-written QR encoder (no dependencies)
geniesolos-business-card.pdf   PRINT THIS — 2 pages, 3.75 x 2.25 in, front then back
card-front-300dpi.png          1125 x 675 px
card-back-300dpi.png           1125 x 675 px
```

---

## Before you print — three checks

1. **Scan the QR with your phone.** It points to `https://geniesolostech.com`. The encoder
   here was written by hand and passes its own structural and round-trip tests, but no
   automated test substitutes for one real scan. Open `card-back-300dpi.png` on screen and
   scan it.
2. **Buy the domain first.** `geniesolostech.com` is printed as text *and* encoded in the
   QR. Until it is registered and pointing at your site, every scan fails and the printed
   URL goes nowhere. This is the one thing that would make a whole print run useless.
3. **Ask the printer whether they want RGB or CMYK.** See the color note below.

---

## Specs for the printer

| | |
|---|---|
| Trim size | 3.5 × 2 in (US standard) |
| Bleed | 0.125 in on all four sides — document is 3.75 × 2.25 in |
| Safe margin | 0.125 in inside the trim; nothing important is closer |
| Resolution | 300 DPI |
| Pages | 2 — page 1 is the front, page 2 is the back |
| Color | RGB (see below) |

Upload `geniesolos-business-card.pdf`. Most printers — Vistaprint, Moo, local shops —
accept a two-page PDF with bleed and handle the rest. If a printer asks for separate
front/back files, send the two PNGs instead.

### A note on color

These files are RGB. Commercial presses print CMYK, and the conversion will dull the
brightest colors — the phosphor green on the back (`#00FF9C`) is well outside the CMYK
gamut and will come back noticeably more muted than it looks on screen. That is normal and
unavoidable for any bright green.

If it matters to you, ask your printer to do the CMYK conversion (they will do a better job
than an automatic one), or ask for a physical proof before committing to a full run.

---

## Editing

Open `index.html` in a browser. The button at the top toggles trim and safe-margin guides —
red is the cut line, blue is the safe boundary. Anything outside the blue line risks being
trimmed off.

All colors are CSS custom properties at the top of the file, matching the site's palette.
To change the QR target, edit the `target` variable in the script block at the bottom.

### Regenerating the print files

The exports are produced by headless Chrome. From the repo root:

```powershell
# PDF
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu `
  --no-pdf-header-footer --print-to-pdf="card\geniesolos-business-card.pdf" `
  "file:///c:/Users/geneg/Geniesolos/Geniesolos/card/index.html"

# PNG, one face at a time (3.125 scale on a 360x216 window lands exactly on 300 DPI)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu `
  --force-device-scale-factor=3.125 --window-size=360,216 `
  --screenshot="card\card-front-300dpi.png" `
  "file:///c:/Users/geneg/Geniesolos/Geniesolos/card/index.html#only=front"
```

`#only=front` / `#only=back` strips the page down to a single card face so the screenshot
captures exactly the bleed area.

---

## About the QR code

`qr.js` is a self-contained QR encoder — byte mode, versions 1–5, single error-correction
block only. Restricting it to single-block configurations removes block interleaving, the
most bug-prone part of a QR encoder, while still covering roughly 106 characters. The card's
URL encodes as version 2 with level M error correction, 25 × 25 modules.

Run `GSQR._test('your text')` in the browser console to re-run the checks: Galois field
arithmetic, Reed-Solomon remainder, finder and timing patterns, the dark module, and a full
round-trip decode of the placed data. The round-trip check is the strongest verification
available without an optical scanner — hence check #1 above.

The QR is printed as dark modules on a light tile rather than inverted onto the black
background. A light-on-dark QR is rejected by a meaningful share of phone scanners, so the
cream tile is a functional requirement, not a style choice.
