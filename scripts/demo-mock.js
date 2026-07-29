/**
 * The demo's back end, such as it is.
 *
 * GitHub Pages serves static files and nothing else, so there is no Worker and
 * no D1 behind the console on the demo site. This script patches `fetch` before
 * the dashboard boots and answers the six endpoints it asks for, out of a
 * synthetic corpus generated in the browser at page load.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It does not ship a JSON dump of precomputed responses. The dashboard sends
 *    a different query for every range, filter stack and comparison toggle, so a
 *    fixture set either explodes combinatorially or quietly returns the same
 *    numbers whatever you click — and clicking is the entire point of an
 *    analytics console. Everything here is computed per request, so filters,
 *    ranges, compare and search all behave.
 *
 *  - It does not bake in any dates. Events are generated at *offsets* from
 *    whenever the page is opened, so the demo is always the last six months
 *    ending today and can never go stale. That is why there is a generator here
 *    rather than a data file: a few hundred bytes of weights beat several
 *    megabytes of timestamps that start rotting the moment they are committed.
 *
 * The aggregation below mirrors src/query.ts. It is much shorter than that file
 * because almost all of query.ts is about D1 — the filter cube, the five-term
 * compound union tree, choosing between rollups and the live hour table. Over a
 * plain array in memory the same semantics are a scan and a Map.
 *
 * Generated demo page — see scripts/build-demo.mjs. Do not edit the copy under
 * the build output; edit this file.
 */

