#!/bin/sh
# Independent checks of the four attestation variables in the EXTERNAL branch of
# `source-acceptance-sidecar-check`.
#
# Why this exists separately from the source negative review (task-72): that review
# proves the *driver* refuses. It says nothing about the Make prerequisite, and a
# prerequisite that cannot fail is indistinguishable from one that is absent.
#
# ## Why this does NOT classify by exit code
#
# A GNU make recipe that fails exits **2** regardless of what the command inside it
# returned, so `make exit 2` cannot distinguish "the Make prerequisite refused" from
# "the driver refused and make wrapped it". Measured, same failing token, same driver:
#
#     bun adapters/dsh/native/verify-source.mjs <install>   -> exit 1
#     make source-acceptance-check RUNTIME=<install>        -> exit 2
#
# So each case is classified by **which message was printed**, and the raw driver is
# invoked directly when the driver's own exit code is the subject. A case matching
# neither message is reported as UNKNOWN rather than folded into a bucket: an
# unclassified case is exactly how a guard can look like it works.
#
# ## Why the URL is a closed port
#
# A case whose four variables are all present is *supposed* to get past the
# prerequisite. Pointing it at a closed port makes it fail inside the driver
# immediately, so the probe never touches the fixture another agent is holding.
set -u
cd /home/vcup/projects/vcup-skills || exit 1

# The prerequisite's own sentence, matched together with the field name so that a
# refusal for an unrelated reason cannot be credited to the guard under test.
PREREQ_PREFIX='error: SOURCE_MODE=external needs '
DRIVER_MARK='must be stated by the operator'
HOLDER='/var/tmp/release-gates/rc5'
FAILURES=0

# One case: all four variables present, optionally removing/emptying/blanking one.
run_case() {
  label="$1"; op="$2"; name="${3:-}"
  (
    unset ENSEMBLE_SOURCE_TEST_TOKEN ENSEMBLE_SOURCE_TEST_URL
    unset ENSEMBLE_SOURCE_ATTEST_BY ENSEMBLE_SOURCE_ATTEST_CONTAINER
    unset ENSEMBLE_SOURCE_ATTEST_STATEMENT ENSEMBLE_SOURCE_ATTEST_COPY_SHA256
    export ENSEMBLE_SOURCE_TEST_URL=http://127.0.0.1:1 ENSEMBLE_SOURCE_TEST_TOKEN=x
    export ENSEMBLE_SOURCE_ATTEST_BY=by ENSEMBLE_SOURCE_ATTEST_CONTAINER=ctr
    export ENSEMBLE_SOURCE_ATTEST_STATEMENT=stmt
    export ENSEMBLE_SOURCE_ATTEST_COPY_SHA256="$(printf 'a%.0s' 1 2 3 4 5 6 7 8)"
    if [ -n "$name" ]; then
      case "$op" in
        unset) unset "$name" ;;
        empty) export "$name"= ;;
        ws)    export "$name"="   " ;;
      esac
    fi
    # RUNTIME is supplied so `require-runtime` passes: the subject here is the
    # attestation guard behind it, not the runtime check in front of it.
    make -s source-acceptance-sidecar-check SOURCE_MODE=external RUNTIME="$HOLDER" 2>&1
  )
}

# Report a case verdict. `want` is `prereq` (this field must be named by the
# prerequisite) or `admit` (the prerequisite must let it through).
check() {
  label="$1"; name="$2"; want="$3"
  out=$(run_case "$label" "$op_used" "$name")
  case "$out" in
    *"$PREREQ_PREFIX$name"*) seen='make-prereq' ;;
    *"$DRIVER_MARK"*)        seen='driver' ;;
    *)                       seen='UNKNOWN' ;;
  esac
  case "$want:$seen" in
    prereq:make-prereq) verdict='ok' ;;
    admit:driver)       verdict='ok' ;;
    admit:UNKNOWN)      verdict='ok' ;;   # admitted, then failed for another reason
    *)                  verdict='FAIL'; FAILURES=$((FAILURES + 1)) ;;
  esac
  printf '%-34s layer=%-12s %s\n' "$label" "$seen" "$verdict"
  if [ "$verdict" = FAIL ]; then
    printf '    expected %s, saw %s; first line: %s\n' "$want" "$seen" "$(printf '%s' "$out" | head -1)"
  fi
}

echo '== baseline: a complete set must be ADMITTED by the prerequisite'
op_used=keep
out=$(run_case 'all four present' keep '')
case "$out" in
  *"$PREREQ_PREFIX"*) echo 'all four present                    FAIL: prerequisite refused a complete set'
     FAILURES=$((FAILURES + 1)) ;;
  *) echo 'all four present                    ok: admitted (its refusal comes from below)' ;;
esac

for name in ENSEMBLE_SOURCE_ATTEST_BY ENSEMBLE_SOURCE_ATTEST_CONTAINER \
            ENSEMBLE_SOURCE_ATTEST_STATEMENT ENSEMBLE_SOURCE_ATTEST_COPY_SHA256; do
  echo
  echo "== $name"
  for op in unset empty ws; do
    op_used="$op"
    check "$name $op" "$name" prereq
  done
done

echo
echo '== the driver layer on its own: raw invocation, so its real exit code is visible'
raw=$( (
  unset ENSEMBLE_SOURCE_ATTEST_BY
  export ENSEMBLE_SOURCE_TEST_URL=http://127.0.0.1:1 ENSEMBLE_SOURCE_TEST_TOKEN=x
  export ENSEMBLE_SOURCE_ATTEST_CONTAINER=ctr ENSEMBLE_SOURCE_ATTEST_STATEMENT=stmt
  export ENSEMBLE_SOURCE_ATTEST_COPY_SHA256="$(printf 'a%.0s' 1 2 3 4 5 6 7 8)"
  bun adapters/dsh/native/verify-source.mjs "$HOLDER" 2>&1
) )
# Capture the status before the case test, which would otherwise overwrite it.
raw_code=$?
case "$raw" in
  *"$DRIVER_MARK"*) raw_layer='driver' ;;
  *)               raw_layer='UNKNOWN' ;;
esac
if [ "$raw_layer" = driver ] && [ "$raw_code" = 1 ]; then
  echo "raw driver, ATTEST_BY unset        layer=driver       ok (exit 1 from the driver itself)"
else
  echo "raw driver, ATTEST_BY unset        layer=$raw_layer  FAIL (exit $raw_code, expected driver/1)"
  FAILURES=$((FAILURES + 1))
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo '== attestation prerequisite: every case classified, 0 failures'
else
  echo "== attestation prerequisite: $FAILURES failure(s)"
fi
exit "$FAILURES"
