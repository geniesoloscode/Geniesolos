# Gene Garland Portfolio

Personal portfolio for **Gene Garland** (GenieSolos): Systems Engineer, CISSP, and web
designer for small businesses.

**Live:** https://geniesolostech.github.io/Geniesolos/

---

## Enabling GitHub Pages (one-time)

1. Go to **Settings → Pages** in this repository.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Set branch to **`main`** and folder to **`/ (root)`**, then **Save**.
4. Wait ~1 minute. The site appears at the URL above.

Want the shorter root URL (`geniesolostech.github.io`) instead? Rename this repo to
`geniesolostech.github.io` under **Settings → General → Repository name**. Pages picks it
up automatically. If you do, update the four absolute URLs in the `og:` / `twitter:`
meta tags at the top of `index.html`.

---

## Structure

```
index.html          all content and page structure
terms.html          service terms (served at /terms)
css/style.css       the entire visual design, both themes
css/terms.css       terms page styles (external: the CloudFront CSP blocks inline styles)
js/terms.js         terms page theme toggle (external, same CSP reason)
js/main.js          boot sequence, canvases, theme toggle, scroll behavior
assets/
  favicon.svg       browser tab icon
  og-card.png       social share preview (1200x630)
.nojekyll           tells Pages to serve files as-is
```

No build step, no dependencies, no framework. Edit a file, commit, push, and it's live.

---

## Editing your content

Everything you'd want to change routinely lives in `index.html`:

| What | Where to look |
|---|---|
| Rotating headline under your name | `roles` array in `js/main.js` |
| Bio and philosophy text | the `<section id="about">` terminal block |
| Skills and proficiency bars | `<section id="skills">`, change the `data-bar="90"` numbers |
| Certifications | `<section id="certs">` |
| Projects | `<section id="work">`, copy an `<article class="proj">` to add one |
| Timeline entries | `<section id="path">` |
| Email, phone, social links | `<section id="contact">` |
| Stat counters | `data-count` attributes in the hero `<ul class="stats">` |

### Adding a project

Copy an existing `<article class="proj" data-reveal data-tilt>` block inside
`<section id="work">` and edit the kicker, title, description, tags, and link. The grid
reflows on its own. Adding `proj--wide` makes a card span two columns.

---

## The two themes

The toggle in the nav switches between the light "sunroom" design and a dark cyber-terminal
design: black canvas, phosphor green, acid lime, amber. The choice is saved to
`localStorage` and applied before first paint by a small inline script in the `<head>`, so
returning dark-theme visitors never see a cream flash.

**Light is the default.** The site follows the visitor's OS dark-mode setting only if they
have never used the toggle themselves; once they pick, their choice wins. To respect the OS
preference on first visit instead, change the inline `<head>` script to fall back to
`window.matchMedia('(prefers-color-scheme: dark)')` when nothing is stored.

Dark mode lives near the bottom of `css/style.css` under `:root[data-theme="dark"]`. It is
mostly a **token remap**: the palette block re-points every custom property, and the purple
family is mapped onto acid lime, which converts most of the design in one move. The rules
after it handle the places that hardcoded an `rgba()` value, plus the spots where the *feel*
changes rather than just the hue: tighter corner radii, glow instead of soft shadow, CRT
scanlines, and the perspective grid horizon in the hero.

Two things CSS can't reach, handled in `js/main.js`:

- The **particle canvas** and the **generative portrait** paint to `<canvas>`. Their colors
  live in the `THEME` object at the top of the file and are re-read on every switch.
- `@keyframes` can't be redefined per theme, so the timeline's pulsing dot swaps to a
  separate `pulseRingDark` animation.

If you add a component, prefer the palette tokens over raw hex values, because anything
token-driven themes itself for free.

---

## Design system

The palette is defined once as CSS custom properties at the top of `css/style.css`.
Change a value there and it propagates everywhere.

| Role | Light | Dark |
|---|---|---|
| Canvas | `#FAF5EC` warm cream | `#060807` near-black |
| Cards | `#FFFDF8` paper | `#0C1310` |
| Ink | `#292437` / `#4E4760` | `#E6F4EC` / `#A9C3B6` |
| Green | `#2ED47F` fills · `#0C7A46` text | `#00FF9C` |
| Yellow | `#FFC933` fills · `#8A5A00` text | `#FFD60A` |
| Accent | `#7C3AED` purple | `#B6FF3A` acid lime |

**A note on the yellow:** `#FFC933` is beautiful as a shape, highlight, or fill, but it
does not meet contrast requirements as small text on cream. That's why yellow speaks
through `--amber-deep` (`#8A5A00`) in the light theme. On black the bright value is already
readable, so dark mode maps both to the same hue. Keep that split if you extend the design.

**A note on the gradients:** the green-to-purple ramps are declared twice: a plain sRGB
version, then the same ramp `in oklch`. Both sRGB and oklab are Cartesian color spaces, so
a green-to-purple ramp crosses the neutral axis and sags to slate-grey in the middle. oklch
interpolates hue angularly and stays saturated. The plain version is the fallback for older
browsers.

Type is Space Grotesk (headings and body), Fraunces (italic accents), and JetBrains Mono
(labels and the terminal), loaded from Google Fonts in the `<head>`.

---

## Deploying

**Normal path: GitHub Actions.** Push to `main`. `.github/workflows/deploy.yml` syncs to
S3, invalidates CloudFront, and checks the live site returns 200. Authentication is OIDC
role assumption; no AWS keys are stored in GitHub.

**Backup path: local.** For when GitHub Actions is unavailable:

```powershell
.\scripts\deploy.ps1 -DryRun    # show what would change
.\scripts\deploy.ps1            # deploy for real
```

It performs the identical steps in the identical order, so either route leaves the bucket
in the same state. It needs the AWS CLI configured with credentials that can write the
bucket and create invalidations.

This is worth knowing about: GitHub Actions is the most outage-prone part of GitHub, and an
outage otherwise leaves no way to ship. The script also deploys the **working tree** rather
than the committed tree, so it can ship a fix before it is committed. It warns loudly when
the tree is dirty, because the next workflow run will overwrite whatever it deployed.

> **Both deployers run `aws s3 sync --delete`.** Their `--exclude` lists must stay
> identical or each will delete what the other uploads, and the site will flip depending on
> which ran last. `scripts/deploy.ps1` parses the workflow on every run and warns if the
> two have drifted. If you add an exclude to one, add it to the other.

---

## Debug flags

Append to the URL when working on the page:

- `?noboot=1` skips the intro animation.
- `?still=1` freezes all motion and forces every scroll-reveal visible. Useful for
  screenshots and for inspecting sections that normally animate in.
- `?theme=dark` / `?theme=light` forces a theme for this page load without changing the
  saved preference. Also handy for sharing a link that opens in a specific look.

The intro also self-skips on repeat views within the same browser tab session, so it
delights once rather than becoming a toll booth.

---

## Accessibility

- Respects `prefers-reduced-motion`, which disables the canvas, boot sequence, and all
  animation while keeping every bit of content visible.
- Keyboard navigable, with a skip link and visible focus rings.
- The theme control is a real `role="switch"` with `aria-checked`, so screen readers
  announce its state.
- Print stylesheet included; the page prints as a clean document.

---

## Regenerating the social card

`assets/og-card.png` is what shows when the link is shared on social media. To change it,
edit the image in any editor or replace the file, but keep it 1200x630 and keep the filename,
since the meta tags point at it. It uses the light palette in both themes, which is
intentional: it needs to read well on the white background of a chat or social feed.
