// Project Setup tool.
//
// Two jobs, both about the project panel rather than a composition:
//
//   project.state    is this project empty? The panel asks on open and every
//                    few seconds, so it can offer a folder structure the
//                    moment someone starts a new project.
//   project.folders  build a folder tree in the project panel from a list of
//                    paths ("01 Assets", "01 Assets/Footage", ...).
//
// Folders are matched by name inside their own parent, so applying a preset
// twice adds nothing the second time and a preset can be applied on top of a
// project that already has some of the folders.
//
// Paths arrive already split and cleaned by the panel (src/utils/folderTree.ts),
// but nothing here trusts that: names are trimmed and checked again, because
// the host is also reachable from anything else that can talk to the bridge.

(function (Flow) {
  if (!Flow) return;

  var MAX_FOLDERS = 300;
  var MAX_DEPTH = 10;
  var MAX_NAME = 120;

  // ------------------------------------------------------------ small utils

  function trim(text) {
    return String(text).replace(/^\s+/, "").replace(/\s+$/, "");
  }

  // After Effects accepts almost anything as an item name, but a name that is
  // blank or only dots leaves a folder nobody can identify in the panel.
  function cleanName(raw) {
    var name = trim(raw);
    if (name.length > MAX_NAME) name = trim(name.substring(0, MAX_NAME));
    if (!name || !/[^.\s]/.test(name)) return "";
    return name;
  }

  function rootFolder() {
    if (!app.project) throw Flow.error("NO_PROJECT", "Open a project first.");
    return app.project.rootFolder;
  }

  // Top-level items only: app.project.items holds every item in the project,
  // wherever it sits, so a folder's own collection is what has to be searched.
  function childFolder(parent, name) {
    var items = parent.items;
    for (var i = 1; i <= items.length; i++) {
      var item = items[i];
      if (item instanceof FolderItem && String(item.name) === name) return item;
    }
    return null;
  }

  // ------------------------------------------------------------ params

  function readPaths(params, ctx) {
    var raw = params ? params.folders : null;
    if (!(raw instanceof Array)) {
      throw Flow.error("INVALID_PARAMS", "Parameter 'folders' must be a list of folder paths.");
    }
    if (raw.length > MAX_FOLDERS) {
      throw Flow.error("INVALID_PARAMS", "That is more than " + MAX_FOLDERS + " folders.");
    }

    var paths = [];
    var dropped = 0;
    for (var i = 0; i < raw.length; i++) {
      var parts = String(raw[i] === undefined || raw[i] === null ? "" : raw[i]).split("/");
      var clean = [];
      for (var k = 0; k < parts.length && clean.length < MAX_DEPTH; k++) {
        var name = cleanName(parts[k]);
        if (name) clean.push(name);
      }
      if (clean.length) paths.push(clean);
      else dropped++;
    }

    if (dropped && ctx) {
      ctx.warnings.push(dropped === 1
        ? "One line had no usable folder name and was skipped."
        : dropped + " lines had no usable folder name and were skipped.");
    }
    if (!paths.length) throw Flow.error("INVALID_PARAMS", "There are no folder names to create.");
    return paths;
  }

  // ------------------------------------------------------------ commands

  Flow.register("project.state", {
    undo: null,
    run: function () {
      if (!app.project) return { empty: false, itemCount: 0, name: "", saved: false };
      var count = app.project.numItems;
      return {
        empty: count === 0,
        itemCount: count,
        name: app.project.file ? String(app.project.file.name) : "",
        saved: !!app.project.file
      };
    }
  });

  Flow.register("project.folders", {
    undo: "Create Folders",
    run: function (params, ctx) {
      var paths = readPaths(params, ctx);
      var root = rootFolder();
      var created = 0;
      var existing = 0;

      for (var i = 0; i < paths.length; i++) {
        var parent = root;
        for (var k = 0; k < paths[i].length; k++) {
          var name = paths[i][k];
          var found = childFolder(parent, name);
          if (found) {
            existing++;
            parent = found;
            continue;
          }
          var made = app.project.items.addFolder(name);
          made.parentFolder = parent;
          created++;
          parent = made;
        }
      }

      if (!created) ctx.warnings.push("Every folder in this preset was already there.");
      return { created: created, existing: existing };
    }
  });
})($.global.Flow);
