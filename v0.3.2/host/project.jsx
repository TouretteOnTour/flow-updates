// Project page: the project panel rather than a composition.
//
//
//   project.state    is this project empty? The panel asks on open and every
//                    few seconds, so it can offer a folder structure the
//                    moment someone starts a new project.
//   project.folders  build a folder tree in the project panel from a list of
//                    paths ("01 Assets", "01 Assets/Footage", ...).
//   project.assets   what is in this project: every item, what kind of thing
//                    it is and which folder it sits in. The panel works out
//                    where each one should go (features/project/sorting.ts).
//   project.sort     build those folders and move the items into them.
//   project.cleanup  the one-press tidies After Effects offers itself:
//                    unused footage, duplicate footage, empty folders, cache,
//                    and Reduce Project: keep the compositions selected in
//                    the Project panel and everything they use, remove the rest.
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
  var MAX_ASSETS = 2000;
  var MAX_MOVES = 2000;

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

  // Builds the folders and hands back what it made, keyed by path, so a sort
  // can drop items straight into them without looking them up again.
  function buildFolders(paths) {
    var root = rootFolder();
    var created = 0;
    var existing = 0;
    var map = {};

    for (var i = 0; i < paths.length; i++) {
      var parent = root;
      var joined = [];
      for (var k = 0; k < paths[i].length; k++) {
        var name = paths[i][k];
        joined.push(name);
        var key = "p" + joined.join("/");

        if (map[key]) {
          existing++;
          parent = map[key];
          continue;
        }
        var found = childFolder(parent, name);
        if (found) {
          existing++;
          map[key] = found;
          parent = found;
          continue;
        }
        var made = app.project.items.addFolder(name);
        made.parentFolder = parent;
        created++;
        map[key] = made;
        parent = made;
      }
    }
    return { created: created, existing: existing, folders: map };
  }

  Flow.register("project.folders", {
    undo: "Create Folders",
    run: function (params, ctx) {
      var built = buildFolders(readPaths(params, ctx));
      if (!built.created) ctx.warnings.push("Every folder in this preset was already there.");
      return { created: built.created, existing: built.existing };
    }
  });

  // ------------------------------------------------------------ clean up

  // What a file extension says an item is. An image sequence is footage
  // rather than an image: it behaves like a clip and belongs with them.
  var EXTENSIONS = {
    mov: "footage", mp4: "footage", m4v: "footage", avi: "footage", mkv: "footage",
    mxf: "footage", mpg: "footage", mpeg: "footage", webm: "footage", r3d: "footage",
    braw: "footage", mts: "footage", m2ts: "footage", wmv: "footage", flv: "footage",
    wav: "audio", mp3: "audio", aif: "audio", aiff: "audio", m4a: "audio",
    flac: "audio", ogg: "audio", aac: "audio", wma: "audio",
    jpg: "images", jpeg: "images", png: "images", tif: "images", tiff: "images",
    exr: "images", dpx: "images", tga: "images", bmp: "images", gif: "images",
    webp: "images", heic: "images", hdr: "images",
    ai: "design", eps: "design", psd: "design", pdf: "design", svg: "design",
    indd: "design", sketch: "design", fig: "design"
  };

  function extensionOf(name) {
    var dot = String(name).lastIndexOf(".");
    return dot > 0 ? String(name).substring(dot + 1).toLowerCase() : "";
  }

  function folderPath(item) {
    var parts = [];
    var parent = null;
    try {
      parent = item.parentFolder;
    } catch (e) {
      return "";
    }
    var guard = 0;
    while (parent && parent !== app.project.rootFolder && guard < MAX_DEPTH + 2) {
      parts.unshift(String(parent.name));
      guard++;
      try {
        parent = parent.parentFolder;
      } catch (walkError) {
        break;
      }
    }
    return parts.join("/");
  }

  function assetKind(item) {
    if (item instanceof CompItem) return "comps";

    var source = null;
    try {
      source = item.mainSource;
    } catch (e) {
      source = null;
    }
    if (source && typeof SolidSource !== "undefined" && source instanceof SolidSource) return "solids";

    var name = "";
    try {
      name = item.file ? decodeURI(String(item.file.name)) : String(item.name);
    } catch (fileError) {
      name = String(item.name);
    }

    var kind = EXTENSIONS[extensionOf(name)];
    if (!kind) return "other";

    // A still image that After Effects gave a duration is a sequence.
    if (kind === "images") {
      try {
        if (source && source.isStill === false) return "footage";
      } catch (stillError) { /* treat it as an image */ }
    }
    return kind;
  }

  function isUsed(item) {
    if (item instanceof CompItem) return true;
    try {
      return item.usedIn && item.usedIn.length > 0;
    } catch (e) {
      return true;
    }
  }

  function eachItem(visit) {
    if (!app.project) return;
    for (var i = 1; i <= app.project.numItems; i++) {
      var item = null;
      try {
        item = app.project.item(i);
      } catch (e) {
        continue;
      }
      if (item) visit(item);
    }
  }

  // ------------------------------------------------------------ reduce

  /** The compositions selected in the Project panel right now. */
  function selectedComps() {
    var out = [];
    var selection;
    try {
      selection = app.project.selection;
    } catch (e) {
      return out;
    }
    for (var i = 0; selection && i < selection.length; i++) {
      if (selection[i] instanceof CompItem) out.push(selection[i]);
    }
    return out;
  }

  /**
   * Every item the compositions use, however deeply nested: layer sources,
   * and the layers of every precomp among them. This is what Reduce Project
   * keeps, and is only used to say beforehand how much it would remove.
   */
  function neededBy(comps) {
    var keep = {};
    var queue = [];
    var i;
    for (i = 0; i < comps.length; i++) queue.push(comps[i]);
    while (queue.length) {
      var item = queue.pop();
      if (keep["i" + item.id]) continue;
      keep["i" + item.id] = true;
      if (!(item instanceof CompItem)) continue;
      for (var l = 1; l <= item.numLayers; l++) {
        var source = null;
        try {
          source = item.layer(l).source || null;
        } catch (e) {
          source = null;
        }
        if (source && !keep["i" + source.id]) queue.push(source);
      }
    }
    return keep;
  }

  Flow.register("project.assets", {
    undo: null,
    run: function () {
      if (!app.project) throw Flow.error("NO_PROJECT", "Open a project first.");

      var assets = [];
      var folders = [];
      var empty = 0;
      var unused = 0;
      var keeping = selectedComps();
      var needed = neededBy(keeping);
      var reducible = 0;

      eachItem(function (item) {
        if (item instanceof FolderItem) {
          var path = folderPath(item);
          folders.push(path ? path + "/" + String(item.name) : String(item.name));
          try {
            if (item.numItems === 0) empty++;
          } catch (countError) { /* not empty as far as anyone can tell */ }
          return;
        }
        var used = isUsed(item);
        if (!used) unused++;
        if (keeping.length && !needed["i" + item.id]) reducible++;
        if (assets.length >= MAX_ASSETS) return;
        assets.push({
          id: item.id,
          name: String(item.name),
          kind: assetKind(item),
          folder: folderPath(item),
          used: used
        });
      });

      return {
        assets: assets,
        folders: folders,
        emptyFolders: empty,
        unused: unused,
        reduceKeep: keeping.length,
        reduceRemove: reducible
      };
    }
  });

  Flow.register("project.sort", {
    undo: "Sort Project",
    run: function (params, ctx) {
      var paths = readPaths(params, ctx);
      var raw = params ? params.moves : null;
      if (!(raw instanceof Array)) {
        throw Flow.error("INVALID_PARAMS", "Parameter 'moves' must be a list.");
      }

      // The folders first: a move has nowhere to go until they are there.
      var built = buildFolders(paths);
      var moved = 0;
      var missing = 0;

      // One pass over the project to find the items, rather than one pass per
      // move: a big project has hundreds of items and dozens of moves.
      var byId = {};
      eachItem(function (item) { byId["i" + item.id] = item; });

      for (var i = 0; i < raw.length && i < MAX_MOVES; i++) {
        var move = raw[i];
        if (!move || typeof move.itemId !== "number") continue;
        var item = byId["i" + move.itemId];
        var target = built.folders["p" + String(move.to)];
        if (!item || !target) {
          missing++;
          continue;
        }
        try {
          item.parentFolder = target;
          moved++;
        } catch (moveError) {
          missing++;
        }
      }

      if (missing) {
        ctx.warnings.push(missing === 1
          ? "One item could not be moved."
          : missing + " items could not be moved.");
      }
      return { moved: moved, created: built.created, missing: missing };
    }
  });

  // Empty folders nest, so removing the inner one can empty its parent. The
  // walk repeats until a pass removes nothing.
  function removeEmptyFolders() {
    var removed = 0;
    for (var pass = 0; pass < MAX_DEPTH + 2; pass++) {
      var found = [];
      eachItem(function (item) {
        if (!(item instanceof FolderItem)) return;
        try {
          if (item.numItems === 0) found.push(item);
        } catch (e) { /* leave it */ }
      });
      if (!found.length) return removed;
      for (var i = 0; i < found.length; i++) {
        try {
          found[i].remove();
          removed++;
        } catch (removeError) { /* leave it */ }
      }
    }
    return removed;
  }

  Flow.register("project.cleanup", {
    undo: "Clean Up Project",
    run: function (params) {
      var action = Flow.oneOf(params, "action", ["unused", "duplicates", "emptyFolders", "cache", "reduce"]);
      if (!app.project) throw Flow.error("NO_PROJECT", "Open a project first.");
      var removed = 0;

      if (action === "unused") {
        removed = app.project.removeUnusedFootage();
      } else if (action === "duplicates") {
        removed = app.project.consolidateFootage();
      } else if (action === "emptyFolders") {
        removed = removeEmptyFolders();
      } else if (action === "reduce") {
        // After Effects' own File > Dependencies > Reduce Project, on the
        // compositions selected now, not the ones the panel last saw.
        var keep = selectedComps();
        if (!keep.length) {
          throw Flow.error("NO_SELECTION", "Select the compositions to keep in the Project panel first.");
        }
        if (typeof app.project.reduceProject !== "function") {
          throw Flow.error("UNSUPPORTED", "This version of After Effects cannot reduce a project from a script.");
        }
        removed = app.project.reduceProject(keep);
      } else {
        // Purging is not an edit, so there is nothing for the undo group to
        // hold; it is in one for the sake of one shape for every command.
        if (typeof app.purge !== "function" || typeof PurgeTarget === "undefined") {
          throw Flow.error("UNSUPPORTED", "This version of After Effects cannot purge its cache from a script.");
        }
        app.purge(PurgeTarget.ALL_CACHES);
      }

      return { action: action, removed: removed };
    }
  });
})($.global.Flow);
