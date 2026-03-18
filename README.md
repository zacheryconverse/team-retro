# Team Retro

Tiny shared retro board for short team meetings.

## Install

Run it without installing:

```bash
npx team-retro
```

Or install it globally:

```bash
npm install -g team-retro
team-retro
```

## What it does

- Runs locally on your machine.
- Gives everyone the same live board with no login.
- Tries to expose a temporary public URL through a no-account tunnel.
- Shuts down cleanly with `Ctrl+C`.

## Common commands

Start with a temporary public URL:

```bash
team-retro
```

Run local-only:

```bash
team-retro --local-only
```

Skip auto-opening the browser:

```bash
team-retro --no-open
```

Pick a port or host:

```bash
team-retro --port 9090 --host 0.0.0.0
```

## Notes

- Keep the terminal open during the meeting.
- If the tunnel service is unavailable, the launcher keeps the board running locally and prints the local URL.
- The app creates a fresh temporary session on each start, so multiple teams can run it at the same time without sharing data.
- Frontend file edits on the host machine still reload live for connected users.
