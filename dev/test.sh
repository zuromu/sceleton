#!/usr/bin/env bash
# Runs the end-to-end test against the fake SCeLE, in both API modes.
#   bash dev/test.sh            both modes
#   bash dev/test.sh --limited  only the HTML fallback mode
set -u
cd "$(dirname "$0")"
node build-dev.mjs > /dev/null

run() {
  python3 mock_scele.py "$@" > /dev/null 2>&1 &
  local mock=$!
  sleep 1
  node e2e.mjs "$@" ${NO_SHOTS:+--no-shots}
  local code=$?
  kill $mock 2> /dev/null
  wait $mock 2> /dev/null
  return $code
}

status=0
if [ "${1:-}" != "--limited" ]; then
  echo "== full API"
  run || status=1
fi
echo "== command line tool"
if python3 -c "import requests, rich" 2> /dev/null; then
  python3 mock_scele.py > /dev/null 2>&1 &
  mock=$!
  sleep 1
  python3 -m unittest test_cli 2>&1 | tail -4
  [ "${PIPESTATUS[0]}" -eq 0 ] || status=1
  kill $mock 2> /dev/null
  wait $mock 2> /dev/null
else
  echo "skipped (pip install requests rich to run it)"
fi
echo "== limited API (HTML fallback)"
NO_SHOTS=1 run --limited || status=1
exit $status
