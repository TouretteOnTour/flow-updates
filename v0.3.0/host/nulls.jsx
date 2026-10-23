// Null Control tool.
//
// Creates null objects for the current selection and parents the selected
// layers to them, so a control rig can be built in one click.
//
// Placement ("origin"):
//   each      one null per selected layer, at that layer's own center
//   group     one null at the center of the selection's combined bounds
//   last      one null at the last selected layer's center
//   comp      one null at the center of the composition
//
// Why measure with a temporary expression: a layer's visible center is its
// sourceRectAtTime rect pushed through its own scale, rotations, orientation
// and its whole parent chain. AE's toComp() inside an expression evaluates
// exactly the transform AE renders, so Flow adds a temporary 3D Point
// Control, reads the rect corners in composition space and removes it again.
// The Anchor Point tool uses the same technique.

(function (Flow) {
  if (!Flow) return;

  var ORIGINS = ["each", "group", "last", "comp"];
  var NULL_SIZE = 100;

  // ------------------------------------------------------------ small utils

  function transformGroup(layer) {
    return layer.property("ADBE Transform Group");
  }

  function numberToSource(n) {
    if (typeof n !== "number" || !isFinite(n)) {
      throw Flow.error("HOST_EXCEPTION", "Could not measure this layer's bounds.");
    }
    return String(n);
  }

  function selectedLayers(comp) {
    var sel = comp.selectedLayers;
    var out = [];
    for (var i = 0; sel && i < sel.length; i++) out.push(sel[i]);
    return out;
  }

  // ------------------------------------------------------------ measuring

  // Maps layer-space points to composition space with a temporary expression.
  // Returns one [x, y, z] per point, or null when the layer takes no effects
  // (cameras, lights) or the expression failed.
  function toCompPoints(layer, points, t) {
    var parade = layer.property("ADBE Effect Parade");
    if (!parade || !parade.canAddProperty("ADBE Point3D Control")) return null;

    var fx = null;
    var out = null;
    try {
      fx = parade.addProperty("ADBE Point3D Control");
      var prop = fx.property(1);
      out = [];
      for (var i = 0; i < points.length; i++) {
        prop.expression = "var p = thisLayer.toComp([" + numberToSource(points[i][0]) +
          ", " + numberToSource(points[i][1]) + ", 0]);\n[p[0], p[1], p.length > 2 ? p[2] : 0];";
        var v = prop.valueAtTime(t, false);
        if (prop.expressionError) {
          out = null;
          break;
        }
        out.push([v[0], v[1], v.length > 2 ? v[2] : 0]);
      }
    } catch (e) {
      out = null;
    } finally {
      if (fx) {
        try { fx.remove(); } catch (removeError) { /* layer already invalid; nothing to clean */ }
      }
    }
    return out;
  }

  // Composition-space axis-aligned bounds of the layer's visible content,
  // or null when it has none (camera, light, audio-only, empty at this time).
  function layerBounds(layer, t) {
    if (!Flow.isVisualLayer(layer) || !layer.hasVideo) return null;

    var rect;
    try {
      rect = layer.sourceRectAtTime(t, false);
    } catch (e) {
      return null;
    }
    if (!rect) return null;

    var corners = toCompPoints(layer, [
      [rect.left, rect.top],
      [rect.left + rect.width, rect.top],
      [rect.left, rect.top + rect.height],
      [rect.left + rect.width, rect.top + rect.height]
    ], t);
    if (!corners) return null;

    var b = {
      min: [corners[0][0], corners[0][1], corners[0][2]],
      max: [corners[0][0], corners[0][1], corners[0][2]]
    };
    for (var i = 1; i < corners.length; i++) {
      for (var d = 0; d < 3; d++) {
        if (corners[i][d] < b.min[d]) b.min[d] = corners[i][d];
        if (corners[i][d] > b.max[d]) b.max[d] = corners[i][d];
      }
    }
    return b;
  }

  function unionBounds(target, b) {
    if (!target) return { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] };
    for (var d = 0; d < 3; d++) {
      if (b.min[d] < target.min[d]) target.min[d] = b.min[d];
      if (b.max[d] > target.max[d]) target.max[d] = b.max[d];
    }
    return target;
  }

  function boundsCenter(b) {
    return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  }

  // Position in the layer's own parent space. Only equals composition space
  // when the layer has no parent, so it is a last-resort fallback.
  function readPosition(layer, t) {
    var tr = transformGroup(layer);
    var pos = tr ? tr.property("ADBE Position") : null;
    if (!pos) return null;
    if (pos.dimensionsSeparated) {
      var x = tr.property("ADBE Position_0");
      var y = tr.property("ADBE Position_1");
      var z = tr.property("ADBE Position_2");
      if (!x || !y) return null;
      return [x.valueAtTime(t, false), y.valueAtTime(t, false), z ? z.valueAtTime(t, false) : 0];
    }
    var v = pos.valueAtTime(t, false);
    return [v[0], v[1], v.length > 2 ? v[2] : 0];
  }

  function anchorInComp(layer, t) {
    var tr = transformGroup(layer);
    var anchor = tr ? tr.property("ADBE Anchor Point") : null;
    if (!anchor) return null;
    var v = anchor.valueAtTime(t, false);
    var pts = toCompPoints(layer, [[v[0], v[1]]], t);
    return pts ? pts[0] : null;
  }

  // Best available composition-space point for one layer: the center of its
  // visible bounds, else its anchor point, else its position.
  function layerPoint(layer, t) {
    var b = layerBounds(layer, t);
    if (b) return boundsCenter(b);
    var a = anchorInComp(layer, t);
    if (a) return a;
    if (layer.parent) return null;
    return readPosition(layer, t);
  }

  // ------------------------------------------------------------ null layer

  function setVector(prop, values) {
    var current = prop.value;
    var out = [];
    for (var i = 0; i < current.length; i++) out.push(i < values.length ? values[i] : 0);
    prop.setValue(out);
  }

  function clampToComp(comp, t) {
    if (t < 0) return 0;
    if (t > comp.duration) return comp.duration;
    return t;
  }

  // in/out must be written in an order that never makes out <= in, which AE
  // rejects.
  function applySpan(nul, comp, inTime, outTime) {
    var a = clampToComp(comp, inTime);
    var b = clampToComp(comp, outTime);
    if (!(b > a)) return;
    if (a > nul.outPoint) {
      nul.outPoint = b;
      nul.inPoint = a;
    } else {
      nul.inPoint = a;
      nul.outPoint = b;
    }
  }

  function createNull(comp, plan, threeD) {
    // Resolved before the null exists, so it is not compared against AE's own
    // temporary "Null 1" name, and so two layers with the same name still get
    // two distinct nulls.
    var name = Flow.uniqueLayerName(comp, plan.name);
    var nul = comp.layers.addNull(comp.duration);
    nul.name = name;
    if (threeD) nul.threeDLayer = true;

    var tr = transformGroup(nul);
    // Center the anchor inside the null's box so the null's visible square and
    // its rotation/scale pivot sit exactly on the measured point.
    var w = nul.width || NULL_SIZE;
    var h = nul.height || NULL_SIZE;
    setVector(tr.property("ADBE Anchor Point"), [w / 2, h / 2, 0]);
    setVector(tr.property("ADBE Position"), plan.point);

    if (plan.span) applySpan(nul, comp, plan.span[0], plan.span[1]);
    // Setting .parent behaves like the pick whip: the null keeps its place on
    // screen, so it stays on the measured point inside the inherited rig.
    if (plan.inherit) {
      try { nul.parent = plan.inherit; } catch (parentError) { /* cycle; leave at the comp root */ }
    }
    if (plan.before) {
      try { nul.moveBefore(plan.before); } catch (moveError) { /* layer gone; leave at the top */ }
    }
    return nul;
  }

  // ------------------------------------------------------------ planning

  function spanOf(layers) {
    var inTime = layers[0].inPoint;
    var outTime = layers[0].outPoint;
    for (var i = 1; i < layers.length; i++) {
      if (layers[i].inPoint < inTime) inTime = layers[i].inPoint;
      if (layers[i].outPoint > outTime) outTime = layers[i].outPoint;
    }
    return [inTime, outTime];
  }

  function topMost(layers) {
    var top = layers[0];
    for (var i = 1; i < layers.length; i++) if (layers[i].index < top.index) top = layers[i];
    return top;
  }

  // The parent every selected layer shares, so the new null can take its place
  // in an existing rig. null when they differ, when there is none, or when the
  // parent is itself selected (it would then be parented to the null).
  function sharedParent(layers) {
    var p = layers[0].parent;
    if (!p) return null;
    var i;
    for (i = 1; i < layers.length; i++) if (layers[i].parent !== p) return null;
    for (i = 0; i < layers.length; i++) if (layers[i] === p) return null;
    return p;
  }

  function distinctParents(layers) {
    var seen = [];
    for (var i = 0; i < layers.length; i++) {
      if (!Flow.contains(seen, layers[i].parent)) seen.push(layers[i].parent);
    }
    return seen.length;
  }

  function anyThreeD(layers) {
    for (var i = 0; i < layers.length; i++) if (layers[i].threeDLayer) return true;
    return false;
  }

  // ------------------------------------------------------------ command

  Flow.register("null.create", {
    undo: "Create Null",
    run: function (params, ctx) {
      var origin = Flow.oneOf(params, "origin", ORIGINS);
      var doParent = Flow.bool(params, "parent", true);
      var threeD = Flow.bool(params, "threeD", false);
      var matchInOut = Flow.bool(params, "matchInOut", false);

      var comp = Flow.requireComp();
      // A composition-centered null is useful with nothing selected; every other
      // placement is measured from the selection.
      var layers = origin === "comp" ? selectedLayers(comp) : Flow.requireSelectedLayers(comp);
      var t = comp.time;
      var skipped = [];
      var plans = [];
      var i;
      // Noted before anything is written: parenting rewrites layer.parent, so
      // the original hierarchy can only be reported from here.
      var mixedParents = doParent && origin !== "each" && layers.length > 1 && distinctParents(layers) > 1;
      var missing3D = !threeD && anyThreeD(layers);

      // ---- plan first: nothing is created until every point is known -------
      if (origin === "each") {
        for (i = 0; i < layers.length; i++) {
          var point = layerPoint(layers[i], t);
          if (!point) {
            skipped.push({ name: layers[i].name, reason: "Could not measure this layer's position." });
            continue;
          }
          plans.push({
            name: layers[i].name + " Null",
            point: point,
            before: layers[i],
            children: [layers[i]],
            inherit: layers[i].parent,
            span: matchInOut ? [layers[i].inPoint, layers[i].outPoint] : null
          });
        }
        if (plans.length === 0) {
          throw Flow.error("UNSUPPORTED_LAYER", skipped.length
            ? skipped[0].name + ": " + skipped[0].reason
            : "No selected layer could be measured.");
        }
      } else {
        var center = null;
        if (origin === "comp") {
          center = [comp.width / 2, comp.height / 2, 0];
        } else if (origin === "last") {
          // AE reports the selection in timeline order, so "last" is the
          // bottom-most selected layer.
          var lastLayer = layers[layers.length - 1];
          center = layerPoint(lastLayer, t);
          if (!center) skipped.push({ name: lastLayer.name, reason: "Could not measure this layer's position." });
        } else {
          var box = null;
          for (i = 0; i < layers.length; i++) {
            var b = layerBounds(layers[i], t);
            if (b) box = unionBounds(box, b);
            else skipped.push({ name: layers[i].name, reason: "No visible bounds to include." });
          }
          if (box) center = boundsCenter(box);
        }
        if (!center) {
          center = [comp.width / 2, comp.height / 2, 0];
          ctx.warnings.push("Could not measure the selection; the null was placed at the center of the composition.");
        }
        plans.push({
          name: origin === "comp" ? "Null" : layers[layers.length - 1].name + " Null",
          point: center,
          before: layers.length ? topMost(layers) : null,
          children: layers,
          inherit: layers.length ? sharedParent(layers) : null,
          span: matchInOut && layers.length ? spanOf(layers) : null
        });
      }

      // ---- write -----------------------------------------------------------
      var created = [];
      var names = [];
      var parented = 0;

      for (i = 0; i < plans.length; i++) {
        var nul = createNull(comp, plans[i], threeD);
        created.push(nul);
        names.push(nul.name);

        if (!doParent) continue;
        var children = plans[i].children;
        for (var c = 0; c < children.length; c++) {
          if (children[c].locked) {
            skipped.push({ name: children[c].name, reason: "Layer is locked." });
            continue;
          }
          try {
            children[c].parent = nul;
            parented++;
          } catch (e) {
            skipped.push({ name: children[c].name, reason: "Could not be parented to the null." });
          }
        }
      }

      // The new nulls become the selection, so they can be moved or keyed
      // straight away, as after any other layer-creating command in AE.
      for (i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
      for (i = 0; i < created.length; i++) created[i].selected = true;

      // ---- notes -----------------------------------------------------------
      if (missing3D) {
        ctx.warnings.push("The selection contains 3D layers. Turn on 3D so the null can control them in 3D space.");
      }
      if (mixedParents) {
        ctx.warnings.push("The selected layers had different parents; they all follow the null now.");
      }
      if (skipped.length) {
        ctx.warnings.push("Skipped " + skipped.length + " layer(s): " + skipped[0].name + " - " + skipped[0].reason);
      }

      return { created: created.length, parented: parented, names: names, skipped: skipped };
    }
  });
})($.global.Flow);
