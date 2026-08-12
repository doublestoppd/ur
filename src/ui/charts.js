/*
 * charts.js - canvas chart renderer for the Graphs tab.
 *
 * Canvas rather than SVG so that "export this graph as PNG" is exact: the same
 * drawing code produces the screen chart and the exported image, with no
 * serialization step and no risk of a tainted canvas under file://.
 *
 * The palette is the validated categorical set (blue, orange, aqua, yellow in
 * fixed slot order, never cycled), with dark-mode steps chosen for the dark
 * surface rather than flipped. Colour is assigned by identity: a chart with one
 * measure uses one colour, because there is no identity to encode. Adjacent
 * pairs clear the colour-vision separation floors on both surfaces, and the two
 * light-mode slots that fall below 3:1 contrast are always accompanied by a
 * legend and a table view, which is the required relief.
 *
 * Every chart carries a legend when it has two or more series, selective direct
 * labels rather than a number on every mark, a hover tooltip, and a data table.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;
  var doc = global.document;

  /* ------------------------------------------------------------- palettes */

  var THEMES = {
    light: {
      surface: '#ffffff',
      series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'],
      status: { Blocking: '#d03b3b', Error: '#ec835a', Warning: '#fab219', Info: '#898781' },
      grid: '#e1e0d9',
      axis: '#c3c2b7',
      muted: '#898781',
      ink: '#0b0b0b',
      secondary: '#52514e',
      reference: '#52514e'
    },
    dark: {
      surface: '#1d242b',
      series: ['#3987e5', '#d95926', '#199e70', '#c98500'],
      status: { Blocking: '#d03b3b', Error: '#ec835a', Warning: '#fab219', Info: '#9aa9b7' },
      grid: '#2f3b46',
      axis: '#3d4a56',
      muted: '#9aa9b7',
      ink: '#e6ecf1',
      secondary: '#c3c2b7',
      reference: '#c3c2b7'
    }
  };

  var FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  function prefersDark() {
    return !!(global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function theme() { return prefersDark() ? THEMES.dark : THEMES.light; }

  /* Colour for one series, by slot or by reserved status role. */
  function seriesColor(spec, index, category, t) {
    if (spec.palette === 'status') {
      return t.status[category] || t.muted;
    }
    if (spec.series.length === 1) { return t.series[0]; }
    return t.series[index % t.series.length];
  }

  /* ---------------------------------------------------------------- scales */

  /* Axis scale arithmetic lives in chartData so it can be unit-tested. */
  function niceTicks(max, min, targetCount) {
    return UR.chartData.niceTicks(max, min, targetCount);
  }

  function maxValue(spec) {
    var max = 0;
    for (var s = 0; s < spec.series.length; s++) {
      for (var i = 0; i < spec.series[s].values.length; i++) {
        var v = spec.series[s].values[i];
        if (v !== null && v !== undefined && v > max) { max = v; }
      }
    }
    if (spec.reference && spec.reference.value > max) { max = spec.reference.value; }
    return max;
  }

  function fmt(value, decimals) {
    if (value === null || value === undefined) { return '-'; }
    return String(util.round(value, decimals === undefined ? 0 : decimals));
  }

  /* ---------------------------------------------------------------- shapes */

  /* Bar with rounded data-end; the baseline end stays square. */
  function barPath(ctx, x, y, w, h, radius, orientation) {
    var r = Math.max(0, Math.min(radius, Math.min(Math.abs(w), Math.abs(h)) / 2));
    ctx.beginPath();
    if (orientation === 'horizontal') {
      ctx.moveTo(x, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x, y + h);
    } else {
      ctx.moveTo(x, y + h);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h);
    }
    ctx.closePath();
    ctx.fill();
  }

  /* ----------------------------------------------------------- the drawing */

  /*
   * Draw one chart. Returns the hit-test marks in CSS pixels.
   * `opts.header` bakes the title and subtitle into the image (used for PNG
   * export, where the surrounding page is not present).
   */
  function draw(ctx, spec, width, height, t, opts) {
    var options = opts || {};
    var marks = [];
    var i, s;

    ctx.save();
    ctx.fillStyle = t.surface;
    ctx.fillRect(0, 0, width, height);
    ctx.textBaseline = 'middle';

    var top = 14;

    if (options.header) {
      ctx.fillStyle = t.ink;
      ctx.font = '600 15px ' + FONT;
      ctx.textAlign = 'left';
      ctx.fillText(spec.title, 16, top + 6);
      top += 22;
      ctx.fillStyle = t.muted;
      ctx.font = '11px ' + FONT;
      var subtitle = spec.subtitle.length > 130 ? spec.subtitle.slice(0, 127) + '...' : spec.subtitle;
      ctx.fillText(subtitle, 16, top + 5);
      top += 18;
    }

    /* ------------------------------------------------------------- legend */
    var showLegend = spec.series.length > 1;
    if (showLegend) {
      var lx = 16;
      ctx.font = '11px ' + FONT;
      ctx.textAlign = 'left';
      for (s = 0; s < spec.series.length; s++) {
        var color = seriesColor(spec, s, spec.series[s].name, t);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(lx + 4, top + 6, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = t.secondary;   /* text wears ink, never the series colour */
        ctx.fillText(spec.series[s].name, lx + 13, top + 6);
        lx += 13 + ctx.measureText(spec.series[s].name).width + 18;
      }
      top += 22;
    }

    if (spec.empty) {
      ctx.fillStyle = t.muted;
      ctx.font = '12px ' + FONT;
      ctx.textAlign = 'center';
      ctx.fillText(spec.empty, width / 2, (top + height) / 2);
      ctx.restore();
      return marks;
    }

    var horizontal = spec.form === 'hbar';
    var scale = niceTicks(maxValue(spec), 0, horizontal ? 4 : 5);

    /* --------------------------------------------------------- plot frame */
    /* Set the label font BEFORE measuring with it, or the gutter is sized
     * against whatever font the last drawing step happened to leave behind. */
    ctx.font = '11px ' + FONT;
    var padLeft = horizontal ? Math.min(190, longestLabelWidth(ctx, spec.categories) + 14) : 46;
    var padRight = horizontal ? 54 : 16;
    var padBottom = horizontal ? 26 : 34;
    var plotX = padLeft;
    var plotY = top;
    var plotW = Math.max(10, width - padLeft - padRight);
    var plotH = Math.max(10, height - top - padBottom);

    ctx.lineWidth = 1;
    ctx.font = '11px ' + FONT;

    if (horizontal) {
      /* Vertical gridlines for a horizontal magnitude scale. */
      for (i = 0; i < scale.ticks.length; i++) {
        var gx = Math.round(plotX + (scale.ticks[i] / scale.max) * plotW) + 0.5;
        ctx.strokeStyle = scale.ticks[i] === 0 ? t.axis : t.grid;
        ctx.beginPath();
        ctx.moveTo(gx, plotY);
        ctx.lineTo(gx, plotY + plotH);
        ctx.stroke();
        ctx.fillStyle = t.muted;
        ctx.textAlign = 'center';
        ctx.fillText(fmt(scale.ticks[i], 0), gx, plotY + plotH + 13);
      }
    } else {
      for (i = 0; i < scale.ticks.length; i++) {
        var gy = Math.round(plotY + plotH - (scale.ticks[i] / scale.max) * plotH) + 0.5;
        ctx.strokeStyle = scale.ticks[i] === 0 ? t.axis : t.grid;
        ctx.beginPath();
        ctx.moveTo(plotX, gy);
        ctx.lineTo(plotX + plotW, gy);
        ctx.stroke();
        ctx.fillStyle = t.muted;
        ctx.textAlign = 'right';
        ctx.fillText(fmt(scale.ticks[i], scale.max < 5 ? 1 : 0), plotX - 8, gy);
      }
    }

    /* ------------------------------------------------------- reference line */
    if (spec.reference && spec.reference.value <= scale.max) {
      var ry = Math.round(plotY + plotH - (spec.reference.value / scale.max) * plotH) + 0.5;
      ctx.save();
      ctx.strokeStyle = t.reference;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plotX, ry);
      ctx.lineTo(plotX + plotW, ry);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = t.secondary;
      ctx.textAlign = 'right';
      ctx.font = '10px ' + FONT;
      ctx.fillText(spec.reference.label, plotX + plotW, ry - 8);
      ctx.font = '11px ' + FONT;
    }

    /* ------------------------------------------------------------- marks */
    var n = spec.categories.length;

    if (horizontal) {
      var rowH = plotH / Math.max(1, n);
      var barH = Math.min(26, Math.max(6, rowH - 8));
      for (i = 0; i < n; i++) {
        var v = spec.series[0].values[i] || 0;
        var w = (v / scale.max) * plotW;
        var by = plotY + rowH * i + (rowH - barH) / 2;
        ctx.fillStyle = seriesColor(spec, 0, spec.categories[i], t);
        barPath(ctx, plotX, by, Math.max(v > 0 ? 2 : 0, w), barH, 4, 'horizontal');

        ctx.fillStyle = t.secondary;
        ctx.textAlign = 'left';
        ctx.fillText(fmt(v, spec.decimals), plotX + w + 8, by + barH / 2);

        ctx.fillStyle = t.muted;
        ctx.textAlign = 'right';
        ctx.fillText(clip(ctx, spec.categories[i], padLeft - 14), plotX - 10, by + barH / 2);

        marks.push({ x: plotX, y: by, w: Math.max(w, 2), h: barH, category: spec.categories[i], series: spec.series[0].name, value: v });
      }
    } else if (spec.form === 'line') {
      var stepX = n > 1 ? plotW / (n - 1) : 0;
      for (s = 0; s < spec.series.length; s++) {
        var color2 = seriesColor(spec, s, spec.series[s].name, t);
        ctx.strokeStyle = color2;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        var started = false;
        for (i = 0; i < n; i++) {
          var val = spec.series[s].values[i];
          if (val === null || val === undefined) { started = false; continue; }
          var px = n > 1 ? plotX + stepX * i : plotX + plotW / 2;
          var py = plotY + plotH - (val / scale.max) * plotH;
          if (!started) { ctx.moveTo(px, py); started = true; } else { ctx.lineTo(px, py); }
        }
        ctx.stroke();

        /* Markers only when they will not crowd: 8px diameter needs 12px pitch. */
        if (n <= 40 && (n <= 1 || stepX >= 12)) {
          for (i = 0; i < n; i++) {
            var mv = spec.series[s].values[i];
            if (mv === null || mv === undefined) { continue; }
            var mx = n > 1 ? plotX + stepX * i : plotX + plotW / 2;
            var my = plotY + plotH - (mv / scale.max) * plotH;
            ctx.fillStyle = t.surface;      /* 2px surface ring on overlap */
            ctx.beginPath();
            ctx.arc(mx, my, 5.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = color2;
            ctx.beginPath();
            ctx.arc(mx, my, 4, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      /* Hit targets: one column per category, covering every series. */
      for (i = 0; i < n; i++) {
        var hx = n > 1 ? plotX + stepX * i : plotX + plotW / 2;
        var values = [];
        for (s = 0; s < spec.series.length; s++) { values.push(spec.series[s].values[i]); }
        marks.push({
          x: hx - Math.max(6, stepX / 2), y: plotY, w: Math.max(12, stepX), h: plotH,
          category: spec.categories[i], allSeries: true, values: values
        });
      }
    } else {
      /* bar and groupedBar */
      var slotW = plotW / Math.max(1, n);
      var count = spec.series.length;
      var gap = 2;                                  /* surface gap between bars */
      var groupW = Math.min(slotW - 10, 46 * count);
      var barW = Math.max(3, (groupW - gap * (count - 1)) / count);

      for (i = 0; i < n; i++) {
        var gx0 = plotX + slotW * i + (slotW - (barW * count + gap * (count - 1))) / 2;
        for (s = 0; s < count; s++) {
          var bv = spec.series[s].values[i];
          if (bv === null || bv === undefined) { continue; }
          var bh = (bv / scale.max) * plotH;
          var bx = gx0 + s * (barW + gap);
          var by2 = plotY + plotH - bh;
          ctx.fillStyle = seriesColor(spec, s, spec.categories[i], t);
          barPath(ctx, bx, by2, barW, Math.max(bh, bv > 0 ? 2 : 0), 4, 'vertical');

          /* Direct labels only when there is room for them to be read. */
          if (n * count <= 16 && bv > 0) {
            ctx.fillStyle = t.secondary;
            ctx.textAlign = 'center';
            ctx.font = '10px ' + FONT;
            ctx.fillText(fmt(bv, spec.decimals), bx + barW / 2, by2 - 8);
            ctx.font = '11px ' + FONT;
          }
          marks.push({ x: bx, y: by2, w: barW, h: Math.max(bh, 2), category: spec.categories[i], series: spec.series[s].name, value: bv });
        }
      }
    }

    /* --------------------------------------------------- category axis */
    if (!horizontal) {
      var labels = spec.axisLabels || spec.categories;
      ctx.fillStyle = t.muted;
      ctx.textAlign = 'center';
      var slot = plotW / Math.max(1, n);
      var every = 1;
      var widest = longestLabelWidth(ctx, labels);
      var avail = spec.form === 'line' ? (n > 1 ? plotW / (n - 1) : plotW) : slot;
      while (widest + 8 > avail * every && every < n) { every++; }

      /*
       * Stepping alone is not enough: the final label often lands a pixel or two
       * from a stepped one and the two collide. Track the right edge of the last
       * label actually drawn and drop anything that would overlap it.
       */
      var drawnRight = -1e9;
      for (i = 0; i < n; i++) {
        if (i % every !== 0 && i !== n - 1) { continue; }
        var text = String(labels[i]);
        var cx = spec.form === 'line'
          ? (n > 1 ? plotX + (plotW / (n - 1)) * i : plotX + plotW / 2)
          : plotX + slot * i + slot / 2;
        var textW = ctx.measureText(text).width;
        var left = cx - textW / 2;
        if (left + textW > plotX + plotW) { left = plotX + plotW - textW; }
        if (left < plotX) { left = plotX; }
        if (left < drawnRight + 6) { continue; }
        ctx.textAlign = 'left';
        ctx.fillText(text, left, plotY + plotH + 15);
        drawnRight = left + textW;
      }
      ctx.textAlign = 'center';
      if (spec.valueLabel) {
        ctx.save();
        ctx.translate(12, plotY + plotH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillStyle = t.muted;
        ctx.font = '10px ' + FONT;
        ctx.fillText(spec.valueLabel, 0, 0);
        ctx.restore();
      }
    }

    ctx.restore();
    return marks;
  }

  function longestLabelWidth(ctx, labels) {
    var max = 0;
    for (var i = 0; i < labels.length; i++) {
      var w = ctx.measureText(String(labels[i])).width;
      if (w > max) { max = w; }
    }
    return max;
  }

  function clip(ctx, text, maxWidth) {
    var s = String(text);
    if (ctx.measureText(s).width <= maxWidth) { return s; }
    while (s.length > 1 && ctx.measureText(s + '...').width > maxWidth) { s = s.slice(0, -1); }
    return s + '...';
  }

  /* ------------------------------------------------------------ chart card */

  function heightFor(spec) {
    if (spec.form === 'hbar') {
      return Math.max(180, 46 + spec.categories.length * 30);
    }
    return 280;
  }

  function el(tag, attrs, children) {
    var node = doc.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') { node.className = attrs[k]; }
        else if (k === 'text') { node.textContent = attrs[k]; }
        else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') { node.addEventListener(k.slice(2), attrs[k]); }
        else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) { node.setAttribute(k, attrs[k]); }
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) { return; }
      node.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
    });
    return node;
  }

  function fileSafe(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  /*
   * Build one chart card: header, canvas, PNG button, table toggle.
   * Returns { spec, redraw, exportPNG, node }.
   */
  function createCard(spec, options) {
    var opts = options || {};
    var canvas = el('canvas', { class: 'chart-canvas' });
    var tooltip = el('div', { class: 'chart-tooltip', hidden: 'hidden' });
    var plot = el('div', { class: 'chart-plot' }, [canvas, tooltip]);
    var marks = [];
    var drawn = { width: 0, height: 0 };   /* the coordinate space `marks` live in */
    var status = el('span', { class: 'chart-status' });

    var tableWrap = el('div', { class: 'chart-table', hidden: 'hidden' });
    var tableBuilt = false;

    function buildTable() {
      if (tableBuilt) { return; }
      var data = UR.chartData.toTable(spec);
      var thead = el('thead', null, [el('tr', null, data.header.map(function (h) { return el('th', { text: h }); }))]);
      var tbody = el('tbody', null, data.rows.map(function (r) {
        return el('tr', null, r.map(function (c, idx) {
          return el('td', { class: idx ? 'num' : null, text: String(c) });
        }));
      }));
      tableWrap.appendChild(el('div', { class: 'table-wrap' }, [el('table', null, [thead, tbody])]));
      tableBuilt = true;
    }

    function redraw() {
      var t = theme();
      var cssWidth = Math.max(280, plot.clientWidth || opts.width || 640);
      var cssHeight = heightFor(spec);
      var dpr = global.devicePixelRatio || 1;
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      canvas.style.width = cssWidth + 'px';
      canvas.style.height = cssHeight + 'px';
      var ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      marks = draw(ctx, spec, cssWidth, cssHeight, t, { header: false });
      drawn.width = cssWidth;
      drawn.height = cssHeight;
    }

    /*
     * PNG export renders on a fresh canvas at 2x with the title and subtitle
     * baked in, always on the light surface so the image drops cleanly into a
     * document regardless of the screen theme.
     */
    function exportPNG(then) {
      var width = Math.max(720, plot.clientWidth || 720);
      var height = heightFor(spec) + 44;
      var out = doc.createElement('canvas');
      var scale = 2;
      out.width = width * scale;
      out.height = height * scale;
      var ctx = out.getContext('2d');
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      draw(ctx, spec, width, height, THEMES.light, { header: true });

      var name = 'UR-' + fileSafe(spec.title) + (opts.periodLabel ? '-' + fileSafe(opts.periodLabel) : '') + '.png';
      if (out.toBlob) {
        out.toBlob(function (blob) { then(blob, name); }, 'image/png');
      } else {
        then(dataURLToBlob(out.toDataURL('image/png')), name);
      }
    }

    function dataURLToBlob(url) {
      var parts = url.split(',');
      var binary = global.atob(parts[1]);
      var bytes = new global.Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
      return new global.Blob([bytes], { type: 'image/png' });
    }

    /* --------------------------------------------------------- hover layer */
    canvas.addEventListener('mousemove', function (ev) {
      var rect = canvas.getBoundingClientRect();
      /*
       * Marks are recorded in the coordinate space the chart was last drawn in.
       * If CSS has since stretched the canvas - a resize between redraws - the
       * pointer has to be mapped back into that space or every hit test misses.
       */
      var sx = rect.width ? drawn.width / rect.width : 1;
      var sy = rect.height ? drawn.height / rect.height : 1;
      var x = (ev.clientX - rect.left) * sx;
      var y = (ev.clientY - rect.top) * sy;
      var hit = null;
      for (var i = 0; i < marks.length; i++) {
        var m = marks[i];
        /* Hit targets are generous: bars extend to the full plot height. */
        var withinX = x >= m.x - 2 && x <= m.x + m.w + 2;
        var withinY = m.allSeries ? (y >= m.y && y <= m.y + m.h) : (y >= m.y - 6 && y <= m.y + m.h + 6);
        if (withinX && withinY) { hit = m; break; }
      }
      if (!hit) { tooltip.hidden = true; return; }

      var lines = [hit.category];
      if (hit.allSeries) {
        for (var s = 0; s < spec.series.length; s++) {
          lines.push(spec.series[s].name + ': ' + fmt(hit.values[s], spec.decimals));
        }
      } else {
        lines.push((spec.series.length > 1 ? hit.series + ': ' : '') + fmt(hit.value, spec.decimals) + ' ' + (spec.valueLabel || '').toLowerCase());
      }
      tooltip.textContent = lines.join('  |  ');
      tooltip.hidden = false;
      var tw = tooltip.offsetWidth;
      tooltip.style.left = Math.max(4, Math.min(x - tw / 2, canvas.clientWidth - tw - 4)) + 'px';
      tooltip.style.top = Math.max(0, y - 34) + 'px';
    });
    canvas.addEventListener('mouseleave', function () { tooltip.hidden = true; });

    /* Rule ids become jumps into the Calculation Reference when the host
     * provides a handler; this module stays ignorant of navigation. */
    var rules = null;
    if (spec.ruleIds && spec.ruleIds.length) {
      rules = el('span', { class: 'chart-rules' });
      spec.ruleIds.slice(0, 6).forEach(function (id, index) {
        if (index > 0) { rules.appendChild(doc.createTextNode(', ')); }
        if (opts.onRuleClick) {
          rules.appendChild(el('button', {
            type: 'button', class: 'rule-link',
            title: 'Open ' + id + ' in the Calculation Reference',
            onclick: function () { opts.onRuleClick(id); }
          }, [id]));
        } else {
          rules.appendChild(doc.createTextNode(id));
        }
      });
    }

    var card = el('figure', { class: 'chart-card', id: 'chart-' + spec.id }, [
      el('figcaption', null, [
        el('h4', { text: spec.title }),
        el('p', { class: 'chart-subtitle', text: spec.subtitle }),
        rules
      ]),
      plot,
      el('div', { class: 'chart-actions' }, [
        opts.onExpand ? el('button', {
          type: 'button', class: 'link',
          title: 'Open a larger version of this graph',
          onclick: function () { opts.onExpand(spec); }
        }, ['Expand']) : null,
        el('button', {
          type: 'button', class: 'link',
          title: 'Saves a PNG on a light background, sized for a document',
          onclick: function () {
            exportPNG(function (blob, name) {
              opts.download(blob, name, 'image/png');
              status.textContent = 'Saved ' + name;
            });
          }
        }, ['Export PNG']),
        el('button', {
          type: 'button', class: 'link',
          onclick: function (ev) {
            buildTable();
            tableWrap.hidden = !tableWrap.hidden;
            ev.target.textContent = tableWrap.hidden ? 'Show data table' : 'Hide data table';
          }
        }, ['Show data table']),
        status
      ]),
      tableWrap
    ]);

    return { spec: spec, node: card, redraw: redraw, exportPNG: exportPNG };
  }

  var charts = {
    THEMES: THEMES,
    niceTicks: niceTicks,
    draw: draw,

    /*
     * Render every chart for a run into `container`.
     * `options.download(blob, filename, mime)` performs the actual save so this
     * module never touches the DOM's download plumbing itself.
     */
    render: function (container, specs, options) {
      var opts = options || {};
      var cards = [];
      while (container.firstChild) { container.removeChild(container.firstChild); }

      specs.forEach(function (spec) {
        var card = createCard(spec, opts);
        container.appendChild(card.node);
        cards.push(card);
      });
      /* Draw after layout so each canvas can measure its container. */
      cards.forEach(function (c) { c.redraw(); });

      /*
       * A transient render (the Expand modal) draws once and must not steal
       * the resize/theme handlers from the chart grid behind it.
       */
      if (!opts.transient) {
        if (charts._resize) { global.removeEventListener('resize', charts._resize); }
        charts._resize = debounce(function () { cards.forEach(function (c) { c.redraw(); }); }, 150);
        global.addEventListener('resize', charts._resize);

        if (global.matchMedia) {
          var mq = global.matchMedia('(prefers-color-scheme: dark)');
          var onTheme = function () { cards.forEach(function (c) { c.redraw(); }); };
          if (mq.addEventListener) { mq.addEventListener('change', onTheme); }
          else if (mq.addListener) { mq.addListener(onTheme); }
        }
      }

      return cards;
    },

    /* Export every chart in sequence, one PNG per graph. */
    exportAll: function (cards, download, onProgress) {
      var index = 0;
      function next() {
        if (index >= cards.length) {
          if (onProgress) { onProgress(cards.length, cards.length); }
          return;
        }
        var card = cards[index++];
        card.exportPNG(function (blob, name) {
          download(blob, name, 'image/png');
          if (onProgress) { onProgress(index, cards.length); }
          /* Browsers throttle rapid successive downloads; pace them. */
          global.setTimeout(next, 350);
        });
      }
      next();
    }
  };

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      if (timer) { global.clearTimeout(timer); }
      timer = global.setTimeout(fn, wait);
    };
  }

  UR.charts = charts;

})(typeof globalThis !== 'undefined' ? globalThis : this);
