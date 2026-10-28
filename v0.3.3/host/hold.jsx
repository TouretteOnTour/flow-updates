// Hold children.
//
// While the switch is on, layers parented to another layer stay where they
// are when that parent is moved, scaled or rotated - live, during the drag,
// at every frame. Scripts cannot run while a drag is going on, but
// expressions can, so that is what does the holding:
//
// hold.start makes a ghost of every parent in the active composition: a
// duplicate, switched off, shy and locked, that keeps the parent's
// transform and animation as they were. Each child gets an expression on
// Position, Rotation and Scale that puts it where it would be if its parent
// were still where the ghost is (the ghosts of nested parents are parented to
// each other, so a whole chain holds). The parent links themselves are never
// cut.
//
// hold.stop removes those expressions and parents each child to the ghost
// and back to its real parent. After Effects keeps a layer in place each time
// its parent is set, so the children stay where they are (exactly at the
// current frame, and at every frame when the parent's rotation and scale are
// not animated) and follow the parent again from then on. Then the ghosts go.
//
// Everything is found again from the project itself - ghosts by their layer
// comment, expressions by their first line - so a session survives a panel
// reload, a host reload and a saved project.

(function (Flow) {
  if (!Flow) return;

  var MARK = "// Flow: Hold children";
  var GHOST = "Flow: Hold children ghost of layer ";

  function transformOf(layer) {
    return layer.property("ADBE Transform Group");
  }

  // The id of the parent a ghost stands in for, or null for any other layer.
  function ghostOf(layer) {
    var comment = String(layer.comment || "");
    return comment.indexOf(GHOST) === 0 ? comment.substring(GHOST.length) : null;
  }

  function hasGhosts(comp) {
    for (var i = 1; i <= comp.numLayers; i++) if (ghostOf(comp.layer(i)) !== null) return true;
    return false;
  }

  // ------------------------------------------------------------ expressions

  function positionExpression(ghostName) {
    return [
      MARK,
      "var g = thisComp.layer(" + Flow.json.stringify(ghostName) + ");",
      "var w = thisLayer.parent.fromWorld(g.toWorld(value));",
      "w.slice(0, value.length);"
    ].join("\n");
  }

  function rotationExpression(ghostName) {
    return [
      MARK,
      "var g = thisComp.layer(" + Flow.json.stringify(ghostName) + "), p = thisLayer.parent;",
      "var a = g.toWorldVec([1, 0, 0]), b = p.toWorldVec([1, 0, 0]);",
      "var d = radiansToDegrees(Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));",
      "value + d - 360 * Math.round(d / 360);"
    ].join("\n");
  }

  function scaleExpression(ghostName) {
    return [
      MARK,
      "var g = thisComp.layer(" + Flow.json.stringify(ghostName) + "), p = thisLayer.parent;",
      "function k(v) { var a = length(g.toWorldVec(v)), b = length(p.toWorldVec(v)); return b > 1e-9 ? a / b : 1; }",
      "var s = value.slice(0);",
      "s[0] *= k([1, 0, 0]);",
      "s[1] *= k([0, 1, 0]);",
      "if (s.length > 2) s[2] *= k([0, 0, 1]);",
      "s;"
    ].join("\n");
  }

  function isOurs(prop) {
    return !!prop && prop.canSetExpression && String(prop.expression).indexOf(MARK) === 0;
  }

  // The properties of a layer that carry a Hold children expression.
  function heldProps(layer) {
    var t = transformOf(layer);
    var out = [];
    if (!t) return out;
    var names = ["ADBE Position", "ADBE Rotate Z", "ADBE Scale"];
    for (var i = 0; i < names.length; i++) {
      var prop = t.property(names[i]);
      if (isOurs(prop)) out.push(prop);
    }
    return out;
  }

  // ------------------------------------------------------------ start

  function makeGhost(comp, parent) {
    var ghost = parent.duplicate();
    try { ghost.locked = false; } catch (e1) { /* was not locked */ }
    ghost.name = Flow.uniqueLayerName(comp, "Flow hold - " + parent.name);
    ghost.comment = GHOST + parent.id;
    ghost.enabled = false;
    ghost.shy = true;
    try { ghost.audioEnabled = false; } catch (e2) { /* no audio */ }
    try { ghost.guideLayer = true; } catch (e3) { /* cameras and lights have none */ }
    return ghost;
  }

  // Sets a Hold children expression unless the property already has one of
  // its own, which is never overwritten.
  function hold(prop, expression, layer, label, ctx) {
    if (!prop || !prop.canSetExpression) return false;
    if (String(prop.expression) !== "") {
      ctx.warnings.push(layer.name + " has its own expression on " + label + ", so its " + label + " still follows its parent.");
      return false;
    }
    prop.expression = expression;
    return true;
  }

  Flow.register("hold.start", {
    undo: "Hold Children",
    run: function (params, ctx) {
      var comp = Flow.requireComp();
      if (hasGhosts(comp)) return { compId: comp.id, held: 0 };

      // Read everything before the first duplicate shifts the layer indices.
      var layers = [];
      var i, j, l;
      for (i = 1; i <= comp.numLayers; i++) layers.push(comp.layer(i));

      var parents = [];
      var kids = {};
      for (i = 0; i < layers.length; i++) {
        l = layers[i];
        if (!l.parent || l.locked) continue;
        var key = "p" + l.parent.id;
        if (!kids[key]) {
          kids[key] = [];
          parents.push(l.parent);
        }
        kids[key].push(l);
      }
      if (parents.length === 0) {
        throw Flow.error("NOTHING_TO_HOLD", "No unlocked layer in this composition has a parent, so there is nothing to hold.");
      }

      var ghosts = {};
      for (i = 0; i < parents.length; i++) ghosts["p" + parents[i].id] = makeGhost(comp, parents[i]);
      // A parent that is itself a child: its ghost follows the grandparent's
      // ghost, so the whole chain stays as it was.
      for (i = 0; i < parents.length; i++) {
        var up = parents[i].parent;
        if (up && ghosts["p" + up.id]) ghosts["p" + parents[i].id].setParentWithJump(ghosts["p" + up.id]);
      }
      for (i = 0; i < parents.length; i++) ghosts["p" + parents[i].id].locked = true;

      var held = 0;
      var separated = [];
      for (i = 0; i < parents.length; i++) {
        var ghostName = ghosts["p" + parents[i].id].name;
        var children = kids["p" + parents[i].id];
        for (j = 0; j < children.length; j++) {
          var child = children[j];
          var t = transformOf(child);
          var any = false;
          var pos = t.property("ADBE Position");
          if (pos.dimensionsSeparated) {
            separated.push(child.name);
          } else if (hold(pos, positionExpression(ghostName), child, "Position", ctx)) {
            any = true;
          }
          if (hold(t.property("ADBE Rotate Z"), rotationExpression(ghostName), child, "Rotation", ctx)) any = true;
          if (hold(t.property("ADBE Scale"), scaleExpression(ghostName), child, "Scale", ctx)) any = true;
          if (any) held++;
        }
      }
      if (separated.length) {
        ctx.warnings.push("Separated X/Y position can't be held, so these still move with their parent: " + separated.join(", ") + ".");
      }
      return { compId: comp.id, held: held };
    }
  });

  // ------------------------------------------------------------ stop

  function release(comp) {
    var ghosts = {};
    var ghostList = [];
    var others = [];
    var i, p, l, id;

    for (i = 1; i <= comp.numLayers; i++) {
      l = comp.layer(i);
      id = ghostOf(l);
      if (id !== null) {
        ghosts["p" + id] = l;
        ghostList.push(l);
      } else {
        others.push(l);
      }
    }

    var released = 0;
    for (i = 0; i < others.length; i++) {
      l = others[i];
      var props = heldProps(l);
      if (props.length === 0) continue;
      var wasLocked = l.locked;
      if (wasLocked) l.locked = false;
      for (p = 0; p < props.length; p++) props[p].expression = "";
      // Parented to the ghost without a jump, it is back where the expression
      // had it; parented to its real parent again, After Effects keeps it there.
      var parent = l.parent;
      var ghost = parent ? ghosts["p" + parent.id] : null;
      if (ghost) {
        l.setParentWithJump(ghost);
        l.parent = parent;
      }
      if (wasLocked) l.locked = true;
      released++;
    }

    for (i = 0; i < ghostList.length; i++) {
      ghostList[i].locked = false;
      ghostList[i].remove();
    }
    return released;
  }

  // Compositions with a Hold children session: the ones asked about, or
  // (none given) every composition in the project.
  function sessions(compIds) {
    var out = [];
    var i, item;
    var project = app.project;
    if (!project) return out;
    // itemByID is quick but newer than some After Effects versions; without
    // it the whole project is searched.
    if (compIds && compIds.length && typeof project.itemByID === "function") {
      for (i = 0; i < compIds.length; i++) {
        item = project.itemByID(compIds[i]);
        if (item && item instanceof CompItem && hasGhosts(item)) out.push(item);
      }
      return out;
    }
    for (i = 1; i <= project.numItems; i++) {
      item = project.item(i);
      if (item instanceof CompItem && hasGhosts(item)) out.push(item);
    }
    return out;
  }

  function ids(comps) {
    var out = [];
    for (var i = 0; i < comps.length; i++) out.push(comps[i].id);
    return out;
  }

  Flow.register("hold.stop", {
    undo: "Release Children",
    run: function () {
      var comps = sessions(null);
      var released = 0;
      for (var i = 0; i < comps.length; i++) released += release(comps[i]);
      return { released: released };
    }
  });

  // Which compositions still hold their children (an undo can end a session
  // behind the panel's back). compIds narrows the search; without it the
  // whole project is searched.
  Flow.register("hold.status", {
    undo: null,
    run: function (params) {
      var compIds = params && params.compIds instanceof Array ? params.compIds : null;
      return { compIds: ids(sessions(compIds)) };
    }
  });
})($.global.Flow);
