#!/bin/sh
set -eu

umask 077
mkdir -p secrets

if [ ! -s secrets/api_token ]; then
  openssl rand -hex -out secrets/api_token 32
fi

if [ ! -s secrets/gui_password ]; then
  openssl rand 24 | openssl base64 -A -out secrets/gui_password
fi

if [ ! -s secrets/agent_tokens.json ]; then
  agent_token=$(openssl rand -hex 32)
  printf '%s\n' "{\"agents\":[{\"id\":\"internal-agent\",\"token\":\"$agent_token\",\"scopes\":[\"commands:read\",\"jobs:submit\",\"jobs:read\",\"jobs:cancel\",\"sessions:read\"]}]}" \
    > secrets/agent_tokens.json
fi

# Compose mounts file-backed secrets without remapping ownership. The parent
# directory remains root-only; api_token is world-readable only inside its mount
# so the unprivileged backend user can consume it.
chmod 644 secrets/api_token
chmod 644 secrets/agent_tokens.json
chmod 600 secrets/gui_password
