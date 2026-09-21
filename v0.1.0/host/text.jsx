// Text Animate tool.
//
// Builds native After Effects text animators: an animator with the chosen
// properties on it, a selector underneath, and - for a sweep - keyframes that
// move that selector through the text. Nothing here is an expression, so the
// result is an ordinary animator the user can open and tweak by hand.
//
// Two engines share one recipe:
//   sweep   a Range Selector whose Start (or End) is keyframed, so the text
//           animates on or off character by character, word by word or line by
//           line. A write-on is this with Smoothness at 0.
//   wiggle  a Wiggly Selector, so every unit keeps moving on its own for as
//           long as the layer lasts, with no keyframes at all.
//
// Flow owns the animators it makes ("Flow Animate - ..." and "Flow Wiggle -
// ...") and replaces its own on the next apply, so changing a value updates
// the animation instead of stacking a second one on top. Animators the user
// made are never read and never touched.
//
// Which end of the selector is keyframed decides the order, with no extra
// properties involved:
//
//   direction  order     keyframed    from -> to   held at
//   in         forward   Start          0 -> 100   End 100
//   in         reverse   End          100 -> 0     Start 0
//   out        forward   End            0 -> 100   Start 0
//   out        reverse   Start        100 -> 0     End 100
//
// "random" is the forward form plus the selector's own Randomize Order.
//
// Why Square shape plus Smoothness rather than a ramp: a square selector edge
// softened by Smoothness is what After Effects' own text presets use. The
// per-unit crossfade is then one unit wide at 100% and instant at 0%, which is
// exactly the write-on control this tool wants. It also means the selector
// defaults (Percentage units, Add mode, Square shape) are already right, so
// Flow only writes the few values that actually differ.
//
// Every selector sub-property is looked up by match name first and by its
// display name second. The advanced selector properties are the least stable
// part of the text API, and a tool that quietly does nothing is worse than one
// that reports which knob it could not find.

