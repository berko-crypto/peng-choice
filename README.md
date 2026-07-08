# Pengu Faceoff

Two random Pudgy Penguins, one vote. Elo-ranked leaderboard.

## Deploy (Railway — easiest path)
1. Push this folder to a GitHub repo.
2. railway.app → New Project → Deploy from GitHub repo → pick it.
3. Add a **Volume**, mount it at `/app/data` (keeps `faceoff.db` across deploys/restarts).
4. Variables tab → add `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `DB_PATH=/app/data/faceoff.db`. Leave `DISCORD_GUILD_ID` unset for production (global commands); set it to your test server's ID if you want instant command updates while iterating.
5. Railway auto-detects the Dockerfile and runs it as a worker — no exposed port needed, the bot only makes outbound connections.
6. Deploy. Check logs for `Logged in as ... commands registered`.

Fly.io or a small VPS work the same way (`docker build` + `docker run`, mount a volume at `/app/data`). Anything serverless/edge (Vercel, Cloudflare Workers) won't work — the bot needs a long-lived process for the Discord gateway connection.

## Local dev
1. `npm install`
2. Create a bot at discord.com/developers → copy token + application ID. No privileged intents needed.
3. Invite with `applications.commands` + `bot` scopes.
4. Copy `.env.example` to `.env`, fill in values, then:
```
node --env-file=.env index.js
```


## Config (env)
- `PENGU_IMAGE_URL` — image URL template, default `https://api.pudgypenguins.io/penguin/image/{id}`. Swap for your preferred CDN if needed.
- `DB_PATH` — SQLite path, default `faceoff.db`.

## Trait modes
Load trait metadata once, then `/faceoff` and `/leaderboard` get a `trait`/`value` option pair with autocomplete (e.g. Head → Bowlcut).

```
node loadTraits.js metadata.json   # array of {token_id, attributes:[{trait_type,value}]}
node loadTraits.js metadata.csv    # header: token_id,trait_type,value
```

Re-run anytime to update; it upserts. Both trait and value must be given together or the command errors; modes with fewer than 2 tagged pengus are rejected gracefully.

## Commands
- `/faceoff [trait] [value]` — two random pengus (optionally within a trait mode) with vote buttons + a "New matchup" button that stays in the same mode.
- `/leaderboard [trait] [value]` — top 10 by Elo, globally or within a mode (min 3 matchups).
- `/mystats` — your vote count (ephemeral).

## Notes
- One vote per user per matchup; live vote tally shown in embed footers.
- Elo (K=32) instead of raw wins so a pengu that beats popular pengus ranks higher than one farming easy matchups.
