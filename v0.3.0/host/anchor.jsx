// Anchor Point tool.
//
// Moves each selected layer's anchor to a point on its visible bounds
// (sourceRectAtTime) and, unless told otherwise, offsets Position so the
// layer does not move on screen.
//
// Why measure with a temporary expression instead of doing the matrix math
// here: a Position change is expressed in the parent's space, so it must be
// the layer-space anchor delta pushed through the layer's own scale,
// rotation, X/Y/Z rotation, orientation and auto-orient. AE's expression
// toWorld()/fromWorld() evaluate exactly the transform AE renders, so the
// result is correct for 3D and auto-oriented layers without re-implementing
// AE's rotation order. A plain 2D matrix is kept as a fallback in case the
// temporary effect cannot be added.

(function (Flow) {
  if (!Flow) return;

  var FRACTIONS = {
    "top-left": [0, 0], "top-center": [0.5, 0], "top-right": [1, 0],
    "middle-left": [0, 0.5], "center": [0.5, 0.5], "middle-right": [1, 0.5],
    "bottom-left": [0, 1], "bottom-center": [0.5, 1], "bottom-right": [1, 1]
  };
  var POSITION_NAMES = [
    "top-left", "top-center", "top-right",
    "middle-left", "center", "middle-right",
    "bottom-left", "bottom-center", "bottom-right"
  ];
  var EPSILON = 1e-6;

  // ------------------------------------------------------------ small utils

  function addVec(v, d) {
    var out = [];
    for (var i = 0; i < v.length; i++) out.push(v[i] + (i < d.length ? d[i] : 0));
    return out;
  }

  function addTime(list, time) {
    for (var i = 0; i < list.length; i++) if (Math.abs(list[i] - time) < 1e-9) return;
    list.push(time);
  }

  function timeIndex(list, time) {
    for (var i = 0; i < list.length; i++) if (Math.abs(list[i] - time) < 1e-9) return i;
    return -1;
  }

  function readOffset(params) {
    var o = params.offset;
    if (o === undefined || o === null) return [0, 0];
    if (!(o instanceof Array) || o.length !== 2 ||
        typeof o[0] !== "number" || typeof o[1] !== "number" ||
        !isFinite(o[0]) || !isFinite(o[1])) {
      throw Flow.error("INVALID_PARAMS", "Parameter 'offset' must be [x, y].");
    }
    return [o[0], o[1]];
  }

  function transformGroup(layer) {
    return layer.property("ADBE Transform Group");
  }

  function unsupportedReason(layer) {
    if (layer instanceof CameraLayer) return "Cameras have no anchor point.";
    if (layer instanceof LightLayer) return "Lights have no anchor point.";
    if (!Flow.isVisualLayer(layer)) return "Unsupported layer type.";
    if (!layer.hasVideo) return "Audio-only layer.";
    if (layer.locked) return "Layer is locked.";
    return null;
  }

  // True when the layer-space -> parent-space mapping changes over time, which
  // means a single static Position offset cannot be exact at every frame.
  function linearPartVaries(layer) {
    var tr = transformGroup(layer);
    var names = ["ADBE Scale", "ADBE Rotate Z"];
    if (layer.threeDLayer) names = names.concat(["ADBE Rotate X", "ADBE Rotate Y", "ADBE Orientation"]);
    for (var i = 0; i < names.length; i++) {
      var p = tr.property(names[i]);
      if (p && (p.numKeys > 0 || Flow.hasActiveExpression(p))) return true;
    }
    return layer.autoOrient !== AutoOrientType.NO_AUTO_ORIENT;
  }

  // ------------------------------------------------------------ measuring

  function buildMeasureExpression(d, hasParent) {
    var dx = String(d[0]);
    var dy = String(d[1]);
    return [
      "var a = thisLayer.transform.anchorPoint.value;",
      "var d = a.length > 2 ? [" + dx + ", " + dy + ", 0] : [" + dx + ", " + dy + "];",
      "var w0 = thisLayer.toWorld(a);",
      "var w1 = thisLayer.toWorld(add(a, d));",
      hasParent ? "w0 = thisLayer.parent.fromWorld(w0); w1 = thisLayer.parent.fromWorld(w1);" : "",
      "var r = sub(w1, w0);",
      "[r[0], r[1], r.length > 2 ? r[2] : 0];"
    ].join("\n");
  }

  // Returns one parent-space [x, y, z] delta per time, or null if the
  // measurement could not be performed. The temporary effect is always removed.
  function measureWithExpression(layer, d, times) {
    var parade = layer.property("ADBE Effect Parade");
    if (!parade || !parade.canAddProperty("ADBE Point3D Control")) return null;

    var fx = null;
    var result = null;
    try {
      fx = parade.addProperty("ADBE Point3D Control");
      var prop = fx.property(1);
      prop.expression = buildMeasureExpression(d, layer.parent !== null);
      result = [];
      for (var i = 0; i < times.length; i++) {
        var v = prop.valueAtTime(times[i], false);
        result.push([v[0], v[1], v.length > 2 ? v[2] : 0]);
      }
      if (prop.expressionError) result = null;
    } catch (e) {
      result = null;
    } finally {
      if (fx) {
        try { fx.remove(); } catch (removeError) { /* layer already invalid; nothing to clean */ }
      }
    }
    return result;
  }

  function measureWithMatrix2D(layer, d, times) {
    var tr = transformGroup(layer);
    var result = [];
    for (var i = 0; i < times.length; i++) {
      var s = tr.property("ADBE Scale").valueAtTime(times[i], false);
      var r = tr.property("ADBE Rotate Z").valueAtTime(times[i], false) * Math.PI / 180;
      var px = d[0] * s[0] / 100;
      var py = d[1] * s[1] / 100;
      var c = Math.cos(r);
      var n = Math.sin(r);
      // AE's Y axis points down, so this standard rotation is clockwise on screen.
      result.push([px * c - py * n, px * n + py * c, 0]);
    }
    return result;
  }

  // ------------------------------------------------------------ position plan

  // Describes the Position properties to compensate by match name, because
  // property references obtained before adding/removing an effect can become
  // invalid in ExtendScript.
  function positionTargets(layer) {
    var tr = transformGroup(layer);
    if (tr.property("ADBE Position").dimensionsSeparated) {
      var list = [{ matchName: "ADBE Position_0", dim: 0 }, { matchName: "ADBE Position_1", dim: 1 }];
      if (layer.threeDLayer) list.push({ matchName: "ADBE Position_2", dim: 2 });
      return list;
    }
    return [{ matchName: "ADBE Position", dim: -1 }];
  }

  // Returns { writes: [...], usedExpression: bool } or a skip-reason string.
  function planPosition(layer, d, t, notes) {
    var tr = transformGroup(layer);
    var targets = positionTargets(layer);
    var times = [t];
    var i, k, prop;

    for (i = 0; i < targets.length; i++) {
      prop = tr.property(targets[i].matchName);
      targets[i].numKeys = prop.numKeys;
      for (k = 1; k <= prop.numKeys; k++) addTime(times, prop.keyTime(k));
      if (Flow.hasActiveExpression(prop)) notes.positionExpression = true;
    }
    if (linearPartVaries(layer)) notes.animatedTransform = true;

    var deltas = measureWithExpression(layer, d, times);
    if (!deltas) {
      if (layer.threeDLayer) return "Could not measure this 3D layer's transform.";
      deltas = measureWithMatrix2D(layer, d, times);
    }

    // Re-acquire properties: the temporary effect invalidated earlier references.
    tr = transformGroup(layer);
    var writes = [];
    for (i = 0; i < targets.length; i++) {
      var target = targets[i];
      prop = tr.property(target.matchName);
      if (target.numKeys === 0) {
        var delta = deltas[timeIndex(times, t)];
        writes.push({
          matchName: target.matchName,
          key: 0,
          value: target.dim < 0 ? addVec(prop.value, delta) : prop.value + delta[target.dim]
        });
      } else {
        for (k = 1; k <= target.numKeys; k++) {
          var keyDelta = deltas[timeIndex(times, prop.keyTime(k))];
          var keyValue = prop.keyValue(k);
          writes.push({
            matchName: target.matchName,
            key: k,
            value: target.dim < 0 ? addVec(keyValue, keyDelta) : keyValue + keyDelta[target.dim]
          });
        }
      }
    }
    return { writes: writes };
  }

  // ------------------------------------------------------------ apply

  // setValueAtKey keeps each key's interpolation, temporal ease and spatial
  // tangents, so existing animation timing is untouched.
  function shiftAnchor(anchor, d) {
    if (anchor.numKeys > 0) {
      for (var k = 1; k <= anchor.numKeys; k++) {
        anchor.setValueAtKey(k, addVec(anchor.keyValue(k), d));
      }
    } else {
      anchor.setValue(addVec(anchor.value, d));
    }
  }

  function applyWrites(layer, writes) {
    var tr = transformGroup(layer);
    for (var i = 0; i < writes.length; i++) {
      var prop = tr.property(writes[i].matchName);
      if (writes[i].key > 0) prop.setValueAtKey(writes[i].key, writes[i].value);
      else prop.setValue(writes[i].value);
    }
  }

  // Returns null on success or a skip reason.
  function processLayer(layer, frac, offset, compensate, includeExtents, t, notes) {
    var anchor = transformGroup(layer).property("ADBE Anchor Point");
    if (Flow.hasActiveExpression(anchor)) return "Anchor Point is driven by an expression.";

    var rect = layer.sourceRectAtTime(t, includeExtents);
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      return "No visible content at the current time.";
    }

    var current = anchor.valueAtTime(t, true);
    var d = [
      rect.left + rect.width * frac[0] + offset[0] - current[0],
      rect.top + rect.height * frac[1] + offset[1] - current[1]
    ];
    if (Math.abs(d[0]) < EPSILON && Math.abs(d[1]) < EPSILON) return null;

    // Plan everything before writing so a failure cannot leave the anchor
    // moved without its Position compensation.
    var plan = null;
    if (compensate) {
      plan = planPosition(layer, d, t, notes);
      if (typeof plan === "string") return plan;
    }

    shiftAnchor(transformGroup(layer).property("ADBE Anchor Point"), d);
    if (plan) applyWrites(layer, plan.writes);
    return null;
  }

  // ------------------------------------------------------------ command

  Flow.register("anchor.set", {
    undo: "Set Anchor Point",
    run: function (params, ctx) {
      var position = Flow.oneOf(params, "position", POSITION_NAMES);
      var offset = readOffset(params);
      var compensate = Flow.bool(params, "compensate", true);
      var includeExtents = Flow.bool(params, "includeExtents", false);

      var comp = Flow.requireComp();
      var layers = Flow.requireSelectedLayers(comp);
      var t = comp.time;
      var frac = FRACTIONS[position];

      var processed = 0;
      var skipped = [];
      var animatedCount = 0;
      var expressionCount = 0;

      for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        var notes = {};
        var reason = unsupportedReason(layer);
        if (!reason) reason = processLayer(layer, frac, offset, compensate, includeExtents, t, notes);

        if (reason) {
          skipped.push({ name: layer.name, reason: reason });
        } else {
          processed++;
          if (notes.animatedTransform) animatedCount++;
          if (notes.positionExpression) expressionCount++;
        }
      }

      if (processed === 0) {
        throw Flow.error("UNSUPPORTED_LAYER", skipped.length === 1
          ? skipped[0].name + ": " + skipped[0].reason
          : "No selected layer could be changed (" + skipped[0].reason + ")");
      }
      if (skipped.length) {
        ctx.warnings.push("Skipped " + skipped.length + " layer(s): " + skipped[0].name + " - " + skipped[0].reason);
      }
      if (animatedCount) {
        ctx.warnings.push("Scale/rotation is animated on " + animatedCount +
          " layer(s): compensation is exact at the current time and at Position keyframes.");
      }
      if (expressionCount) {
        ctx.warnings.push("Position has an expression on " + expressionCount +
          " layer(s); its underlying value was compensated.");
      }

      return { processed: processed, skipped: skipped };
    }
  });
})($.global.Flow);
