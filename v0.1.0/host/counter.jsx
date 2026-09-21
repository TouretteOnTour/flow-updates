// Counter tool: a sliding number counter.
//
// One text layer per digit column. Each holds three lines - the digit before,
// the digit now and the digit next - and slides vertically behind a window, so
// a digit leaves upwards as the next one arrives from below. Counting down
// runs the same rig backwards.
//
// The window is the composition itself. Building the rig in its own comp means
// the strips are clipped by the comp bounds, with no masks and no track
// mattes: a mask would be no use here anyway, because masks live in layer
// space and these layers are the things that move.
//
// Two expressions do all the work. For the column c places from the right:
//
//   i = floor(value)        the whole number showing
//   n = floor(i / 10^c)     this column's digit
//   f = value - i           how far it is between one whole number and the
//                           next - but only if this column's digit is one of
//                           the ones that changes on that step, else 0
//
//   source text = wrap(n-1) + "\r" + wrap(n) + "\r" + wrap(n+1)
//   position.y  = centre - shape(f) * lineHeight
//
// The slide phase is shared by every column rather than taken from each
// column's own fractional position. That is the difference between a counter
// and an odometer: at 760 the hundreds column reads 7 and holds, instead of
// creeping six tenths of the way to 8 because 760/100 is 7.6. Columns that do
// change on a given step move together, and every column lands exactly on its
// digit whenever the number is whole.
//
// At f = 0 the middle line sits in the window; at f = 1 the strip has moved up
// exactly one line, so the bottom line is centred - and by then n has ticked
// over and the text has regenerated with that same digit in the middle. The
// seam is invisible, and three lines is all the text a column ever needs no
// matter how far it counts.
//
// Line height and window height are deliberately the same number. That is what
// makes one digit sit cleanly in the window at rest and exactly two show while
// it moves, which is what the sliding look is.
//
// shape(f) is the Smoothness control:
//
//   t = clamp((f - 0.5) / w + 0.5, 0, 1)      w = max(0.02, smoothness)
//   shape = t + (smoothstep(t) - t) * (1 - smoothness)
//
// At 100 that is the identity, so the strip glides at a constant rate and
// digits are caught half way. As it drops, the travel is squeezed into a
// shorter and shorter window around the half-way point and eased, so each
// digit holds and then flicks to the next. It is centred on f = 0.5 rather
// than at one end so that counting up and counting down behave the same.
//
// Motion:
//   count   true place value: the number really counts, so the units column
//           travels ten times as far as the tens.
//   slide   every column travels from its own first digit to its own last one,
//           so they all move at a readable rate however large the number is.
//
// What the keyframed slider holds is progress, nought to a hundred, and never
// the number itself. Every After Effects property value is a single-precision
// float: a Slider Control refuses anything past a million outright, and an
// angle, a rotation or a position - none of which have that limit - still turn
// 999,999,999 into 1,000,000,000 because seven significant digits is all they
// keep. So the two ends of the count are written into the expression as
// literals and the number is worked out there, where the arithmetic is double
// precision and lands on the last digit exactly.
//
// Layout is measured, never assumed: the digits are measured in the chosen
// font and size, and the column pitch, line height, window and anchors all
// follow from that, so changing the font re-aligns the whole counter.

