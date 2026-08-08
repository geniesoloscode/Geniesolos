# Brand assets — Stripe

Derived from the hexagon mark in the site navigation.

```
stripe-icon-512.png        512x512    11 KB   -> Stripe "Icon"
stripe-logo-1024x208.png   1024x208   25 KB   -> Stripe "Logo"
src/icon.html                                  source for the icon
src/logo.html                                  source for the logo
```

Stripe requires **JPG or PNG** (not SVG), **under 512 KB**, **at least 128x128**. Both files
are PNG, well under the size cap, and rendered at 4x the minimum so they stay sharp on
high-DPI screens.

---

## Upload

Go to **Dashboard → Settings → Branding** (`dashboard.stripe.com/account/branding`):

| Field | File / value |
|---|---|
| Icon | `stripe-icon-512.png` |
| Logo | `stripe-logo-1024x208.png` |
| Brand color | `#7C3AED` |
| Accent color | `#FAF5EC` |

---

## Where each setting actually shows up

From Stripe's own documentation — worth knowing, because the icon does far more work than
the logo:

| Setting | Emails | Checkout | Customer portal | Invoice page | Invoice PDF |
|---|---|---|---|---|---|
| Icon | yes | yes | yes | yes | yes |
| Logo | — | yes | — | — | yes |
| Brand color | yes | — | yes | yes | yes |
| Accent color | yes *(background)* | yes | yes | yes | — |

**The icon appears on every surface; the logo only overrides it in two.** That is why the
icon is a solid tile rather than the site's thin outline — line art that reads beautifully
at 26px in the nav goes faint and spindly when Stripe renders it as a small avatar in an
email header. The solid version holds up.

The glyph also sits inside roughly 25% padding, so it survives being cropped to a circle,
which some Stripe surfaces do.

---

## Why these two colors

**Brand `#7C3AED`** is the exact violet of the nav mark and the site's section headings.
White text on it measures **5.7:1** contrast, clearing WCAG AA for normal text — which
matters because Stripe puts it behind white type on buttons and invoice headers.

**Accent `#FAF5EC`** is the site's page background, reused deliberately. Stripe uses the
accent as a **background color on emails**, so it has to stay light. This is the most
common way to make Stripe emails unreadable: pick a vivid accent and the body text on top
of it disappears. Cream keeps dark text at **13.8:1** and makes a receipt feel like a
continuation of geniesolos.com.

If you ever change these, check the accent against Stripe's dark body text before saving.

---

## The logo has a transparent background

Verified — corner pixel alpha is 0. It composites cleanly on white Checkout pages and on
the cream accent alike. There is no baked-in white box that would show as a rectangle over
a tinted surface.

The wordmark uses the same green-to-violet ramp as the site, interpolated in `oklch` so it
does not sag to grey through the middle. Both ends stay dark enough to read on white.

---

## Regenerating

The PNGs are rendered from the HTML in `src/` with headless Chrome:

```powershell
$exe = "C:\Program Files\Google\Chrome\Application\chrome.exe"

# icon - opaque tile
& $exe --headless=new --disable-gpu --hide-scrollbars --window-size=512,512 `
  --screenshot="brand\stripe-icon-512.png" `
  "file:///c:/Users/geneg/Geniesolos/Geniesolos/brand/src/icon.html"

# logo - transparent background
& $exe --headless=new --disable-gpu --hide-scrollbars --window-size=1024,208 `
  --default-background-color=00000000 `
  --screenshot="brand\stripe-logo-1024x208.png" `
  "file:///c:/Users/geneg/Geniesolos/Geniesolos/brand/src/logo.html"
```

`--default-background-color=00000000` is what produces the transparency; without it the
logo gets an opaque white background.

These files are excluded from the website deploy — they are brand source, not site content.
