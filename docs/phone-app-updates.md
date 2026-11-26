# Phone app updates

The phone app gets most changes **over the air**: new and changed screens reach phones on their own,
without a new build in the App Store or Google Play and without anyone installing anything.

## What happens on its own

1. A change to the phone app's code is pushed to `main`.
2. GitHub runs the tests. If they pass, the website is updated as always.
3. Once the website is running the new code, the same GitHub run sends the phone app's change to
   Expo's update service (the job called **app-update**).
4. Phones pick it up:
   - **Opened from closed:** the app downloads the update in the background and uses it the next
     time it's opened.
   - **Left open:** each time someone comes back to the app (at most every 15 minutes) it looks
     again. When an update has been downloaded, a blue **Update** button shows in the top bar. Tap it
     and the app restarts on the new version in a few seconds.
   - **Me tab:** the bottom of the page shows the version and when it was last updated, with
     **Check for updates** to look right now.

The website always goes first, so a phone never gets a screen before the server it talks to is ready.

If the push didn't touch the phone app (`apps/mobile` or `packages/shared`), nothing is sent.

## Switching it on (once)

Until both of these are done, everything works as before and nothing is sent to phones.

**1. Put out one new build of the app.** Updates only reach builds that were made with updates
switched on, and version 1.1.0 is the first. On a computer signed in to Expo (`eas login`):

```bash
cd apps/mobile
```

```bash
eas build --platform all --profile production
```

```bash
eas submit --platform all --profile production
```

Release it in App Store Connect and the Play Console as usual. (For an Android file to install by
hand, use `--profile preview` instead; it takes the same updates.)

**2. Let GitHub publish updates for you.**

1. Sign in at expo.dev and open **Account settings → Access tokens**
   (https://expo.dev/settings/access-tokens). Create a token, name it "GitHub", and copy it.
2. On GitHub open the repository's **Settings → Secrets and variables → Actions → New repository
   secret** (https://github.com/brizine/HR-Business-Management-Software/settings/secrets/actions/new).
   Name it exactly `EXPO_TOKEN`, paste the token and save.

The token lets its holder publish updates to your app, so paste it only into that GitHub box: not in
chat, email or a file.

To send the first update without waiting for the next change: GitHub → **Actions → CI → Run
workflow**.

Expo's free plan includes updates and should cover a crew this size; the allowance is counted per
phone that downloads an update in a month (https://expo.dev/pricing).

## When a store build is still needed

An update can change screens. It cannot change what is compiled into the installed app:

- a new native library (anything that needs the camera, sensors, files and so on in a new way),
- permissions, the app's name, icon or splash screen, or any other setting in `apps/mobile/app.json`,
- a newer Expo or React Native.

Sending screens that expect native code a phone doesn't have would crash the app, so the checks
refuse it: when a native part changes, `pnpm typecheck` fails until the **version** in
`apps/mobile/app.json` is raised (1.1.0 → 1.2.0). Phones only take updates made for their own
version, so the change then waits for the new build instead of going to phones that can't run it.

After a version is raised:

1. Build and submit as in step 1 above.
2. Phones still on the old version keep working with the screens they have, but **get no more
   updates** until they install the new build. Ask the crew to update from the store.

## Seeing what was sent

- **GitHub → Actions → the run → Summary** says "Sent to phones" or why not (no token yet, nothing
  changed for the phone app, and so on).
- **expo.dev → the project → Updates** lists every update that was sent.
- The `phone-app` branch on GitHub points at the commit phones have, the way `production` points at
  the commit the website runs.
- On a phone: **Me** tab, bottom of the page.

## Taking back a bad update

Fix or revert the change on `main`; the fix goes out like any other update, usually within about
15 minutes of the push.

To take it back at once, from a computer signed in to Expo:

```bash
cd apps/mobile
```

```bash
eas update:rollback
```

It asks which update to undo and puts the one before it back. (If an update ever stops the app from
opening, the app itself goes back to the last version that worked.)

## For developers

| What | Where |
|---|---|
| Update address, version rule | `apps/mobile/app.json` (`updates.url`, `runtimeVersion: appVersion`) |
| Channel (`production` for both build profiles) | `apps/mobile/eas.json` |
| Looking for updates, the Update button, the version line | `apps/mobile/lib/updates.tsx` |
| Native-parts check and its record | `scripts/app-native.mjs`, `apps/mobile/native-parts.json` |
| Plan / wait for the website / publish | `scripts/app-update.mjs`, the `app-update` job in `.github/workflows/ci.yml` |
| "Which code is live?" | `GET /api/health` → `build` (`apps/api/src/lib/source-stamp.ts`) |

- The update is bundled with the API address from `eas.json`, the same one store builds use.
- `node scripts/app-native.mjs --record` rewrites the record; it refuses while the native parts have
  changed and the version hasn't.
- The publishing tool's version is pinned in `scripts/app-update.mjs` (`EAS_CLI`). Raise it on
  purpose, after reading its release notes.
- Updates are off in Expo Go, development builds and the browser preview, so the Update button and
  **Check for updates** don't show there.
- To try an update on one phone before everyone gets it, give a build profile its own `channel` in
  `eas.json` and publish to it by hand: `eas update --channel <name> --message "…"`.
