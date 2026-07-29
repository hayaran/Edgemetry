/**
 * The brand mark, as a tab icon.
 *
 * The same three bars as the `.mark` element in the console header and on the
 * sign-in screen, so the icon in the tab strip cannot drift away from the logo
 * sitting next to it. One file, three places.
 *
 * SVG rather than ICO for two reasons. The mark is three rectangles, so it costs
 * a few hundred bytes at every size a browser cares to ask for instead of a
 * multi-resolution bitmap bundle. And it can carry the light/dark inversion the
 * header mark already does — dark square with pale bars on a light tab strip,
 * lavender square with dark bars on a dark one — which no ICO can express.
 *
 * `prefers-color-scheme` inside a favicon is honoured by Chrome and Firefox and
 * ignored elsewhere. Ignoring it lands on the dark square with pale bars, which
 * is the variant that reads on either tab strip, so the fallback is the safe one
 * rather than the broken one.
 */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Edgemetry">
<style>
.bg { fill:#1A1922 }
.bar { fill:#F7F6F3 }
.signal { fill:#5B54E8 }
@media (prefers-color-scheme: dark) {
  .bg { fill:#A29CF7 }
  .bar { fill:#14131A }
  .signal { fill:#14131A; fill-opacity:.5 }
}
</style>
<rect class="bg" width="32" height="32" rx="9"/>
<rect class="bar" x="7" y="6" width="18" height="4" rx="2"/>
<rect class="signal" x="7" y="14" width="10.4" height="4" rx="2"/>
<rect class="bar" x="7" y="22" width="14.4" height="4" rx="2"/>
</svg>
`;
