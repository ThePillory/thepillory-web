// Maps on /explore/: draws a map from pre-projected SVG paths (data/geo/,
// built by tools/build_geo.mjs) inside each [data-map] figure. Every shape is a
// link (its page is also in the list beside the map). Zoom with the buttons,
// pinch, or drag once zoomed in; at normal size a swipe still scrolls the page.
// A [data-still] map (the hub) never zooms or drags: taps only.
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  var cache = {};

  function load(url) {
    if (!cache[url]) {
      cache[url] = fetch(url, { credentials: "same-origin" }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
    }
    return cache[url];
  }

  function init(fig) {
    var canvas = fig.querySelector("[data-map-canvas]");
    var zoomBox = fig.querySelector("[data-map-zoom]");
    var meta = JSON.parse(fig.querySelector("[data-map-links]").textContent);
    var src = fig.getAttribute("data-src");
    var layered = src.indexOf("{layer}") >= 0;
    var still = fig.hasAttribute("data-still");
    var view = null; // [x, y, w, h]
    var base = null;
    var svg = null;
    var moved = false;

    function setView(v) {
      // Keep the view inside the map and no smaller than 1/12 of it.
      var w = Math.max(base[2] / 12, Math.min(base[2], v[2]));
      var h = (w * base[3]) / base[2];
      var x = Math.max(base[0], Math.min(base[0] + base[2] - w, v[0]));
      var y = Math.max(base[1], Math.min(base[1] + base[3] - h, v[1]));
      view = [x, y, w, h];
      svg.setAttribute("viewBox", view.join(" "));
      if (still) return;
      // Zoomed in, one finger pans the map; at full size it scrolls the page.
      svg.style.touchAction = w < base[2] - 0.5 ? "none" : "pan-y";
      svg.classList.toggle("is-zoomed", w < base[2] - 0.5);
    }

    function zoomAt(factor, cx, cy) {
      var w = view[2] / factor;
      var h = view[3] / factor;
      setView([cx - ((cx - view[0]) / view[2]) * w, cy - ((cy - view[1]) / view[3]) * h, w, h]);
    }

    function toSvg(clientX, clientY) {
      var r = svg.getBoundingClientRect();
      return [view[0] + ((clientX - r.left) / r.width) * view[2], view[1] + ((clientY - r.top) / r.height) * view[3]];
    }

    function draw(layer) {
      var url = layered ? src.replace("{layer}", layer) : src;
      canvas.setAttribute("aria-busy", "true");
      load(url)
        .then(function (data) {
          var links = (layered ? meta.links[layer] : meta.links) || {};
          var status = meta.status || {};
          svg = document.createElementNS(NS, "svg");
          svg.setAttribute("class", "map-svg");
          svg.setAttribute("role", "img");
          svg.setAttribute("aria-label", fig.getAttribute("aria-label") || "Map");
          base = data.viewBox.split(" ").map(Number);
          var shapes = data.paths || data.states;
          shapes.forEach(function (s) {
            var id = s.id || s.st;
            var link = links[id];
            var path = document.createElementNS(NS, "path");
            path.setAttribute("d", s.d);
            // A state can have more than one status ("live here": a live community, and the visitor's state).
            path.setAttribute("class", "map-shape" + (status[id] ? " is-" + String(status[id]).split(" ").join(" is-") : ""));
            if (!link) {
              svg.appendChild(path);
              return;
            }
            var a = document.createElementNS(NS, "a");
            a.setAttribute("href", link[0]);
            var t = document.createElementNS(NS, "title");
            t.textContent = link[1];
            a.appendChild(t);
            a.appendChild(path);
            a.addEventListener("click", function (e) {
              if (moved) e.preventDefault();
            });
            svg.appendChild(a);
          });
          canvas.textContent = "";
          canvas.appendChild(svg);
          canvas.removeAttribute("aria-busy");
          setView(base);
          if (zoomBox) zoomBox.hidden = false;
          if (!still) gestures();
        })
        .catch(function () {
          canvas.innerHTML = '<p class="small secondary">The map couldn\'t load. Everything on it is in the lists below.</p>';
        });
    }

    function gestures() {
      var pts = {};
      var start = null;
      svg.addEventListener("pointerdown", function (e) {
        pts[e.pointerId] = [e.clientX, e.clientY];
        moved = false;
        start = { view: view.slice(), pts: JSON.parse(JSON.stringify(pts)) };
      });
      svg.addEventListener("pointermove", function (e) {
        if (!pts[e.pointerId] || !start) return;
        pts[e.pointerId] = [e.clientX, e.clientY];
        var ids = Object.keys(pts);
        var r = svg.getBoundingClientRect();
        var scale = start.view[2] / r.width;
        if (ids.length >= 2 && start.pts[ids[0]] && start.pts[ids[1]]) {
          // Pinch: zoom around the midpoint.
          var a0 = start.pts[ids[0]], b0 = start.pts[ids[1]], a1 = pts[ids[0]], b1 = pts[ids[1]];
          var d0 = Math.hypot(a0[0] - b0[0], a0[1] - b0[1]) || 1;
          var d1 = Math.hypot(a1[0] - b1[0], a1[1] - b1[1]) || 1;
          var f = d1 / d0;
          var mx = (a0[0] + b0[0]) / 2, my = (a0[1] + b0[1]) / 2;
          var cx = start.view[0] + (mx - r.left) * scale, cy = start.view[1] + (my - r.top) * scale;
          var w = start.view[2] / f, h = start.view[3] / f;
          setView([cx - (cx - start.view[0]) / f, cy - (cy - start.view[1]) / f, w, h]);
          moved = true;
          e.preventDefault();
        } else if (svg.classList.contains("is-zoomed")) {
          var p0 = start.pts[e.pointerId];
          if (!p0) return;
          var dx = e.clientX - p0[0], dy = e.clientY - p0[1];
          if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
          if (moved) setView([start.view[0] - dx * scale, start.view[1] - dy * scale, start.view[2], start.view[3]]);
        }
      });
      function end(e) {
        delete pts[e.pointerId];
        start = Object.keys(pts).length ? { view: view.slice(), pts: JSON.parse(JSON.stringify(pts)) } : null;
      }
      svg.addEventListener("pointerup", end);
      svg.addEventListener("pointercancel", end);
      svg.addEventListener("pointerleave", end);
      // Ctrl + wheel (and trackpad pinch) zooms; a plain wheel scrolls the page.
      svg.addEventListener("wheel", function (e) {
        if (!e.ctrlKey) return;
        e.preventDefault();
        var p = toSvg(e.clientX, e.clientY);
        zoomAt(e.deltaY < 0 ? 1.25 : 0.8, p[0], p[1]);
      }, { passive: false });
    }

    if (zoomBox) {
      zoomBox.addEventListener("click", function (e) {
        var b = e.target.closest("[data-zoom]");
        if (!b || !svg) return;
        var k = b.getAttribute("data-zoom");
        if (k === "reset") return setView(base);
        zoomAt(k === "in" ? 1.6 : 1 / 1.6, view[0] + view[2] / 2, view[1] + view[3] / 2);
      });
    }

    // Layer toggles redraw without reloading the page; the links still work without JavaScript.
    fig.querySelectorAll("[data-layer]").forEach(function (t) {
      if (t === fig) return;
      t.addEventListener("click", function (e) {
        e.preventDefault();
        var layer = t.getAttribute("data-layer");
        fig.querySelectorAll(".map-layers [data-layer]").forEach(function (x) {
          if (x.getAttribute("data-layer") === layer) x.setAttribute("aria-current", "true");
          else x.removeAttribute("aria-current");
        });
        fig.setAttribute("data-layer", layer);
        history.replaceState(null, "", "?layer=" + layer + "#map");
        draw(layer);
      });
    });

    draw(fig.getAttribute("data-layer"));
  }

  document.querySelectorAll("[data-map]").forEach(init);

  // "Find a county": filters the list as you type.
  document.querySelectorAll("[data-filter-list]").forEach(function (input) {
    var list = document.getElementById(input.getAttribute("data-filter-list"));
    var none = document.getElementById(input.getAttribute("data-filter-none"));
    input.hidden = false;
    input.addEventListener("input", function () {
      var q = input.value.trim().toLowerCase();
      var shown = 0;
      list.querySelectorAll("li").forEach(function (li) {
        var hit = !q || li.textContent.toLowerCase().indexOf(q) >= 0;
        li.hidden = !hit;
        if (hit) shown++;
      });
      if (none) none.hidden = shown > 0;
    });
  });
})();
