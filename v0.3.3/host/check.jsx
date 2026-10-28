// Check: the mistake detector.
//
// One scan reads the chosen compositions and reports what looks wrong. The
// work is deliberately split:
//
//   check.scan     reads the project and returns findings, plus the raw
//                  material the panel needs to finish two of the checks.
//   check.frame    renders one frame to a PNG so the panel can look at it.
//   check.markers  drops the findings into the timeline as markers.
//   check.clear    removes markers Flow put there.
//   check.reveal   opens a composition at the moment a finding is about.
//
// One check cannot be finished here and says so by returning material instead
// of findings: black borders. Layer geometry can only say "nothing is known to
// cover the frame here", which a mask or an effect can make wrong in either
// direction. It returns candidate times; the panel renders those frames and
// decides. Everything uncertain is treated as a candidate, because a wasted
// render is cheaper than a missed border.
//
// The scan never writes to the project: no temporary effects, no undo group.
// That is why the geometry below is plain arithmetic on the layers it can
// work out by hand, rather than the measured toComp() trick the Anchor Point
// and Null tools use.

(function (Flow) {
  if (!Flow) return;

  var MAX_COMPS = 60;
  var MAX_LAYERS = 600;
  var MAX_PROP_DEPTH = 10;
  var MAX_GEOMETRY_TIMES = 48;
  var MAX_MARKERS = 500;
  var MAX_DETAIL = 220;
  var NEST_DEPTH = 6;

  // How long to wait for After Effects to finish writing a saved frame, and
  // how often to look. One frame of a heavy composition can take a moment.
  var FRAME_TIMEOUT = 20000;
  var FRAME_POLL = 40;

  // Counts up for the life of the host, so two saved frames never share a name.
  var frameSeq = 0;

  // Every marker Flow writes starts with this, which is the only way it can
  // tell its own markers from the user's when clearing them again.
  var MARKER_PREFIX = "Flow: ";

  var CHECKS = ["footage", "expressions", "borders", "timing"];
  var SCOPES = ["selected", "active", "project"];

  // ------------------------------------------------------------ small utils

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function frameTime(comp) {
    var fps = comp.frameRate;
    return (fps && isFinite(fps) && fps > 0) ? 1 / fps : 1 / 25;
  }

  // Layer in and out points land on frames, but float arithmetic on them does
  // not, so every time that leaves this file is snapped to a frame first.
  function snapToFrame(comp, t) {
    var step = frameTime(comp);
    var frame = Math.round(t / step);
    return frame * step;
  }

  function pad(n, width) {
    var s = String(Math.abs(n));
    while (s.length < width) s = "0" + s;
    return s;
  }

  // After Effects' own formatter honours the project's display format (frames
  // or timecode, and its start time), which is what the user reads off the
  // timeline. It is a global function, so it is not there in the test harness.
  function timecode(comp, t) {
    try {
      if (typeof timeToCurrentFormat === "function") {
        return String(timeToCurrentFormat(t, comp.frameRate, false));
      }
    } catch (e) { /* fall through to the plain formatter */ }

    var fps = comp.frameRate && comp.frameRate > 0 ? comp.frameRate : 25;
    var frames = Math.round(t * fps);
    var sign = frames < 0 ? "-" : "";
    frames = Math.abs(frames);
    var ff = frames % Math.round(fps);
    var seconds = (frames - ff) / Math.round(fps);
    return sign + Math.floor(seconds / 3600) + ":" + pad(Math.floor(seconds / 60) % 60, 2) +
      ":" + pad(seconds % 60, 2) + ":" + pad(ff, 2);
  }

  function shorten(text, max) {
    var s = String(text === undefined || text === null ? "" : text);
    s = s.replace(/[\r\n\t]+/g, " ");
    return s.length > max ? s.substring(0, max - 1) + "\u2026" : s;
  }

  function layerName(layer) {
    try {
      return String(layer.name);
    } catch (e) {
      return "Layer";
    }
  }

  // ------------------------------------------------------------ findings

  function makeFindings() {
    return { list: [], seq: 0 };
  }

  function addFinding(store, comp, layer, opts) {
    store.seq++;
    var t = clamp(opts.time, 0, Math.max(0, comp.duration - frameTime(comp)));
    t = snapToFrame(comp, t);
    var finding = {
      id: "f" + store.seq,
      check: opts.check,
      severity: opts.severity,
      compId: comp.id,
      compName: String(comp.name),
      layerIndex: layer ? layer.index : 0,
      layerName: layer ? layerName(layer) : String(comp.name),
      time: t,
      timecode: timecode(comp, t),
      message: opts.message
    };
    if (opts.detail) finding.detail = shorten(opts.detail, MAX_DETAIL);
    store.list.push(finding);
    return finding;
  }

  // ------------------------------------------------------------ finding comps

  function itemById(id) {
    var project = app.project;
    if (!project) return null;
    try {
      if (typeof project.itemByID === "function") {
        var direct = project.itemByID(id);
        if (direct) return direct;
      }
    } catch (e) { /* older hosts: fall back to the scan below */ }
    for (var i = 1; i <= project.numItems; i++) {
      var item = project.item(i);
      if (item && item.id === id) return item;
    }
    return null;
  }

  function compById(id) {
    var item = itemById(id);
    if (!item || !(item instanceof CompItem)) {
      throw Flow.error("NO_ACTIVE_COMP", "That composition is no longer in the project.");
    }
    return item;
  }

  function pushComp(list, seen, comp) {
    if (!comp || seen["c" + comp.id]) return false;
    seen["c" + comp.id] = true;
    list.push(comp);
    return true;
  }

  // Compositions used by the layers of `comp`, and theirs in turn.
  function addNested(comp, list, seen, depth) {
    if (depth > NEST_DEPTH || list.length >= MAX_COMPS) return;
    var count = 0;
    try {
      count = comp.numLayers;
    } catch (e) {
      return;
    }
    for (var i = 1; i <= count && list.length < MAX_COMPS; i++) {
      var source = null;
      try {
        source = comp.layer(i).source;
      } catch (readError) {
        continue;
      }
      if (source && source instanceof CompItem && pushComp(list, seen, source)) {
        addNested(source, list, seen, depth + 1);
      }
    }
  }

  function collectComps(scope, includeNested, notes) {
    if (!app.project) throw Flow.error("NO_PROJECT", "Open a project first.");

    var list = [];
    var seen = {};
    var i;

    if (scope === "project") {
      for (i = 1; i <= app.project.numItems && list.length < MAX_COMPS; i++) {
        var item = app.project.item(i);
        if (item instanceof CompItem) pushComp(list, seen, item);
      }
    } else if (scope === "selected") {
      var selection = app.project.selection || [];
      for (i = 0; i < selection.length && list.length < MAX_COMPS; i++) {
        if (selection[i] instanceof CompItem) pushComp(list, seen, selection[i]);
      }
      if (!list.length) {
        var active = app.project.activeItem;
        if (active instanceof CompItem) {
          pushComp(list, seen, active);
          notes.push("Nothing was selected in the Project panel, so the open composition was checked.");
        }
      }
    } else {
      var open = app.project.activeItem;
      if (open instanceof CompItem) pushComp(list, seen, open);
    }

    if (!list.length) {
      if (scope === "project") {
        throw Flow.error("NO_SELECTION", "This project has no compositions to check.");
      }
      if (scope === "active") {
        throw Flow.error("NO_ACTIVE_COMP", "Open a composition first.");
      }
      throw Flow.error("NO_SELECTION", "Select one or more compositions in the Project panel.");
    }

    if (includeNested) {
      var roots = list.slice(0);
      for (i = 0; i < roots.length; i++) addNested(roots[i], list, seen, 1);
    }

    if (list.length >= MAX_COMPS) {
      notes.push("Only the first " + MAX_COMPS + " compositions were checked.");
    }
    return list;
  }

  function layersOf(comp, notes) {
    var out = [];
    var count = 0;
    try {
      count = comp.numLayers;
    } catch (e) {
      return out;
    }
    for (var i = 1; i <= count && out.length < MAX_LAYERS; i++) {
      try {
        out.push(comp.layer(i));
      } catch (readError) { /* a layer that cannot be read cannot be checked */ }
    }
    if (count > MAX_LAYERS) {
      notes.push("\"" + comp.name + "\" has " + count + " layers; only the first " + MAX_LAYERS + " were checked.");
    }
    return out;
  }

  // ------------------------------------------------------------ check: footage

  function startTimeOf(comp, layer) {
    var t = 0;
    try {
      t = layer.inPoint;
    } catch (e) {
      t = 0;
    }
    if (!isFinite(t)) t = 0;
    return clamp(t, 0, Math.max(0, comp.duration - frameTime(comp)));
  }

  function checkFootage(comp, layers, store) {
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var source = null;
      try {
        source = layer.source;
      } catch (e) {
        continue;
      }
      if (!source || !(source instanceof FootageItem)) continue;

      var missing = false;
      try {
        missing = source.footageMissing === true;
      } catch (readError) {
        missing = false;
      }
      if (missing) {
        var where = "";
        try {
          where = source.file ? String(source.file.fsName) : "";
        } catch (fileError) { /* a missing file may have no File object left */ }
        addFinding(store, comp, layer, {
          check: "footage",
          severity: "error",
          time: startTimeOf(comp, layer),
          message: "Missing footage: " + shorten(source.name, 60),
          detail: where
        });
        continue;
      }

      var placeholder = false;
      try {
        placeholder = typeof PlaceholderSource !== "undefined" && source.mainSource instanceof PlaceholderSource;
      } catch (sourceError) {
        placeholder = false;
      }
      if (placeholder) {
        addFinding(store, comp, layer, {
          check: "footage",
          severity: "warning",
          time: startTimeOf(comp, layer),
          message: "Placeholder instead of real footage: " + shorten(source.name, 60)
        });
      }
    }
  }

  // ------------------------------------------------------------ check: expressions

  // Walks a layer's property tree. Both numProperties and property(i) throw on
  // some group types, so every step is guarded and the depth is capped.
  function walkProperties(group, path, depth, visit) {
    if (depth > MAX_PROP_DEPTH) return;
    var count = 0;
    try {
      count = group.numProperties;
    } catch (e) {
      return;
    }
    for (var i = 1; i <= count; i++) {
      var prop = null;
      try {
        prop = group.property(i);
      } catch (readError) {
        continue;
      }
      if (!prop) continue;

      var name = path;
      try {
        name = path ? path + " > " + String(prop.name) : String(prop.name);
      } catch (nameError) { /* keep the parent path */ }

      if (prop.propertyType === PropertyType.PROPERTY) {
        visit(prop, name);
      } else {
        walkProperties(prop, name, depth + 1, visit);
      }
    }
  }

  function checkExpressions(comp, layers, store) {
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var at = startTimeOf(comp, layer);
      walkProperties(layer, "", 0, (function (currentLayer, time) {
        return function (prop, path) {
          var expression = "";
          try {
            if (!prop.canSetExpression) return;
            expression = String(prop.expression || "");
          } catch (e) {
            return;
          }
          if (!expression) return;

          var error = "";
          try {
            error = String(prop.expressionError || "");
          } catch (errorRead) {
            error = "";
          }

          if (error) {
            addFinding(store, comp, currentLayer, {
              check: "expressions",
              severity: "error",
              time: time,
              message: "Expression error on " + shorten(path, 60),
              detail: error
            });
            return;
          }

          var enabled = true;
          try {
            enabled = prop.expressionEnabled !== false;
          } catch (enabledRead) {
            enabled = true;
          }
          if (!enabled) {
            addFinding(store, comp, currentLayer, {
              check: "expressions",
              severity: "warning",
              time: time,
              message: "Expression is switched off on " + shorten(path, 60),
              detail: shorten(expression, MAX_DETAIL)
            });
          }
        };
      })(layer, at));
    }
  }

  // ------------------------------------------------------------ check: timing

  /**
   * How far a moment sits from a round second, or null when it is on one.
   *
   * The question has to be asked in frames, not seconds. At 29.97 the twelve
   * second mark is frame 360, which is 12.012012... seconds - a number that
   * looks nothing like a round one while the timeline reads 0:00:12:00. So the
   * test is the one the timecode makes: does the frame count divide by the
   * frames in a displayed second?
   */
  function roundMiss(comp, t) {
    var fps = comp.frameRate > 0 ? comp.frameRate : 25;
    var perSecond = Math.round(fps);
    if (perSecond < 1) return null;

    var frames = Math.round(t * fps);
    var over = frames % perSecond;
    if (over === 0) return null;

    var under = perSecond - over;
    var past = over <= under;
    return {
      frames: past ? over : under,
      past: past,
      target: (past ? frames - over : frames + under) / fps
    };
  }

  function missMessage(comp, label, t, miss) {
    return label + " is at " + timecode(comp, t) + ", " + miss.frames +
      (miss.frames === 1 ? " frame " : " frames ") + (miss.past ? "past " : "short of ") +
      timecode(comp, miss.target);
  }

  /**
   * The composition's own in and out points - the ends of the work area - and
   * nothing else. Whether the work area stops short of the end of the
   * composition is not a mistake: a ten second out point in a fifteen second
   * composition is a perfectly ordinary way to work. What matters is that the
   * two points land on round numbers.
   */
  function checkTiming(comp, store) {
    var step = frameTime(comp);
    var start = 0;
    var areaDuration = comp.duration;
    try {
      start = comp.workAreaStart;
      areaDuration = comp.workAreaDuration;
    } catch (e) {
      return;
    }

    var startMiss = roundMiss(comp, start);
    if (startMiss) {
      addFinding(store, comp, null, {
        check: "timing",
        severity: "warning",
        time: start,
        message: missMessage(comp, "In point", start, startMiss)
      });
    }

    var end = start + areaDuration;
    var endMiss = roundMiss(comp, end);
    if (endMiss) {
      addFinding(store, comp, null, {
        check: "timing",
        severity: "warning",
        time: Math.max(0, end - step),
        message: missMessage(comp, "Out point", end, endMiss)
      });
    }
  }

  // ------------------------------------------------------------ check: borders

  function transformOf(layer) {
    try {
      return layer.property("ADBE Transform Group");
    } catch (e) {
      return null;
    }
  }

  function valueAt(group, matchName, t) {
    try {
      var prop = group.property(matchName);
      if (!prop) return null;
      return prop.valueAtTime(t, false);
    } catch (e) {
      return null;
    }
  }

  function groupCount(layer, matchName) {
    try {
      var group = layer.property(matchName);
      return group ? group.numProperties : 0;
    } catch (e) {
      return 0;
    }
  }

  function positionAt(layer, group, t) {
    try {
      var prop = group.property("ADBE Position");
      if (prop && prop.dimensionsSeparated) {
        var x = valueAt(group, "ADBE Position_0", t);
        var y = valueAt(group, "ADBE Position_1", t);
        if (x === null || y === null) return null;
        return [Number(x), Number(y)];
      }
    } catch (e) {
      return null;
    }
    var v = valueAt(group, "ADBE Position", t);
    return v ? [v[0], v[1]] : null;
  }

  /**
   * True only when this one layer certainly fills the whole frame on its own.
   * Anything that could make that untrue - a parent, 3D, rotation, a mask, an
   * effect, a matte, partial opacity, a blending mode - answers false, so the
   * frame is rendered and looked at instead of trusted.
   */
  function coversFrame(comp, layer, t) {
    try {
      if (layer.threeDLayer) return false;
      if (layer.parent) return false;
      if (layer.adjustmentLayer) return false;
      if (layer.hasTrackMatte) return false;
      if (typeof BlendingMode !== "undefined" && layer.blendingMode !== BlendingMode.NORMAL) return false;
    } catch (e) {
      return false;
    }
    if (groupCount(layer, "ADBE Mask Parade") > 0) return false;
    if (groupCount(layer, "ADBE Effect Parade") > 0) return false;

    var group = transformOf(layer);
    if (!group) return false;

    var opacity = valueAt(group, "ADBE Opacity", t);
    if (opacity === null || Number(opacity) < 100) return false;

    var rotation = valueAt(group, "ADBE Rotate Z", t);
    if (rotation === null || Math.abs(Number(rotation) % 360) > 1e-6) return false;

    var anchor = valueAt(group, "ADBE Anchor Point", t);
    var scale = valueAt(group, "ADBE Scale", t);
    var position = positionAt(layer, group, t);
    if (!anchor || !scale || !position) return false;

    var rect;
    try {
      rect = layer.sourceRectAtTime(t, false);
    } catch (rectError) {
      return false;
    }
    if (!rect || !rect.width || !rect.height) return false;

    var sx = Number(scale[0]) / 100;
    var sy = Number(scale[1]) / 100;
    var left = position[0] + (rect.left - anchor[0]) * sx;
    var top = position[1] + (rect.top - anchor[1]) * sy;
    var right = left + rect.width * sx;
    var bottom = top + rect.height * sy;
    if (right < left) { var swapX = left; left = right; right = swapX; }
    if (bottom < top) { var swapY = top; top = bottom; bottom = swapY; }

    var slack = 0.5;
    return left <= slack && top <= slack && right >= comp.width - slack && bottom >= comp.height - slack;
  }

  function isVisibleAt(layer, t) {
    try {
      if (!layer.enabled) return false;
      if (!Flow.isVisualLayer(layer) || !layer.hasVideo) return false;
      if (t < layer.inPoint || t >= layer.outPoint) return false;
    } catch (e) {
      return false;
    }
    return true;
  }

  // Moments worth testing: the start and end, every layer's own edges (where
  // coverage changes), and a spread across the composition for everything in
  // between.
  function geometryTimes(comp, layers) {
    var step = frameTime(comp);
    var last = Math.max(0, comp.duration - step);
    var seen = {};
    var frames = [];

    function add(t) {
      if (!isFinite(t)) return;
      var frame = Math.round(clamp(t, 0, last) / step);
      if (seen["f" + frame]) return;
      seen["f" + frame] = true;
      frames.push(frame);
    }

    add(0);
    add(last);
    for (var i = 0; i < layers.length; i++) {
      try {
        add(layers[i].inPoint);
        add(layers[i].inPoint + step);
        add(layers[i].outPoint - step);
      } catch (e) { /* a layer without usable times adds nothing */ }
    }
    for (var k = 1; k < 10; k++) add(comp.duration * k / 10);

    frames.sort(function (a, b) { return a - b; });
    if (frames.length > MAX_GEOMETRY_TIMES) {
      var thinned = [];
      for (var n = 0; n < MAX_GEOMETRY_TIMES; n++) {
        thinned.push(frames[Math.round(n * (frames.length - 1) / (MAX_GEOMETRY_TIMES - 1))]);
      }
      frames = thinned;
    }

    var times = [];
    for (var f = 0; f < frames.length; f++) times.push(frames[f] * step);
    return times;
  }

  /**
   * Stretches of time where nothing is known to cover the frame.
   *
   * A border is almost never one frame: a layer sitting a few pixels off shows
   * a line for as long as it is on screen. So the sampled times are collected
   * into runs, and a run is what the panel reports - one finding spanning the
   * whole stretch, not one per frame that happened to be looked at.
   *
   * A moment where nothing at all is visible ends a run rather than extending
   * it: an empty frame is an empty frame, not a border.
   */
  function uncoveredRuns(comp, layers) {
    var times = geometryTimes(comp, layers);
    var runs = [];
    var current = null;

    for (var i = 0; i < times.length; i++) {
      var t = times[i];
      var visible = false;
      var covered = false;
      for (var k = 0; k < layers.length; k++) {
        if (!isVisibleAt(layers[k], t)) continue;
        visible = true;
        if (coversFrame(comp, layers[k], t)) {
          covered = true;
          break;
        }
      }
      if (visible && !covered) {
        if (current) current.end = t;
        else current = { start: t, end: t };
      } else if (current) {
        runs.push(current);
        current = null;
      }
    }
    if (current) runs.push(current);
    return runs;
  }

  function borderCandidates(comp, layers, maxSamples, candidates, notes) {
    if (comp.duration <= 0 || maxSamples <= 0) return;

    var runs = uncoveredRuns(comp, layers);
    if (!runs.length) return;

    if (runs.length > maxSamples) {
      var kept = [];
      for (var n = 0; n < maxSamples; n++) {
        kept.push(runs[Math.round(n * (runs.length - 1) / (maxSamples - 1))]);
      }
      notes.push("\"" + comp.name + "\" has more places to check than Flow renders; " +
        maxSamples + " of them were looked at.");
      runs = kept;
    }

    // The budget is shared out over the runs: up to the start, the middle and
    // the end of each. One frame can be the one frame a mask happens to cover,
    // and the deepest part of a border is rarely where it starts.
    var perRun = Math.floor(maxSamples / runs.length);
    if (perRun > 3) perRun = 3;
    if (perRun < 1) perRun = 1;

    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      var at = [run.start];
      if (perRun > 2 && run.end > run.start) at.push(snapToFrame(comp, (run.start + run.end) / 2));
      if (perRun > 1 && run.end > run.start) at.push(run.end);

      for (var s = 0; s < at.length; s++) {
        if (s > 0 && Flow.contains(at.slice(0, s), at[s])) continue;
        candidates.push({
          compId: comp.id,
          compName: String(comp.name),
          time: at[s],
          timecode: timecode(comp, at[s]),
          spanStart: run.start,
          spanStartTimecode: timecode(comp, run.start),
          spanEnd: run.end,
          spanEndTimecode: timecode(comp, run.end),
          width: comp.width,
          height: comp.height
        });
      }
    }
  }

  // ------------------------------------------------------------ markers

  // A composition holds its markers on markerProperty and has no property()
  // at all; a layer holds them on its "ADBE Marker" property. Both are tried,
  // in that order, so one function covers either target.
  function markerProperty(target) {
    var prop = null;
    try {
      prop = target.markerProperty;
    } catch (e) {
      prop = null;
    }
    if (prop) return prop;
    try {
      prop = target.property("ADBE Marker");
    } catch (matchNameError) {
      prop = null;
    }
    if (prop) return prop;
    try {
      return target.property("Marker");
    } catch (nameError) {
      return null;
    }
  }

  function markerAt(prop, t, comment, tolerance) {
    var keys = 0;
    try {
      keys = prop.numKeys;
    } catch (e) {
      return false;
    }
    for (var i = 1; i <= keys; i++) {
      try {
        if (Math.abs(prop.keyTime(i) - t) > tolerance) continue;
        if (String(prop.keyValue(i).comment) === comment) return true;
      } catch (readError) { /* an unreadable key cannot be the duplicate */ }
    }
    return false;
  }

  function readMarkers(params) {
    var raw = params ? params.markers : null;
    if (!(raw instanceof Array)) {
      throw Flow.error("INVALID_PARAMS", "Parameter 'markers' must be a list.");
    }
    if (raw.length > MAX_MARKERS) {
      throw Flow.error("INVALID_PARAMS", "That is more than " + MAX_MARKERS + " markers.");
    }
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var entry = raw[i];
      if (!entry || typeof entry.compId !== "number" || typeof entry.time !== "number") continue;
      out.push({
        compId: entry.compId,
        layerIndex: typeof entry.layerIndex === "number" ? entry.layerIndex : 0,
        time: entry.time,
        duration: typeof entry.duration === "number" && entry.duration > 0 ? entry.duration : 0,
        comment: shorten(entry.comment, 180)
      });
    }
    return out;
  }

  // ------------------------------------------------------------ saved frames

  function waitForPng(path) {
    return Flow.waitForPng(path, FRAME_TIMEOUT, FRAME_POLL);
  }

  // ------------------------------------------------------------ commands

  Flow.register("check.scan", {
    undo: null,
    run: function (params, ctx) {
      var scope = Flow.oneOf(params, "scope", SCOPES);
      var includeNested = Flow.bool(params, "includeNested", false);
      var maxSamples = Math.round(clamp(Flow.num(params, "maxBorderSamples", 6), 0, 40));

      var wanted = {};
      var rawChecks = params ? params.checks : null;
      if (!(rawChecks instanceof Array) || !rawChecks.length) {
        throw Flow.error("INVALID_PARAMS", "Choose at least one thing to check.");
      }
      for (var c = 0; c < rawChecks.length; c++) {
        if (Flow.contains(CHECKS, rawChecks[c])) wanted["k_" + rawChecks[c]] = true;
      }

      var notes = [];
      var comps = collectComps(scope, includeNested, notes);
      var store = makeFindings();
      var candidates = [];
      var summaries = [];

      for (var i = 0; i < comps.length; i++) {
        var comp = comps[i];
        var layers = layersOf(comp, notes);

        summaries.push({
          id: comp.id,
          name: String(comp.name),
          duration: comp.duration,
          frameRate: comp.frameRate,
          width: comp.width,
          height: comp.height
        });

        if (wanted.k_footage) checkFootage(comp, layers, store);
        if (wanted.k_expressions) checkExpressions(comp, layers, store);
        if (wanted.k_timing) checkTiming(comp, store);
        if (wanted.k_borders) borderCandidates(comp, layers, maxSamples, candidates, notes);
      }

      for (var n = 0; n < notes.length; n++) ctx.warnings.push(notes[n]);

      return {
        comps: summaries,
        findings: store.list,
        borderCandidates: candidates,
        notes: notes
      };
    }
  });

  Flow.register("check.frame", {
    undo: null,
    run: function (params) {
      var comp = compById(Flow.num(params, "compId", -1));
      if (typeof comp.saveFrameToPng !== "function") {
        throw Flow.error("UNSUPPORTED", "This version of After Effects cannot save a frame for Flow to inspect.");
      }
      var t = clamp(Flow.num(params, "time", 0), 0, Math.max(0, comp.duration - frameTime(comp)));
      var frame = Math.round(t / frameTime(comp));

      // A name that cannot already be taken. Re-using one would be a trap: a
      // complete PNG left behind by an earlier scan passes the "is it finished"
      // test below immediately, so the panel would read the old picture while
      // After Effects was still writing the new one over it.
      frameSeq++;
      var path = Folder.temp.fsName + "/flow-check-" + comp.id + "-" + frame +
        "-" + (new Date()).getTime() + "-" + frameSeq + ".png";
      var file = new File(path);
      try {
        if (file.exists) file.remove();
      } catch (removeError) { /* overwriting is fine too */ }

      comp.saveFrameToPng(t, file);
      if (!waitForPng(path)) {
        throw Flow.error("UNSUPPORTED", "After Effects did not finish writing the frame to " + path + ".");
      }
      return { path: String(new File(path).fsName) };
    }
  });

  Flow.register("check.markers", {
    undo: "Flag Mistakes",
    run: function (params) {
      var wanted = readMarkers(params);
      var added = 0;
      var existing = 0;

      // A re-scan replaces the last one's flags rather than piling more on top,
      // and it happens inside this same undo group so one undo puts the
      // composition back exactly as it was.
      var stale = params && params.clearComps instanceof Array ? params.clearComps : [];
      var removed = stale.length ? clearFlowMarkers(stale) : 0;

      for (var i = 0; i < wanted.length; i++) {
        var entry = wanted[i];
        var comp = null;
        try {
          comp = compById(entry.compId);
        } catch (missing) {
          continue;
        }

        var step = frameTime(comp);
        var t = clamp(entry.time, 0, Math.max(0, comp.duration - step));
        var target = comp;
        if (entry.layerIndex >= 1 && entry.layerIndex <= comp.numLayers) {
          target = comp.layer(entry.layerIndex);
          // A marker outside the layer's own span is invisible in the timeline.
          try {
            t = clamp(t, target.inPoint, Math.max(target.inPoint, target.outPoint - step));
          } catch (spanError) { /* keep the composition time */ }
        }
        t = snapToFrame(comp, t);

        var prop = markerProperty(target);
        if (!prop) continue;

        var comment = MARKER_PREFIX + entry.comment;
        if (markerAt(prop, t, comment, step / 2)) {
          existing++;
          continue;
        }

        var value = new MarkerValue(comment);
        try {
          value.label = 1; // red, so a flag stands out from the user's markers
        } catch (labelError) { /* older hosts have no marker labels */ }
        if (entry.duration > 0) {
          // A mistake that lasts gets a marker that lasts, so the timeline
          // shows how far it runs instead of one tick at the start.
          try {
            value.duration = Math.min(entry.duration, Math.max(0, comp.duration - t));
          } catch (durationError) { /* a plain marker is still useful */ }
        }
        prop.setValueAtTime(t, value);
        added++;
      }

      return { added: added, existing: existing, removed: removed };
    }
  });

  // Removes every marker Flow left in these compositions, on the composition
  // and on each of its layers. Shared by check.clear and by a re-scan, which
  // clears the last scan's flags before writing this one's.
  function clearFlowMarkers(ids) {
    var removed = 0;

    function clearOn(target) {
      var prop = markerProperty(target);
      if (!prop) return;
      var keys = 0;
      try {
        keys = prop.numKeys;
      } catch (e) {
        return;
      }
      // Backwards: removing a key renumbers everything after it.
      for (var k = keys; k >= 1; k--) {
        try {
          var comment = String(prop.keyValue(k).comment);
          if (comment.substring(0, MARKER_PREFIX.length) !== MARKER_PREFIX) continue;
          prop.removeKey(k);
          removed++;
        } catch (keyError) { /* leave a key that cannot be read */ }
      }
    }

    for (var i = 0; i < ids.length && i < MAX_COMPS; i++) {
      var comp = null;
      try {
        comp = compById(ids[i]);
      } catch (missing) {
        continue;
      }
      clearOn(comp);
      var count = 0;
      try {
        count = comp.numLayers;
      } catch (layerError) {
        count = 0;
      }
      for (var n = 1; n <= count && n <= MAX_LAYERS; n++) {
        try {
          clearOn(comp.layer(n));
        } catch (readError) { /* skip a layer that cannot be read */ }
      }
    }
    return removed;
  }

  function readCompIds(params, key) {
    var ids = params ? params[key] : null;
    if (!(ids instanceof Array)) {
      throw Flow.error("INVALID_PARAMS", "Parameter '" + key + "' must be a list.");
    }
    return ids;
  }

  Flow.register("check.clear", {
    undo: "Clear Flow Markers",
    run: function (params) {
      return { removed: clearFlowMarkers(readCompIds(params, "compIds")) };
    }
  });

  Flow.register("check.reveal", {
    undo: null,
    run: function (params) {
      var comp = null;
      try {
        comp = compById(Flow.num(params, "compId", -1));
      } catch (missing) {
        return { found: false };
      }

      try {
        if (typeof comp.openInViewer === "function") comp.openInViewer();
      } catch (openError) { /* the panel still gets a useful time below */ }

      var t = clamp(Flow.num(params, "time", 0), 0, Math.max(0, comp.duration - frameTime(comp)));
      try {
        comp.time = snapToFrame(comp, t);
      } catch (timeError) { /* a locked viewer can refuse the time */ }

      var index = Math.round(Flow.num(params, "layerIndex", 0));
      if (index >= 1 && index <= comp.numLayers) {
        for (var i = 1; i <= comp.numLayers; i++) {
          try {
            comp.layer(i).selected = (i === index);
          } catch (selectError) { /* a locked layer cannot be selected */ }
        }
      }
      return { found: true };
    }
  });
})($.global.Flow);
