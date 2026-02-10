#!/usr/bin/env bash
# Setup DNS records for myagents.run on Cloudflare (for AiInbx email)
#
# Usage:
#   CF_API_TOKEN="your-token" ./scripts/setup-myagents-dns.sh
#   # or
#   CF_API_TOKEN="your-token" ZONE_ID="zone-id" ./scripts/setup-myagents-dns.sh
#
# The script will auto-detect the zone ID if not provided.

set -euo pipefail

CF_API="${CF_API_TOKEN:?Set CF_API_TOKEN env var}"
CF_ACCOUNT="c2eaf9330b4b8edda5908b44a5604d53"
DOMAIN="myagents.run"

# Auto-detect zone ID if not provided
if [ -z "${ZONE_ID:-}" ]; then
  echo "Looking up zone ID for $DOMAIN..."
  ZONE_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones?name=$DOMAIN&account.id=$CF_ACCOUNT" \
    -H "Authorization: Bearer $CF_API" \
    -H "Content-Type: application/json" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['result'][0]['id'] if r.get('result') else '')")
  if [ -z "$ZONE_ID" ]; then
    echo "ERROR: Could not find zone for $DOMAIN. Is it added to Cloudflare?"
    exit 1
  fi
  echo "Found zone: $ZONE_ID"
fi

add_record() {
  local type="$1" name="$2" content="$3" priority="${4:-}" proxied="${5:-false}"
  local data="{\"type\":\"$type\",\"name\":\"$name\",\"content\":\"$content\",\"proxied\":$proxied,\"ttl\":1"
  if [ -n "$priority" ]; then
    data+=",\"priority\":$priority"
  fi
  data+="}"

  echo -n "  Adding $type $name ... "
  local resp
  resp=$(curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
    -H "Authorization: Bearer $CF_API" \
    -H "Content-Type: application/json" \
    -d "$data")
  local ok
  ok=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success',''))" 2>/dev/null || echo "")
  if [ "$ok" = "True" ]; then
    echo "OK"
  else
    local err
    err=$(echo "$resp" | python3 -c "import sys,json; r=json.load(sys.stdin); msgs=r.get('errors',[]); print(msgs[0].get('message','unknown') if msgs else 'unknown')" 2>/dev/null || echo "unknown")
    echo "FAIL ($err)"
  fi
}

echo ""
echo "Adding DNS records for $DOMAIN (zone $ZONE_ID)..."
echo ""

# 1. SES verification TXT
add_record "TXT" "_amazonses.$DOMAIN" "WRZ0dNzfp8YSqwoxx6nB0nL7tircDpp/I1JzVkEzhSc="

# 2-4. DKIM CNAME records
add_record "CNAME" "mt5wwktrtxhggl4kwl2h5ejgiv24a2wl._domainkey.$DOMAIN" "mt5wwktrtxhggl4kwl2h5ejgiv24a2wl.dkim.amazonses.com" "" "false"
add_record "CNAME" "n73jdv3tfbuaasxpw6cjltcdsy7lkob2._domainkey.$DOMAIN" "n73jdv3tfbuaasxpw6cjltcdsy7lkob2.dkim.amazonses.com" "" "false"
add_record "CNAME" "msyrh74nv4ookbf4q6254pvnftxlcmtb._domainkey.$DOMAIN" "msyrh74nv4ookbf4q6254pvnftxlcmtb.dkim.amazonses.com" "" "false"

# 5. Bounce MX
add_record "MX" "bounces.$DOMAIN" "feedback-smtp.us-east-1.amazonses.com" 10

# 6. Bounce SPF
add_record "TXT" "bounces.$DOMAIN" "v=spf1 include:amazonses.com -all"

# 7. Inbound MX (for receiving emails)
add_record "MX" "$DOMAIN" "inbound-smtp.us-east-1.amazonaws.com" 10

# 8. DMARC
add_record "TXT" "_dmarc.$DOMAIN" "v=DMARC1; p=none; sp=none; adkim=r; aspf=r"

echo ""
echo "Done! Run 'CF_API_TOKEN=... ./scripts/verify-myagents-dns.sh' to check propagation."
echo "Or verify on AiInbx: check domain status for myagents.run (domainId: mo0by7n5l9xcvoga27c40rhe)"
