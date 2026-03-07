#!/bin/bash
# Sanitize branch name for Azure resource naming
# Usage: ./sanitize-branch-name.sh "feature/my-branch"
# Output: feature-my-branch
#
# Rules:
# - Lowercase
# - Replace / with -
# - Remove special characters (keep only a-z, 0-9, -)
# - Max 20 characters
# - Remove trailing dashes

BRANCH_NAME="$1"

if [ -z "$BRANCH_NAME" ]; then
  echo "Usage: $0 <branch-name>" >&2
  exit 1
fi

echo "$BRANCH_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[\/]/-/g' | sed 's/[^a-z0-9-]//g' | cut -c1-20 | sed 's/-*$//'
