// export.js - Handles animated GIF recording and exporting with gif.js
//
// REQUIRES: gif.worker.js saved next to index.html
//   https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js

async function exportGIF() {
  if (isReplaying) return;

  const currentContinent = document.getElementById('continentSelect').value;
  const filteredLog = historyLog.filter(entry => entry.continent === currentContinent);

  if (filteredLog.length === 0) {
    alert('No history changes recorded for this region to export yet!');
    return;
  }

  isReplaying = true;
  closeInfoPanel();

  const replayBtn = document.getElementById('replayBtn');
  const exportBtn = document.getElementById('exportBtn');
  const continentSelect = document.getElementById('continentSelect');
  const listEl = document.getElementById('historyList');

  if (replayBtn) replayBtn.disabled = true;
  if (exportBtn) exportBtn.disabled = true;
  if (continentSelect) continentSelect.disabled = true;

  listEl.innerHTML = '<li><em>Preparing animation frames...</em></li>';

  let exportTimeout = null;
  let currentLabels = [];
  let finalState = null;
  let stateWiped = false;

  const resetUI = () => {
    isReplaying = false;
    if (replayBtn) replayBtn.disabled = false;
    if (exportBtn) exportBtn.disabled = false;
    if (continentSelect) continentSelect.disabled = false;
    renderHistoryUI();
  };

  try {
    const isMobile = /Mobi|Android/i.test(navigator.userAgent);

    // ---------- Fit the map to the changed regions ----------
    const activeFeatureIds = new Set();
    filteredLog.forEach(entry => {
      if (entry.id) activeFeatureIds.add(entry.id);
    });

    const changedFeaturesList = rawFeatures.filter(f => activeFeatureIds.has(getFeatureId(f)));

    let currentBounds = null;
    changedFeaturesList.forEach(feat => {
      try {
        const b = L.geoJSON(feat).getBounds();
        if (!currentBounds) {
          currentBounds = L.latLngBounds(b.getSouthWest(), b.getNorthEast());
        } else {
          currentBounds.extend(b);
        }
      } catch (e) {}
    });

    if (currentBounds && currentBounds.isValid()) {
      map.fitBounds(currentBounds, { animate: false, padding: [60, 60] });
    } else {
      const continentBounds = CONTINENT_BOUNDS[currentContinent];
      if (continentBounds) {
        map.fitBounds(continentBounds, { animate: false, padding: [30, 30] });
      }
    }
    await new Promise(resolve => setTimeout(resolve, 400));
    currentBounds = map.getBounds();

    const everActiveKeys = new Set();
    filteredLog.forEach(e => {
      if (e.from) everActiveKeys.add(e.from);
      if (e.to) everActiveKeys.add(e.to);
      if (e.targetCountryObj && e.targetCountryObj.key) everActiveKeys.add(e.targetCountryObj.key);
    });

    // ---------- Country labels (centroids cached per feature) ----------
    const centroidCache = new Map();
    function getCachedCentroid(feat) {
      const id = getFeatureId(feat);
      if (!centroidCache.has(id)) {
        const c = turf.centroid(feat).geometry.coordinates;
        centroidCache.set(id, L.latLng(c[1], c[0]));
      }
      return centroidCache.get(id);
    }

    // Builds a plain list of labels; they are drawn straight onto each
    // frame's canvas (crisp text) instead of using Leaflet markers + html2canvas.
    function refreshCountryLabels() {
      currentLabels = [];

      const countryGroups = {};
      rawFeatures.forEach(feat => {
        const data = getCountryData(feat);
        const groupKey = data.key;

        const isBaselineMajor = (groupKey === 'Canada' || groupKey === 'United States of America' || groupKey === 'Mexico');
        if (isBaselineMajor || everActiveKeys.has(groupKey) || everActiveKeys.has(data.name)) {
          try {
            const latLng = getCachedCentroid(feat);
            if (currentBounds.contains(latLng)) {
              if (!countryGroups[groupKey]) {
                countryGroups[groupKey] = {
                  name: data.name === 'United States of America' ? 'USA' : data.name,
                  features: []
                };
              }
              countryGroups[groupKey].features.push(feat);
            }
          } catch (e) {}
        }
      });

      Object.values(countryGroups).forEach(group => {
        try {
          const center = turf.centerOfMass(turf.featureCollection(group.features));
          const coords = center.geometry.coordinates;
          const n = group.features.length;
          currentLabels.push({
            text: group.name,
            latLng: L.latLng(coords[1], coords[0]),
            size: n > 10 ? 'large' : (n > 3 ? 'medium' : 'small')
          });
        } catch (e) {}
      });
    }

    function drawLabels(ctx, scale, targetWidth) {
      // Font sizes are in final-GIF pixels so they stay readable after downscaling
      const uiScale = Math.max(0.6, targetWidth / 500);
      const sizes = { large: 17, medium: 14, small: 12 };

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;

      currentLabels.forEach(label => {
        const fs = Math.round(sizes[label.size] * uiScale);
        const pt = map.latLngToContainerPoint(label.latLng);
        const x = pt.x * scale;
        const y = pt.y * scale;
        if (x < 0 || y < 0 || x > ctx.canvas.width || y > ctx.canvas.height) return;

        ctx.font = `800 ${fs}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
        ctx.lineWidth = Math.max(3, fs * 0.28);
        ctx.strokeStyle = '#ffffff';
        ctx.strokeText(label.text, x, y);
        ctx.fillStyle = '#000000';
        ctx.fillText(label.text, x, y);
      });
    }

    // ---------- Sizing (use the same element html2canvas captures) ----------
    const mapElement = document.getElementById('map');
    const originalWidth = mapElement.offsetWidth;
    const originalHeight = mapElement.offsetHeight;

    const maxDimension = isMobile ? 280 : 500;
    const scaleFactor = Math.min(1, maxDimension / originalWidth);
    const targetWidth = Math.round(originalWidth * scaleFactor);
    const targetHeight = Math.round(originalHeight * scaleFactor);

    // ---------- GIF encoder (needs gif.worker.js) ----------
    const gif = new GIF({
      workers: 2,
      workerScript: './gif.worker.js',
      quality: 10,        // lower = better color/text fidelity (slower)
      dither: false,
      width: targetWidth,
      height: targetHeight
    });
    activeGif = gif;

    const captureFrame = async (isFinal = false) => {
      const canvas = await html2canvas(mapElement, {
        useCORS: true,
        scale: 1,
        backgroundColor: null,
        // Keep Leaflet's zoom buttons out of the GIF
        ignoreElements: el => el.classList && el.classList.contains('leaflet-control-container')
      });

      const resizeCanvas = document.createElement('canvas');
      resizeCanvas.width = targetWidth;
      resizeCanvas.height = targetHeight;
      const ctx = resizeCanvas.getContext('2d', { willReadFrequently: true });

      ctx.fillStyle = '#aad3df';
      ctx.fillRect(0, 0, targetWidth, targetHeight);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, 0, 0, targetWidth, targetHeight);
      drawLabels(ctx, scaleFactor, targetWidth);

      const frameDelay = isFinal ? 2500 : 900;
      gif.addFrame(resizeCanvas, { delay: frameDelay, copy: true });
    };

    // ---------- Capture frames (state is always restored in finally) ----------
    finalState = JSON.parse(JSON.stringify(stateStatus));
    for (let key in stateStatus) delete stateStatus[key];
    stateWiped = true;
    geojsonLayer.setStyle(style);

    try {
      refreshCountryLabels();
      await new Promise(resolve => setTimeout(resolve, 200));

      await captureFrame(false);

      for (let i = 0; i < historyLog.length; i++) {
        const entry = historyLog[i];

        if (entry.action === 'RENAME') {
          const targetKey = entry.oldKey || entry.from;
          for (let id in stateStatus) {
            if (stateStatus[id].key === targetKey) {
              stateStatus[id].key = entry.to;
              stateStatus[id].name = entry.to;
            }
          }
        } else {
          stateStatus[entry.id] = entry.targetCountryObj;
        }

        if (entry.continent === currentContinent) {
          geojsonLayer.setStyle(style);
          refreshCountryLabels();
          await new Promise(resolve => setTimeout(resolve, 200));
          await captureFrame(false);
        }
      }

      await captureFrame(true);
    } finally {
      currentLabels = [];
      if (stateWiped) {
        for (let key in stateStatus) delete stateStatus[key];
        Object.assign(stateStatus, finalState);
        stateWiped = false;
      }
      geojsonLayer.setStyle(style);

      const defaultBounds = CONTINENT_BOUNDS[currentContinent];
      if (defaultBounds) {
        map.fitBounds(defaultBounds, { animate: false, padding: [20, 20] });
      }
    }

    // ---------- Encode ----------
    listEl.innerHTML = '<li><em>Encoding multi-frame GIF... 0%</em></li>';

    gif.removeAllListeners('finished');
    gif.removeAllListeners('progress');

    gif.on('progress', p => {
      listEl.innerHTML = `<li><em>Encoding GIF... ${Math.round(p * 100)}%</em></li>`;
    });

    gif.on('finished', function (blob) {
      clearTimeout(exportTimeout);
      activeGif = null;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;

      const now = new Date();
      const timestamp = now.getFullYear().toString() +
                        String(now.getMonth() + 1).padStart(2, '0') +
                        String(now.getDate()).padStart(2, '0') + '-' +
                        String(now.getHours()).padStart(2, '0') +
                        String(now.getMinutes()).padStart(2, '0') +
                        String(now.getSeconds()).padStart(2, '0');

      const safeName = currentContinent.toLowerCase().replace(/\s+/g, '-');
      a.download = `can-expand-${safeName}-${timestamp}.gif`;

      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      resetUI();
    });

    // Watchdog: starts right before encoding, cleared when finished/failed
    exportTimeout = setTimeout(() => {
      if (isReplaying) {
        console.warn('GIF encoding timed out');
        try { gif.abort(); } catch (e) {}
        activeGif = null;
        resetUI();
        alert('GIF export timed out. Check that gif.worker.js loads (DevTools > Network).');
      }
    }, 60000);

    gif.render();

  } catch (err) {
    console.error('GIF export error:', err);
    clearTimeout(exportTimeout);
    try { if (activeGif) activeGif.abort(); } catch (e) {}
    activeGif = null;
    alert('GIF export failed: ' + err.message);
    resetUI();
  }
}
