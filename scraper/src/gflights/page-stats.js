'use strict';
/* Per-page telemetry: where a browser page's time and CPU go.
 *
 * We had page counts and median page times, not why a page took that long or what it cost the
 * machine. So we guessed: reduced motion was a guess at a ~7 CPU-second search page (12:05 am
 * Vancouver, Nov 14), and so was each gap and slot change. Every page now records:
 *   - phases (ms): open (new tab), load (navigation to the first reply), more ("View more flights"),
 *     reload, sellers (booking reply), close. The phases add up to the page's time.
 *   - its renderer's CPU from Chrome's own counters (CDP Performance.getMetrics): process (all
 *     the renderer's threads: main, compositor, raster), and its main thread split into script,
 *     compile, layout, style and other tasks.
 *   - requests by resource type, including the lean context's aborted images, fonts and media.
 *
 *   const p = await profile(page, 'search');  p.mark('load');  ...  await p.done();
 *   summary(stats)  // one log line per kind
 */
const stats = {}; // kind → { n, ms: {phase: [ms]}, cpu: {name: [s]}, req: {type: n}, failed: n }

// The renderer counters we read (seconds, cumulative): ProcessTime is the renderer process's CPU
// time (every thread); TaskDuration its main thread busy, split by the rest.
const METRICS = { ProcessTime: 'process', TaskDuration: 'main', ScriptDuration: 'script', V8CompileDuration: 'compile', LayoutDuration: 'layout', RecalcStyleDuration: 'style' };

async function metrics(cdp) {
  const got = await Promise.race([cdp.send('Performance.getMetrics'), new Promise((r) => setTimeout(() => r(null), 2_000))]);
  if (!got) return null;
  const m = {};
  for (const { name, value } of got.metrics) if (METRICS[name]) m[METRICS[name]] = value;
  return m;
}

/**
 * Start profiling a page of `kind` ('search', 'booking'), opened at `t0` (before ctx.newPage: the
 * first mark, 'open', includes the new tab). Never throws: telemetry only.
 */
async function profile(page, kind, t0 = Date.now()) {
  const s = (stats[kind] ??= { n: 0, ms: {}, cpu: {}, req: {}, failed: 0 });
  let last = t0;
  const ms = {};
  const req = {};
  page.on('request', (r) => { const t = r.resourceType(); req[t] = (req[t] ?? 0) + 1; });
  let cdp = null, start = null;
  try {
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    start = await metrics(cdp);
  } catch { cdp = null; }
  return {
    /** The time since the last mark (or the start) goes to `phase`. */
    mark(phase) { const now = Date.now(); ms[phase] = (ms[phase] ?? 0) + now - last; last = now; },
    /** Before the page closes: reads its CPU and adds this page to the tallies. */
    async done(ok = true) {
      try {
        const end = cdp && await metrics(cdp).catch(() => null);
        if (start && end) for (const k of Object.values(METRICS)) if (end[k] != null) (s.cpu[k] ??= []).push(Math.max(0, end[k] - (start[k] ?? 0)));
        await cdp?.detach().catch(() => {});
      } catch {}
      s.n++;
      if (!ok) s.failed++;
      ms.total = Date.now() - t0;
      for (const [k, v] of Object.entries(ms)) (s.ms[k] ??= []).push(v);
      for (const [k, v] of Object.entries(req)) s.req[k] = (s.req[k] ?? 0) + v;
    },
  };
}

const q = (a, f) => (a?.length ? a.toSorted((x, y) => x - y)[Math.floor(f * (a.length - 1))] : 0);
const sum = (a) => (a ?? []).reduce((x, y) => x + y, 0);

/**
 * One line per kind, e.g. "search pages: 905 (12 failed); time a page median/p90 (share of all
 * page time): load 8.1/15.2 s (61%), more ...; renderer CPU a page median/p90: process 6.1/9.0 s,
 * main 4.0 (script 2.1, compile 0.3, layout 0.4, style 0.3); all pages' CPU 5,520 s; requests a
 * page: xhr 14.2, script 31.0, ..."
 */
function summary(all = stats) {
  return Object.entries(all).map(([kind, s]) => {
    const total = sum(s.ms.total) || 1;
    const phases = Object.keys(s.ms).filter((k) => k !== 'total')
      .map((k) => `${k} ${(q(s.ms[k], 0.5) / 1000).toFixed(1)}/${(q(s.ms[k], 0.9) / 1000).toFixed(1)} s (${Math.round((100 * sum(s.ms[k])) / total)}%)`);
    const c = s.cpu;
    const med = (k) => q(c[k], 0.5).toFixed(1);
    const cpu = c.process?.length
      ? `renderer CPU a page median/p90: process ${med('process')}/${q(c.process, 0.9).toFixed(1)} s, main thread ${med('main')} (script ${med('script')}, compile ${med('compile')}, layout ${med('layout')}, style ${med('style')}); all pages' renderer CPU ${Math.round(sum(c.process))} s (${c.process.length} measured)`
      : 'renderer CPU not measured';
    const req = Object.entries(s.req).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${(n / s.n).toFixed(1)}`).join(', ');
    return `${kind} pages: ${s.n} (${s.failed} failed); time a page median/p90 (share of all page time): ${phases.join(', ')}, total ${(q(s.ms.total, 0.5) / 1000).toFixed(1)}/${(q(s.ms.total, 0.9) / 1000).toFixed(1)} s; ${cpu}; requests a page: ${req}`;
  });
}

module.exports = { stats, profile, summary };
