# How the README images are made

- `cover.html` draws the README cover and the social preview (1280x640) from a real screenshot in `docs/assets/`.
- `docs/how-it-works.svg` is plain SVG, edited by hand.
- The screenshots in `docs/assets/` come from the Playwright desktop suites (`node scripts/check.mjs`) running the source build against throwaway data (`HAVEN_TEST_MODE=1`).

```bash
cd docs/src
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1280,640 --allow-file-access-from-files \
  --screenshot="$PWD/../assets/cover.png" "file://$PWD/cover.html"
```
