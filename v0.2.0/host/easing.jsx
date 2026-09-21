// Easing tool: applies and reads temporal ease on selected keyframes.
//
// The panel describes each ease side in unit-free terms (influence % and
// velocity as a multiple of the segment's average speed). AE stores speed in
// the property's own units per second, so every side is converted per
// segment: speed = velocity * (value change / duration). For a 1D property
// this reproduces the panel's bezier curve exactly in AE's value graph.
//
// Only temporal ease and interpolation types are written. Keyframe values,
// times and spatial tangents are never modified.

(function (Flow) {
  if (!Flow) return;

  var MIN_INFLUENCE = 0.1;
  var ARC_SAMPLES = 24;
  var TINY = 1e-9;

  // ------------------------------------------------------------ math utils

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function distance(a, b) {
    var sum = 0;
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) sum += (b[i] - a[i]) * (b[i] - a[i]);
    return Math.sqrt(sum);
  }

  function addVec(a, b) {
    var out = [];
    for (var i = 0; i < a.length; i++) out.push(a[i] + (i < b.length ? b[i] : 0));
    return out;
  }

  function bezierPoint(p0, p1, p2, p3, u) {
    var v = 1 - u;
    var out = [];
    for (var i = 0; i < p0.length; i++) {
      out.push(v * v * v * p0[i] + 3 * v * v * u * p1[i] + 3 * v * u * u * p2[i] + u * u * u * p3[i]);
    }
    return out;
  }

  // ------------------------------------------------------------ params

  function readSide(params, key) {
    var s = params[key];
    if (s === null || s === undefined) return null;
    if (typeof s !== "object" || typeof s.influence !== "number" || typeof s.velocity !== "number" ||
        !isFinite(s.influence) || !isFinite(s.velocity)) {
      throw Flow.error("INVALID_PARAMS", "Parameter '" + key + "' must be { influence, velocity }.");
    }
    return { influence: clamp(s.influence, MIN_INFLUENCE, 100), velocity: s.velocity };
  }

  // ------------------------------------------------------------ properties

  // scalar: 1D values, speed is signed.
  // spatial: Position-like, one speed along the motion path (never negative).
  // vector: multi-dimensional non-spatial (Scale, Color...).
  // influenceOnly: paths and custom values - AE has no meaningful speed unit.
  function propertyKind(prop) {
    var t = prop.propertyValueType;
    if (t === PropertyValueType.OneD) return "scalar";
    if (t === PropertyValueType.TwoD_SPATIAL || t === PropertyValueType.ThreeD_SPATIAL) return "spatial";
    if (t === PropertyValueType.TwoD || t === PropertyValueType.ThreeD || t === PropertyValueType.COLOR) return "vector";
    if (t === PropertyValueType.SHAPE || t === PropertyValueType.CUSTOM_VALUE) return "influenceOnly";
    return null; // Source Text, markers, layer/mask references: hold-only or not easable
  }

  function propertyLabel(prop) {
    return prop.propertyGroup(prop.propertyDepth).name + " > " + prop.name;
  }

  // Selected keyframed properties across the active comp, in one pass.
  function collectKeyTargets(comp) {
    var props = comp.selectedProperties || [];
    var targets = [];
    var skipped = [];

    for (var i = 0; i < props.length; i++) {
      var prop = props[i];
      if (prop.propertyType !== PropertyType.PROPERTY || !prop.numKeys) continue;
      var keys = prop.selectedKeys;
      if (!keys || keys.length === 0) continue;

      var label = propertyLabel(prop);
      var kind = propertyKind(prop);
      if (!kind) {
        skipped.push({ name: label, reason: "These keyframes can't be eased." });
        continue;
      }
      if (prop.propertyGroup(prop.propertyDepth).locked) {
        skipped.push({ name: label, reason: "Layer is locked." });
        continue;
      }
      var copy = [];
      for (var k = 0; k < keys.length; k++) copy.push(keys[k]);
      targets.push({ prop: prop, kind: kind, keys: copy, label: label });
    }

    if (targets.length === 0 && skipped.length === 0) {
      throw Flow.error("NO_KEYFRAMES", "Select keyframes first.");
    }
    return { targets: targets, skipped: skipped };
  }

  // ------------------------------------------------------------ speeds

  // AE has no "spatial interpolation type" getter: a linear spatial side is
  // simply stored as a zero-length tangent, so the tangents alone describe
  // the path segment.
  function spatialArcLength(prop, a, b, va, vb) {
    var p1 = addVec(va, prop.keyOutSpatialTangent(a));
    var p2 = addVec(vb, prop.keyInSpatialTangent(b));
    var length = 0;
    var prev = va;
    for (var s = 1; s <= ARC_SAMPLES; s++) {
      var point = bezierPoint(va, p1, p2, vb, s / ARC_SAMPLES);
      length += distance(prev, point);
      prev = point;
    }
    return length;
  }

  // Average speed of the segment between keys a and b, one entry per ease
  // dimension (AE's ease arrays are length 1 for scalar/spatial/color).
  function segmentSpeeds(prop, kind, a, b, len) {
    var out = [];
    var i;
    var dt = prop.keyTime(b) - prop.keyTime(a);
    if (dt > TINY && kind !== "influenceOnly") {
      var va = prop.keyValue(a);
      var vb = prop.keyValue(b);
      if (kind === "scalar") out.push((vb - va) / dt);
      else if (kind === "spatial") out.push(spatialArcLength(prop, a, b, va, vb) / dt);
      else if (len === 1) out.push(distance(va, vb) / dt);
      else for (i = 0; i < len && i < va.length; i++) out.push((vb[i] - va[i]) / dt);
    }
    while (out.length < len) out.push(out.length ? out[out.length - 1] : 0);
    return out;
  }

  function buildEase(side, speeds, kind, state) {
    var unsigned = kind === "spatial" || (kind === "vector" && speeds.length === 1);
    var arr = [];
    for (var i = 0; i < speeds.length; i++) {
      var speed = side.velocity * speeds[i];
      if (unsigned && speed < 0) {
        speed = 0;
        state.overshootClamped = true;
      }
      if (kind === "influenceOnly" && side.velocity !== 0) state.velocityIgnored = true;
      arr.push(new KeyframeEase(speed, side.influence));
    }
    return arr;
  }

  // ------------------------------------------------------------ apply

  function applyToProperty(target, interpolation, incoming, outgoing, state, skipped) {
    var prop = target.prop;
    var n = prop.numKeys;
    var BEZIER = KeyframeInterpolationType.BEZIER;
    var LINEAR = KeyframeInterpolationType.LINEAR;
    var newType = interpolation === "linear" ? LINEAR : BEZIER;
    var changed = 0;
    var roving = 0;

    for (var i = 0; i < target.keys.length; i++) {
      var k = target.keys[i];
      if (target.kind === "spatial" && prop.keyRoving(k)) {
        roving++;
        continue;
      }
      // The first key has no incoming segment, the last no outgoing one.
      var doIn = incoming !== null && k > 1;
      var doOut = outgoing !== null && k < n;
      if (!doIn && !doOut) continue;

      prop.setInterpolationTypeAtKey(
        k,
        doIn ? newType : prop.keyInInterpolationType(k),
        doOut ? newType : prop.keyOutInterpolationType(k)
      );

      if (interpolation === "bezier") {
        var inEase = prop.keyInTemporalEase(k);
        var outEase = prop.keyOutTemporalEase(k);
        var len = inEase.length;
        if (doIn) inEase = buildEase(incoming, segmentSpeeds(prop, target.kind, k - 1, k, len), target.kind, state);
        if (doOut) outEase = buildEase(outgoing, segmentSpeeds(prop, target.kind, k, k + 1, len), target.kind, state);
        // Continuous/auto-bezier keys force AE to recompute speeds, which
        // would silently discard asymmetric eases.
        prop.setTemporalContinuousAtKey(k, false);
        prop.setTemporalAutoBezierAtKey(k, false);
        prop.setTemporalEaseAtKey(k, inEase, outEase);
      }
      changed++;
    }

    if (roving) skipped.push({ name: target.label, reason: roving + " roving keyframe(s) left unchanged." });
    return changed;
  }

  Flow.register("easing.apply", {
    undo: "Apply Easing",
    run: function (params, ctx) {
      var interpolation = Flow.oneOf(params, "interpolation", ["bezier", "linear"]);
      var incoming = readSide(params, "incoming");
      var outgoing = readSide(params, "outgoing");
      if (!incoming && !outgoing) {
        throw Flow.error("INVALID_PARAMS", "Nothing to apply: both ease sides are empty.");
      }

      var comp = Flow.requireComp();
      var found = collectKeyTargets(comp);
      var skipped = found.skipped;
      var state = {};
      var keys = 0;
      var properties = 0;

      for (var i = 0; i < found.targets.length; i++) {
        var changed = applyToProperty(found.targets[i], interpolation, incoming, outgoing, state, skipped);
        if (changed) {
          keys += changed;
          properties++;
        }
      }

      if (keys === 0) {
        if (skipped.length) throw Flow.error("INVALID_PROPERTY", skipped[0].name + ": " + skipped[0].reason);
        throw Flow.error("NO_KEYFRAMES",
          "Nothing changed: select keyframes that have a neighbouring keyframe on the side being eased.");
      }
      if (skipped.length) {
        ctx.warnings.push("Skipped " + skipped.length + " item(s): " + skipped[0].name + " - " + skipped[0].reason);
      }
      if (state.overshootClamped) {
        ctx.warnings.push("Overshoot isn't possible on spatial properties like Position. " +
          "Use Separate Dimensions to overshoot.");
      }
      if (state.velocityIgnored) {
        ctx.warnings.push("Path keyframes support influence only; velocity was set to 0.");
      }
      return { keys: keys, properties: properties, skipped: skipped };
    }
  });

  // ------------------------------------------------------------ read

  function velocityRatio(speed, average) {
    return Math.abs(average) < TINY ? 0 : speed / average;
  }

  // Reads the curve of the segment that starts at the first selected keyframe
  // (or ends at it, when that keyframe is the last one).
  Flow.register("easing.read", {
    undo: null,
    run: function (params, ctx) {
      var comp = Flow.requireComp();
      var found = collectKeyTargets(comp);
      if (found.targets.length === 0) {
        throw Flow.error("INVALID_PROPERTY", found.skipped[0].name + ": " + found.skipped[0].reason);
      }

      var target = found.targets[0];
      var prop = target.prop;
      if (prop.numKeys < 2) {
        throw Flow.error("NO_KEYFRAMES", "A property needs at least two keyframes to have easing.");
      }
      var a = Math.min(target.keys[0], prop.numKeys - 1);
      var b = a + 1;
      var HOLD = KeyframeInterpolationType.HOLD;
      var LINEAR = KeyframeInterpolationType.LINEAR;
      var outType = prop.keyOutInterpolationType(a);
      var inType = prop.keyInInterpolationType(b);
      var source = target.label + " (keys " + a + "-" + b + ")";

      if (outType === HOLD || inType === HOLD) {
        throw Flow.error("INVALID_PROPERTY", "Hold keyframes have no easing to copy.");
      }
      if (outType === LINEAR && inType === LINEAR) {
        return {
          interpolation: "linear",
          outgoing: { influence: 33.33, velocity: 1 },
          incoming: { influence: 33.33, velocity: 1 },
          source: source
        };
      }

      var outEase = prop.keyOutTemporalEase(a);
      var inEase = prop.keyInTemporalEase(b);
      var speeds = segmentSpeeds(prop, target.kind, a, b, outEase.length);
      // Normalise against the first dimension that actually changes value.
      var dim = 0;
      for (var i = 0; i < speeds.length; i++) {
        if (Math.abs(speeds[i]) > TINY) { dim = i; break; }
      }
      if (Math.abs(speeds[dim]) < TINY) {
        ctx.warnings.push("The value doesn't change between these keyframes, so only influence was copied.");
      }

      return {
        interpolation: "bezier",
        outgoing: {
          influence: outEase[dim].influence,
          velocity: outType === LINEAR ? 1 : velocityRatio(outEase[dim].speed, speeds[dim])
        },
        incoming: {
          influence: inEase[dim].influence,
          velocity: inType === LINEAR ? 1 : velocityRatio(inEase[dim].speed, speeds[dim])
        },
        source: source
      };
    }
  });
})($.global.Flow);
