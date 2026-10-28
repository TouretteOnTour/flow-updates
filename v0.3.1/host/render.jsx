// Render: put compositions into After Effects' render queue with the right
// settings, and either render them, hand them to Adobe Media Encoder, or leave
// them queued.
//
//   render.info   what the panel needs to draw the page: the compositions in
//                 the project and the templates this After Effects offers.
//   render.queue  queue the chosen compositions and start them off.
//
// Why templates rather than settings: After Effects gives scripts no way into
// the codec dialogs. There is no API for "H.264 at 20 Mbit" - the only thing a
// script can do is apply an **output module template**, which is where those
// settings already live. So Flow reads the templates this installation has and
// offers those. Anyone who needs a format that is not there makes it once in
// After Effects (Output Module > Make Template) and it appears in the list.
//
// The render queue is not part of the undo stack, so nothing here opens an
// undo group; there would be nothing in it.

(function (Flow) {
  if (!Flow) return;

  var MAX_TARGETS = 200;
  var MAX_NAME = 160;

  // Templates whose name starts with this are After Effects' own internals and
  // are not offered in its interface either.
  var HIDDEN_PREFIX = "_HIDDEN";

  // ------------------------------------------------------------ small utils

  function trim(text) {
    return String(text).replace(/^\s+/, "").replace(/\s+$/, "");
  }

  function visibleTemplates(list) {
    var out = [];
    for (var i = 0; list && i < list.length; i++) {
      var name = String(list[i]);
      if (name.substring(0, HIDDEN_PREFIX.length) === HIDDEN_PREFIX) continue;
      out.push(name);
    }
    return out;
  }

  // File.name is URI-encoded ("a%20b.mp4"), which is not what anyone wants to
  // read or to take an extension from.
  function fileName(file) {
    if (!file) return "";
    try {
      return decodeURI(String(file.name));
    } catch (e) {
      return String(file.name);
    }
  }

  /**
   * What After Effects would call this file, minus the part Flow replaces.
   * For a movie that is ".mp4"; for an image sequence it is "_[#####].tif",
   * because the frame-number token belongs to the format, not to the name.
   */
  function outputSuffix(file) {
    var name = fileName(file);
    var dot = name.lastIndexOf(".");
    var extension = dot > 0 ? name.substring(dot) : "";
    var token = /(_?\[#+\])/.exec(name);
    return (token ? token[1] : "") + extension;
  }

  function projectComps() {
    var out = [];
    if (!app.project) return out;
    for (var i = 1; i <= app.project.numItems; i++) {
      var item = app.project.item(i);
      if (item instanceof CompItem) out.push(item);
    }
    return out;
  }

  function isSelected(comp) {
    try {
      return comp.selected === true;
    } catch (e) {
      return false;
    }
  }

  function compById(id) {
    var comps = projectComps();
    for (var i = 0; i < comps.length; i++) if (comps[i].id === id) return comps[i];
    return null;
  }

  function renderQueue() {
    if (!app.project || !app.project.renderQueue) {
      throw Flow.error("NO_PROJECT", "Open a project first.");
    }
    return app.project.renderQueue;
  }

  // ------------------------------------------------------------ render.info

  /**
   * Reading the template lists needs a render queue item, because that is the
   * only object that has them. One is added for the first composition and
   * removed again, which leaves the queue exactly as it was.
   */
  function readTemplates(comps) {
    var empty = { render: [], output: [] };
    if (!comps.length) return empty;

    var queue = renderQueue();
    var item = null;
    try {
      item = queue.items.add(comps[0]);
      return {
        render: visibleTemplates(item.templates),
        output: visibleTemplates(item.outputModule(1).templates)
      };
    } catch (e) {
      return empty;
    } finally {
      if (item) {
        try { item.remove(); } catch (removeError) { /* nothing else to try */ }
      }
    }
  }

  Flow.register("render.info", {
    undo: null,
    run: function (params) {
      if (!app.project) throw Flow.error("NO_PROJECT", "Open a project first.");

      var comps = projectComps();
      var queue = renderQueue();
      var busy = false;
      try {
        busy = queue.rendering === true;
      } catch (e) {
        busy = false;
      }
      var list = [];
      for (var i = 0; i < comps.length; i++) {
        list.push({
          id: comps[i].id,
          name: String(comps[i].name),
          width: comps[i].width,
          height: comps[i].height,
          duration: comps[i].duration,
          frameRate: comps[i].frameRate,
          selected: isSelected(comps[i])
        });
      }

      // Never touch the queue while it is rendering, and only when the panel
      // actually needs the lists.
      var templates = (Flow.bool(params, "templates", false) && !busy)
        ? readTemplates(comps)
        : { render: [], output: [] };
      var file = app.project.file;
      return {
        comps: list,
        renderTemplates: templates.render,
        outputTemplates: templates.output,
        projectName: file ? String(file.name).replace(/\.aep$/i, "") : "",
        projectFolder: file ? String(file.parent.fsName) : "",
        saved: !!file,
        unsavedChanges: app.project.dirty === true,
        queued: queue.numItems,
        rendering: busy
      };
    }
  });

  // ------------------------------------------------------------ render.queue

  function readTargets(params) {
    var raw = params ? params.targets : null;
    if (!(raw instanceof Array) || !raw.length) {
      throw Flow.error("NO_SELECTION", "Choose at least one composition to render.");
    }
    if (raw.length > MAX_TARGETS) {
      throw Flow.error("INVALID_PARAMS", "That is more than " + MAX_TARGETS + " compositions.");
    }

    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var entry = raw[i];
      if (!entry || typeof entry.compId !== "number") {
        throw Flow.error("INVALID_PARAMS", "Every target needs a composition.");
      }
      var comp = compById(entry.compId);
      if (!comp) {
        throw Flow.error("NO_ACTIVE_COMP", "A composition Flow was asked to render is no longer in the project.");
      }
      var name = trim(String(entry.name === undefined ? "" : entry.name));
      if (name.length > MAX_NAME) name = name.substring(0, MAX_NAME);
      if (!name) name = String(comp.name);
      out.push({ comp: comp, name: name });
    }
    return out;
  }

  function outputFolder(params) {
    var path = trim(String(params && params.folder ? params.folder : ""));
    if (!path) throw Flow.error("INVALID_PARAMS", "Choose a folder to export to.");
    var folder = new Folder(path);
    if (!folder.exists) {
      try {
        folder.create();
      } catch (e) { /* the check below reports it */ }
    }
    if (!new Folder(path).exists) {
      throw Flow.error("INVALID_PARAMS", "That export folder does not exist and could not be created:\n" + path);
    }
    return folder;
  }

  Flow.register("render.queue", {
    undo: null,
    run: function (params, ctx) {
      var destination = Flow.oneOf(params, "destination", ["queue", "ae", "ame"]);
      var startInAme = Flow.bool(params, "startInAme", true);
      var renderTemplate = Flow.str(params, "renderTemplate", "", 120);
      var outputTemplate = Flow.str(params, "outputTemplate", "", 120);

      // Everything is worked out before a single item is added, because the
      // render queue has no undo to fall back on.
      var targets = readTargets(params);
      var folder = outputFolder(params);
      var queue = renderQueue();

      // Other people's queue items must not be swept along. Their render flags
      // are turned off for the duration and put back in the finally below.
      var previous = [];
      var i;
      for (i = 1; i <= queue.numItems; i++) {
        var existing = queue.item(i);
        previous.push({ item: existing, render: existing.render });
      }

      var added = [];
      var files = [];
      var overwritten = [];
      var rendered = false;
      var sentToAme = false;

      try {
        if (destination !== "queue") {
          for (i = 0; i < previous.length; i++) {
            try { previous[i].item.render = false; } catch (flagError) { /* leave it be */ }
          }
        }

        for (i = 0; i < targets.length; i++) {
          var item = queue.items.add(targets[i].comp);
          added.push(item);
          if (renderTemplate) item.applyTemplate(renderTemplate);

          var om = item.outputModule(1);
          if (outputTemplate) om.applyTemplate(outputTemplate);

          // The suffix is read after the template is applied, so the file ends
          // up with the extension that template actually writes.
          var path = folder.fsName + "/" + targets[i].name + outputSuffix(om.file);
          var out = new File(path);
          if (out.exists) overwritten.push(String(out.fsName));
          om.file = out;
          files.push(String(new File(path).fsName));
        }

        if (destination === "ae") {
          queue.render();
          rendered = true;
        } else if (destination === "ame") {
          if (typeof queue.queueInAME !== "function") {
            throw Flow.error("UNSUPPORTED", "This version of After Effects cannot hand a render to Media Encoder.");
          }
          // Media Encoder renders the project file from disk, so a project that
          // has never been saved has nothing for it to open.
          if (!app.project.file) {
            throw Flow.error("NOT_SAVED", "Save the project first. Media Encoder renders it from the saved file.");
          }
          if (app.project.dirty === true) {
            ctx.warnings.push("The project has unsaved changes. Media Encoder renders the saved version.");
          }
          queue.queueInAME(startInAme);
          sentToAme = true;
        }
      } finally {
        for (i = 0; i < previous.length; i++) {
          try { previous[i].item.render = previous[i].render; } catch (restoreError) { /* leave it be */ }
        }
      }

      if (overwritten.length) {
        ctx.warnings.push(overwritten.length === 1
          ? "One file was already there and will be written over."
          : overwritten.length + " files were already there and will be written over.");
      }
      if (destination !== "queue" && previous.length) {
        ctx.warnings.push(previous.length === 1
          ? "One item was already in the render queue; it was left alone."
          : previous.length + " items were already in the render queue; they were left alone.");
      }

      return {
        added: added.length,
        rendered: rendered,
        sentToAme: sentToAme,
        files: files,
        overwritten: overwritten
      };
    }
  });

})($.global.Flow);
