// Keeping the app current without anybody being told to do anything.
//
// What was wrong: expo-updates, left at its defaults, checks for an update
// when the app cold-boots and downloads it in the background -- and then
// applies it on the NEXT cold boot. Expo's own words: "users load the
// update on a later cold boot, after they kill and restart the app."
//
// So a push reached the phone and sat there. The only way to see it was to
// force-close the app and open it again, which is exactly the manual step
// the one-push-updates-both-apps setup existed to remove. The push was not
// the problem; nothing was ever wired to apply what the push delivered.
//
// This checks on launch and every time the app comes back to the front,
// downloads anything new, and then reloads -- but only at a moment when a
// reload costs nothing.
//
// Why "only at a moment when it costs nothing": a reload is a cold start.
// It throws away whatever is in memory, which right now includes the
// signed-in session and anything half-typed. Reloading a man out of a
// delivery he is halfway through entering would be a worse bug than the
// one this fixes. So the screen says when it is safe, and until it is,
// the update waits.

import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Updates from 'expo-updates';

// Don't hammer the update server when the app is being switched in and out
// of all day at the dock.
const QUIET_PERIOD_MS = 20000;

/**
 * safeToReload — the screen's own word for "nothing would be lost right
 * now". Pass false while a form is open or a session is in memory that a
 * reload would drop.
 *
 * Returns { waiting, apply } so a screen can say an update is ready and
 * let him take it when he chooses.
 */
export function useAutoUpdate(safeToReload) {
  const [waiting, setWaiting] = useState(false);
  const busy = useRef(false);
  const lastLook = useRef(0);

  async function look() {
    // Expo Go and development builds have no update to check for, and
    // asking throws. Guarded rather than caught, so a real failure is
    // still a real failure.
    if (busy.current || __DEV__) return;
    if (Updates.isEnabled === false) return;
    if (Date.now() - lastLook.current < QUIET_PERIOD_MS) return;

    lastLook.current = Date.now();
    busy.current = true;
    try {
      const found = await Updates.checkForUpdateAsync();
      if (found && found.isAvailable) {
        await Updates.fetchUpdateAsync();
        setWaiting(true);
      }
    } catch (e) {
      // No signal at the dock is the usual reason. Try again next time he
      // opens it; never let this surface as an error on his screen.
    } finally {
      busy.current = false;
    }
  }

  useEffect(() => {
    look();
    // Only ever reload a foregrounded app. Expo call reloading from the
    // background experimental, and this is the app his bank position
    // lives in.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') look();
    });
    return () => { if (sub && sub.remove) sub.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (waiting && safeToReload) {
      Updates.reloadAsync().catch(() => { /* it will go on the next one */ });
    }
  }, [waiting, safeToReload]);

  return {
    waiting: waiting,
    apply: () => Updates.reloadAsync().catch(() => {}),
  };
}
