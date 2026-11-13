# Hot Streak

A pass-and-play, push-your-luck card game for one phone. It works offline once installed.

**Play:** https://timbones7-cell.github.io/hot-streak/

## Put it on your iPhone

1. The site is hosted on GitHub Pages (see below).
2. Open the Pages URL in **Safari** on the iPhone.
3. Tap **Share**, then **Add to Home Screen**.
4. Open it from the home screen icon. It runs full-screen and works with no internet.

Updates: push changes to GitHub, then open the app once while online and it picks them up.

## Hosting on GitHub Pages

1. Create a repository on github.com (it must be public for free Pages).
2. Push this folder to it.
3. Repo **Settings → Pages**: Source = "Deploy from a branch", Branch = `main`, folder `/ (root)`.
4. The site appears at `https://<username>.github.io/<repo>/`.

## Files

- `engine.js`: the rules (deck, turns, actions, scoring). No UI.
- `app.js`: screens, animations, sound, saving.
- `styles.css`: all visuals, including the card designs.
- `sw.js`: offline cache.
- `tests.html`: open it in a browser to run the rules tests.

Local testing: `python -m http.server 8137`, then open http://localhost:8137. Adding `?debug` exposes `window.__deal(names, cards)` for stacking the deck.
