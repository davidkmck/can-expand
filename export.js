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
  let activeLabelMarkers = [];
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

    function refreshCountryLabels() {
      activeLabelMarkers.forEach(m => map.removeLayer(m));
      activeLabelMarkers = [];

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

      Object.entries(countryGroups).forEach(([groupKey, group]) => {
        try {
          const turfCollection = turf.featureCollection(group.features);
          const center = turf.centerOfMass(turfCollection);
          const coords = center.geometry.coordinates;

          const featureCount = group.features.length;
          const isMegaNation = featureCount > 10;
          const isMediumNation = featureCount > 3;
          const fontSize = isMegaNation ? 24 : (isMediumNation ? 18 : 14);
          const anchorOffset = Math.round(fontSize * 3.5);

          const labelIcon = L.divIcon({
            className: 'gif-country-label',
            html: `<div style="background: transparent; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: ${fontSize}px; font-weight: 800; color: #111111; text-align: center; white-space: nowrap; text-shadow: -1.5px -1.5px 0 #fff, 1.5px -1.5px 0 #fff, -1.5px 1.5px 0 #fff, 1.5px 1.5px 0 #fff, 0 2px 5px rgba(0,0,0,0.3); pointer-events: none; letter-spacing: 0.5px;">${group.name}</div>`,
            iconSize: [fontSize * 8, fontSize * 1.6],
            iconAnchor: [anchorOffset, fontSize * 0.8]
          });

          const marker = L.marker([coords[1], coords[0]], { icon: labelIcon }).addTo(map);
          activeLabelMarkers.push(marker);
        } catch (e) {}
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
      quality: 20,        // higher = faster, coarser colors
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
      ctx.drawImage(canvas, 0, 0, targetWidth, targetHeight);

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
      activeLabelMarkers.forEach(m => map.removeLayer(m));
      activeLabelMarkers = [];
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
