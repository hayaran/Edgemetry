/**
 * The version this build calls itself.
 *
 * Kept as a constant rather than read from `package.json` because the Worker
 * bundle has no business importing the manifest, and rather than injected from
 * git metadata because the copy most people run has none worth reading: the
 * deploy button *imports* this repository instead of forking it, so their
 * history starts at one squashed commit whose SHA exists nowhere upstream.
 * A tag name is the only identity both sides can compare.
 *
 * Bump this and `package.json` together — CI fails the build if they drift —
 * and tag the release `v<this>` so the update check has something to find.
 */
export const VERSION = '0.3.0';