(function () {
  'use strict';

  /* ============================================================ config === */

  /**
   * How much history the demo pretends to have, and how busy the site is at its
   * peak hour. Everything else scales off the two.
   *
   * Their product is the corpus size, and the corpus is one object per event in
   * the browser's heap — so these trade against each other at a fixed budget of
   * roughly a quarter second to generate and fifty megabytes to hold.
   *
   * Volume wins the trade. Six months of a busy site demonstrates more of this
   * console than a year of a quiet one: the live counter needs about a dozen
   * visits an hour before it stops reading zero at 05:00 UTC, every panel has
   * enough distinct values to rank, and 90d is still fully populated. The cost
   * is that the 12mo range shows the site starting six months ago, which is
   * what a six-month-old site looks like.
   */
  var DAYS = 180;
  var PEAK_VISITS_PER_HOUR = 60;

  /**
   * Fixed seed. Two people opening the demo on the same day should be looking
   * at the same numbers — a screenshot in an issue has to mean something.
   */
  var SEED = 0x9e3779b9;

  var SITE_ID = 1;
  var SITE_DOMAIN = 'edgemetry.dev';
  var DEMO_EMAIL = 'demo@edgemetry.dev';

  /**
   * What the install snippet on the Settings tab should say.
   *
   * Left to itself the console guesses its own origin, which on the demo is a
   * github.io address — an install snippet nobody could ever use. This is the
   * same override a real operator saves under Settings when the tracker is
   * served from somewhere other than the dashboard.
   */
  var TRACKER_URL = 'https://stats.edgemetry.dev/em.js';

  /**
   * The demo account is a viewer, not an owner. That is not decoration: the
   * dashboard already keeps Team off the account menu and hides the add-site
   * and remove-site controls for a viewer, so the read-only shape of the demo
   * falls out of the real role check
   * instead of a second code path that could drift from it.
   */
  var DEMO_ROLE = 'viewer';

  /**
   * Rewritten by scripts/build-demo.mjs from src/version.ts, so the account
   * menu in the demo names the build the demo was cut from. The update line
   * never appears here: it is owner-only, and the demo account is a viewer.
   */
  var VERSION = '0.0.0';

  var READ_ONLY = 'Read-only demo — deploy your own to change anything.';

  /* ====================================================== distributions === */

  /* Kept in step with scripts/seed.mjs, which seeds a real local instance. The
     two are separate on purpose: that one posts beacons through the ingest
     pipeline, this one has no pipeline to post to. */

  var COUNTRIES = [
    ['IN', 15], ['US', 15], ['DE', 7], ['GB', 6], ['BR', 5], ['JP', 4], ['CA', 4],
    ['NL', 3], ['AU', 3], ['FR', 3], ['SG', 2], ['NG', 2], ['PL', 2], ['ID', 2],
    ['ES', 2], ['SE', 1]
  ];
  var BROWSERS = [['Chrome', 12], ['Safari', 6], ['Firefox', 3], ['Edge', 2], ['Arc', 1]];
  var SYSTEMS = [['macOS', 9], ['Windows', 7], ['iOS', 4], ['Linux', 2], ['Android', 1]];
  var REFS = [
    ['github.com', 6], ['', 5], ['news.ycombinator.com', 5], ['google.com', 4],
    ['reddit.com', 2], ['x.com', 2], ['lobste.rs', 1]
  ];
  var ROUTES = [
    ['/', 10], ['/pricing', 5], ['/docs', 4], ['/docs/getting-started', 4],
    ['/blog/analytics-at-the-edge', 3], ['/changelog', 2], ['/about', 2],
    ['/blog/hello-world', 1]
  ];
  var EVENTS = [['docs_search', 6], ['signup', 3], ['plan_upgrade', 1]];
  var EVENT_PATHS = { docs_search: '/docs', signup: '/', plan_upgrade: '/pricing' };
  var WIDE = [['≥ 1440px', 6], ['1024–1439', 3]];

  /**
   * Traffic through the UTC day, as a percentage of the busiest hour, so the
   * hourly chart has a recognisable shape.
   *
   * Flatter overnight than the curve in scripts/seed.mjs, and that is the
   * honest shape rather than a fudge: the country weights above put India and
   * the United States at the top together, and an audience split across those
   * two has no dead hours. It also means the person who opens the demo link at
   * 05:00 UTC still sees a moving realtime panel instead of a blank one.
   */
  var HOURLY = [
    38, 34, 31, 30, 32, 38, 48, 62, 78, 92, 100, 98,
    94, 96, 100, 97, 90, 82, 76, 70, 64, 56, 48, 42
  ];

  /* ============================================================= random === */

  /**
   * mulberry32. Math.random() cannot be seeded, and an unseeded demo would show
   * every visitor a different chart — including across a reload, which reads as
   * a bug rather than as fresh data.
   */
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var rand = rng(SEED);

  function weighted(list) {
    var total = 0;
    var i;
    for (i = 0; i < list.length; i++) total += list[i][1];

    var n = rand() * total;
    for (i = 0; i < list.length; i++) {
      n -= list[i][1];
      if (n <= 0) return list[i][0];
    }
    return list[0][0];
  }

  /* =============================================================== time === */

  /* All bucketing is UTC, exactly as in src/time.ts — the demo would otherwise
     disagree with the console it is demonstrating for anyone east of London. */

  function pad(n, width) {
    return String(n).padStart(width || 2, '0');
  }

  function dayOf(ts) {
    var d = new Date(ts * 1000);
    return pad(d.getUTCFullYear(), 4) + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function hourOf(ts) {
    return dayOf(ts) + 'T' + pad(new Date(ts * 1000).getUTCHours());
  }

  function shiftDay(day, delta) {
    var d = new Date(day + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + delta);
    return dayOf(Math.floor(d.getTime() / 1000));
  }

  function daysBetween(from, to) {
    return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;
  }

  /** Monday of the ISO week containing `day`. */
  function weekStart(day) {
    var d = new Date(day + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return dayOf(Math.floor(d.getTime() / 1000));
  }

  function bucketLabel(day, granularity) {
    if (granularity === 'week') return weekStart(day);
    if (granularity === 'month') return day.slice(0, 7);
    return day;
  }

  function isValidDay(day) {
    return /^\d{4}-\d{2}-\d{2}$/.test(day) && !isNaN(Date.parse(day + 'T00:00:00Z'));
  }

  /* ============================================================== corpus === */

  /**
   * One row per event, shaped like a raw `ev_*` row plus the three window
   * functions src/query.ts computes over it (`rn_first = 1`, `visit_views`,
   * `visit_span`). Precomputing them here is the same trick the SQL uses: rank
   * the visit *before* any filter is applied, so "entrances" keeps meaning
   * "visits that started here" rather than "the first row that matched".
   */
  var rows = [];
  var byDay = Object.create(null);
  var visitorSeq = 0;

  function visit(hourStart, nowSec, dayEnd) {
    var country = weighted(COUNTRIES);
    var browser = weighted(BROWSERS);
    var os = weighted(SYSTEMS);
    var device = os === 'iOS' || os === 'Android' ? (rand() < 0.15 ? 'Tablet' : 'Mobile') : 'Desktop';
    var screen = device === 'Mobile' ? '< 768px' : device === 'Tablet' ? '768–1023' : weighted(WIDE);
    var ref = weighted(REFS);

    var utm = ['', '', ''];
    if (ref === 'news.ycombinator.com' && rand() < 0.4) utm = ['hn', 'social', 'launch-week'];
    else if (ref === '' && rand() < 0.2) utm = ['newsletter', 'email', 'launch-week'];

    var visitor = 'v' + ++visitorSeq;
    var pages = rand() < 0.42 ? 1 : 1 + Math.floor(rand() * 3);
    var start = hourStart + Math.floor(rand() * 3600);

    var mine = [];
    for (var p = 0; p < pages; p++) {
      var ts = start + p * (25 + Math.floor(rand() * 200));
      // A visit is one visitor's pageviews inside a UTC day, so one that would
      // run past midnight is truncated rather than split — the same thing the
      // real per-day rollup does to it. `nowSec` does the same at the live edge:
      // the demo must never show traffic from the future.
      if (ts >= dayEnd || ts > nowSec) break;
      mine.push({
        ts: ts,
        day: dayOf(ts),
        hour: hourOf(ts),
        visitor: visitor,
        name: 'pageview',
        path: weighted(ROUTES),
        ref: ref,
        country: country,
        browser: browser,
        os: os,
        device: device,
        screen: screen,
        utm_source: utm[0],
        utm_medium: utm[1],
        utm_campaign: utm[2],
        first: p === 0,
        last: false,
        visitViews: 0,
        visitSpan: 0
      });
    }
    if (mine.length === 0) return;

    var span = mine[mine.length - 1].ts - mine[0].ts;
    for (var i = 0; i < mine.length; i++) {
      mine[i].visitViews = mine.length;
      mine[i].visitSpan = span;
      mine[i].last = i === mine.length - 1;
      push(mine[i]);
    }

    // Roughly one visit in sixteen fires a custom event. Custom events are
    // separate rows with a name other than 'pageview', which is what keeps them
    // out of every pageview metric and inside the Events panel.
    if (rand() < 0.06) {
      var at = mine[0].ts + 60;
      var fired = weighted(EVENTS);
      if (at < dayEnd && at <= nowSec) {
        push({
          ts: at,
          day: dayOf(at),
          hour: hourOf(at),
          visitor: visitor,
          name: fired,
          // Where the event would plausibly have fired. Pinning them all to one
          // page — as the local seed script does, where it does not matter —
          // empties the Events panel the moment anyone filters by a different
          // path, which looks like the panel is broken rather than like the
          // filter is working.
          path: EVENT_PATHS[fired],
          ref: ref,
          country: country,
          browser: browser,
          os: os,
          device: device,
          screen: screen,
          utm_source: utm[0],
          utm_medium: utm[1],
          utm_campaign: utm[2],
          first: false,
          last: false,
          visitViews: 0,
          visitSpan: 0
        });
      }
    }
  }

  function push(row) {
    rows.push(row);
    (byDay[row.day] || (byDay[row.day] = [])).push(row);
  }

  var NOW_AT_LOAD = new Date();
  var TODAY = dayOf(Math.floor(NOW_AT_LOAD.getTime() / 1000));

  (function generate() {
    var nowSec = Math.floor(NOW_AT_LOAD.getTime() / 1000);
    var todayMidnight =
      Date.UTC(NOW_AT_LOAD.getUTCFullYear(), NOW_AT_LOAD.getUTCMonth(), NOW_AT_LOAD.getUTCDate()) / 1000;

    for (var back = DAYS; back >= 0; back--) {
      var midnight = todayMidnight - back * 86400;
      var dayEnd = midnight + 86400;
      var weekday = new Date(midnight * 1000).getUTCDay();
      // A gentle upward trend, plus quieter weekends, so the 90d and 12mo
      // ranges have something to show besides noise.
      var scale = (1 - back / (DAYS * 2.4)) * (weekday === 0 || weekday === 6 ? 0.6 : 1);
      var lastHour = back === 0 ? NOW_AT_LOAD.getUTCHours() : 23;

      for (var hour = 0; hour <= lastHour; hour++) {
        var visits = Math.max(
          0,
          Math.round((HOURLY[hour] / 100) * PEAK_VISITS_PER_HOUR * scale * (0.7 + rand() * 0.6))
        );
        for (var v = 0; v < visits; v++) visit(midnight + hour * 3600, nowSec, dayEnd);
      }
    }

    rows.sort(function (a, b) {
      return a.ts - b.ts;
    });
  })();

  /* ============================================================== query === */

  var METRICS = ['visitors', 'views', 'vpv', 'bounce', 'time'];

  var RANGES = {
    today: { days: 1, granularity: 'hour', prevLabel: 'yesterday' },
    '7d': { days: 7, granularity: 'day', prevLabel: 'previous 7 days' },
    '30d': { days: 30, granularity: 'day', prevLabel: 'previous 30 days' },
    '90d': { days: 90, granularity: 'week', prevLabel: 'previous 90 days' },
    '12mo': { days: 365, granularity: 'month', prevLabel: 'previous year' }
  };

  var MAX_RANGE_DAYS = 3660;

  /** `dim` name -> the row property it reads. Mirrors src/dimensions.ts. */
  var FILTER_COLUMNS = {
    path: 'path',
    referrer: 'ref',
    country: 'country',
    browser: 'browser',
    os: 'os',
    device: 'device',
    screen: 'screen',
    utm_source: 'utm_source',
    utm_medium: 'utm_medium',
    utm_campaign: 'utm_campaign'
  };

  var DIRECT = 'Direct / none';

  function resolveRange(rangeId, from, to) {
    if (from || to) {
      var start = from || TODAY;
      var end = to || TODAY;
      if (!isValidDay(start) || !isValidDay(end) || start > end) return null;

      var length = daysBetween(start, end);
      if (length > MAX_RANGE_DAYS) return null;

      return {
        id: 'custom',
        from: start,
        to: end,
        prevFrom: shiftDay(start, -length),
        prevTo: shiftDay(start, -1),
        granularity: length === 1 ? 'hour' : length > 180 ? 'month' : length > 45 ? 'week' : 'day',
        prevLabel: 'previous ' + length + ' days'
      };
    }

    var preset = RANGES[rangeId || '30d'];
    if (!preset) return null;

    var begin = shiftDay(TODAY, -(preset.days - 1));
    return {
      id: rangeId || '30d',
      from: begin,
      to: TODAY,
      prevFrom: shiftDay(begin, -preset.days),
      prevTo: shiftDay(begin, -1),
      granularity: preset.granularity,
      prevLabel: preset.prevLabel
    };
  }

  /**
   * Parse `f=path:/docs,country:DE`. Only the first colon of each entry splits
   * the dimension from its value, because a path can contain a comma and a
   * referrer can carry a port.
   */
  function parseFilters(raw) {
    if (!raw) return [];

    var filters = [];
    var entries = raw.split(',');
    for (var i = 0; i < entries.length && filters.length < 12; i++) {
      var colon = entries[i].indexOf(':');
      if (colon <= 0) continue;

      var dim = entries[i].slice(0, colon).trim();
      if (!Object.prototype.hasOwnProperty.call(FILTER_COLUMNS, dim)) continue;

      var value;
      try {
        value = decodeURIComponent(entries[i].slice(colon + 1));
      } catch (e) {
        value = entries[i].slice(colon + 1);
      }

      var seen = filters.some(function (f) {
        return f.dim === dim && f.value === value;
      });
      if (!seen) filters.push({ dim: dim, value: value });
    }
    return filters;
  }

  /**
   * Several values on one dimension are OR-ed, different dimensions are AND-ed
   * — clicking two countries means "either", a country plus a path means "both".
   */
  function matcher(filters) {
    if (filters.length === 0) return null;

    var byDim = Object.create(null);
    filters.forEach(function (f) {
      var column = FILTER_COLUMNS[f.dim];
      (byDim[column] || (byDim[column] = [])).push(f.value);
    });

    var columns = Object.keys(byDim);
    return function (row) {
      for (var i = 0; i < columns.length; i++) {
        if (byDim[columns[i]].indexOf(row[columns[i]]) === -1) return false;
      }
      return true;
    };
  }

  function daysIn(from, to) {
    var out = [];
    for (var day = from; day <= to; day = shiftDay(day, 1)) out.push(day);
    return out;
  }

  var EMPTY = { views: 0, visits: 0, bounces: 0, duration: 0 };

  function blank(label) {
    return { label: label, views: 0, visits: 0, bounces: 0, duration: 0 };
  }

  /**
   * The four components every metric is derived from, exactly as the SQL in
   * src/query.ts sums them: a pageview is a view, the visit's *first* pageview
   * is a visit, a visit of one page is a bounce, and a visit contributes the
   * span between its first and last pageview.
   */
  function accumulate(into, row) {
    into.views += 1;
    if (row.first) {
      into.visits += 1;
      if (row.visitViews === 1) into.bounces += 1;
      into.duration += row.visitSpan;
    }
  }

  function labelsFor(range, from, to) {
    if (range.granularity === 'hour') {
      var last = from === TODAY ? NOW_AT_LOAD.getUTCHours() : 23;
      var hours = [];
      for (var h = 0; h <= last; h++) hours.push(from + 'T' + pad(h));
      return hours;
    }

    // Days with no traffic have no row at all; without padding them back in a
    // slow week renders as one lonely bar instead of a seven-day chart.
    var labels = [];
    var seen = Object.create(null);
    daysIn(from, to).forEach(function (day) {
      var label = bucketLabel(day, range.granularity);
      if (!seen[label]) {
        seen[label] = true;
        labels.push(label);
      }
    });
    return labels;
  }

  function loadSeries(range, from, to, filters) {
    var match = matcher(filters);
    var folded = Object.create(null);

    daysIn(from, to).forEach(function (day) {
      var dayRows = byDay[day];
      if (!dayRows) return;

      for (var i = 0; i < dayRows.length; i++) {
        var row = dayRows[i];
        if (row.name !== 'pageview') continue;
        if (match && !match(row)) continue;

        var label = range.granularity === 'hour' ? row.hour : bucketLabel(day, range.granularity);
        accumulate(folded[label] || (folded[label] = blank(label)), row);
      }
    });

    return labelsFor(range, from, to).map(function (label) {
      return folded[label] || blank(label);
    });
  }

  function totalsFrom(buckets) {
    var totals = { views: 0, visits: 0, bounces: 0, duration: 0 };
    buckets.forEach(function (b) {
      totals.views += b.views;
      totals.visits += b.visits;
      totals.bounces += b.bounces;
      totals.duration += b.duration;
    });
    return totals;
  }

  function metricValue(metric, c) {
    if (metric === 'views') return c.views;
    if (metric === 'visitors') return c.visits;
    if (metric === 'vpv') return c.visits === 0 ? 0 : Math.round((c.views / c.visits) * 100) / 100;
    if (metric === 'bounce') return c.visits === 0 ? 0 : Math.round((c.bounces / c.visits) * 1000) / 10;
    return c.visits === 0 ? 0 : Math.round(c.duration / c.visits);
  }

  function summarize(components) {
    var out = {};
    METRICS.forEach(function (m) {
      out[m] = metricValue(m, components);
    });
    return out;
  }

  /* --------------------------------------------------------- breakdowns -- */

  /** How a ranked dimension is read. Mirrors `planFor` in src/query.ts. */
  function planFor(dim) {
    if (dim === 'entry') return { column: 'path', measure: 'entrances', events: false };
    if (dim === 'exit') return { column: 'path', measure: 'exits', events: false };
    if (dim === 'event') return { column: 'name', measure: 'views', events: true };
    return { column: FILTER_COLUMNS[dim], measure: 'views', events: false };
  }

  var BREAKDOWN_DIMS = Object.keys(FILTER_COLUMNS).concat(['entry', 'exit', 'event']);

  /**
   * `visits` on a breakdown row is an entrance count here.
   *
   * The real engine reaches this number by two routes — the per-dimension daily
   * rollup counts distinct visitors, the filter cube counts entrances — and the
   * dashboard renders neither, only `value`. Entrances is the cube's rule, it is
   * the one the README documents, and for every visit-stable dimension (country,
   * browser, device, referrer) it *is* the distinct-visitor count, because a
   * visit has exactly one of each.
   *
   * It is also the cheap one, which turned out to matter: counting distinct
   * visitors meant a set of visitor ids per ranked value, which at twelve months
   * across six dimensions is well over a million retained strings per request.
   * That put a 700ms stall on a panel nobody was reading the number in.
   */
  function loadBreakdowns(range, filters, dims, limit) {
    var match = matcher(filters);

    // Hoisted out of the scan. A twelve-month range is a couple of hundred
    // thousand rows and the plans are the same for every one of them, so
    // resolving them per row per dimension turned this into a million
    // throwaway objects and made the panel take a second to draw.
    var plans = dims.map(function (dim) {
      var plan = planFor(dim);
      plan.dim = dim;
      plan.tally = new Map();
      return plan;
    });

    daysIn(range.from, range.to).forEach(function (day) {
      var dayRows = byDay[day];
      if (!dayRows) return;

      for (var i = 0; i < dayRows.length; i++) {
        var row = dayRows[i];
        if (match && !match(row)) continue;
        var isEvent = row.name !== 'pageview';

        for (var d = 0; d < plans.length; d++) {
          var plan = plans[d];
          if (plan.events !== isEvent) continue;

          var amount =
            plan.measure === 'views' ? 1 : plan.measure === 'entrances' ? (row.first ? 1 : 0) : row.last ? 1 : 0;
          if (amount === 0) continue;

          var name = row[plan.column];
          var bucket = plan.tally.get(name);
          if (!bucket) {
            bucket = { name: name, value: 0, entrances: 0 };
            plan.tally.set(name, bucket);
          }
          bucket.value += amount;
          if (row.first) bucket.entrances += 1;
        }
      }
    });

    var out = {};
    plans.forEach(function (plan) {
      var merged = plan.tally;
      // An entry or exit count *is* a visit count. So is an event count, in this
      // corpus: a visit fires at most one custom event, and no event row is a
      // visit's first pageview, so its entrance count would be zero.
      var countIsVisits = plan.dim === 'entry' || plan.dim === 'exit' || plan.dim === 'event';

      // The absence of a referrer is itself the answer, so it is relabelled
      // rather than dropped. Every other dimension drops its empties — an
      // unnamed UTM campaign is not a campaign.
      var empty = merged.get('');
      if (empty && plan.dim === 'referrer') {
        empty.name = DIRECT;
        merged.set(DIRECT, empty);
      }
      merged.delete('');

      out[plan.dim] = Array.from(merged.values())
        .map(function (bucket) {
          return {
            name: bucket.name,
            value: bucket.value,
            visits: countIsVisits ? bucket.value : bucket.entrances
          };
        })
        .sort(function (a, b) {
          return b.value - a.value || a.name.localeCompare(b.name);
        })
        .slice(0, limit);
    });
    return out;
  }

  /* ----------------------------------------------------------- realtime -- */

  function loadRealtime() {
    // Anchored to the wall clock rather than to page load, so the panel keeps
    // moving while the tab is open — it polls every thirty seconds.
    var seconds = Math.floor(Date.now() / 1000);
    var since = seconds - 30 * 60;
    var currentMinute = Math.floor(seconds / 60);

    var counts = Object.create(null);
    var active = Object.create(null);
    var recent = [];

    for (var i = rows.length - 1; i >= 0; i--) {
      var row = rows[i];
      if (row.ts < since) break;
      if (row.ts > seconds) continue;

      if (row.ts >= seconds - 300) active[row.visitor] = true;
      if (row.name !== 'pageview') continue;

      var minute = Math.floor(row.ts / 60);
      counts[minute] = (counts[minute] || 0) + 1;
      if (recent.length < 8) recent.push({ ts: row.ts, path: row.path, country: row.country });
    }

    // Thirty buckets ending on the minute in progress — the newest minute is
    // the one anybody watching this panel is watching for.
    var minutes = [];
    for (var m = 0; m < 30; m++) {
      var at = currentMinute - (29 - m);
      minutes.push({ label: 30 - m + 'm', cur: counts[at] || 0 });
    }

    return { online: Object.keys(active).length, minutes: minutes, recent: recent };
  }

  /* ============================================================ handlers === */

  var SITE = {
    id: SITE_ID,
    domain: SITE_DOMAIN,
    created_at: Math.floor(NOW_AT_LOAD.getTime() / 1000) - DAYS * 86400
  };

  var ME = {
    id: 1,
    email: DEMO_EMAIL,
    role: DEMO_ROLE,
    created_at: SITE.created_at,
    siteIds: [SITE_ID]
  };

  function json(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }

  function summary(params) {
    var range = resolveRange(params.get('range'), params.get('from'), params.get('to'));
    if (!range) return json({ error: 'invalid range' }, 400);

    var filters = parseFilters(params.get('f'));
    var compare = params.get('cmp') === '1';
    var started = performance.now();

    var series = loadSeries(range, range.from, range.to, filters);
    var previousSeries = compare ? loadSeries(range, range.prevFrom, range.prevTo, filters) : null;

    var per = function (buckets) {
      if (!buckets) return null;
      var out = {};
      METRICS.forEach(function (m) {
        out[m] = buckets.map(function (b) {
          return metricValue(m, b);
        });
      });
      return out;
    };

    var hasPathFilter = filters.some(function (f) {
      return f.dim === 'path';
    });

    return json({
      site: SITE,
      range: range,
      filters: filters,
      totals: summarize(totalsFrom(series)),
      previous: previousSeries ? summarize(totalsFrom(previousSeries)) : null,
      series: {
        labels: series.map(function (b) {
          return b.label;
        }),
        cur: per(series),
        // Trimmed so the two line up point for point; a partial "today" must
        // not be compared against a whole day.
        prev: previousSeries ? per(previousSeries.slice(0, series.length)) : null
      },
      visitsBasis: hasPathFilter ? 'entrances' : 'exact',
      // The console puts a query time in its chrome. Reporting the real cost of
      // the work this page just did is more useful than inventing a plausible
      // number, even though the work is a scan of an array rather than D1.
      meta: { ms: Math.max(1, Math.round(performance.now() - started)), colo: 'DEMO' }
    });
  }

  function breakdown(params) {
    var range = resolveRange(params.get('range'), params.get('from'), params.get('to'));
    if (!range) return json({ error: 'invalid range' }, 400);

    var dims = (params.get('dim') || 'path')
      .split(',')
      .map(function (d) {
        return d.trim();
      })
      .filter(function (d) {
        return BREAKDOWN_DIMS.indexOf(d) !== -1;
      });
    if (dims.length === 0) return json({ error: 'unknown dimension' }, 400);

    var parsed = parseInt(params.get('limit'), 10);
    var limit = isFinite(parsed) ? Math.min(Math.max(parsed, 1), 50) : 10;

    var breakdowns = loadBreakdowns(range, parseFilters(params.get('f')), dims, limit);
    return json({ breakdowns: breakdowns, rows: dims.length === 1 ? breakdowns[dims[0]] : undefined });
  }

  function timeseries(params) {
    var range = resolveRange(params.get('range'), params.get('from'), params.get('to'));
    if (!range) return json({ error: 'invalid range' }, 400);

    var metric = params.get('metric') || 'visitors';
    if (METRICS.indexOf(metric) === -1) return json({ error: 'unknown metric' }, 400);

    var filters = parseFilters(params.get('f'));
    var series = loadSeries(range, range.from, range.to, filters);
    var previous = params.get('cmp') === '1' ? loadSeries(range, range.prevFrom, range.prevTo, filters) : [];

    return json({
      granularity: range.granularity,
      points: series.map(function (bucket, i) {
        return {
          label: bucket.label,
          cur: metricValue(metric, bucket),
          prev: previous[i] ? metricValue(metric, previous[i]) : null
        };
      })
    });
  }

  /* ============================================================== shim === */

  /**
   * The world map is the one thing that stays a real file: it is a hundred
   * kilobytes of Natural Earth geometry, it never changes, and the build script
   * writes it out next to the page. Resolved against this script's own URL so
   * the demo works from a project page under /<repo>/ as well as from a root
   * domain.
   */
  var BASE = document.currentScript ? document.currentScript.src : location.href;
  var WORLD_URL = new URL('./world.json', BASE).href;

  var realFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var request = typeof input === 'string' ? input : input && input.url;
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();

    if (typeof request !== 'string') return realFetch(input, init);

    var url;
    try {
      url = new URL(request, location.href);
    } catch (e) {
      return realFetch(input, init);
    }

    var path = url.pathname;
    if (path.indexOf('/api/') === -1) return realFetch(input, init);

    // Anything that would change state on a real instance. The dashboard shows
    // `error` from the body, and the toast covers the paths that do not.
    if (method !== 'GET') {
      notice(READ_ONLY);
      return Promise.resolve(json({ error: READ_ONLY }, 403));
    }

    if (path.endsWith('/api/world.json')) return realFetch(WORLD_URL, init);

    var params = url.searchParams;
    if (path.endsWith('/api/me')) {
      return Promise.resolve(json({ user: ME, trackerUrl: TRACKER_URL, version: VERSION, update: null }));
    }
    if (path.endsWith('/api/sites')) return Promise.resolve(json({ sites: [SITE] }));
    if (path.endsWith('/api/summary')) return Promise.resolve(summary(params));
    if (path.endsWith('/api/breakdown')) return Promise.resolve(breakdown(params));
    if (path.endsWith('/api/timeseries')) return Promise.resolve(timeseries(params));
    if (path.endsWith('/api/realtime')) return Promise.resolve(json(loadRealtime()));
    if (path.endsWith('/api/users')) return Promise.resolve(json({ users: [] }));

    return Promise.resolve(json({ error: 'not found in demo' }, 404));
  };

  /* ------------------------------------------------------------ chrome -- */

  /** Borrows the console's own toast, so demo messages look like the product. */
  function notice(message) {
    var host = document.getElementById('toast');
    if (!host) return;
    host.textContent = message;
    host.classList.add('on');
    clearTimeout(host._demoTimer);
    host._demoTimer = setTimeout(function () {
      host.classList.remove('on');
    }, 2600);
  }

  /**
   * A standing note that none of this is real.
   *
   * Built here rather than in the page template so the build script stays a
   * pure byte-mover, and pinned bottom-left because the console's own toast
   * owns bottom-centre.
   */
  function banner() {
    var host = document.createElement('div');
    host.setAttribute('role', 'note');
    host.style.cssText =
      'position:fixed;left:14px;bottom:14px;z-index:80;display:flex;align-items:center;gap:8px;' +
      'padding:7px 12px;border:1px solid var(--line);border-radius:999px;background:var(--panel);' +
      'box-shadow:var(--shadow);font:400 11.5px var(--sans);color:var(--muted);max-width:calc(100vw - 28px)';
    host.innerHTML =
      '<span style="width:6px;height:6px;border-radius:50%;background:var(--live);flex:none"></span>' +
      '<span>Live demo · synthetic data · read-only</span>' +
      '<a href="https://github.com/hayaran/Edgemetry" style="color:var(--signal-ink);' +
      'text-decoration:none;font-weight:500;white-space:nowrap">Deploy your own →</a>';
    document.body.appendChild(host);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', banner);
  } else {
    banner();
  }

  // Sign out is a plain form post, not a fetch, so the shim above never sees
  // it. Capture phase, because the dashboard's own submit listener runs first
  // otherwise and this one has to win.
  document.addEventListener(
    'submit',
    function (event) {
      var form = event.target;
      if (form && form.getAttribute('action') === '/logout') {
        event.preventDefault();
        event.stopPropagation();
        notice(READ_ONLY);
      }
    },
    true
  );
})();
