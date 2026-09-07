#!/bin/sh

case "${1:-}" in
  *Username*|*username*)
    printf '%s\n' "${GIT_USERNAME:-x-access-token}"
    ;;
  *)
    printf '%s\n' "${GIT_TOKEN:-${GITHUB_TOKEN:-}}"
    ;;
esac

