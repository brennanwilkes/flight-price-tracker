#!/usr/bin/env bash
# CPU now (top over 3 s) split by process tree, and within each tree by process kind:
#   cpu-split.sh name=pid [name=pid ...]
# Prints "booking 123% (node 10 browser 15 renderer 80 gpu 12 utility 6) search ... other 67%"
# (100% = one core). Kinds: node, Chrome's browser process, and Chrome's --type= (renderer,
# gpu-process as gpu, utility, zygote, ...). sweep.yml's booking job logs it every minute and the
# run's averages at the end (cpu-split.sh --summary <log>): which runner, and which part of Chrome,
# takes the 4 cores?
set -u
if [ "${1:-}" = "--summary" ]; then
  # Averages of the logged samples: "name N%" and each "kind N" inside its parentheses.
  awk '/cpu now:/ {
      n++; sub(/.*cpu now: /, "")
      while (match($0, /[a-z]+ [0-9]+%( \([^)]*\))?/)) {
        part = substr($0, RSTART, RLENGTH); $0 = substr($0, RSTART + RLENGTH)
        split(part, w, " "); name = w[1]; v = w[2]; sub(/%/, "", v); tot[name] += v
        if (!(name in seen)) { seen[name] = 1; order[++k] = name }
        if (match(part, /\(.*\)/)) {
          m = split(substr(part, RSTART + 1, RLENGTH - 2), kv, " ")
          for (i = 1; i < m; i += 2) { key = name SUBSEP kv[i]; sub_[key] += kv[i + 1]; if (!(key in kseen)) { kseen[key] = 1; kinds[name] = kinds[name] " " kv[i] } }
        }
      }
    }
    END {
      if (!n) { print "no CPU samples"; exit }
      printf "CPU averages over %d samples (100%% = one core):", n
      for (j = 1; j <= k; j++) {
        name = order[j]; printf " %s %d%%", name, tot[name] / n
        if (kinds[name] != "") { c = split(substr(kinds[name], 2), ks, " "); printf " ("; for (i = 1; i <= c; i++) printf "%s%s %d", (i > 1 ? " " : ""), ks[i], sub_[name, ks[i]] / n; printf ")" }
      }
      print ""
    }' "$2"
  exit
fi
top -b -n 2 -d 3 -w 512 | awk 'f && $1 ~ /^[0-9]+$/ { print $1, $9 } /^top -/ { n++ } n == 2 && /PID/ { f = 1 }' > /tmp/cpu-now.$$
ps -eo pid=,ppid=,args= > /tmp/cpu-tree.$$
awk -v roots="$*" '
  FNR == NR {
    parent[$1] = $2
    kind = "other"
    if ($3 ~ /(^|\/)node$/) kind = "node"
    else if ($0 ~ /chrom|headless_shell/) { kind = "browser"; if (match($0, /--type=[a-z-]+/)) { kind = substr($0, RSTART + 7, RLENGTH - 7); sub(/-process$/, "", kind) } }
    k[$1] = kind
    next
  }
  { cpu[$1] = $2 }
  END {
    n = split(roots, r, " ")
    for (i = 1; i <= n; i++) { split(r[i], kv, "="); name[kv[2]] = kv[1]; sum[kv[1]] = 0 }
    for (p in cpu) {
      j = p; who = "other"
      while (j != "" && j != 0 && j != 1) { if (j in name) { who = name[j]; break } j = parent[j] }
      sum[who] += cpu[p]
      if (who != "other") { by[who, k[p]] += cpu[p]; if (!((who, k[p]) in seen)) { seen[who, k[p]] = 1; kinds[who] = kinds[who] " " k[p] } }
    }
    for (i = 1; i <= n; i++) {
      split(r[i], kv, "="); w = kv[1]; printf "%s %d%%", w, sum[w]
      if (kinds[w] != "") { c = split(substr(kinds[w], 2), ks, " "); printf " ("; for (m = 1; m <= c; m++) printf "%s%s %d", (m > 1 ? " " : ""), ks[m], by[w, ks[m]]; printf ")" }
      printf " "
    }
    printf "other %d%%\n", sum["other"]
  }' /tmp/cpu-tree.$$ /tmp/cpu-now.$$
rm -f /tmp/cpu-now.$$ /tmp/cpu-tree.$$
