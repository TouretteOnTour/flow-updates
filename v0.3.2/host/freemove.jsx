// Free Move.
//
// While the panel's Free Move switch is on, layers can be dragged, scaled and
// rotated in the composition without disturbing their animation: the whole
// animation moves along instead of a keyframe being added or changed.
//
// After Effects tells scripts nothing about a drag, so the panel calls
// freemove.watch a few times a second. Each call compares the keyframes of
// Position, Scale and Rotation with what it saw last time. A drag in the
// viewer leaves exactly one trace on a keyed property: one new keyframe at the
// playhead, or one existing keyframe with a new value. Either is turned into
// the same change applied to every keyframe (the new one is removed again),
// so the layer stays where it was dropped and keeps its timing, eases and
// motion path. Position and Rotation move by the difference; Scale is
// multiplied, so an animation from 0% to 100% stays one that starts at 0%.
//
// Anything else - a key moved in time, several keys edited, a bake, a paste -
// is simply accepted as the new state. Undo and redo are recognised because
// they bring back a state that was seen before: every property remembers its
// recent states, and a change back to one of them is never "fixed".
//
// Hold children: when it is on, the children of a moved layer stay where they
// are. The parent link is never really cut (an animated parent's motion would
// be lost at every other frame). Instead the parent is put back as it was
// before the drag, its children are unparented, the move is made again, and
// they are parented again. After Effects keeps a layer in place each time its
// parent is set, so the children end up unchanged in the comp but still
// follow the parent from then on. It is exact at the current frame, and
// everywhere when the parent's rotation and scale are not animated. With it
// on, unkeyed values are watched too, so a still parent holds its children.
// Hold children also works with Free Move itself off (move: false): the
// parent's drag is then kept as After Effects made it, one key added or
// changed, and only the children are looked after.
//
// The state lives in $.global so a host reload does not forget it.

