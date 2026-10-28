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

  function readKeys(prop) {
    var n = prop.numKeys;
    var keys = { times: [], values: [] };
    for (var i = 1; i <= n; i++) {
      keys.times.push(prop.keyTime(i));
      keys.values.push(copyValue(prop.keyValue(i)));
    }
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
  // Returns { type: "added" | "changed", index (1-based) } or null.
  function classify(oldKeys, curKeys) {
    var n = oldKeys.times.length;
    var m = curKeys.times.length;
    var i, j, extra, diff;

    if (n === 0) return null;

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

  // Turns the drag's one key into a change of the whole animation.
  function fix(item, change, oldKeys) {
    var prop = item.prop;
    var k = change.index;
    var i, moved, from, to, t;

    if (change.type === "added") {
      t = prop.keyTime(k);
      to = copyValue(prop.keyValue(k));
      prop.removeKey(k);
      from = copyValue(prop.valueAtTime(t, true));
      if (sameValue(from, to)) {
        // A key added on purpose (the keyframe button), not a drag: put it back.
        prop.setValueAtTime(t, to);
        return false;
      }
      moved = shifter(from, to, item.mode);
      for (i = 1; i <= prop.numKeys; i++) prop.setValueAtKey(i, moved(prop.keyValue(i)));
      return true;
    }

    from = oldKeys.values[k - 1];
    to = copyValue(prop.keyValue(k));
    moved = shifter(from, to, item.mode);
    for (i = 1; i <= prop.numKeys; i++) {
      if (i !== k) prop.setValueAtKey(i, moved(prop.keyValue(i)));
    }
    return true;
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

  function checkLayer(s, layer, kinds, allowFix, undo) {
    if (layer.locked) return false;
    var items = watched(layer, kinds);
    var fixedAny = false;

    for (var p = 0; p < items.length; p++) {
      var item = items[p];
      var id = "L" + layer.id + "|" + item.name;
      var cur = readKeys(item.prop);
      var sig = signature(cur);
      var entry = s.entries[id];

      if (!entry) {
        s.entries[id] = { keys: cur, sig: sig, seen: [sig] };
        continue;
      }
      if (sig === entry.sig) continue;

      var change = allowFix && !wasSeen(entry, sig) ? classify(entry.keys, cur) : null;
      if (change) {
        undo.open();
        remember(entry, sig);
        if (fix(item, change, entry.keys)) fixedAny = true;
        cur = readKeys(item.prop);
        sig = signature(cur);
      }
      entry.keys = cur;
      entry.sig = sig;
      remember(entry, sig);
    }
    return fixedAny;
  }

  Flow.register("freemove.watch", {
    undo: null,
    run: function (params) {
      var kinds = {
        position: Flow.bool(params, "position", true),
        scale: Flow.bool(params, "scale", true),
        rotation: Flow.bool(params, "rotation", true)
      };
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
          app.beginUndoGroup("Flow: Free Move");
          opened = true;
        }
      };

      try {
        var i, layer;
        var n = item.numLayers;

        if (s.fresh) {
          // First look at this composition: record everything, change nothing.
          for (i = 1; i <= n; i++) checkLayer(s, item.layer(i), kinds, false, undo);
          s.fresh = false;
          return { fixed: [] };
        }

        // A drag always leaves the dragged layers selected, so those are read
        // on every call. The rest are kept up to date a few at a time.
        var sel = item.selectedLayers;
        var done = {};
        for (i = 0; sel && i < sel.length; i++) {
          done["L" + sel[i].id] = true;
          if (checkLayer(s, sel[i], kinds, true, undo)) fixed.push(sel[i].name);
        }

        var count = Math.min(BATCH, n);
        for (var c = 0; c < count; c++) {
          s.cursor = s.cursor % n + 1;
          layer = item.layer(s.cursor);
          if (done["L" + layer.id]) continue;
          if (checkLayer(s, layer, kinds, true, undo)) fixed.push(layer.name);
        }
      } finally {
        if (opened) app.endUndoGroup();
      }

      return { fixed: fixed };
    }
  });
})($.global.Flow);
