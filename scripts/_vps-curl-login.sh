#!/bin/bash
# Portal-login probe for the dedicated smoke account.
# The password comes from SMOKE_PORTAL_PASSWORD - never hardcode it.
# Note: no portal-smoke@bitpype.com account exists in production
# (verified 2026-11-15); the previously hardcoded value was a
# deliberately-wrong probe string and is inert.
curl -sS -X POST https://bitpype.com/api/v1/portal/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"portal-smoke@bitpype.com\",\"password\":\"${SMOKE_PORTAL_PASSWORD:-}\",\"captchaToken\":\"\"}" \
  -w '\nHTTP %{http_code}\n'
