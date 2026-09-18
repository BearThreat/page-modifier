#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data_dir="${HOME}/.local/share/page-modifier"
legacy_registry="${HOME}/.openclaw/page-modifier/registry.json"
registry="${data_dir}/registry.json"
unit_dir="${HOME}/.config/systemd/user"

mkdir -p "$data_dir" "$unit_dir"
if [[ ! -e "$registry" && -f "$legacy_registry" ]]; then
  cp --preserve=timestamps "$legacy_registry" "$registry"
  chmod 0600 "$registry"
fi
ln -sfn "$project_dir/systemd/page-modifier-bridge.service" "$unit_dir/page-modifier-bridge.service"
systemctl --user daemon-reload
systemctl --user enable --now page-modifier-bridge.service
for _ in {1..50}; do
  if curl --fail --silent http://127.0.0.1:18793/health >/dev/null; then
    exit 0
  fi
  sleep 0.1
done
systemctl --user status page-modifier-bridge.service --no-pager >&2 || true
exit 1
