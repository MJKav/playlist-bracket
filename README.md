# Playlist Bracket

Turn any public Spotify playlist into a head-to-head song tournament. Listen to each matchup, pick a winner, and keep going until one song is crowned champion.

## Run it

Requires [Node.js](https://nodejs.org) 18 or newer. There are no dependencies to install.

```bash
npm start
```

Then open http://localhost:3100. On Windows you can also just double-click `start.cmd`.

Use a different port with `PORT=4000 npm start`.

## How to use

1. Paste a Spotify playlist (or album) link, such as `https://open.spotify.com/playlist/…`, and click **Load playlist**.
2. Untick any songs you want to leave out, then choose the seeding:
   - **Playlist order**: songs near the top get the highest seeds, so #1 plays the lowest seed first.
   - **Random draw**: songs are shuffled into the bracket.
3. If the song count isn't a power of two (16, 32, 64…), choose how to handle it:
   - **Give byes**: top seeds skip the first round.
   - **Trim the field**: keep the top 16/32/64… songs.
4. Click **Build bracket**, then either:
   - click **Start matchups** to go through them one at a time, with a Spotify player for each song, or
   - click any song in the bracket to advance it.

Changing an earlier pick automatically clears any later results it affected, and **Undo** reverses it. Your bracket is saved in the browser, so you can close the tab and come back later.

Matchup keyboard shortcuts: <kbd>←</kbd> / <kbd>→</kbd> to pick, <kbd>S</kbd> to skip, <kbd>U</kbd> to undo, <kbd>Esc</kbd> to close.

## Playlists with more than 100 songs

No Spotify login is needed. The app reads Spotify's public embed data, which only includes the **first 100 songs** of a playlist. To use a longer playlist:

1. Open the playlist in the Spotify desktop app.
2. Click any song, then press <kbd>Ctrl</kbd>+<kbd>A</kbd> and <kbd>Ctrl</kbd>+<kbd>C</kbd>.
3. On the home page, open **Playlist has more than 100 songs?** and paste the links.

## Deploy to Render

This repo includes a `render.yaml` blueprint, so Render reads all the settings from it.

1. Push this folder to a GitHub repository. A private repository is fine.
2. On [render.com](https://render.com), sign in with GitHub and choose **New → Blueprint**.
3. Pick the repository and click **Apply**.

Render gives you an address like `https://playlist-bracket.onrender.com`, and every push to `main` redeploys automatically. On the free plan the site goes to sleep after 15 minutes without visitors, so the next visit takes 30–60 seconds to load.

The server protects itself and Spotify from overuse:

- Each visitor gets about 1,500 Spotify lookups per 10 minutes, which is plenty for normal use. Change this with the `RATE_BUDGET` environment variable.
- The server never runs more than 12 Spotify requests at once.
- Playlists are cached for 10 minutes, and songs and artwork for 24 hours.

## How it works

- `server.js` is a small Node server with no dependencies. It serves the site and fetches Spotify's public embed pages and oEmbed endpoint for song titles, artists and artwork, because browsers can't read those directly.
- `public/bracket.js` holds the bracket logic: standard seeding, byes, and deriving each round from your picks.
- `public/view.js` draws the bracket, the matchup cards and the confetti.
- `public/app.js` handles importing, setup, picks, undo and saving.

Spotify's embed pages aren't an official API. If Spotify changes them, importing may stop working until `server.js` is updated.
