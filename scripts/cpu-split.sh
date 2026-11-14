#!/usr/bin/env bash
# CPU now (top over 3 s) split by process tree: cpu-split.sh name=pid [name=pid ...]
# Prints "name 123% name 45% other 67%" (100% = one core). sweep.yml's booking job logs it every
# 5 min: which of the booking runner's and the search runner's browsers takes the 4 cores?
set -u
top -b -n 2 -d 3 -w 512 | awk 'f && $1 ~ /^[0-9]+$/ { print $1, $9 } /^top -/ { n++ } n == 2 && /PID/ { f = 1 }' > /tmp/cpu-now.$$
ps -eo pid=,ppid= > /tmp/cpu-tree.$$
awk -v roots="$*" '
  FNR == NR { parent[$1] = $2; next }
  { cpu[$1] = $2 }
  END {
    n = split(roots, r, " ")
    for (i = 1; i <= n; i++) { split(r[i], kv, "="); name[kv[2]] = kv[1]; sum[kv[1]] = 0 }
    for (p in cpu) {
      j = p; who = "other"
      while (j != "" && j != 0 && j != 1) { if (j in name) { who = name[j]; break } j = parent[j] }
      sum[who] += cpu[p]
    }
    for (i = 1; i <= n; i++) { split(r[i], kv, "="); printf "%s %d%% ", kv[1], sum[kv[1]] }
    printf "other %d%%\n", sum["other"]
  }' /tmp/cpu-tree.$$ /tmp/cpu-now.$$
rm -f /tmp/cpu-now.$$ /tmp/cpu-tree.$$