(function (Flow) {
  if (!Flow) return;

  var MOTIONS = ["count", "slide"];
  var TIMINGS = ["playhead", "layer"];

  var MARKER = "flow:counter";
  var COMP_NAME = "Flow Counter";
  var CONTROL = "Counter Control";
  var PROGRESS_SLIDER = "Progress";
  var OVERLAP_SLIDER = "Overlap";

  var GAP = 0.18;           // space between columns, as a fraction of digit width
  var MARGIN = 0.15;        // side margin, as a fraction of digit width
  var POINT = 0.5;          // width of the decimal point column, fraction of digit width
  var MIN_WINDOW = 0.6;     // window height, as a multiple of digit height
  var MAX_WINDOW = 4;
  var MIN_STEP = 0.02;      // shortest slide a fully stepped counter still makes
  var MAX_COLUMNS = 12;
  // Whole numbers a double still counts one at a time, with room left for the
  // rounding epsilon below. Past this the counter would skip steps, which is
  // worse than refusing.
  var MAX_STEPS = 1e14;
  var MAX_SIZE = 4000;
  var MIN_DURATION = 1 / 120;

  var DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

  // ------------------------------------------------------------ small utils

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  // Numbers written into an expression. isFinite is checked because a bad
  // measurement would otherwise produce an expression that silently fails.
  // Layout numbers are tidied to six decimals; large counts are left alone,
  // because multiplying them by 1e6 to round them is what would lose the
  // precision the rounding is meant to protect.
  function n2s(n) {
    if (typeof n !== "number" || !isFinite(n)) {
      throw Flow.error("HOST_EXCEPTION", "Could not work out the counter's layout.");
    }
    return String(Math.abs(n) < 1e9 ? Math.round(n * 1e6) / 1e6 : n);
  }

  function setVec(prop, values) {
    var current = prop.value;
    var out = [];
    for (var i = 0; i < current.length; i++) out.push(i < values.length ? values[i] : 0);
    prop.setValue(out);
  }

  function transformGroup(layer) {
    return layer.property("ADBE Transform Group");
  }

  function readColor(params, key, fallback) {
    var v = params ? params[key] : undefined;
    if (v === undefined || v === null) return fallback;
    if (!(v instanceof Array) || v.length < 3) {
      throw Flow.error("INVALID_PARAMS", "Colour '" + key + "' must be three numbers.");
    }
    var out = [];
    for (var i = 0; i < 3; i++) {
      if (typeof v[i] !== "number" || !isFinite(v[i])) {
        throw Flow.error("INVALID_PARAMS", "Colour '" + key + "' must be three numbers.");
      }
      out.push(clamp(v[i], 0, 1));
    }
    return out;
  }

  function uniqueCompName(base) {
    var taken = {};
    var items = app.project.items;
    var i;
    for (i = 1; i <= items.length; i++) taken["n_" + items[i].name] = true;
    if (!taken["n_" + base]) return base;
    for (i = 2; i < 1000; i++) {
      if (!taken["n_" + base + " " + i]) return base + " " + i;
    }
    return base;
  }

  // ------------------------------------------------------------ params

  function readParams(params) {
    var config = {
      from: Flow.num(params, "from", 0),
      to: Flow.num(params, "to", 100),
      duration: Math.max(MIN_DURATION, Flow.num(params, "duration", 2)),
      timing: Flow.oneOf(params, "timing", TIMINGS),
      digits: Math.round(clamp(Flow.num(params, "digits", 0), 0, MAX_COLUMNS)),
      decimals: Math.round(clamp(Flow.num(params, "decimals", 0), 0, 4)),
      motion: Flow.oneOf(params, "motion", MOTIONS),
      ease: clamp(Flow.num(params, "ease", 70), 0, 100),
      smoothness: clamp(Flow.num(params, "smoothness", 100), 0, 100),
      overlap: clamp(Flow.num(params, "overlap", 0.05), -2, 2),
      font: Flow.str(params, "font", "", 200),
      size: clamp(Flow.num(params, "size", 120), 6, 600),
      window: clamp(Flow.num(params, "window", 115) / 100, MIN_WINDOW, MAX_WINDOW),
      onlyExisting: Flow.bool(params, "onlyExisting", false),
      color: [1, 1, 1]
    };
    config.color = readColor(params, "color", config.color);

    // The rig counts in steps of the smallest column, so that is the number
    // that has to stay exact.
    var steps = Math.pow(10, config.decimals);
    if (Math.abs(config.from) * steps > MAX_STEPS || Math.abs(config.to) * steps > MAX_STEPS) {
      throw Flow.error("INVALID_PARAMS",
        "That number is too large to count exactly. Use a smaller number or fewer decimals.");
    }
    return config;
  }

  // How many columns the number needs. Leading zeros are a deliberate look, so
  // the count comes from the larger of the two ends, never from what happens
  // to be showing at the time.
  function columnCount(config) {
    if (config.digits > 0) return Math.min(MAX_COLUMNS, config.digits + config.decimals);
    var largest = Math.max(Math.abs(config.from), Math.abs(config.to));
    var whole = Math.floor(largest);
    var places = 1;
    while (whole >= 10 && places < MAX_COLUMNS) {
      whole = Math.floor(whole / 10);
      places++;
    }
    return Math.min(MAX_COLUMNS, places + config.decimals);
  }

  // ------------------------------------------------------------ text

  function textDocument(layer) {
    return layer.property("ADBE Text Properties").property("ADBE Text Document");
  }

  // Centre justification is what keeps a digit in the middle of its column
  // whatever font it is set in, and whichever digit the expression puts there:
  // the source text changes every frame, so a measured horizontal offset would
  // be wrong as soon as the digit changed.
  function styleText(layer, config, text, leading) {
    var prop = textDocument(layer);
    var doc = prop.value;
    doc.text = text;
    doc.fontSize = config.size;
    if (config.font) {
      try {
        doc.font = config.font;
      } catch (fontError) {
        // The font went away since the panel listed it; AE's default stands in.
      }
    }
    doc.applyFill = true;
    doc.fillColor = config.color;
    doc.applyStroke = false;
    try {
      doc.justification = ParagraphJustification.CENTER_JUSTIFY;
    } catch (justifyError) {
      // Older hosts refuse justification on point text.
    }
    if (leading) {
      try {
        doc.autoLeading = false;
        doc.leading = leading;
      } catch (leadingError) {
        // Without a settable leading the strip still works, but the line
        // spacing is the font's own rather than the window height.
      }
    }
    prop.setValue(doc);
  }

  function setText(layer, text) {
    var prop = textDocument(layer);
    var doc = prop.value;
    doc.text = text;
    prop.setValue(doc);
  }

  function measure(layer) {
    var rect = layer.sourceRectAtTime(0, false);
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }

  // Everything the layout needs, taken from the font itself rather than
  // guessed: the widest digit sets the column pitch, the digit height sets the
  // window, and the three-line block is measured once the leading is known so
  // the anchor lands on the middle line.
  function measureDigits(comp, config) {
    var probe = comp.layers.addText("0");
    var metrics;
    try {
      styleText(probe, config, "0", 0);
      var width = 0;
      var top = null;
      var bottom = null;
      for (var i = 0; i < DIGITS.length; i++) {
        setText(probe, DIGITS[i]);
        var rect = measure(probe);
        if (rect.width > width) width = rect.width;
        if (top === null || rect.top < top) top = rect.top;
        if (bottom === null || rect.top + rect.height > bottom) bottom = rect.top + rect.height;
      }
      if (!width || top === null || bottom <= top) {
        throw Flow.error("HOST_EXCEPTION", "Could not measure the digits in this font.");
      }

      var height = bottom - top;
      var line = height * config.window;
      styleText(probe, config, "0\r0\r0", line);
      var block = measure(probe);
      // Three equal lines, so the block's centre is the middle line's centre.
      // If the host refused the leading, fall back to the analytic answer.
      var centre = block.height > height * 1.5 ? block.top + block.height / 2 : line + top + height / 2;
      metrics = { width: width, height: height, line: line, anchor: centre, baseline: line - centre };
    } finally {
      probe.remove();
    }
    return metrics;
  }

  // ------------------------------------------------------------ layout

  function layout(metrics, config, columns) {
    var pitch = metrics.width * (1 + GAP);
    var pointWidth = config.decimals > 0 ? metrics.width * POINT : 0;
    var margin = metrics.width * MARGIN;
    var content = columns * pitch + pointWidth;

    var box = {
      width: Math.max(4, Math.round(content + margin * 2)),
      height: Math.max(4, Math.round(metrics.line)),
      pitch: pitch,
      columns: []
    };
    if (box.width > MAX_SIZE || box.height > MAX_SIZE) {
      throw Flow.error("INVALID_PARAMS", "That font size makes the counter larger than After Effects allows.");
    }
    box.centerY = box.height / 2;
    var left = (box.width - content) / 2;

    var whole = columns - config.decimals;
    for (var k = 0; k < columns; k++) {
      box.columns.push({
        x: left + k * pitch + pitch / 2 + (k >= whole ? pointWidth : 0),
        // Counted from the right, so column 0 is the one that changes on every
        // step - whether that is the units or the last decimal.
        scale: Math.pow(10, columns - 1 - k),
        // Overlap is measured from the left, the way the digits read.
        lag: k
      });
    }
    box.pointX = left + whole * pitch + pointWidth / 2;
    return box;
  }

  // ------------------------------------------------------------ expressions

  // Every column reads the same slider, just a little later than the one to
  // its left. That delay is the overlap: the columns stop landing in unison.
  function sampled(lag) {
    return "var c = thisComp.layer(\"" + CONTROL + "\");\n" +
      "var p = c.effect(\"" + PROGRESS_SLIDER + "\")(\"Slider\")" +
      ".valueAtTime(time - c.effect(\"" + OVERLAP_SLIDER + "\")(\"Slider\") * " + n2s(lag) + ") / 100;\n";
  }

  // The digit a column shows, and how far it has slid towards the next one.
  //
  // count: the number is read the way a number is read. i is the whole number
  // showing, n is this column's digit, and the slide phase is the fraction
  // between one whole number and the next - shared by every column, so the
  // ones that change move together. A column only slides when its own digit
  // actually changes on the next step, which is what keeps it still: at 760
  // the hundreds column is on 7 and stays there, rather than sitting six
  // tenths of the way to 8 because 760/100 happens to be 7.6.
  //
  // slide: each column walks its own path from its first digit to its last, so
  // the phase is simply where along that path it is.
  function digits(config, column) {
    if (config.motion === "count") {
      var mult = Math.pow(10, config.decimals);
      // The number is worked out here rather than stored, so it keeps the
      // expression engine's full precision. Absolute, because there is no
      // minus column and without it a negative value would wrap into ten's
      // complement - showing 9 for -1 rather than 1. The epsilon is relative,
      // because the gap between neighbouring doubles grows with the number.
      return "var v = " + n2s(config.from) + " + " + n2s(config.to - config.from) + " * p;\n" +
        "var k = Math.abs(v) * " + n2s(mult) + ";\n" +
        "var i = Math.floor(k + 1e-9 + k * 1e-15);\n" +
        "var n = Math.floor(i / " + n2s(column.scale) + ");\n" +
        "var f = Math.floor((i + 1) / " + n2s(column.scale) + ") === n ? 0 : k - i;\n" +
        "if (f < 0) f = 0;\n";
    }

    var first = digitOf(config.from, config, column);
    var last = digitOf(config.to, config, column);
    var up = config.to >= config.from;
    var delta = up ? (last - first + 10) % 10 : -((first - last + 10) % 10);
    // A column whose digit ends where it started still turns once, as long as
    // its own place really did roll over.
    var step = column.scale / Math.pow(10, config.decimals);
    if (delta === 0 && Math.abs(config.to - config.from) >= step) delta = up ? 10 : -10;

    return "var d = " + n2s(first) + " + " + n2s(delta) + " * p;\n" +
      "var n = Math.floor(d);\n" +
      "var f = d - n;\n";
  }

  // What this column reads at a given value. Multiplying by 10^decimals first
  // keeps the arithmetic on whole numbers, which dividing by 10^-1 would not.
  function digitOf(value, config, column) {
    var whole = Math.floor(Math.abs(value) * Math.pow(10, config.decimals) + 1e-9);
    var digit = Math.floor(whole / column.scale);
    return digit - Math.floor(digit / 10) * 10;
  }

  function sourceExpression(config, column) {
    return sampled(column.lag) + digits(config, column) +
      "function w(x) { x = x % 10; return x < 0 ? x + 10 : x; }\n" +
      "w(n - 1) + \"\\r\" + w(n) + \"\\r\" + w(n + 1)";
  }

  function slideExpression(config, column, box, metrics) {
    var s = config.smoothness / 100;
    return sampled(column.lag) + digits(config, column) +
      "var s = " + n2s(s) + ";\n" +
      "var w = Math.max(" + n2s(MIN_STEP) + ", s);\n" +
      "var t = (f - 0.5) / w + 0.5;\n" +
      "t = t < 0 ? 0 : (t > 1 ? 1 : t);\n" +
      "var e = t * t * (3 - 2 * t);\n" +
      "[" + n2s(column.x) + ", " + n2s(box.centerY) + " - (t + (e - t) * (1 - s)) * " + n2s(metrics.line) + "]";
  }

  // ------------------------------------------------------------ building

  function clearComp(comp) {
    for (var i = comp.numLayers; i >= 1; i--) comp.layer(i).remove();
  }

  function addControl(comp, config, times) {
    var control = comp.layers.addNull();
    control.name = CONTROL;
    control.guideLayer = true;
    var effects = control.property("ADBE Effect Parade");

    effects.addProperty("ADBE Slider Control");
    var value = effects.property(effects.numProperties);
    value.name = PROGRESS_SLIDER;
    var slider = value.property("ADBE Slider Control-0001");
    // Nought to a hundred, never the number itself. See the note at the top:
    // no After Effects property can hold a nine-digit number.
    slider.setValueAtTime(times.start, 0);
    slider.setValueAtTime(times.end, 100);

    // One influence on both sides: a plain easy ease, which is what "ease"
    // means to everyone who has ever pressed F9.
    var influence = clamp(config.ease, 0.1, 100);
    if (config.ease <= 0) {
      slider.setInterpolationTypeAtKey(1, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
      slider.setInterpolationTypeAtKey(2, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
    } else {
      for (var i = 1; i <= 2; i++) {
        var side = new KeyframeEase(0, influence);
        slider.setTemporalEaseAtKey(i, [side], [side]);
      }
    }

    effects.addProperty("ADBE Slider Control");
    var overlap = effects.property(effects.numProperties);
    overlap.name = OVERLAP_SLIDER;
    overlap.property("ADBE Slider Control-0001").setValue(config.overlap);
    return control;
  }

  function addColumns(comp, config, box, metrics) {
    for (var k = box.columns.length - 1; k >= 0; k--) {
      var column = box.columns[k];
      var layer = comp.layers.addText("0\r0\r0");
      layer.name = "Digit " + (k + 1);
      // Styled and measured as static text first; the expression goes on last.
      styleText(layer, config, "0\r0\r0", metrics.line);

      var tr = transformGroup(layer);
      setVec(tr.property("ADBE Anchor Point"), [0, metrics.anchor, 0]);
      setVec(tr.property("ADBE Position"), [column.x, box.centerY, 0]);
      tr.property("ADBE Position").expression = slideExpression(config, column, box, metrics);
      textDocument(layer).expression = sourceExpression(config, column);
    }
  }

  // The point sits on the digits' baseline rather than on their centre, which
  // is the one place it has to line up.
  function addPoint(comp, config, box, metrics) {
    if (config.decimals <= 0) return null;
    var layer = comp.layers.addText(".");
    layer.name = "Point";
    styleText(layer, config, ".", 0);
    var tr = transformGroup(layer);
    setVec(tr.property("ADBE Anchor Point"), [0, 0, 0]);
    setVec(tr.property("ADBE Position"), [box.pointX, box.centerY + metrics.baseline, 0]);
    return layer;
  }

  function build(comp, config, times) {
    clearComp(comp);
    var metrics = measureDigits(comp, config);
    var columns = columnCount(config);
    var box = layout(metrics, config, columns);

    comp.width = box.width;
    comp.height = box.height;

    addPoint(comp, config, box, metrics);
    addColumns(comp, config, box, metrics);
    addControl(comp, config, times);
    return { box: box, columns: columns };
  }

  // ------------------------------------------------------------ placement

  function isCounterLayer(layer) {
    return layer && layer.source instanceof CompItem &&
      String(layer.comment).substring(0, MARKER.length) === MARKER;
  }

  function findSelectedCounter(comp) {
    var sel = comp.selectedLayers || [];
    for (var i = 0; i < sel.length; i++) {
      if (isCounterLayer(sel[i])) return sel[i];
    }
    return null;
  }

  // Times are in the counter composition's own timeline, which is offset from
  // the outer comp whenever the layer has been slid along it.
  function sweepTimes(comp, layer, config) {
    var offset = layer ? layer.startTime : 0;
    if (config.timing === "layer" && layer) {
      var start = layer.inPoint - offset;
      return { start: start, end: start + config.duration };
    }
    var now = comp.time - offset;
    return { start: now, end: now + config.duration };
  }

  // Re-centres the layer's anchor after a resize, so a counter that grew or
  // shrank stays where the user put it instead of drifting by half the change.
  function centreAnchor(layer, source) {
    var anchor = transformGroup(layer).property("ADBE Anchor Point");
    if (anchor.numKeys === 0 && !Flow.hasActiveExpression(anchor)) {
      setVec(anchor, [source.width / 2, source.height / 2, 0]);
    }
  }

  // ------------------------------------------------------------ commands

  Flow.register("counter.create", {
    undo: "Counter",
    run: function (params, ctx) {
      var config = readParams(params);
      var nothing = { created: false, name: "", columns: 0 };
      var comp;

      // A value changed in the panel rather than a button being pressed, so
      // "no comp" and "nothing selected" are normal states, not mistakes.
      try {
        comp = Flow.requireComp();
      } catch (noComp) {
        if (config.onlyExisting) return nothing;
        throw noComp;
      }

      var existing = findSelectedCounter(comp);
      if (!existing && config.onlyExisting) return nothing;

      var source, layer, result;
      if (existing) {
        source = existing.source;
        layer = existing;
      } else {
        // Created empty and sized by the build, which is the only place that
        // knows how wide the digits turn out in this font.
        source = app.project.items.addComp(uniqueCompName(COMP_NAME), 64, 64, 1,
          Math.max(comp.duration, config.duration), comp.frameRate);
        layer = comp.layers.add(source);
        layer.comment = MARKER;
      }

      try {
        result = build(source, config, sweepTimes(comp, layer, config));
      } catch (buildError) {
        // A half-built counter is worse than none. On a first run nothing else
        // refers to the composition yet, so it goes with the failed attempt.
        if (!existing) {
          try { layer.remove(); } catch (layerError) { /* never added */ }
          try { source.remove(); } catch (removeError) { /* already gone */ }
        }
        throw buildError;
      }

      centreAnchor(layer, source);
      if (!existing) layer.name = source.name;
      for (var i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
      layer.selected = true;

      if (!config.onlyExisting && result.columns >= MAX_COLUMNS) {
        ctx.warnings.push("That number needs " + result.columns +
          " columns, which is as many as Flow builds.");
      }
      return { created: !existing, name: source.name, columns: result.columns };
    }
  });

  // The font list the panel offers. app.fonts arrived in After Effects 24.0;
  // without it the counter simply uses whatever font AE creates text with.
  //
  // allFonts hands back one entry per family, each of which is itself an array
  // of that family's styles - a Font read straight off the outer entry has
  // undefined names. Both shapes are walked, because a flat list is what the
  // documentation describes and what an older host may well return.
  function collectFont(families, index, font) {
    var family, style, postScript;
    try {
      family = font.familyName;
      style = font.styleName;
      postScript = font.postScriptName;
    } catch (readError) {
      return;
    }
    if (typeof family !== "string" || !family) return;
    if (typeof postScript !== "string" || !postScript) return;
    if (typeof style !== "string" || !style) style = "Regular";

    var key = "f_" + family;
    if (!index.hasOwnProperty(key)) {
      index[key] = { family: family, styles: [] };
      families.push(index[key]);
    }
    index[key].styles.push({ style: style, postScriptName: postScript });
  }

  Flow.register("counter.fonts", {
    undo: null,
    run: function () {
      var families = [];
      var index = {};
      var all = null;
      try {
        all = app.fonts ? app.fonts.allFonts : null;
      } catch (fontsError) {
        all = null;
      }
      if (!all) return { families: families };

      for (var i = 0; i < all.length; i++) {
        var entry = all[i];
        if (!entry) continue;
        if (typeof entry.familyName === "string") {
          collectFont(families, index, entry);
          continue;
        }
        var count = 0;
        try {
          count = entry.length || 0;
        } catch (lengthError) {
          count = 0;
        }
        for (var j = 0; j < count; j++) collectFont(families, index, entry[j]);
      }
      return { families: families };
    }
  });
})($.global.Flow);
