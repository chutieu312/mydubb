#!/bin/sh
# Check whether a commit is a safe Render "Rollback" target for the production database.
#
# Usage: docker/rollback-target-check.sh <commit> <database-revision>
#   <database-revision>: from the Neon SQL Editor: SELECT version_num FROM alembic_version;
#
# A rollback target must know the database's current Alembic revision. Otherwise its
# startup migration step stops with "Can't locate revision" and the rollback deploy fails
# (the database is not changed). Read-only: only inspects git objects.
set -eu

[ $# -eq 2 ] || { echo "usage: $0 <commit> <database-revision>" >&2; exit 2; }
commit=$1
db_revision=$2

git rev-parse --verify --quiet "$commit^{commit}" >/dev/null \
  || { echo "unknown commit: $commit (run 'git fetch' first?)" >&2; exit 2; }

known=$(git grep -h -E "^revision(: str)? = " "$commit" -- backend/alembic/versions/ \
  | sed -E "s/.*= ['\"]([^'\"]+)['\"].*/\1/" | sort | tr '\n' ' ')

echo "commit $(git rev-parse --short "$commit") knows revisions: ${known:-none}"
case " $known " in
  *" $db_revision "*)
    echo "OK: database revision $db_revision is known; this commit is a supported rollback target."
    ;;
  *)
    echo "NOT SUPPORTED: database revision $db_revision is newer than this commit."
    echo "Its container would stop at startup. Roll forward instead (revert the faulty change"
    echo "in a pull request, keeping migration files); see docs/DEPLOYMENT.md, 'Rolling back'."
    exit 1
    ;;
esac