(function (Flow) {
  if (!Flow) return;

  var BATCH = 16;      // unselected layers re-read per call, round robin
  var HISTORY = 40;    // states remembered per property, to recognise undo/redo
  var EPS_TIME = 1e-6;
  var EPS_VALUE = 1e-4;

  function state(compId, reset) {
    var s = $.global.__flowFreeMove;
    if (reset || !s || s.compId !== compId) {
      s = { compId: compId, entries: {}, cursor: 0, fresh: true };
      $.global.__flowFreeMove = s;
    }
    return s;
  }

  // The keyed transform properties Free Move looks after on one layer.
  function watched(layer, kinds) {
    var group = layer.property("ADBE Transform Group");
    if (!group) return [];
    var out = [];
    var threeD = layer.threeDLayer === true;
    var p;

    function add(matchName, mode) {
      var prop = group.property(matchName);
      if (prop) out.push({ name: matchName, prop: prop, mode: mode });
    }

    if (kinds.position) {
      p = group.property("ADBE Position");
      if (p && p.dimensionsSeparated) {
        add("ADBE Position_0", "add");
        add("ADBE Position_1", "add");
        if (threeD) add("ADBE Position_2", "add");
      } else if (p) {
        out.push({ name: "ADBE Position", prop: p, mode: "add" });
      }
    }
    if (kinds.scale) add("ADBE Scale", "multiply");
    if (kinds.rotation) {
      add("ADBE Rotate Z", "add");
      if (threeD) {
        add("ADBE Rotate X", "add");
        add("ADBE Rotate Y", "add");
      }
    }
    return out;
  }

  // ------------------------------------------------------------ keys

  function copyValue(v) {
    if (typeof v === "number") return v;
    var out = [];
    for (var i = 0; i < v.length; i++) out.push(v[i]);
    return out;
  }

  // `still` also reads the value of a property without keys (Hold children).
  function readKeys(prop, still) {
    var n = prop.numKeys;
    var keys = { times: [], values: [], value: null };
    for (var i = 1; i <= n; i++) {
      keys.times.push(prop.keyTime(i));
      keys.values.push(copyValue(prop.keyValue(i)));
    }
    if (n === 0 && still) keys.value = copyValue(prop.value);
    return keys;
  }

  function valueText(v) {
    if (typeof v === "number") return v.toFixed(4);
    var parts = [];
    for (var i = 0; i < v.length; i++) parts.push(v[i].toFixed(4));
    return parts.join(",");
  }

  function signature(keys) {
    var parts = [];
    for (var i = 0; i < keys.times.length; i++) {
      parts.push(keys.times[i].toFixed(6) + "=" + valueText(keys.values[i]));
    }
    if (keys.value !== null) parts.push("v=" + valueText(keys.value));
    return parts.join(";");
  }

  function sameValue(a, b) {
    if (typeof a === "number" || typeof b === "number") {
      return typeof a === "number" && typeof b === "number" && Math.abs(a - b) < EPS_VALUE;
    }
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) >= EPS_VALUE) return false;
    return true;
  }

  function sameKey(oldKeys, i, curKeys, j) {
    return Math.abs(oldKeys.times[i] - curKeys.times[j]) < EPS_TIME &&
      sameValue(oldKeys.values[i], curKeys.values[j]);
  }

  // What happened between two states, if it is what a drag does.
  // Returns { type: "added" | "changed" | "still", index (1-based) } or null.
  function classify(oldKeys, curKeys) {
    var n = oldKeys.times.length;
    var m = curKeys.times.length;
    var i, j, extra, diff;

    if (n === 0) {
      // A new value on a property without keys: only Hold children reads these.
      return m === 0 && oldKeys.value !== null && curKeys.value !== null &&
        !sameValue(oldKeys.value, curKeys.value) ? { type: "still" } : null;
    }

    if (m === n + 1) {
      extra = -1;
      for (i = 0, j = 0; j < m; j++) {
        if (i < n && sameKey(oldKeys, i, curKeys, j)) {
          i++;
        } else if (extra < 0) {
          extra = j;
        } else {
          return null;
        }
      }
      return i === n && extra >= 0 ? { type: "added", index: extra + 1 } : null;
    }

    if (m === n) {
      diff = -1;
      for (i = 0; i < n; i++) {
        if (Math.abs(oldKeys.times[i] - curKeys.times[i]) >= EPS_TIME) return null;
        if (!sameValue(oldKeys.values[i], curKeys.values[i])) {
          if (diff >= 0) return null;
          diff = i;
        }
      }
      return diff >= 0 ? { type: "changed", index: diff + 1 } : null;
    }

    return null;
  }

  // The change that turns `from` into `to`, as a function of a key value.
  // Scale multiplies (falling back to adding on a 0% component, where a factor
  // means nothing); everything else adds.
  function shifter(from, to, mode) {
    function one(v, a, b) {
      if (mode === "multiply" && Math.abs(a) > 1e-6) return v * (b / a);
      return v + (b - a);
    }
    return function (v) {
      if (typeof v === "number") return one(v, from, to);
      var out = [];
      for (var i = 0; i < v.length; i++) {
        out.push(i < from.length && i < to.length ? one(v[i], from[i], to[i]) : v[i]);
      }
      return out;
    };
  }

  // A drag's trace is turned into a move of the whole animation in two steps,
  // so Hold children can let go of the children in between. undoDrag puts the
  // property back as it was before the drag and returns how to make the move
  // again (null for a key added on purpose); redo makes it, on every key.
  // Without `whole` (Hold children with Free Move off) redo makes the drag
  // again just as After Effects made it: one key added or changed.
  function undoDrag(item, change, oldKeys, whole) {
    var prop = item.prop;
    var k = change.index;
    var from, to, t;

    if (change.type === "still") {
      to = copyValue(prop.value);
      prop.setValue(oldKeys.value);
      return { prop: prop, still: to };
    }

    if (change.type === "added") {
      t = prop.keyTime(k);
      to = copyValue(prop.keyValue(k));
      prop.removeKey(k);
      from = copyValue(prop.valueAtTime(t, true));
      if (sameValue(from, to)) {
        // A key added on purpose (the keyframe button), not a drag: put it back.
        prop.setValueAtTime(t, to);
        return null;
      }
      if (!whole) return { prop: prop, time: t, to: to };
      return { prop: prop, moved: shifter(from, to, item.mode), key: 0 };
    }

    from = oldKeys.values[k - 1];
    to = copyValue(prop.keyValue(k));
    prop.setValueAtKey(k, from);
    // The dragged key gets its own value back exactly, not through the shift.
    return { prop: prop, moved: whole ? shifter(from, to, item.mode) : null, key: k, to: to };
  }

  function redo(move) {
    var prop = move.prop;
    if (move.still) {
      prop.setValue(move.still);
      return;
    }
    if (move.time !== undefined) {
      prop.setValueAtTime(move.time, move.to);
      return;
    }
    if (!move.moved) {
      prop.setValueAtKey(move.key, move.to);
      return;
    }
    for (var i = 1; i <= prop.numKeys; i++) {
      prop.setValueAtKey(i, i === move.key ? move.to : move.moved(prop.keyValue(i)));
    }
  }

  function remember(entry, sig) {
    for (var i = 0; i < entry.seen.length; i++) if (entry.seen[i] === sig) return;
    entry.seen.push(sig);
    if (entry.seen.length > HISTORY) entry.seen.shift();
  }

  function wasSeen(entry, sig) {
    for (var i = 0; i < entry.seen.length; i++) if (entry.seen[i] === sig) return true;
    return false;
  }

  // ------------------------------------------------------------ watching

  // Takes what one layer looks like now as the state to compare against.
  function record(s, layer, kinds, still) {
    var items = watched(layer, kinds);
    for (var p = 0; p < items.length; p++) {
      var id = "L" + layer.id + "|" + items[p].name;
      var cur = readKeys(items[p].prop, still);
      var sig = signature(cur);
      var entry = s.entries[id];
      if (!entry) {
        s.entries[id] = { keys: cur, sig: sig, seen: [sig] };
      } else {
        entry.keys = cur;
        entry.sig = sig;
        remember(entry, sig);
      }
    }
  }

  // The unlocked layers parented to `layer`. Locked ones are left alone.
  function childrenOf(comp, layer) {
    var out = [];
    for (var i = 1; i <= comp.numLayers; i++) {
      var l = comp.layer(i);
      if (l.parent && l.parent.id === layer.id && !l.locked) out.push(l);
    }
    return out;
  }

  // opts: { kinds, whole (Free Move itself), hold (Hold children), allowFix, comp, undo }
  function checkLayer(s, layer, opts) {
    if (layer.locked) return false;
    var items = watched(layer, opts.kinds);
    var drags = [];
    var p, c;

    for (p = 0; p < items.length; p++) {
      var item = items[p];
      var id = "L" + layer.id + "|" + item.name;
      var cur = readKeys(item.prop, opts.hold);
      var sig = signature(cur);
      var entry = s.entries[id];

      if (!entry) {
        s.entries[id] = { keys: cur, sig: sig, seen: [sig] };
        continue;
      }
      if (sig === entry.sig) continue;

      var change = opts.allowFix && !wasSeen(entry, sig) ? classify(entry.keys, cur) : null;
      if (change) drags.push({ item: item, change: change, keys: entry.keys });
      entry.keys = cur;
      entry.sig = sig;
      remember(entry, sig);
    }

    // A new still value only matters to children, and so does any drag when
    // only Hold children is on.
    var children = opts.hold ? childrenOf(opts.comp, layer) : [];
    if (children.length === 0) {
      if (!opts.whole) return false;
      for (p = drags.length - 1; p >= 0; p--) if (drags[p].change.type === "still") drags.splice(p, 1);
    }
    if (drags.length === 0) return false;

    opts.undo.open();
    var moves = [];
    for (p = 0; p < drags.length; p++) {
      var move = undoDrag(drags[p].item, drags[p].change, drags[p].keys, opts.whole);
      if (move) moves.push(move);
    }
    if (moves.length === 0) children = [];
    // Unparented while the parent is where it was before the drag, parented
    // again once it is where it was dropped: After Effects keeps them in place.
    for (c = 0; c < children.length; c++) children[c].parent = null;
    for (p = 0; p < moves.length; p++) redo(moves[p]);
    for (c = 0; c < children.length; c++) children[c].parent = layer;

    record(s, layer, opts.kinds, opts.hold);
    for (c = 0; c < children.length; c++) record(s, children[c], opts.kinds, opts.hold);
    return moves.length > 0;
  }

  Flow.register("freemove.watch", {
    undo: null,
    run: function (params) {
      var kinds = {
        position: Flow.bool(params, "position", true),
        scale: Flow.bool(params, "scale", true),
        rotation: Flow.bool(params, "rotation", true)
      };
      var whole = Flow.bool(params, "move", true);
      var hold = Flow.bool(params, "holdChildren", false);
      var reset = Flow.bool(params, "reset", false);
      var item = app.project ? app.project.activeItem : null;
      // Quiet when there is nothing to watch: this runs constantly.
      if (!item || !(item instanceof CompItem)) return { fixed: [] };

      var s = state(item.id, reset);
      var fixed = [];
      var opened = false;
      var undo = {
        open: function () {
          if (opened) return;
          app.beginUndoGroup(whole ? "Flow: Free Move" : "Flow: Hold Children");
          opened = true;
        }
      };

      var opts = { kinds: kinds, whole: whole, hold: hold, allowFix: false, comp: item, undo: undo };

      try {
        var i, layer;
        var n = item.numLayers;

        if (s.fresh) {
          // First look at this composition: record everything, change nothing.
          for (i = 1; i <= n; i++) checkLayer(s, item.layer(i), opts);
          s.fresh = false;
          return { fixed: [] };
        }

        // A drag always leaves the dragged layers selected, so those are read
        // on every call. The rest are kept up to date a few at a time.
        opts.allowFix = true;
        var sel = item.selectedLayers;
        var done = {};
        for (i = 0; sel && i < sel.length; i++) {
          done["L" + sel[i].id] = true;
          if (checkLayer(s, sel[i], opts)) fixed.push(sel[i].name);
        }

        var count = Math.min(BATCH, n);
        for (var c = 0; c < count; c++) {
          s.cursor = s.cursor % n + 1;
          layer = item.layer(s.cursor);
          if (done["L" + layer.id]) continue;
          if (checkLayer(s, layer, opts)) fixed.push(layer.name);
        }
      } finally {
        if (opened) app.endUndoGroup();
      }

      return { fixed: fixed };
    }
  });
})($.global.Flow);
