// Physics page.
//
// After Effects cannot simulate anything itself, so the panel runs the physics
// engine and this module only does the two ends of it:
//
//   physics.read   what the simulation starts from: the composition, and for
//                  every layer that takes part its anchor, position, scale,
//                  rotation, bounds, the velocity it already has, and - when it
//                  is animated - where it is on every frame of the run
//   physics.bake   writes the recorded motion back as Position and Rotation
//                  keyframes in one undo step: one key per frame, or the few
//                  editable keys the panel fitted, with their eases and handles
//   physics.clear  removes those keys again
//   physics.save   stores a layer's physics settings
//   physics.addForce / physics.removeForce
//                  a force (wind, turbulence, vortex, magnet) lives on a null:
//                  its settings in the null's comment, its place the null's
//
// Settings live in the layer's own comment, on one line starting with TAG, so
// they travel with the project and survive duplicating the layer. The rest of
// the comment is the user's and is left exactly as it was. This module never
// parses the settings: it hands the text to the panel, which owns the format.
//
// Version 1 is 2D only, in composition space. A 3D or parented layer is still
// listed, with the reason it cannot take part, so nobody wonders where it went.

(function (Flow) {
  if (!Flow) return;

  var TAG = "flow-physics:";
  var FROM = ["workArea", "playhead"];
  // More frames than this is almost certainly a mistake (a 10-minute work
  // area) and would take After Effects a long time to sample and write.
  var MAX_FRAMES = 3000;

  // ------------------------------------------------------------ lookups

  function compById(id) {
    for (var i = 1; i <= app.project.numItems; i++) {
      var item = app.project.item(i);
      if (item && item instanceof CompItem && item.id === id) return item;
    }
    return null;
  }

  function layerById(comp, id) {
    for (var i = 1; i <= comp.numLayers; i++) {
      var layer = comp.layer(i);
      if (layer.id === id) return layer;
    }
    return null;
  }

  function transformOf(layer) {
    return layer.property("ADBE Transform Group");
  }

  // ------------------------------------------------------------ settings tag

  function splitLines(text) {
    return String(text || "").split(/\r\n|\r|\n/);
  }

  function readTag(layer) {
    var lines = splitLines(layer.comment);
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].substring(0, TAG.length) === TAG) return lines[i].substring(TAG.length);
    }
    return null;
  }

  // Replaces Flow's line and keeps every other line of the comment as it was.
  function writeTag(layer, tag) {
    var lines = splitLines(layer.comment);
    var kept = [];
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].substring(0, TAG.length) !== TAG) kept.push(lines[i]);
    }
    while (kept.length && kept[kept.length - 1] === "") kept.pop();
    if (tag !== null) kept.push(TAG + tag);
    layer.comment = kept.join("\r");
  }

  // ------------------------------------------------------------ reading

  function positionAt(tr, t) {
    var pos = tr.property("ADBE Position");
    if (pos.dimensionsSeparated) {
      return [tr.property("ADBE Position_0").valueAtTime(t, false), tr.property("ADBE Position_1").valueAtTime(t, false)];
    }
    var v = pos.valueAtTime(t, false);
    return [v[0], v[1]];
  }

  function isAnimated(prop) {
    return prop.numKeys > 0 || Flow.hasActiveExpression(prop);
  }

  function positionAnimated(tr) {
    var pos = tr.property("ADBE Position");
    if (pos.dimensionsSeparated) return isAnimated(tr.property("ADBE Position_0")) || isAnimated(tr.property("ADBE Position_1"));
    return isAnimated(pos);
  }

  function positionHasExpression(tr) {
    var pos = tr.property("ADBE Position");
    if (pos.dimensionsSeparated) {
      return Flow.hasActiveExpression(tr.property("ADBE Position_0")) || Flow.hasActiveExpression(tr.property("ADBE Position_1"));
    }
    return Flow.hasActiveExpression(pos);
  }

  // True when a shape layer is drawn by a single ellipse, so it can collide as
  // a circle rather than as the box around it. Anything unexpected - another
  // path, a repeater, a property that will not answer - means "not a circle".
  function isEllipseLayer(layer) {
    if (!(layer instanceof ShapeLayer)) return false;
    var found = { ellipses: 0, others: 0 };
    function walk(group) {
      for (var i = 1; i <= group.numProperties; i++) {
        var p = group.property(i);
        var mn = p.matchName;
        if (mn === "ADBE Vector Shape - Ellipse") found.ellipses++;
        else if (mn === "ADBE Vector Shape - Rect" || mn === "ADBE Vector Shape - Star" ||
          mn === "ADBE Vector Shape - Group" || mn === "ADBE Vector Filter - Repeater") found.others++;
        else if (mn === "ADBE Vector Group" || mn === "ADBE Vectors Group") walk(p);
      }
    }
    try {
      walk(layer.property("ADBE Root Vectors Group"));
    } catch (e) {
      return false;
    }
    return found.ellipses === 1 && found.others === 0;
  }

  // A null has no picture, so it never collides; it can carry a force.
  function isNull(layer) {
    return Flow.isVisualLayer(layer) && layer.nullLayer === true;
  }

  // Why a layer cannot take part as a body, or "" when it can.
  function unusableReason(layer) {
    if (!Flow.isVisualLayer(layer) || !layer.hasVideo || isNull(layer)) return "Has no picture to collide with";
    return placementReason(layer);
  }

  // Why the layer's place cannot be read in composition space, or "".
  function placementReason(layer) {
    if (layer.threeDLayer) return "3D layers are not supported yet";
    if (layer.parent) return "Parented layers are not supported yet";
    return "";
  }

  // Where the layer is on every frame of the run, when it is animated.
  function pathOf(tr, start, dt, frames) {
    var rotProp = tr.property("ADBE Rotate Z");
    if (!positionAnimated(tr) && !isAnimated(rotProp)) return undefined;
    var path = [];
    for (var f = 0; f < frames; f++) {
      var t = start + f * dt;
      var p = positionAt(tr, t);
      path.push([p[0], p[1], rotProp.valueAtTime(t, false)]);
    }
    return path;
  }

  // A null carries a force (the panel tells which from its settings): its
  // place, its turn, and its path when it is animated. It is still listed with
  // the reason it cannot collide, so it never becomes a body.
  function readNull(comp, layer, out, start, frames) {
    out.isNull = true;
    // Forces act between the null's in and out points.
    out.inFrame = (layer.inPoint - start) / comp.frameDuration;
    out.outFrame = (layer.outPoint - start) / comp.frameDuration;
    var placement = placementReason(layer);
    if (placement) {
      out.forceReason = placement;
      return out;
    }
    var tr = transformOf(layer);
    out.position = positionAt(tr, start);
    out.rotation = tr.property("ADBE Rotate Z").valueAtTime(start, false);
    out.expression = positionHasExpression(tr) || Flow.hasActiveExpression(tr.property("ADBE Rotate Z"));
    var path = pathOf(tr, start, comp.frameDuration, frames);
    if (path) out.path = path;
    return out;
  }

  function readLayer(comp, layer, start, frames) {
    var reason = unusableReason(layer);
    var out = {
      id: layer.id,
      index: layer.index,
      name: layer.name,
      selected: layer.selected,
      reason: reason,
      tag: readTag(layer)
    };
    if (isNull(layer)) return readNull(comp, layer, out, start, frames);
    if (reason) return out;

    var tr = transformOf(layer);
    var dt = comp.frameDuration;
    var rotProp = tr.property("ADBE Rotate Z");
    var anchor = tr.property("ADBE Anchor Point").valueAtTime(start, false);
    var scale = tr.property("ADBE Scale").valueAtTime(start, false);
    var rect;
    try {
      rect = layer.sourceRectAtTime(start, true);
    } catch (e) {
      rect = null;
    }
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      out.reason = "Is empty at the start of the simulation";
      return out;
    }

    var pos = positionAt(tr, start);
    var rot = rotProp.valueAtTime(start, false);
    var posAnimated = positionAnimated(tr);
    var rotAnimated = isAnimated(rotProp);

    out.anchor = [anchor[0], anchor[1]];
    out.position = pos;
    out.scale = [scale[0], scale[1]];
    out.rotation = rot;
    out.rect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    out.ellipse = isEllipseLayer(layer);
    out.separated = tr.property("ADBE Position").dimensionsSeparated;
    out.expression = positionHasExpression(tr) || Flow.hasActiveExpression(rotProp);

    // The motion the layer already has as the simulation takes over, so a
    // layer animated up to that point is thrown rather than dropped.
    out.velocity = [0, 0];
    out.spin = 0;
    if (start - dt >= 0) {
      if (posAnimated) {
        var before = positionAt(tr, start - dt);
        out.velocity = [(pos[0] - before[0]) / dt, (pos[1] - before[1]) / dt];
      }
      if (rotAnimated) out.spin = (rot - rotProp.valueAtTime(start - dt, false)) / dt;
    }

    // Where an animated layer is on every frame, so it can push the others
    // (or pull them, as a magnet) along its own path.
    var path = pathOf(tr, start, dt, frames);
    if (path) out.path = path;
    return out;
  }

  Flow.register("physics.read", {
    undo: null,
    run: function (params) {
      var from = Flow.oneOf(params, "from", FROM);
      var comp = Flow.requireComp();
      var dt = comp.frameDuration;
      var end = comp.workAreaStart + comp.workAreaDuration;
      var start = from === "playhead" ? comp.time : comp.workAreaStart;
      // Snap to a frame, so the keys land exactly on frames.
      start = Math.round(start / dt) * dt;
      if (start >= end - dt / 2) {
        throw Flow.error("INVALID_PARAMS", "The playhead is past the end of the work area. Move it back or start from the work area.");
      }
      var frames = Math.floor((end - start) / dt + 0.5);
      if (frames > MAX_FRAMES) {
        throw Flow.error("INVALID_PARAMS", "The work area is " + frames + " frames long. Shorten it to " + MAX_FRAMES + " frames or fewer.");
      }

      var layers = [];
      for (var i = 1; i <= comp.numLayers; i++) {
        var layer = comp.layer(i);
        if (!layer.selected && readTag(layer) === null) continue;
        layers.push(readLayer(comp, layer, start, frames));
      }

      return {
        compId: comp.id,
        compName: comp.name,
        width: comp.width,
        height: comp.height,
        fps: comp.frameRate,
        start: start,
        frames: frames,
        layers: layers
      };
    }
  });

  // ------------------------------------------------------------ settings

  Flow.register("physics.save", {
    undo: "Physics Settings",
    run: function (params) {
      var comp = compById(Flow.num(params, "compId", -1));
      if (!comp) throw Flow.error("NOT_FOUND", "The composition is gone. Press Refresh.");
      var layer = layerById(comp, Flow.num(params, "layerId", -1));
      if (!layer) throw Flow.error("NOT_FOUND", "That layer is gone. Press Refresh.");
      var tag = params.tag === null ? null : Flow.str(params, "tag", "", 2000);
      if (tag !== null && /[\r\n]/.test(tag)) throw Flow.error("INVALID_PARAMS", "Settings must be one line.");

      var wasLocked = layer.locked;
      if (wasLocked) layer.locked = false;
      try {
        writeTag(layer, tag);
      } finally {
        if (wasLocked) layer.locked = true;
      }
      return { saved: true };
    }
  });

  // ------------------------------------------------------------ forces

  // A force is a null with the force's settings in its comment: move or
  // animate the null and the force goes with it; turn it and a wind turns.
  var FORCE_NAMES = { wind: "Wind", turbulence: "Turbulence", vortex: "Vortex", magnet: "Magnet", burst: "Burst" };
  var NULL_SIZE = 100;

  Flow.register("physics.addForce", {
    undo: "Add Physics Force",
    run: function (params) {
      var comp = compById(Flow.num(params, "compId", -1));
      if (!comp) throw Flow.error("NOT_FOUND", "The composition is gone. Press Refresh.");
      var kind = Flow.oneOf(params, "kind", ["wind", "turbulence", "vortex", "magnet", "burst"]);
      var tag = Flow.str(params, "tag", "", 2000);
      if (/[\r\n]/.test(tag)) throw Flow.error("INVALID_PARAMS", "Settings must be one line.");

      // Named before the null exists, so AE's own "Null 1" is not in the way.
      var name = Flow.uniqueLayerName(comp, FORCE_NAMES[kind]);
      var nul = comp.layers.addNull(comp.duration);
      nul.name = name;
      // A Burst goes off at its in point: at the playhead, to start with.
      if (kind === "burst" && comp.time > nul.inPoint && comp.time < nul.outPoint) nul.inPoint = comp.time;
      var tr = transformOf(nul);
      // The anchor in the middle of the null's square, so it turns about its centre.
      var w = nul.width || NULL_SIZE;
      var h = nul.height || NULL_SIZE;
      tr.property("ADBE Anchor Point").setValue([w / 2, h / 2]);
      tr.property("ADBE Position").setValue([comp.width / 2, comp.height / 2]);
      writeTag(nul, tag);
      return { id: nul.id, name: name };
    }
  });

  Flow.register("physics.removeForce", {
    undo: "Remove Physics Force",
    run: function (params) {
      var comp = compById(Flow.num(params, "compId", -1));
      if (!comp) throw Flow.error("NOT_FOUND", "The composition is gone. Press Refresh.");
      var layer = layerById(comp, Flow.num(params, "layerId", -1));
      if (!layer) throw Flow.error("NOT_FOUND", "That force is gone. Press Refresh.");
      if (!isNull(layer)) throw Flow.error("INVALID_PARAMS", layer.name + " is not a force null.");
      var name = layer.name;
      if (layer.locked) layer.locked = false;
      layer.remove();
      return { name: name };
    }
  });

  // ------------------------------------------------------------ exact shapes

  // A layer that collides on its real outline - a star's points, the letters of
  // a word - is rendered on its own and the panel traces the picture. Any kind
  // of layer works that way (shapes, text, images with transparency, precomps),
  // where reading vector paths would only cover shape layers.
  //
  // The layer is copied into a temporary composition with its transform undone,
  // so the picture is in the layer's own space: rotation and scale are applied
  // by the simulation. The composition is removed again straight away.
  var TRACE_MAX = 512;
  var TRACE_PAD = 4;
  var TRACE_TIMEOUT = 20000;
  var TRACE_POLL = 40;
  var traceSeq = 0;

  // Leaves one plain value on a property: no keys, no expression.
  function flatten(prop, value) {
    if (!prop) return;
    if (prop.canSetExpression && prop.expression !== "") prop.expression = "";
    while (prop.numKeys > 0) prop.removeKey(prop.numKeys);
    prop.setValue(value);
  }

  function traceLayer(comp, layer, t) {
    var rect = layer.sourceRectAtTime(t, true);
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    var k = Math.min(1, TRACE_MAX / Math.max(rect.width, rect.height));
    var w = Math.max(4, Math.ceil(rect.width * k) + 2 * TRACE_PAD);
    var h = Math.max(4, Math.ceil(rect.height * k) + 2 * TRACE_PAD);

    var temp = app.project.items.addComp("Flow physics trace", w, h, 1, comp.duration, comp.frameRate);
    try {
      layer.copyToComp(temp);
      var copy = temp.layer(1);
      // A copy of a locked layer is locked too, and would refuse every change.
      if (copy.locked) copy.locked = false;
      if (copy.parent) copy.parent = null;
      copy.enabled = true;
      var tr = transformOf(copy);
      var anchorProp = tr.property("ADBE Anchor Point");
      var anchor = anchorProp.valueAtTime(t, false);
      var pos = tr.property("ADBE Position");
      if (pos.dimensionsSeparated) pos.dimensionsSeparated = false;
      flatten(anchorProp, [anchor[0], anchor[1]]);
      flatten(tr.property("ADBE Scale"), [100 * k, 100 * k]);
      flatten(tr.property("ADBE Rotate Z"), 0);
      flatten(tr.property("ADBE Opacity"), 100);
      // Puts the rect's top-left corner TRACE_PAD pixels in from the corner.
      flatten(pos, [TRACE_PAD - (rect.left - anchor[0]) * k, TRACE_PAD - (rect.top - anchor[1]) * k]);

      traceSeq++;
      var path = Folder.temp.fsName + "/flow-physics-" + layer.id + "-" + (new Date()).getTime() + "-" + traceSeq + ".png";
      temp.saveFrameToPng(t, new File(path));
      if (!Flow.waitForPng(path, TRACE_TIMEOUT, TRACE_POLL)) return null;
      // A pixel (u, v) of the picture is the layer point (left + u / k, top + v / k).
      return {
        id: layer.id,
        path: String(new File(path).fsName),
        scale: k,
        left: rect.left - TRACE_PAD / k,
        top: rect.top - TRACE_PAD / k
      };
    } finally {
      temp.remove();
    }
  }

  Flow.register("physics.trace", {
    // Nothing is left behind, but the temporary composition is still a change
    // to the project, and this keeps it to a single step in Edit > Undo.
    undo: "Trace Physics Shapes",
    run: function (params, ctx) {
      var comp = compById(Flow.num(params, "compId", -1));
      if (!comp) throw Flow.error("NOT_FOUND", "The composition is gone. Press Refresh.");
      if (typeof comp.saveFrameToPng !== "function") {
        throw Flow.error("UNSUPPORTED", "This version of After Effects cannot render a layer for Flow to trace.");
      }
      var t = Flow.num(params, "time", 0);
      var ids = params.layerIds;
      if (!(ids instanceof Array)) throw Flow.error("INVALID_PARAMS", "Parameter 'layerIds' must be a list.");

      var shapes = [];
      for (var i = 0; i < ids.length; i++) {
        var layer = layerById(comp, ids[i]);
        if (!layer || unusableReason(layer)) continue;
        var shape = traceLayer(comp, layer, t);
        if (shape) shapes.push(shape);
        else ctx.warnings.push(layer.name + " could not be traced, so it collides as a box.");
      }
      return { shapes: shapes };
    }
  });

  // ------------------------------------------------------------ baking

  function removeKeysBetween(prop, t0, t1) {
    for (var k = prop.numKeys; k >= 1; k--) {
      var t = prop.keyTime(k);
      if (t >= t0 && t <= t1) prop.removeKey(k);
    }
  }

  // ------------------------------------------------------------ on top of the animation
  //
  // A layered bake never touches the layer's own keys. The simulation goes on
  // three effects instead - Physics Offset (how far it is from its animation),
  // Physics Spin, and Physics Influence, a slider that mixes it in - and a short
  // expression on Position and Rotation adds them to whatever the keys say.
  // Keyframe the slider to fade the physics in and out.

  var INFLUENCE_FX = "Physics Influence";
  var OFFSET_FX = "Physics Offset";
  var SPIN_FX = "Physics Spin";
  var LAYERED_FX = [
    { name: INFLUENCE_FX, matchName: "ADBE Slider Control" },
    { name: OFFSET_FX, matchName: "ADBE Point Control" },
    { name: SPIN_FX, matchName: "ADBE Angle Control" }
  ];
  // Every expression Flow writes starts with this line, so Flow knows its own.
  var EXPR_TAG = "// Flow physics";
  var MIX = "(effect(\"" + INFLUENCE_FX + "\")(1) / 100)";

  function effectsOf(layer) {
    return layer.property("ADBE Effect Parade");
  }

  function findEffect(layer, def) {
    var parade = effectsOf(layer);
    if (!parade) return null;
    for (var i = 1; i <= parade.numProperties; i++) {
      var fx = parade.property(i);
      if (fx.name === def.name && fx.matchName === def.matchName) return fx;
    }
    return null;
  }

  function isLayered(layer) {
    return findEffect(layer, LAYERED_FX[1]) !== null;
  }

  // Adds whichever of the three effects is missing. Adding an effect can
  // invalidate references to the others, so they are always found afresh.
  function ensureEffects(layer) {
    for (var i = 0; i < LAYERED_FX.length; i++) {
      if (findEffect(layer, LAYERED_FX[i])) continue;
      var fx = effectsOf(layer).addProperty(LAYERED_FX[i].matchName);
      fx.name = LAYERED_FX[i].name;
      if (LAYERED_FX[i].name === INFLUENCE_FX) fx.property(1).setValue(100);
      else if (LAYERED_FX[i].name === OFFSET_FX) fx.property(1).setValue([0, 0]);
      else fx.property(1).setValue(0);
    }
  }

  function removeEffects(layer) {
    for (var i = 0; i < LAYERED_FX.length; i++) {
      var fx = findEffect(layer, LAYERED_FX[i]);
      if (fx) fx.remove();
    }
  }

  function isFlowExpression(prop) {
    return prop.expression.substring(0, EXPR_TAG.length) === EXPR_TAG;
  }

  // The properties that carry the animation: X and Y, or Position, plus Rotation.
  function motionProps(layer) {
    var tr = transformOf(layer);
    var pos = tr.property("ADBE Position");
    var list = pos.dimensionsSeparated
      ? [{ prop: tr.property("ADBE Position_0"), kind: "x" }, { prop: tr.property("ADBE Position_1"), kind: "y" }]
      : [{ prop: pos, kind: "pos" }];
    list.push({ prop: tr.property("ADBE Rotate Z"), kind: "rot" });
    return list;
  }

  // The name of a property whose own expression a layered bake would replace, or "".
  function userExpression(layer) {
    var list = motionProps(layer);
    for (var i = 0; i < list.length; i++) {
      var prop = list[i].prop;
      if (prop.expression !== "" && !isFlowExpression(prop)) return list[i].prop.name;
    }
    return "";
  }

  function expressionFor(kind) {
    var offset = "effect(\"" + OFFSET_FX + "\")(1)";
    var body;
    if (kind === "pos") {
      // One number at a time: the JavaScript expression engine has no maths on whole arrays.
      body = "var o = " + offset + ";\rvar m = " + MIX + ";\r[value[0] + o[0] * m, value[1] + o[1] * m].concat(value.slice(2))";
    } else if (kind === "x") {
      body = "value + " + offset + "[0] * " + MIX;
    } else if (kind === "y") {
      body = "value + " + offset + "[1] * " + MIX;
    } else {
      body = "value + effect(\"" + SPIN_FX + "\")(1) * " + MIX;
    }
    return EXPR_TAG + ": your keyframes plus the simulation, mixed by " + INFLUENCE_FX + "\r" + body;
  }

  function setExpressions(layer) {
    var list = motionProps(layer);
    for (var i = 0; i < list.length; i++) {
      list[i].prop.expression = expressionFor(list[i].kind);
      list[i].prop.expressionEnabled = true;
    }
  }

  function removeExpressions(layer) {
    var list = motionProps(layer);
    for (var i = 0; i < list.length; i++) {
      if (list[i].prop.expression !== "" && isFlowExpression(list[i].prop)) list[i].prop.expression = "";
    }
  }

  // The offset and spin a layered bake writes to, in the same shape as targetsOf.
  function layeredTargets(layer) {
    return {
      pos: findEffect(layer, LAYERED_FX[1]).property(1),
      rot: findEffect(layer, LAYERED_FX[2]).property(1)
    };
  }

  // The properties a baked layer writes to: X and Y, or Position, plus Rotation.
  function targetsOf(layer) {
    var tr = transformOf(layer);
    var pos = tr.property("ADBE Position");
    return pos.dimensionsSeparated
      ? { x: tr.property("ADBE Position_0"), y: tr.property("ADBE Position_1"), rot: tr.property("ADBE Rotate Z") }
      : { pos: pos, rot: tr.property("ADBE Rotate Z") };
  }

  function clearRange(targets, t0, t1) {
    if (targets.pos) removeKeysBetween(targets.pos, t0, t1);
    else {
      removeKeysBetween(targets.x, t0, t1);
      removeKeysBetween(targets.y, t0, t1);
    }
    removeKeysBetween(targets.rot, t0, t1);
  }

  function isNumberList(list, length) {
    if (!(list instanceof Array) || list.length !== length) return false;
    for (var i = 0; i < list.length; i++) {
      if (typeof list[i] !== "number" || !isFinite(list[i])) return false;
    }
    return true;
  }

  // Editable keys: on whole frames of the run, in order, each value and speed
  // with one number per dimension.
  function isKeyList(list, dims, frames) {
    if (!(list instanceof Array) || !list.length) return false;
    var last = -1;
    for (var i = 0; i < list.length; i++) {
      var key = list[i];
      if (!key || typeof key.frame !== "number" || Math.floor(key.frame) !== key.frame) return false;
      if (key.frame <= last || key.frame >= frames) return false;
      if (!isNumberList(key.value, dims) || !isNumberList(key.speedIn, dims) || !isNumberList(key.speedOut, dims)) return false;
      if (typeof key.smooth !== "boolean") return false;
      last = key.frame;
    }
    return true;
  }

  // Handles one third of the way along, so the curve is the one the panel fitted.
  var INFLUENCE = 100 / 3;

  function length2(v) {
    return Math.sqrt(v[0] * v[0] + v[1] * v[1]);
  }

  // Writes editable keys to one property. `dim` picks the dimension for a
  // one-dimensional property (Rotation, X or Y); -1 writes the [x, y] pairs to
  // an unseparated Position, a motion path with spatial handles.
  function writeKeys(prop, keys, start, dt, dim) {
    var pair = dim < 0;
    // Position has a motion path; a two-dimensional property without one eases X and Y apart.
    var spatial = pair && prop.isSpatial !== false;
    var times = [];
    var values = [];
    var i;
    for (i = 0; i < keys.length; i++) {
      times.push(start + keys[i].frame * dt);
      values.push(pair ? [keys[i].value[0], keys[i].value[1]] : keys[i].value[dim]);
    }
    prop.setValuesAtTimes(times, values);

    var BEZIER = KeyframeInterpolationType.BEZIER;
    for (i = 0; i < keys.length; i++) {
      var key = keys[i];
      var k = prop.nearestKeyIndex(times[i]);
      // Seconds to the previous and next key; an end key borrows its one neighbour.
      var before = i > 0 ? (key.frame - keys[i - 1].frame) * dt : 0;
      var after = i + 1 < keys.length ? (keys[i + 1].frame - key.frame) * dt : before;
      if (!before) before = after;

      prop.setInterpolationTypeAtKey(k, BEZIER, BEZIER);
      prop.setTemporalAutoBezierAtKey(k, false);
      prop.setTemporalContinuousAtKey(k, key.smooth);
      if (spatial) {
        prop.setSpatialAutoBezierAtKey(k, false);
        prop.setSpatialContinuousAtKey(k, key.smooth);
        // A handle is a third of the way along the speed, towards its neighbour.
        var size = prop.keyInSpatialTangent(k).length;
        var inTan = [-key.speedIn[0] * before / 3, -key.speedIn[1] * before / 3];
        var outTan = [key.speedOut[0] * after / 3, key.speedOut[1] * after / 3];
        while (inTan.length < size) {
          inTan.push(0);
          outTan.push(0);
        }
        prop.setSpatialTangentsAtKey(k, inTan, outTan);
        prop.setTemporalEaseAtKey(k, [new KeyframeEase(length2(key.speedIn), INFLUENCE)],
          [new KeyframeEase(length2(key.speedOut), INFLUENCE)]);
      } else if (pair) {
        prop.setTemporalEaseAtKey(k,
          [new KeyframeEase(key.speedIn[0], INFLUENCE), new KeyframeEase(key.speedIn[1], INFLUENCE)],
          [new KeyframeEase(key.speedOut[0], INFLUENCE), new KeyframeEase(key.speedOut[1], INFLUENCE)]);
      } else {
        prop.setTemporalEaseAtKey(k, [new KeyframeEase(key.speedIn[dim], INFLUENCE)],
          [new KeyframeEase(key.speedOut[dim], INFLUENCE)]);
      }
    }
    return keys.length;
  }

  // Finds every layer and checks every number before anything is written, so
  // a bad request changes nothing at all.
  function planBake(params) {
    var comp = compById(Flow.num(params, "compId", -1));
    if (!comp) throw Flow.error("NOT_FOUND", "The composition is gone. Press Refresh.");
    var start = Flow.num(params, "start", 0);
    var frames = Flow.num(params, "frames", 0);
    if (frames < 1 || frames > MAX_FRAMES || Math.floor(frames) !== frames) {
      throw Flow.error("INVALID_PARAMS", "Nothing to bake.");
    }
    var list = params.layers;
    if (!(list instanceof Array) || !list.length) throw Flow.error("INVALID_PARAMS", "Nothing to bake.");

    var plan = [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      var layer = layerById(comp, entry.id);
      if (!layer) throw Flow.error("NOT_FOUND", "A layer is gone. Press Refresh.");
      if (unusableReason(layer)) throw Flow.error("INVALID_PARAMS", layer.name + ": " + unusableReason(layer));
      var editable = entry.positionKeys !== undefined;
      if (editable
        ? !isKeyList(entry.positionKeys, 2, frames) || !isKeyList(entry.rotationKeys, 1, frames)
        : !isNumberList(entry.x, frames) || !isNumberList(entry.y, frames) || !isNumberList(entry.rotation, frames)) {
        throw Flow.error("INVALID_PARAMS", "The recording for " + layer.name + " is incomplete.");
      }
      if (entry.tag !== undefined && (typeof entry.tag !== "string" || entry.tag.length > 2000 || /[\r\n]/.test(entry.tag))) {
        throw Flow.error("INVALID_PARAMS", "The settings for " + layer.name + " are not valid.");
      }
      plan.push({ layer: layer, entry: entry });
    }
    return { comp: comp, start: start, frames: frames, plan: plan, editable: editable, layered: params.layered === true };
  }

  Flow.register("physics.bake", {
    undo: "Bake Physics",
    run: function (params, ctx) {
      var job = planBake(params);
      var dt = job.comp.frameDuration;
      var t0 = job.start - dt / 2;
      var t1 = job.start + (job.frames - 1) * dt + dt / 2;
      var times = [];
      for (var f = 0; f < job.frames; f++) times.push(job.start + f * dt);
      var written = 0;
      var baked = 0;

      for (var i = 0; i < job.plan.length; i++) {
        var layer = job.plan[i].layer;
        var entry = job.plan[i].entry;
        var wasLocked = layer.locked;
        if (wasLocked) layer.locked = false;
        try {
          if (job.layered) {
            var conflict = userExpression(layer);
            if (conflict) {
              ctx.warnings.push(layer.name + " was skipped: its " + conflict + " has an expression of its own, which a layered bake would replace.");
              continue;
            }
            ensureEffects(layer);
            setExpressions(layer);
          }
          var targets = job.layered ? layeredTargets(layer) : targetsOf(layer);
          clearRange(targets, t0, t1);
          if (entry.positionKeys !== undefined) {
            if (targets.pos) written += writeKeys(targets.pos, entry.positionKeys, job.start, dt, -1);
            else {
              written += writeKeys(targets.x, entry.positionKeys, job.start, dt, 0);
              writeKeys(targets.y, entry.positionKeys, job.start, dt, 1);
            }
            written += writeKeys(targets.rot, entry.rotationKeys, job.start, dt, 0);
          } else {
            if (targets.pos) {
              var values = [];
              for (f = 0; f < job.frames; f++) values.push([entry.x[f], entry.y[f]]);
              targets.pos.setValuesAtTimes(times, values);
            } else {
              targets.x.setValuesAtTimes(times, entry.x);
              targets.y.setValuesAtTimes(times, entry.y);
            }
            targets.rot.setValuesAtTimes(times, entry.rotation);
          }
          if (typeof entry.tag === "string") writeTag(layer, entry.tag);
          baked++;
          if (!job.layered && (positionHasExpression(transformOf(layer)) || Flow.hasActiveExpression(targets.rot))) {
            ctx.warnings.push(layer.name + " has an expression on Position or Rotation, which still overrides the baked keys.");
          }
        } finally {
          if (wasLocked) layer.locked = true;
        }
      }
      return { layers: baked, keys: job.editable ? written : job.frames };
    }
  });

  Flow.register("physics.clear", {
    undo: "Remove Physics Keys",
    run: function (params) {
      var comp = compById(Flow.num(params, "compId", -1));
      if (!comp) throw Flow.error("NOT_FOUND", "The composition is gone. Press Refresh.");
      var start = Flow.num(params, "start", 0);
      var frames = Flow.num(params, "frames", 0);
      var ids = params.layerIds;
      if (!(ids instanceof Array)) throw Flow.error("INVALID_PARAMS", "Parameter 'layerIds' must be a list.");
      var dt = comp.frameDuration;
      var t0 = start - dt / 2;
      var t1 = start + (frames - 1) * dt + dt / 2;

      var layers = [];
      for (var i = 0; i < ids.length; i++) {
        var layer = layerById(comp, ids[i]);
        if (layer && !unusableReason(layer)) layers.push(layer);
      }
      for (i = 0; i < layers.length; i++) {
        var wasLocked = layers[i].locked;
        if (wasLocked) layers[i].locked = false;
        try {
          if (isLayered(layers[i])) {
            removeExpressions(layers[i]);
            removeEffects(layers[i]);
          } else {
            clearRange(targetsOf(layers[i]), t0, t1);
          }
        } finally {
          if (wasLocked) layers[i].locked = true;
        }
      }
      return { layers: layers.length };
    }
  });
})($.global.Flow);
