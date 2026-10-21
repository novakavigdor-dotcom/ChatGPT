# Umami Bingo advertisement

- **Umami-Bingo-Poster.pdf** — one US Letter page, ready to print at 100% / actual size.
- **Umami-Bingo-Ad.png** — 1080×1350 image for social posts.
- **caption.md** — accompanying post text.
- **alt-text.txt** — accessible description for the social image.
- **poster.html** — editable poster source. It uses the restaurant's fonts and illustration asset from `../assets`.

The printed QR goes to `https://umamisushipassport.netlify.app/customer`. It is a signup link, not a customer's personal code. The poster offers a 10% discount for each completed row, column or diagonal: four rows, four columns and two diagonals give up to ten line rewards per card. Filling all 16 squares earns a separate 25% discount. Each line and the full card earn their reward once. Use each reward on a separate purchase; discounts cannot be combined.

To print from the source, open `poster.html` in Chrome or Edge, choose Letter paper, turn on background graphics, and turn off the browser's headers and footers. The supplied PDF already contains those settings.

`render.mjs` regenerates both exports and verifies the QR from the actual PNG. It needs Playwright and Chromium, separately from the app's production dependencies. With Playwright installed locally, run `node marketing/render.mjs` from the repository. To use an installation outside the checkout, set `PLAYWRIGHT_MODULE` to its absolute module path and, if needed, `CHROMIUM_EXECUTABLE` to the browser executable. The normal app build does not run this renderer.
