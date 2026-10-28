// Expression Control tool.
//
// Applies the expressions motion designers retype all day, and lets them
// stack: a loop and a wiggle live in one expression, and re-applying one of
// them rewrites only its own line.
//
// Flow writes a structured expression it can read back:
//
//   // Flow
//   var v = loopOut("cycle"); // flow:loop
//   v += wiggle(2, 30) - value; // flow:wiggle
//   v
//
// The base line is "var v = value;" when there is no loop. A wiggle is added
// as an offset (wiggle(...) - value) rather than a replacement, which is the
// idiomatic way to lay a wiggle over another expression. Each part is found
// by its marker comment, so replacing one never disturbs the other.
//
// Expressions Flow wrote before it could stack (a bare loopOut or wiggle
// call) are still recognised and converted on the next apply.
//
// Anything else is the user's own work: Flow reports overwriting it, and
// removal never touches it.

(function (Flow) {
  if (!Flow) return;

  var LOOP_TYPES = ["cycle", "pingpong", "offset", "continue"];
  var WIGGLE_TARGETS = ["position", "rotation", "scale", "selected"];
  var PARTS = ["loop", "wiggle", "all"];
  var LOOP_CALLS = ["loopIn", "loopOut", "loopInDuration", "loopOutDuration"];

  var HEADER = "// Flow";
  var MARK = "// flow:";
  var BASE = "var v = value;";

  var SPEED_CONTROL = "Wiggle Speed";
  var RANGE_CONTROL = "Wiggle Range";
  var MAX_DEPTH = 12;

  // ------------------------------------------------------------ small utils

  function trim(s) {
    return String(s).replace(/^\s+/, "").replace(/\s+$/, "");
  }

  function stripSemicolons(s) {
    return trim(trim(s).replace(/;+$/, ""));
  }

  // True only when the text is a single complete call to one of `names`, so a
  // call used as one term of a larger expression is never mistaken for one
  // Flow wrote.
  function isSingleCall(text, names) {
    var s = stripSemicolons(text);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (s.substring(0, name.length + 1) !== name + "(") continue;
      if (s.charAt(s.length - 1) !== ")") return false;
      var depth = 0;
      for (var c = name.length; c < s.length; c++) {
        var ch = s.charAt(c);
        if (ch === "(") {
          depth++;
        } else if (ch === ")") {
          depth--;
          // The call closed before the end, so real code follows it.
          if (depth === 0 && c !== s.length - 1) return false;
        }
      }
      return depth === 0;
    }
    return false;
  }

  function layerOf(prop) {
    return prop.propertyGroup(prop.propertyDepth);
  }

  function propertyLabel(prop) {
    return layerOf(prop).name + " > " + prop.name;
  }

  function pushUnique(list, prop) {
    for (var i = 0; i < list.length; i++) if (list[i] === prop) return;
    list.push(prop);
  }

  // ------------------------------------------------------------ expression parts

  function loopLine(call) {
    return "var v = " + call + "; " + MARK + "loop";
  }

  function wiggleLine(call) {
    return "v += " + call + " - value; " + MARK + "wiggle";
  }

  function buildLoopCall(type, keyframes) {
    // "continue" carries on at the last keyframe's velocity; it takes no count.
    if (type === "continue") return "loopOut(\"continue\")";
    if (keyframes > 0) return "loopOut(\"" + type + "\", " + keyframes + ")";
    return "loopOut(\"" + type + "\")";
  }

  function buildWiggleCall(speed, range, sliders) {
    if (sliders) {
      return "wiggle(effect(\"" + SPEED_CONTROL + "\")(\"Slider\"), effect(\"" +
        RANGE_CONTROL + "\")(\"Slider\"))";
    }
    return "wiggle(" + String(speed) + ", " + String(range) + ")";
  }

  // Whole lines are kept rather than the calls inside them, so rewriting one
  // part never has to understand the other.
  function parseParts(text) {
    var parts = { loop: null, wiggle: null, foreign: false };
    var s = trim(text);
    if (s === "") return parts;

    if (s.substring(0, HEADER.length) === HEADER) {
      var lines = s.split("\n");
      for (var i = 0; i < lines.length; i++) {
        var line = trim(lines[i]);
        var at = line.indexOf(MARK);
        if (at < 0) continue;
        var name = trim(line.substring(at + MARK.length));
        if (name === "loop") parts.loop = line;
        else if (name === "wiggle") parts.wiggle = line;
      }
      return parts;
    }

    // Written by an earlier Flow, before expressions could stack.
    var bare = stripSemicolons(s);
    if (isSingleCall(bare, LOOP_CALLS)) {
      parts.loop = loopLine(bare);
      return parts;
    }
    if (isSingleCall(bare, ["wiggle"])) {
      parts.wiggle = wiggleLine(bare);
      return parts;
    }

    parts.foreign = true;
    return parts;
  }

  function hasAnyPart(parts) {
    return !!(parts.loop || parts.wiggle);
  }

  function buildExpression(parts) {
    var lines = [HEADER];
    lines.push(parts.loop || BASE);
    if (parts.wiggle) lines.push(parts.wiggle);
    lines.push("v");
    return lines.join("\n");
  }

  // ------------------------------------------------------------ predicates

  function isRealProperty(prop) {
    if (!prop || prop.propertyType !== PropertyType.PROPERTY) return false;
    if (!prop.canSetExpression) return false;
    var vt = prop.propertyValueType;
    // Markers and value-less rows accept an expression but cannot be driven.
    return vt !== PropertyValueType.NO_VALUE && vt !== PropertyValueType.MARKER;
  }

  function canLoop(prop) {
    return isRealProperty(prop) && prop.numKeys >= 2;
  }

  function partPredicate(kind) {
    return function (prop) {
      if (!isRealProperty(prop)) return false;
      var text = prop.expression || "";
      if (text === "") return false;
      var parts = parseParts(text);
      if (parts.foreign) return false;
      return kind === "all" ? hasAnyPart(parts) : !!parts[kind];
    };
  }

  // ------------------------------------------------------------ collecting

  // Walks a layer or property group. Groups vary by layer type and some throw
  // when read, so every step is guarded rather than assumed.
  function walk(group, out, accept, depth) {
    if (depth > MAX_DEPTH) return;
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
      if (prop.propertyType === PropertyType.PROPERTY) {
        if (accept(prop)) pushUnique(out, prop);
      } else {
        walk(prop, out, accept, depth + 1);
      }
    }
  }

  // Returns { targets, fromSelection }.
  function collect(comp, layers, accept) {
    var targets = [];
    var selected = comp.selectedProperties || [];
    var selectionSize = 0;
    var i;

    for (i = 0; i < selected.length; i++) {
      var picked = selected[i];
      if (!picked) continue;
      selectionSize++;
      if (picked.propertyType === PropertyType.PROPERTY) {
        if (accept(picked)) pushUnique(targets, picked);
      } else {
        // A selected group (Transform, an effect, a shape group) means
        // "everything inside it".
        walk(picked, targets, accept, 0);
      }
    }
    if (selectionSize > 0) return { targets: targets, fromSelection: true };

    for (i = 0; i < layers.length; i++) walk(layers[i], targets, accept, 0);
    return { targets: targets, fromSelection: false };
  }

  function addPositionTargets(layer, out) {
    var tr = layer.property("ADBE Transform Group");
    var pos = tr ? tr.property("ADBE Position") : null;
    if (!pos) return;
    if (!pos.dimensionsSeparated) {
      if (isRealProperty(pos)) pushUnique(out, pos);
      return;
    }
    var names = ["ADBE Position_0", "ADBE Position_1"];
    if (layer.threeDLayer) names.push("ADBE Position_2");
    for (var i = 0; i < names.length; i++) {
      var p = tr.property(names[i]);
      if (p && isRealProperty(p)) pushUnique(out, p);
    }
  }

  function addTransformTarget(layer, target, out) {
    if (target === "position") {
      addPositionTargets(layer, out);
      return;
    }
    var tr = layer.property("ADBE Transform Group");
    if (!tr) return;
    // Z rotation is what "Rotation" means on a 2D layer, and the one people
    // mean on a 3D one.
    var p = tr.property(target === "rotation" ? "ADBE Rotate Z" : "ADBE Scale");
    if (p && isRealProperty(p)) pushUnique(out, p);
  }

  // Wiggle needs no keyframes, so "every animated property" would be the wrong
  // default: it would wiggle anchor points and opacity too. The target is
  // named explicitly, or taken from what is picked in the timeline.
  function collectWiggleTargets(comp, layers, target) {
    var targets = [];
    var i;
    if (target === "selected") {
      var selected = comp.selectedProperties || [];
      for (i = 0; i < selected.length; i++) {
        var picked = selected[i];
        if (picked && picked.propertyType === PropertyType.PROPERTY && isRealProperty(picked)) {
          pushUnique(targets, picked);
        }
      }
      return targets;
    }
    for (i = 0; i < layers.length; i++) addTransformTarget(layers[i], target, targets);
    return targets;
  }

  // Splits off locked layers before anything is written, so a half-applied
  // expression can never be left behind.
  function planWrites(targets, skipped) {
    var writes = [];
    var reported = {};
    for (var i = 0; i < targets.length; i++) {
      var prop = targets[i];
      var layer = layerOf(prop);
      if (layer.locked) {
        if (!reported["n_" + layer.name]) {
          reported["n_" + layer.name] = true;
          skipped.push({ name: layer.name, reason: "Layer is locked." });
        }
        continue;
      }
      writes.push(prop);
    }
    return writes;
  }

  function countLayers(props) {
    var seen = [];
    for (var i = 0; i < props.length; i++) {
      var layer = layerOf(props[i]);
      var known = false;
      for (var j = 0; j < seen.length; j++) if (seen[j] === layer) known = true;
      if (!known) seen.push(layer);
    }
    return seen.length;
  }

  // Rewrites one part and leaves every other part of the expression as it was.
  function writePart(writes, kind, line) {
    var replaced = [];
    for (var i = 0; i < writes.length; i++) {
      var prop = writes[i];
      var existing = prop.expression || "";
      var parts = parseParts(existing);
      if (parts.foreign) {
        replaced.push(propertyLabel(prop));
        parts = { loop: null, wiggle: null, foreign: false };
      }
      parts[kind] = line;
      prop.expression = buildExpression(parts);
      prop.expressionEnabled = true;
    }
    return replaced;
  }

  function reportReplaced(ctx, replaced) {
    if (!replaced.length) return;
    ctx.warnings.push("Replaced an existing expression on " + replaced.length +
      " propert" + (replaced.length === 1 ? "y" : "ies") + " (" + replaced[0] + "). Undo to get it back.");
  }

  function reportSkipped(ctx, skipped) {
    if (!skipped.length) return;
    ctx.warnings.push("Skipped " + skipped.length + " layer(s): " + skipped[0].name + " - " + skipped[0].reason);
  }

  // ------------------------------------------------------------ slider rig

  // Reuses a control of the same name, so applying twice never stacks up
  // duplicates - which would also break the expression, because After Effects
  // renames the second one and effect("Wiggle Speed") would miss it.
  function ensureSlider(layer, name, value) {
    var parade = layer.property("ADBE Effect Parade");
    if (!parade) return false;
    for (var i = 1; i <= parade.numProperties; i++) {
      var existing = parade.property(i);
      if (existing.name === name) {
        existing.property(1).setValue(value);
        return true;
      }
    }
    if (!parade.canAddProperty("ADBE Slider Control")) return false;
    var made = parade.addProperty("ADBE Slider Control");
    made.name = name;
    made.property(1).setValue(value);
    return true;
  }

  // ------------------------------------------------------------ commands

  Flow.register("expression.loop", {
    undo: "Apply Loop Expression",
    run: function (params, ctx) {
      var type = Flow.oneOf(params, "type", LOOP_TYPES);
      var keyframes = Flow.num(params, "keyframes", 0);
      if (keyframes < 0 || keyframes > 999 || keyframes !== Math.floor(keyframes)) {
        throw Flow.error("INVALID_PARAMS", "Parameter 'keyframes' must be a whole number from 0 to 999.");
      }

      var comp = Flow.requireComp();
      var layers = Flow.requireSelectedLayers(comp);
      var skipped = [];
      var found = collect(comp, layers, canLoop);

      if (found.targets.length === 0) {
        throw Flow.error("NO_KEYFRAMES", found.fromSelection
          ? "The selected properties need at least two keyframes to loop."
          : "No selected layer has an animated property with two or more keyframes.");
      }

      var writes = planWrites(found.targets, skipped);
      if (writes.length === 0) {
        throw Flow.error("UNSUPPORTED_LAYER", skipped.length
          ? skipped[0].name + ": " + skipped[0].reason
          : "Nothing could be changed.");
      }

      var call = buildLoopCall(type, keyframes);
      var replaced = writePart(writes, "loop", loopLine(call));

      reportReplaced(ctx, replaced);
      reportSkipped(ctx, skipped);

      return {
        properties: writes.length,
        layers: countLayers(writes),
        replaced: replaced.length,
        expression: call,
        skipped: skipped
      };
    }
  });

  Flow.register("expression.wiggle", {
    undo: "Apply Wiggle",
    run: function (params, ctx) {
      var target = Flow.oneOf(params, "target", WIGGLE_TARGETS);
      var speed = Flow.num(params, "speed", 2);
      var range = Flow.num(params, "range", 30);
      var sliders = Flow.bool(params, "sliders", false);
      if (speed < 0 || speed > 1000) {
        throw Flow.error("INVALID_PARAMS", "Parameter 'speed' must be between 0 and 1000.");
      }
      if (range < -100000 || range > 100000) {
        throw Flow.error("INVALID_PARAMS", "Parameter 'range' must be between -100000 and 100000.");
      }

      var comp = Flow.requireComp();
      var layers = Flow.requireSelectedLayers(comp);
      var skipped = [];
      var targets = collectWiggleTargets(comp, layers, target);

      if (targets.length === 0) {
        throw Flow.error("INVALID_PROPERTY", target === "selected"
          ? "Pick the properties to wiggle in the timeline, or choose Position, Rotation or Scale."
          : "The selected layers have no " + target + " property to wiggle.");
      }
      var writes = planWrites(targets, skipped);
      if (writes.length === 0) {
        throw Flow.error("UNSUPPORTED_LAYER", skipped.length
          ? skipped[0].name + ": " + skipped[0].reason
          : "Nothing could be changed.");
      }

      var i;
      var noControls = [];
      if (sliders) {
        // Controls first, then the targets are re-acquired: addProperty can
        // invalidate property references taken before it.
        var touched = [];
        for (i = 0; i < writes.length; i++) {
          var owner = layerOf(writes[i]);
          if (Flow.contains(touched, owner)) continue;
          touched.push(owner);
          if (!ensureSlider(owner, SPEED_CONTROL, speed) || !ensureSlider(owner, RANGE_CONTROL, range)) {
            noControls.push(owner.name);
          }
        }
        writes = planWrites(collectWiggleTargets(comp, layers, target), []);
      }

      var call = buildWiggleCall(speed, range, sliders);
      var replaced = writePart(writes, "wiggle", wiggleLine(call));

      if (noControls.length) {
        ctx.warnings.push("Could not add slider controls to " + noControls.length +
          " layer(s) (" + noControls[0] + "), so their wiggle has nothing to read.");
      }
      reportReplaced(ctx, replaced);
      reportSkipped(ctx, skipped);

      return {
        properties: writes.length,
        layers: countLayers(writes),
        replaced: replaced.length,
        expression: call,
        skipped: skipped
      };
    }
  });

  Flow.register("expression.remove", {
    undo: "Remove Expression",
    run: function (params, ctx) {
      var part = Flow.oneOf(params, "part", PARTS);
      var comp = Flow.requireComp();
      var layers = Flow.requireSelectedLayers(comp);
      var skipped = [];
      var found = collect(comp, layers, partPredicate(part));

      if (found.targets.length === 0) {
        throw Flow.error("INVALID_PROPERTY", part === "all"
          ? "No Flow expression found on the selection."
          : "No " + part + " found on the selection.");
      }

      var writes = planWrites(found.targets, skipped);
      if (writes.length === 0) {
        throw Flow.error("UNSUPPORTED_LAYER", skipped[0].name + ": " + skipped[0].reason);
      }

      for (var i = 0; i < writes.length; i++) {
        var parts = parseParts(writes[i].expression || "");
        if (part === "all") {
          parts.loop = null;
          parts.wiggle = null;
        } else {
          parts[part] = null;
        }
        // Whatever is left keeps working; an empty result clears the field.
        writes[i].expression = hasAnyPart(parts) ? buildExpression(parts) : "";
      }

      reportSkipped(ctx, skipped);

      // Slider controls are left alone: they may be keyframed, and another
      // expression could be reading them.
      return {
        properties: writes.length,
        layers: countLayers(writes),
        replaced: 0,
        expression: "",
        skipped: skipped
      };
    }
  });
})($.global.Flow);
