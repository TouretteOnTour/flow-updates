// Flow host core: JSON, command registry, undo wrapping, standard responses
// and shared validation helpers. ES3 only - ExtendScript has no JSON object,
// no Array.prototype.indexOf/forEach and no Object.keys.

(function () {
  var Flow = {};
  $.global.Flow = Flow;

  Flow.VERSION = "0.1.0";
  Flow.commands = {};

  // ---------------------------------------------------------------- errors

  // Thrown objects carry a stable code the UI can react to.
  Flow.error = function (code, message) {
    return { flowCode: code, message: message };
  };

  Flow.toFailure = function (e) {
    if (e && e.flowCode) {
      return { success: false, code: e.flowCode, error: e.message };
    }
    var msg = e && e.toString ? e.toString() : String(e);
    if (e && e.line) msg += " (line " + e.line + ")";
    return { success: false, code: "HOST_EXCEPTION", error: msg };
  };

  // ---------------------------------------------------------------- JSON

  var ESCAPES = { "\"": "\\\"", "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };

  function quote(str) {
    return "\"" + str.replace(/["\\\x00-\x1f\u2028\u2029]/g, function (ch) {
      if (ESCAPES.hasOwnProperty(ch)) return ESCAPES[ch];
      var hex = ch.charCodeAt(0).toString(16);
      return "\\u" + "0000".substring(hex.length) + hex;
    }) + "\"";
  }

  function stringify(value) {
    var i, parts, key;
    if (value === null || value === undefined) return "null";
    switch (typeof value) {
      case "string": return quote(value);
      case "number": return isFinite(value) ? String(value) : "null";
      case "boolean": return value ? "true" : "false";
      case "function": return "null";
    }
    if (value instanceof Array) {
      parts = [];
      for (i = 0; i < value.length; i++) parts.push(stringify(value[i]));
      return "[" + parts.join(",") + "]";
    }
    parts = [];
    for (key in value) {
      if (value.hasOwnProperty(key) && value[key] !== undefined && typeof value[key] !== "function") {
        parts.push(quote(key) + ":" + stringify(value[key]));
      }
    }
    return "{" + parts.join(",") + "}";
  }

  // Validates that the text is pure JSON before eval, so a malformed or
  // hostile parameter string can never execute code inside After Effects.
  function parse(text) {
    var s = String(text);
    var check = s
      .replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, "@")
      .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]")
      .replace(/(?:^|:|,)(?:\s*\[)+/g, "");
    if (!/^[\],:{}\s]*$/.test(check)) {
      throw Flow.error("INVALID_PARAMS", "Malformed command parameters.");
    }
    return eval("(" + s + ")");
  }

  Flow.json = { stringify: stringify, parse: parse };

  // ---------------------------------------------------------------- registry

  // def: { undo: "Undo label" | null, run: function (params, ctx) { return data; } }
  Flow.register = function (name, def) {
    Flow.commands[name] = def;
  };

  // Single entry point used by the panel bridge. Always returns a JSON string
  // and never throws, so evalScript callbacks always receive a response.
  Flow.execute = function (name, paramsJson) {
    var response, def, params, data;
    var ctx = { warnings: [] };
    try {
      if (!Flow.commands.hasOwnProperty(name)) {
        throw Flow.error("UNKNOWN_COMMAND", "Unknown command: " + name);
      }
      def = Flow.commands[name];
      params = paramsJson ? parse(paramsJson) : {};

      if (def.undo) {
        app.beginUndoGroup("Flow: " + def.undo);
        try {
          data = def.run(params, ctx);
        } finally {
          // Always close the group, otherwise every later AE action is merged
          // into one broken undo step until AE is restarted.
          app.endUndoGroup();
        }
      } else {
        data = def.run(params, ctx);
      }

      response = { success: true, data: data === undefined ? null : data };
      if (ctx.warnings.length) response.warnings = ctx.warnings;
    } catch (e) {
      response = Flow.toFailure(e);
    }
    return stringify(response);
  };

  // ---------------------------------------------------------------- helpers

  Flow.contains = function (arr, item) {
    for (var i = 0; i < arr.length; i++) if (arr[i] === item) return true;
    return false;
  };

  Flow.requireComp = function () {
    var item = app.project ? app.project.activeItem : null;
    if (!item || !(item instanceof CompItem)) {
      throw Flow.error("NO_ACTIVE_COMP", "Open or select a composition first.");
    }
    return item;
  };

  Flow.requireSelectedLayers = function (comp) {
    var sel = comp.selectedLayers;
    if (!sel || sel.length === 0) {
      throw Flow.error("NO_SELECTION", "Select at least one layer.");
    }
    var out = [];
    for (var i = 0; i < sel.length; i++) out.push(sel[i]);
    return out;
  };

  Flow.num = function (params, key, fallback) {
    var v = params ? params[key] : undefined;
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "number" || !isFinite(v)) {
      throw Flow.error("INVALID_PARAMS", "Parameter '" + key + "' must be a number.");
    }
    return v;
  };

  Flow.bool = function (params, key, fallback) {
    var v = params ? params[key] : undefined;
    if (v === undefined || v === null) return fallback;
    return v === true;
  };

  // Text that ends up in a layer or animator name. Length-capped so a bad
  // caller cannot push a novel into the timeline.
  Flow.str = function (params, key, fallback, maxLength) {
    var v = params ? params[key] : undefined;
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "string") {
      throw Flow.error("INVALID_PARAMS", "Parameter '" + key + "' must be text.");
    }
    return v.length > maxLength ? v.substring(0, maxLength) : v;
  };

  Flow.oneOf = function (params, key, allowed) {
    var v = params ? params[key] : undefined;
    if (!Flow.contains(allowed, v)) {
      throw Flow.error("INVALID_PARAMS", "Parameter '" + key + "' must be one of: " + allowed.join(", "));
    }
    return v;
  };

  // A layer name can collide with Object.prototype members ("toString"), so the
  // lookup is prefixed rather than using the raw name as a key.
  Flow.uniqueLayerName = function (comp, base) {
    var taken = {};
    var i;
    for (i = 1; i <= comp.numLayers; i++) taken["n_" + comp.layer(i).name] = true;
    if (!taken["n_" + base]) return base;
    for (i = 2; i < 1000; i++) {
      if (!taken["n_" + base + " " + i]) return base + " " + i;
    }
    return base;
  };

  // The scripting guide documents ShapeLayer and TextLayer as AVLayer
  // subclasses, but in ExtendScript `instanceof AVLayer` is false for them,
  // so every layer class with transform + source bounds is listed explicitly.
  Flow.isVisualLayer = function (layer) {
    return layer instanceof AVLayer || layer instanceof ShapeLayer || layer instanceof TextLayer;
  };

  Flow.hasActiveExpression = function (prop) {
    return prop.canSetExpression && prop.expressionEnabled && prop.expression !== "";
  };

  // ---------------------------------------------------------------- system

  Flow.register("system.ping", {
    undo: null,
    run: function () {
      return {
        appName: app.appName || "After Effects",
        appVersion: app.version,
        hostScriptVersion: Flow.VERSION,
        hostStamp: $.global.__flowLoadedStamp || "",
        loadErrors: $.global.__flowLoadErrors || []
      };
    }
  });
})();
