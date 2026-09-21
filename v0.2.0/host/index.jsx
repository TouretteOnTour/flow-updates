// Flow host bootstrap. Loaded by CEP via manifest <ScriptPath>, and again by
// the panel (with an explicit path) whenever Flow is missing or reloaded.
// Every module file is loaded independently so one broken tool cannot take
// the whole host down; failures are reported through system.ping.
//
// Staleness: the panel cannot see the file system, and After Effects keeps
// whatever ExtendScript it loaded first for the life of the panel. So the host
// stamps the module files it loaded (size + modification time) and re-loads
// itself when that stamp no longer matches what is on disk. Editing a .jsx
// file therefore takes effect on the very next command, with no panel restart
// and nothing for anyone to remember.

(function () {
  var MODULES = ["core.jsx", "anchor.jsx", "easing.jsx", "nulls.jsx", "expression.jsx", "matte.jsx", "text.jsx", "counter.jsx", "project.jsx"];

  var hostDir = (typeof $.global.__flowHostDir === "string" && $.global.__flowHostDir)
    ? new Folder($.global.__flowHostDir)
    : new File($.fileName).parent;

  // Remembered so a reload triggered from inside the host can find the files
  // even when the panel never told us where they are.
  $.global.__flowHostDir = hostDir.fsName;

  // Size and modification time of every module, which is enough to notice any
  // edit without reading the files themselves.
  function stamp() {
    var parts = [];
    for (var i = 0; i < MODULES.length; i++) {
      var file = new File(hostDir.fsName + "/" + MODULES[i]);
      if (!file.exists) {
        parts.push("-");
        continue;
      }
      var when = file.modified;
      parts.push(String(file.length) + ":" + (when ? String(when.getTime()) : "0"));
    }
    return parts.join("|");
  }

  var errors = [];
  var i, file;

  for (i = 0; i < MODULES.length; i++) {
    file = new File(hostDir.fsName + "/" + MODULES[i]);
    if (!file.exists) {
      errors.push(MODULES[i] + ": file not found in " + hostDir.fsName);
      continue;
    }
    try {
      $.evalFile(file);
    } catch (e) {
      errors.push(MODULES[i] + ": " + e.toString() + (e.line ? " (line " + e.line + ")" : ""));
    }
  }

  $.global.__flowLoadErrors = errors;
  $.global.__flowLoadedStamp = stamp();

  // Called by the transport before every command. Re-evaluating this file
  // reloads every module and replaces this function, which is safe: the
  // modules only register commands, they hold no state worth keeping.
  $.global.__flowEnsureFresh = function () {
    if ($.global.__flowLoadedStamp === stamp()) return false;
    $.evalFile(new File(hostDir.fsName + "/index.jsx"));
    return true;
  };
})();