(function (Flow) {
  if (!Flow) return;

  var MOTIONS = ["sweep", "wiggle"];
  var UNITS = ["characters", "words", "lines"];
  var DIRECTIONS = ["in", "out"];
  var ORDERS = ["forward", "reverse", "random"];
  var TIMINGS = ["playhead", "layer"];

  var FLOW_PREFIX = "Flow ";
  var SWEEP_PREFIX = "Flow Animate";
  var WIGGLE_PREFIX = "Flow Wiggle";

  var RANGE_SELECTOR = "ADBE Text Selector";
  var WIGGLY_SELECTOR = "ADBE Text Wiggly Selector";

  // "Based On" on a selector: 1 characters, 2 characters excluding spaces,
  // 3 words, 4 lines.
  var BASED_ON = { characters: 1, words: 3, lines: 4 };

  var MIN_INFLUENCE = 0.1;
  var MIN_DURATION = 1 / 120;
  var MAX_DEPTH = 3;

  // ------------------------------------------------------------ properties

  // Every property Flow can put on an animator. `build` turns the panel's one
  // or two numbers into the value the property expects; writeValue then pads
  // it out to whatever dimension After Effects actually gave the property.
  var PROPERTY_IDS = ["opacity", "position", "scale", "rotation", "rotationX", "rotationY",
    "blur", "tracking", "skew", "charOffset"];

  var PROPERTIES = {
    opacity: {
      label: "Opacity",
      match: ["ADBE Text Opacity"],
      names: ["Opacity"],
      build: function (v) { return v[0]; }
    },
    position: {
      label: "Position",
      match: ["ADBE Text Position 3D"],
      names: ["Position"],
      build: function (v) { return [v[0], v.length > 1 ? v[1] : 0]; }
    },
    scale: {
      label: "Scale",
      match: ["ADBE Text Scale 3D"],
      names: ["Scale"],
      build: function (v) { return [v[0], v.length > 1 ? v[1] : v[0]]; }
    },
    rotation: {
      label: "Rotation",
      match: ["ADBE Text Rotation"],
      names: ["Rotation", "Z Rotation"],
      build: function (v) { return v[0]; }
    },
    rotationX: {
      label: "X Rotation",
      match: ["ADBE Text Rotation X"],
      names: ["X Rotation"],
      perCharacter3D: true,
      build: function (v) { return v[0]; }
    },
    rotationY: {
      label: "Y Rotation",
      match: ["ADBE Text Rotation Y"],
      names: ["Y Rotation"],
      perCharacter3D: true,
      build: function (v) { return v[0]; }
    },
    blur: {
      label: "Blur",
      match: ["ADBE Text Blur"],
      names: ["Blur"],
      build: function (v) { return [v[0], v.length > 1 ? v[1] : v[0]]; }
    },
    tracking: {
      label: "Tracking",
      // Tracking Amount is the value; Tracking Type decides which side of the
      // character the space goes on and has to exist for the amount to show.
      match: ["ADBE Text Tracking Amount"],
      names: ["Tracking Amount"],
      companions: ["ADBE Text Track Type"],
      build: function (v) { return v[0]; }
    },
    skew: {
      label: "Skew",
      match: ["ADBE Text Skew"],
      names: ["Skew"],
      build: function (v) { return v[0]; }
    },
    charOffset: {
      label: "Character Offset",
      match: ["ADBE Text Character Offset"],
      names: ["Character Offset"],
      build: function (v) { return Math.round(v[0]); }
    }
  };

  function propertyDef(id) {
    return Flow.contains(PROPERTY_IDS, id) ? PROPERTIES[id] : null;
  }

  // ------------------------------------------------------------ small utils

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function startsWith(text, prefix) {
    return String(text).substring(0, prefix.length) === prefix;
  }

  // A property group can throw on numProperties or on property(i) for some
  // group types, so every step of a walk is guarded.
  function childCount(group) {
    try {
      return group.numProperties || 0;
    } catch (e) {
      return 0;
    }
  }

  function childAt(group, i) {
    try {
      return group.property(i) || null;
    } catch (e) {
      return null;
    }
  }

  function byMatchName(group, matchNames) {
    for (var i = 0; i < matchNames.length; i++) {
      try {
        var found = group.property(matchNames[i]);
        if (found) return found;
      } catch (e) {
        // Unknown match names throw on some group types; try the next one.
      }
    }
    return null;
  }

  // The Advanced knobs sit one group deeper in some hosts and directly on the
  // selector in others, so the fallback search is recursive.
  function byDisplayName(group, names, depth) {
    var count = childCount(group);
    for (var i = 1; i <= count; i++) {
      var child = childAt(group, i);
      if (!child) continue;
      for (var j = 0; j < names.length; j++) {
        if (child.name === names[j]) return child;
      }
      if (depth > 0 && child.propertyType !== PropertyType.PROPERTY) {
        var found = byDisplayName(child, names, depth - 1);
        if (found) return found;
      }
    }
    return null;
  }

  function findProp(group, matchNames, names) {
    return byMatchName(group, matchNames) || byDisplayName(group, names, MAX_DEPTH);
  }

  // Writes one or two numbers into a property of unknown dimension: After
  // Effects decides whether Position is 2D or 3D, so the current value is what
  // says how many components to send.
  function writeValue(prop, value) {
    var current;
    try {
      current = prop.value;
    } catch (e) {
      current = null;
    }
    if (!(value instanceof Array)) {
      prop.setValue(value);
      return;
    }
    if (current === null || typeof current === "number") {
      prop.setValue(value[0]);
      return;
    }
    var out = [];
    for (var i = 0; i < current.length; i++) {
      out.push(i < value.length ? value[i] : current[i]);
    }
    prop.setValue(out);
  }

  function setNumber(prop, value) {
    if (!prop) return false;
    try {
      prop.setValue(value);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ------------------------------------------------------------ params

  function readProperties(params) {
    var list = params ? params.properties : null;
    if (!(list instanceof Array) || list.length === 0) {
      throw Flow.error("INVALID_PARAMS", "Pick at least one property to animate.");
    }
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var def = item && typeof item.id === "string" ? propertyDef(item.id) : null;
      if (!def) {
        throw Flow.error("INVALID_PARAMS", "Unknown text property.");
      }
      var values = item.value;
      if (!(values instanceof Array) || values.length === 0 || values.length > 2) {
        throw Flow.error("INVALID_PARAMS", "Property '" + item.id + "' needs one or two numbers.");
      }
      var nums = [];
      for (var j = 0; j < values.length; j++) {
        if (typeof values[j] !== "number" || !isFinite(values[j])) {
          throw Flow.error("INVALID_PARAMS", "Property '" + item.id + "' must be numbers.");
        }
        nums.push(values[j]);
      }
      out.push({ id: item.id, def: def, value: nums });
    }
    return out;
  }

  function readParams(params) {
    var motion = Flow.oneOf(params, "motion", MOTIONS);
    return {
      motion: motion,
      properties: readProperties(params),
      unit: Flow.oneOf(params, "unit", UNITS),
      direction: Flow.oneOf(params, "direction", DIRECTIONS),
      order: Flow.oneOf(params, "order", ORDERS),
      duration: Math.max(MIN_DURATION, Flow.num(params, "duration", 1)),
      timing: Flow.oneOf(params, "timing", TIMINGS),
      smoothness: clamp(Flow.num(params, "smoothness", 100), 0, 100),
      ease: clamp(Flow.num(params, "ease", 50), 0, 100),
      speed: Math.max(0, Flow.num(params, "speed", 2)),
      correlation: clamp(Flow.num(params, "correlation", 50), 0, 100),
      label: Flow.str(params, "label", "", 40),
      onlyExisting: Flow.bool(params, "onlyExisting", false)
    };
  }

  // ------------------------------------------------------------ layer access

  function textProperties(layer) {
    try {
      return layer.property("ADBE Text Properties") || null;
    } catch (e) {
      return null;
    }
  }

  function animatorsOf(layer) {
    var text = textProperties(layer);
    if (!text) return null;
    try {
      return text.property("ADBE Text Animators") || null;
    } catch (e) {
      return null;
    }
  }

  function unsupportedReason(layer) {
    if (!(layer instanceof TextLayer)) return "Not a text layer.";
    if (layer.locked) return "Layer is locked.";
    if (!animatorsOf(layer)) return "This text layer has no animator group.";
    return null;
  }

  function removeFlowAnimators(layer, prefix) {
    var animators = animatorsOf(layer);
    if (!animators) return 0;
    var removed = 0;
    // Backwards: removing a child renumbers everything after it.
    for (var i = childCount(animators); i >= 1; i--) {
      var animator = childAt(animators, i);
      if (!animator || !startsWith(animator.name, prefix)) continue;
      try {
        animator.remove();
        removed++;
      } catch (e) {
        // A locked or otherwise protected animator stays; the caller reports it.
      }
    }
    return removed;
  }

  function hasFlowAnimator(layer, prefix) {
    var animators = animatorsOf(layer);
    if (!animators) return false;
    for (var i = 1; i <= childCount(animators); i++) {
      var animator = childAt(animators, i);
      if (animator && startsWith(animator.name, prefix)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ building

  function addAnimator(layer, name) {
    var animators = animatorsOf(layer);
    animators.addProperty("ADBE Text Animator");
    // Re-acquired by index: the reference addProperty returns can go stale.
    var animator = childAt(animators, childCount(animators));
    if (!animator) throw Flow.error("INVALID_PROPERTY", "Could not add an animator to " + layer.name + ".");
    try {
      animator.name = name;
    } catch (e) {
      // A duplicate name is not worth failing over.
    }
    return animator;
  }

  function addAnimatorProperty(animator, def) {
    var group = animator.property("ADBE Text Animator Properties");
    if (!group) return null;
    var i;
    if (def.companions) {
      for (i = 0; i < def.companions.length; i++) {
        try {
          group.addProperty(def.companions[i]);
        } catch (e) {
          // Optional partner property; the amount is what matters.
        }
      }
    }
    for (i = 0; i < def.match.length; i++) {
      try {
        group.addProperty(def.match[i]);
      } catch (e) {
        continue;
      }
      var added = findProp(animator.property("ADBE Text Animator Properties"), [def.match[i]], def.names);
      if (added) return added;
    }
    return null;
  }

  // After Effects adds a Range Selector of its own to every new animator.
  // Clearing them first means the animator holds exactly one selector, whose
  // behaviour is then fully described by what Flow writes - no second selector
  // quietly combining with it.
  function resetSelector(animator, matchName) {
    var selectors = animator.property("ADBE Text Selectors");
    for (var i = childCount(selectors); i >= 1; i--) {
      var existing = childAt(selectors, i);
      if (!existing) continue;
      try {
        existing.remove();
      } catch (e) {
        // Keep going; the new selector is appended either way.
      }
    }
    selectors.addProperty(matchName);
    return childAt(selectors, childCount(selectors));
  }

  function sweepTimes(layer, comp, config) {
    if (config.timing === "layer") {
      if (config.direction === "in") {
        return { start: layer.inPoint, end: layer.inPoint + config.duration };
      }
      return { start: layer.outPoint - config.duration, end: layer.outPoint };
    }
    return { start: comp.time, end: comp.time + config.duration };
  }

  // Ease on the two sweep keyframes. Speed stays 0: this is a percentage
  // sweeping from one end to the other, so influence alone shapes it.
  function easeSweep(prop, ease) {
    if (prop.numKeys < 2) return;
    var i;
    for (i = 1; i <= prop.numKeys; i++) {
      try { prop.setTemporalContinuousAtKey(i, false); } catch (e) { /* not supported here */ }
      try { prop.setTemporalAutoBezierAtKey(i, false); } catch (e) { /* not supported here */ }
    }
    if (ease <= 0) {
      for (i = 1; i <= prop.numKeys; i++) {
        prop.setInterpolationTypeAtKey(i, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
      }
      return;
    }
    var influence = clamp(ease, MIN_INFLUENCE, 100);
    for (i = 1; i <= prop.numKeys; i++) {
      var side = new KeyframeEase(0, influence);
      prop.setTemporalEaseAtKey(i, [side], [side]);
    }
  }

  function applySweep(animator, layer, comp, config, missing) {
    var selector = resetSelector(animator, RANGE_SELECTOR);
    if (!selector) throw Flow.error("INVALID_PROPERTY", "Could not add a range selector to " + layer.name + ".");

    if (!setNumber(findProp(selector, ["ADBE Text Range Type2"], ["Based On"]), BASED_ON[config.unit])) {
      missing.push("Based On");
    }
    if (!setNumber(findProp(selector, ["ADBE Text Selector Smoothness"], ["Smoothness"]), config.smoothness)) {
      missing.push("Smoothness");
    }
    if (config.order === "random") {
      if (!setNumber(findProp(selector, ["ADBE Text Randomize Order"], ["Randomize Order"]), 1)) {
        missing.push("Randomize Order");
      }
    }

    var startProp = findProp(selector, ["ADBE Text Percent Start"], ["Start"]);
    var endProp = findProp(selector, ["ADBE Text Percent End"], ["End"]);
    if (!startProp || !endProp) {
      throw Flow.error("INVALID_PROPERTY", "The range selector on " + layer.name + " has no Start and End.");
    }

    // Reverse sweeps the other end of the selection, which is what makes the
    // last unit move first. See the table at the top of this file.
    var useEnd = (config.direction === "in") === (config.order === "reverse");
    var moving = useEnd ? endProp : startProp;
    var held = useEnd ? startProp : endProp;
    var from;
    if (config.direction === "in") from = useEnd ? 100 : 0;
    else from = useEnd ? 0 : 100;
    var to = 100 - from;

    setNumber(held, useEnd ? 0 : 100);
    var times = sweepTimes(layer, comp, config);
    moving.setValueAtTime(times.start, from);
    moving.setValueAtTime(times.end, to);
    easeSweep(moving, config.ease);
  }

  function applyWiggle(animator, layer, config, missing) {
    var selector = resetSelector(animator, WIGGLY_SELECTOR);
    if (!selector) throw Flow.error("INVALID_PROPERTY", "Could not add a wiggly selector to " + layer.name + ".");

    if (!setNumber(findProp(selector, ["ADBE Text Range Type2"], ["Based On"]), BASED_ON[config.unit])) {
      missing.push("Based On");
    }
    if (!setNumber(findProp(selector, ["ADBE Text Temporal Freq", "ADBE Text Wiggly Temporal Freq"],
      ["Wiggles/Second", "Wiggles / Second"]), config.speed)) {
      missing.push("Wiggles/Second");
    }
    if (!setNumber(findProp(selector, ["ADBE Text Character Correlation", "ADBE Text Wiggly Correlation"],
      ["Correlation"]), config.correlation)) {
      missing.push("Correlation");
    }
  }

  function animatorName(config) {
    var prefix = config.motion === "sweep" ? SWEEP_PREFIX : WIGGLE_PREFIX;
    return config.label ? prefix + " - " + config.label : prefix;
  }

  function buildOnLayer(layer, comp, config, missing) {
    var needs3D = false;
    var i;
    for (i = 0; i < config.properties.length; i++) {
      if (config.properties[i].def.perCharacter3D) needs3D = true;
    }
    if (needs3D) {
      try {
        layer.threeDPerChar = true;
      } catch (e) {
        missing.push("Per-character 3D");
      }
    }

    var animator = addAnimator(layer, animatorName(config));
    for (i = 0; i < config.properties.length; i++) {
      var target = config.properties[i];
      var prop = addAnimatorProperty(animator, target.def);
      if (!prop) {
        missing.push(target.def.label);
        continue;
      }
      writeValue(prop, target.def.build(target.value));
    }

    if (config.motion === "sweep") applySweep(animator, layer, comp, config, missing);
    else applyWiggle(animator, layer, config, missing);
  }

  // ------------------------------------------------------------ reporting

  function uniqueList(items) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      if (!Flow.contains(out, items[i])) out.push(items[i]);
    }
    return out;
  }

  function reportSkipped(ctx, skipped) {
    if (!skipped.length) return;
    ctx.warnings.push("Skipped " + skipped.length + " layer(s): " + skipped[0].name + " - " + skipped[0].reason);
  }

  // ------------------------------------------------------------ commands

  Flow.register("text.animate", {
    undo: "Animate Text",
    run: function (params, ctx) {
      var config = readParams(params);
      var nothing = { layers: 0, names: [], missing: [], skipped: [] };
      var comp, layers;

      // A value changed in the panel rather than a button being pressed. That
      // has to stay silent: "no composition" and "nothing selected" are normal
      // states to be scrubbing a slider in, not mistakes worth a notification.
      try {
        comp = Flow.requireComp();
        layers = Flow.requireSelectedLayers(comp);
      } catch (e) {
        if (config.onlyExisting) return nothing;
        throw e;
      }
      var prefix = config.motion === "sweep" ? SWEEP_PREFIX : WIGGLE_PREFIX;

      // Plan first: After Effects cannot roll back half an undo group, so the
      // layers that will be written are settled before anything is written.
      var targets = [];
      var skipped = [];
      var i;
      for (i = 0; i < layers.length; i++) {
        var layer = layers[i];
        var reason = unsupportedReason(layer);
        if (reason) {
          // A mixed selection is normal; only say something when nothing at
          // all could be animated.
          skipped.push({ name: layer.name, reason: reason });
          continue;
        }
        if (config.onlyExisting && !hasFlowAnimator(layer, prefix)) continue;
        targets.push(layer);
      }

      if (targets.length === 0) {
        // A value changed while nothing carries a Flow animator yet: there is
        // simply nothing to update, which is not an error.
        if (config.onlyExisting) return nothing;
        throw Flow.error("UNSUPPORTED_LAYER", skipped.length === 1
          ? skipped[0].name + ": " + skipped[0].reason
          : "Select a text layer.");
      }

      var missing = [];
      var names = [];
      for (i = 0; i < targets.length; i++) {
        removeFlowAnimators(targets[i], prefix);
        buildOnLayer(targets[i], comp, config, missing);
        names.push(targets[i].name);
      }

      missing = uniqueList(missing);
      // Same reason as above: a live value change reports through the result,
      // not by interrupting with a notification on every scrub.
      if (!config.onlyExisting) {
        if (missing.length) {
          ctx.warnings.push("This After Effects version did not accept: " + missing.join(", ") + ".");
        }
        reportSkipped(ctx, skipped);
      }
      return { layers: targets.length, names: names, missing: missing, skipped: skipped };
    }
  });

  Flow.register("text.remove", {
    undo: "Remove Text Animators",
    run: function (params, ctx) {
      var comp = Flow.requireComp();
      var layers = Flow.requireSelectedLayers(comp);
      var skipped = [];
      var removed = 0;
      var touched = 0;

      for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        var reason = unsupportedReason(layer);
        if (reason) {
          skipped.push({ name: layer.name, reason: reason });
          continue;
        }
        var count = removeFlowAnimators(layer, FLOW_PREFIX);
        if (count) {
          removed += count;
          touched++;
        }
      }

      if (removed === 0) {
        throw Flow.error("INVALID_PROPERTY", "No Flow animator found on the selection.");
      }
      reportSkipped(ctx, skipped);
      return { removed: removed, layers: touched, skipped: skipped };
    }
  });
})($.global.Flow);
