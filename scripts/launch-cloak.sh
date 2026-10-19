#!/usr/bin/env bash
# Launch CloakBrowser (stealth Chromium) with a dedicated profile and remote
# debugging. macOS only.
#
# Usually you do not need this: `pi-browser` launches the browser itself. Use it
# when you want to start the browser separately and run `pi-browser --attach-only`.
#
#   scripts/launch-cloak.sh [url]
#
# Environment:
#   CLOAK_BIN      Path to the CloakBrowser binary (default: newest in ~/.cloakbrowser)
#   CDP_PORT       Remote-debugging port (default 9223)
#   CLOAK_PROFILE  Profile directory (default ~/.pi-browser/profile)
#   FINGERPRINT    Fingerprint seed (default: read/written from the profile)
#   HEADLESS       Set to 1 for headless (default: headed)
set -euo pipefail

resolve_binary() {
  if [[ -n "${CLOAK_BIN:-}" ]]; then echo "$CLOAK_BIN"; return; fi
  if [[ -n "${CLOAKBROWSER_BINARY_PATH:-}" ]]; then echo "$CLOAKBROWSER_BINARY_PATH"; return; fi
  # Newest chromium-* install under ~/.cloakbrowser
  local newest
  newest="$(ls -d "$HOME"/.cloakbrowser/chromium-*/Chromium.app/Contents/MacOS/Chromium 2>/dev/null | tail -1 || true)"
  echo "$newest"
}

BIN="$(resolve_binary)"
if [[ -z "$BIN" || ! -x "$BIN" ]]; then
  echo "CloakBrowser binary not found. Run: npx cloakbrowser install" >&2
  echo "(or set CLOAK_BIN / CLOAKBROWSER_BINARY_PATH)" >&2
  exit 1
fi

PORT="${CDP_PORT:-9223}"
PROFILE="${CLOAK_PROFILE:-$HOME/.pi-browser/profile}"
URL="${1:-about:blank}"
HEADLESS="${HEADLESS:-}"

mkdir -p "$PROFILE"

# Stable fingerprint per profile: generate once, reuse thereafter.
if [[ -n "${FINGERPRINT:-}" ]]; then
  SEED="$FINGERPRINT"
elif [[ -f "$PROFILE/fingerprint.txt" ]]; then
  SEED="$(cat "$PROFILE/fingerprint.txt")"
else
  SEED=$(( (RANDOM % 90000) + 10000 ))
  echo "$SEED" > "$PROFILE/fingerprint.txt"
fi

ARGS=(
  "--remote-debugging-port=$PORT"
  "--remote-allow-origins=*"
  "--user-data-dir=$PROFILE"
  "--fingerprint=$SEED"
  "--fingerprint-platform=macos"
  --no-first-run
  --no-default-browser-check
  # Keep the page active even when the window is occluded; important for
  # timers, animations and requestAnimationFrame during automation.
  --disable-background-timer-throttling
  --disable-backgrounding-occluded-windows
  --disable-renderer-backgrounding
  --disable-features=CalculateNativeWinOcclusion
)

if [[ -n "$HEADLESS" ]]; then
  ARGS+=(--headless=new)
fi

echo "Launching CloakBrowser (port $PORT, profile $PROFILE, fingerprint $SEED)"
exec "$BIN" "${ARGS[@]}" "$URL"
