// export2.js - Handles lightweight PNG frame sequence export

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

  try {
    const isMobile = /Mobi|Android/i.test(navigator.userAgent);

    const activeFeatureIds = new Set();
    filteredLog.forEach(entry => {
      if (entry.id) activeFeatureIds.add(entry.id);
    });

    const changedFeaturesList = rawFeatures.filter(f => activeFeatureIds.has(getFeatureId(f)));

    let currentBounds = null;
    if (changedFeaturesList.length > 0) {
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
          currentBounds = map.getBounds();
        }
      }
    } else {
      const continentBounds = CONTINENT_BOUNDS[currentContinent];
      if (continentBounds) {
        map.fitBounds(continentBounds, { animate: false, padding: [30, 30] });
        currentBounds = map.getBounds();
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

    let activeLabelMarkers = [];
    let lockedCountryCenters = null;
    
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
            const featCenter = turf.centroid(feat);
            const coords = featCenter.geometry.coordinates;
            const latLng = L.latLng(coords[1], coords[0]);
            
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

      if (!lockedCountryCenters) {
        lockedCountryCenters = {};
        Object.entries(countryGroups).forEach(([key, group]) => {
          try {
            const turfCollection = turf.featureCollection(group.features);
            const center = turf.centerOfMass(turfCollection);
            lockedCountryCenters[key] = center.geometry.coordinates;
          } catch (e) {}
        });
      }

      Object.entries(countryGroups).forEach(([groupKey, group]) => {
        try {
          let coords = lockedCountryCenters[groupKey];
          if (!coords) {
            const turfCollection = turf.featureCollection(group.features);
            const center = turf.centerOfMass(turfCollection);
            coords = center.geometry.coordinates;
            lockedCountryCenters[groupKey] = coords;
          }

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

    const mapElement = document.getElementById('map');
    const targetPane = mapElement.querySelector('.leaflet-overlay-pane') || mapElement;
    
    const rect = targetPane.getBoundingClientRect();
    const originalWidth = Math.round(rect.width) || mapElement.offsetWidth;
    const originalHeight = Math.round(rect.height) || mapElement.offsetHeight;

    const maxDimension = isMobile ? 280 : 500;
    const scaleFactor = Math.min(1, maxDimension / originalWidth);
    const targetWidth = Math.round(originalWidth * scaleFactor);
    const targetHeight = Math.round(originalHeight * scaleFactor);

    const finalState = JSON.parse(JSON.stringify(stateStatus));
    for (let key in stateStatus) delete stateStatus[key];
    geojsonLayer.setStyle(style);
    refreshCountryLabels();
    await new Promise(resolve => setTimeout(resolve, 200));

    const capturedFrames = [];

    const captureFrame = async () => {
      const canvas = await html2canvas(mapElement, { 
        useCORS: true,
        scale: 1,
        backgroundColor: null,
        width: targetWidth,
        height: targetHeight,
        windowWidth: originalWidth,
        windowHeight: originalHeight
      });

      const resizeCanvas = document.createElement('canvas');
      resizeCanvas.width = targetWidth;
      resizeCanvas.height = targetHeight;
      const ctx = resizeCanvas.getContext('2d', { willReadFrequently: true });
      
      ctx.fillStyle = '#aad3df';
      ctx.fillRect(0, 0, targetWidth, targetHeight);
      ctx.drawImage(canvas, 0, 0, targetWidth, targetHeight);

      capturedFrames.push(resizeCanvas.toDataURL('image/png'));
    };

    // 1. Initial state
    await captureFrame();

    // 2. History steps
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
        await captureFrame();
      }
    }

    // 3. Final frame
    await captureFrame();

    activeLabelMarkers.forEach(m => map.removeLayer(m));
    Object.assign(stateStatus, finalState);
    geojsonLayer.setStyle(style);
    
    const defaultBounds = CONTINENT_BOUNDS[currentContinent];
    if (defaultBounds) {
      map.fitBounds(defaultBounds, { animate: false, padding: [20, 20] });
    }

    listEl.innerHTML = `<li><em>Downloading ${capturedFrames.length} animation frames...</em></li>`;

    // Instantly trigger downloads for each frame with a brief staggered delay
    capturedFrames.forEach((dataUrl, index) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = dataUrl;
        const safeName = currentContinent.toLowerCase().replace(/\s+/g, '-');
        a.download = `frame-${safeName}-${String(index + 1).padStart(3, '0')}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }, index * 200);
    });

    setTimeout(() => {
      isReplaying = false;
      if (replayBtn) replayBtn.disabled = false;
      if (exportBtn) exportBtn.disabled = false;
      if (continentSelect) continentSelect.disabled = false;
      renderHistoryUI();
      listEl.innerHTML = '';
    }, capturedFrames.length * 200 + 500);

  } catch (err) {
    console.error('Frame export error:', err);
    alert('Export failed: ' + err.message);
    isReplaying = false;
    if (replayBtn) replayBtn.disabled = false;
    if (exportBtn) exportBtn.disabled = false;
    if (continentSelect) continentSelect.disabled = false;
    renderHistoryUI();
  }
}
