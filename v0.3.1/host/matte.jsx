// Matte tool.
//
// Builds a shape layer directly above each selected layer and hooks it up as
// that layer's track matte.
//
// The matte always spans exactly the same frames as the layer it mattes.
//
// Shapes:
//   box      a rectangle covering the layer's visible bounds
//   ellipse  an ellipse inscribed in those bounds
//   shape    an exact copy of the selected shape layer's own paths
//   comp     a rectangle the size of the composition
//
// Why the matte copies the layer's transform instead of measuring comp-space
// bounds: giving the matte the same parent, anchor, position, scale and
// rotation makes its layer space identical to the source layer's. The
// rectangle can then be drawn straight from sourceRectAtTime, which is exact
// for rotated, scaled and parented layers without any measurement at all.
//
// After Effects 23.0 replaced "the layer directly above" with a real layer
// reference (setTrackMatte). Flow uses it when present and falls back to the
// old trackMatteType for older hosts; the matte is placed directly above
// either way, so both behave the same.

(function (Flow) {
  if (!Flow) return;

  var SHAPES = ["box", "ellipse", "shape", "comp"];
  var WHITE = [1, 1, 1, 1];

  // ------------------------------------------------------------ small utils

  function transformGroup(layer) {
    return layer.property("ADBE Transform Group");
  }

  function setVector(prop, values) {
    var current = prop.value;
    var out = [];
    for (var i = 0; i < current.length; i++) out.push(i < values.length ? values[i] : 0);
    prop.setValue(out);
  }

  function readVector(prop, t) {
    var v = prop.valueAtTime(t, false);
    if (typeof v === "number") return [v, 0, 0];
    return [v[0], v.length > 1 ? v[1] : 0, v.length > 2 ? v[2] : 0];
  }

  // Position is the one transform property that can be split into separate
  // X/Y/Z properties, which hold the real values when it is.
  function readPosition(layer, t) {
    var tr = transformGroup(layer);
    var pos = tr.property("ADBE Position");
    if (!pos) return [0, 0, 0];
    if (pos.dimensionsSeparated) {
      var x = tr.property("ADBE Position_0");
      var y = tr.property("ADBE Position_1");
      var z = tr.property("ADBE Position_2");
      if (!x || !y) return [0, 0, 0];
      return [x.valueAtTime(t, false), y.valueAtTime(t, false), z ? z.valueAtTime(t, false) : 0];
    }
    return readVector(pos, t);
  }

  function unsupportedReason(layer) {
    if (layer instanceof CameraLayer) return "Cameras cannot have a track matte.";
    if (layer instanceof LightLayer) return "Lights cannot have a track matte.";
    if (!Flow.isVisualLayer(layer)) return "Unsupported layer type.";
    if (!layer.hasVideo) return "Audio-only layer.";
    if (layer.locked) return "Layer is locked.";
    return null;
  }

  // A static matte can only match a moving layer at one point in time.
  function transformAnimated(layer) {
    var tr = transformGroup(layer);
    var names = [
      "ADBE Anchor Point", "ADBE Position", "ADBE Position_0", "ADBE Position_1", "ADBE Position_2",
      "ADBE Scale", "ADBE Rotate Z", "ADBE Rotate X", "ADBE Rotate Y", "ADBE Orientation"
    ];
    for (var i = 0; i < names.length; i++) {
      var p = tr.property(names[i]);
      if (p && (p.numKeys > 0 || Flow.hasActiveExpression(p))) return true;
    }
    return false;
  }

  // Trims the matte to the layer it mattes. in/out have to be written in an
  // order that never makes out <= in, which After Effects rejects.
  function matchSpan(matte, layer) {
    var inTime = layer.inPoint;
    var outTime = layer.outPoint;
    if (typeof inTime !== "number" || typeof outTime !== "number" || !(outTime > inTime)) return true;
    try {
      if (inTime > matte.outPoint) {
        matte.outPoint = outTime;
        matte.inPoint = inTime;
      } else {
        matte.inPoint = inTime;
        matte.outPoint = outTime;
      }
    } catch (trimError) {
      // Some sources refuse to be stretched past their own length.
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------ track matte

  function applyTrackMatte(layer, matte, inverted) {
    var type = inverted ? TrackMatteType.ALPHA_INVERTED : TrackMatteType.ALPHA;
    if (typeof layer.setTrackMatte === "function") {
      layer.setTrackMatte(matte, type);
    } else {
      // Pre-23.0 hosts take the layer directly above, which is where the
      // matte was just placed.
      layer.trackMatteType = type;
    }
    // A track matte layer is not drawn itself. AE does this too, but doing it
    // here keeps both host versions behaving the same.
    matte.enabled = false;
  }

  function clearTrackMatte(layer) {
    if (typeof layer.removeTrackMatte === "function") {
      layer.removeTrackMatte();
    } else {
      layer.trackMatteType = TrackMatteType.NO_TRACK_MATTE;
    }
  }

  function hasTrackMatte(layer) {
    if (layer.trackMatteLayer) return true;
    return layer.trackMatteType !== undefined && layer.trackMatteType !== TrackMatteType.NO_TRACK_MATTE;
  }

  // ------------------------------------------------------------ shape layer

  // Draws one rectangle or ellipse, filled white, in the layer's own space.
  function addGeometry(matte, kind, size, center) {
    var root = matte.property("ADBE Root Vectors Group");
    root.addProperty("ADBE Vector Group");
    // Re-acquire after addProperty: earlier references can go stale.
    var group = matte.property("ADBE Root Vectors Group").property(1);
    var contents = group.property("ADBE Vectors Group");

    var isEllipse = kind === "ellipse";
    contents.addProperty(isEllipse ? "ADBE Vector Shape - Ellipse" : "ADBE Vector Shape - Rect");
    var geo = group.property("ADBE Vectors Group").property(1);
    geo.property(isEllipse ? "ADBE Vector Ellipse Size" : "ADBE Vector Rect Size").setValue(size);
    geo.property(isEllipse ? "ADBE Vector Ellipse Position" : "ADBE Vector Rect Position").setValue(center);

    // The fill is added after the path, which is the order After Effects uses.
    group.property("ADBE Vectors Group").addProperty("ADBE Vector Graphic - Fill");
    var contentsAgain = matte.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group");
    var fill = contentsAgain.property(contentsAgain.numProperties);
    fill.property("ADBE Vector Fill Color").setValue(WHITE);
  }

  // Gives the matte the same layer space as the source, so shapes drawn from
  // sourceRectAtTime land exactly on it.
  function copyTransform(matte, layer, t) {
    if (layer.threeDLayer) matte.threeDLayer = true;
    // Parent first: assigning .parent rewrites the transform to hold the layer
    // in place, so every value has to be written after it.
    if (layer.parent) {
      try { matte.parent = layer.parent; } catch (parentError) { /* cycle; leave at the comp root */ }
    }

    var src = transformGroup(layer);
    var dst = transformGroup(matte);
    setVector(dst.property("ADBE Anchor Point"), readVector(src.property("ADBE Anchor Point"), t));
    setVector(dst.property("ADBE Position"), readPosition(layer, t));
    setVector(dst.property("ADBE Scale"), readVector(src.property("ADBE Scale"), t));
    dst.property("ADBE Rotate Z").setValue(src.property("ADBE Rotate Z").valueAtTime(t, false));

    if (!layer.threeDLayer) return;
    var spatial = ["ADBE Rotate X", "ADBE Rotate Y"];
    for (var i = 0; i < spatial.length; i++) {
      var from = src.property(spatial[i]);
      var to = dst.property(spatial[i]);
      if (from && to) to.setValue(from.valueAtTime(t, false));
    }
    var orientFrom = src.property("ADBE Orientation");
    var orientTo = dst.property("ADBE Orientation");
    if (orientFrom && orientTo) setVector(orientTo, readVector(orientFrom, t));
  }

  function buildFromBounds(comp, layer, kind, t) {
    // Extents included: a matte that clipped a layer's own stroke would be
    // visibly wrong.
    var rect = layer.sourceRectAtTime(t, true);
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;

    var matte = comp.layers.addShape();
    copyTransform(matte, layer, t);
    addGeometry(matte, kind, [rect.width, rect.height],
      [rect.left + rect.width / 2, rect.top + rect.height / 2]);
    return matte;
  }

  function buildCompSized(comp) {
    var matte = comp.layers.addShape();
    var tr = transformGroup(matte);
    setVector(tr.property("ADBE Anchor Point"), [0, 0, 0]);
    setVector(tr.property("ADBE Position"), [comp.width / 2, comp.height / 2, 0]);
    addGeometry(matte, "box", [comp.width, comp.height], [0, 0]);
    return matte;
  }

  // An exact copy of a shape layer, paths, transform, animation and all.
  function buildFromShapeLayer(layer) {
    var copy = layer.duplicate();
    // The duplicate inherits the original's own matte link; a matte must not
    // be matted itself.
    try { clearTrackMatte(copy); } catch (matteError) { /* nothing was set */ }
    return copy;
  }

  // ------------------------------------------------------------ commands

  Flow.register("matte.create", {
    undo: "Create Matte",
    run: function (params, ctx) {
      var shape = Flow.oneOf(params, "shape", SHAPES);
      var inverted = Flow.bool(params, "inverted", false);

      var comp = Flow.requireComp();
      var layers = Flow.requireSelectedLayers(comp);
      var t = comp.time;
      var skipped = [];
      var names = [];
      var created = [];
      var animated = 0;
      var fellBack = 0;
      var untrimmed = 0;
      var i;

      for (i = 0; i < layers.length; i++) {
        var layer = layers[i];
        var reason = unsupportedReason(layer);
        if (reason) {
          skipped.push({ name: layer.name, reason: reason });
          continue;
        }

        var kind = shape;
        if (kind === "shape" && !(layer instanceof ShapeLayer)) {
          kind = "box";
          fellBack++;
        }

        var matte = null;
        if (kind === "comp") {
          matte = buildCompSized(comp);
        } else if (kind === "shape") {
          matte = buildFromShapeLayer(layer);
        } else {
          matte = buildFromBounds(comp, layer, kind, t);
          if (!matte) {
            skipped.push({ name: layer.name, reason: "No visible content at the current time." });
            continue;
          }
        }

        matte.name = Flow.uniqueLayerName(comp, layer.name + " Matte");
        matte.moveBefore(layer);
        if (!matchSpan(matte, layer)) untrimmed++;
        applyTrackMatte(layer, matte, inverted);

        if (kind !== "comp" && transformAnimated(layer)) animated++;
        created.push(matte);
        names.push(matte.name);
      }

      if (created.length === 0) {
        throw Flow.error("UNSUPPORTED_LAYER", skipped.length === 1
          ? skipped[0].name + ": " + skipped[0].reason
          : "No selected layer could take a matte.");
      }

      // The new mattes become the selection, so they can be shaped or keyed
      // straight away.
      for (i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
      for (i = 0; i < created.length; i++) created[i].selected = true;

      if (untrimmed) {
        ctx.warnings.push("Could not trim " + untrimmed +
          " matte(s) to their layer; adjust the in/out points by hand.");
      }
      if (fellBack) {
        ctx.warnings.push("Shape copy needs a shape layer; " + fellBack +
          " layer(s) got a box matching their bounds instead.");
      }
      if (animated) {
        ctx.warnings.push("The transform is animated on " + animated +
          " layer(s), so the matte matches at the current time.");
      }
      if (skipped.length) {
        ctx.warnings.push("Skipped " + skipped.length + " layer(s): " + skipped[0].name + " - " + skipped[0].reason);
      }

      return { created: created.length, names: names, skipped: skipped };
    }
  });

  Flow.register("matte.remove", {
    undo: "Remove Matte",
    run: function (params, ctx) {
      var comp = Flow.requireComp();
      var layers = Flow.requireSelectedLayers(comp);
      var skipped = [];
      var removed = 0;

      for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        if (!Flow.isVisualLayer(layer) || !hasTrackMatte(layer)) {
          skipped.push({ name: layer.name, reason: "No track matte." });
          continue;
        }
        if (layer.locked) {
          skipped.push({ name: layer.name, reason: "Layer is locked." });
          continue;
        }
        clearTrackMatte(layer);
        removed++;
      }

      if (removed === 0) {
        throw Flow.error("INVALID_PROPERTY", "No track matte found on the selection.");
      }
      if (skipped.length) {
        ctx.warnings.push("Skipped " + skipped.length + " layer(s): " + skipped[0].name + " - " + skipped[0].reason);
      }

      // The matte layers stay in the comp, hidden, so nothing is destroyed.
      return { removed: removed, skipped: skipped };
    }
  });
})($.global.Flow);
