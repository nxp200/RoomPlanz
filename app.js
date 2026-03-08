/*
  RoomPlanner — Offline SVG-based 2D room layout editor
  - All coordinates and sizes stored as integer millimetres.
  - Origin = room's top-left; X right, Y down. Objects stored by center (xMm,yMm) with rotation deg.
  - Zoom/pan affect only view transform; underlying mm values unchanged.
  - No external dependencies or network calls. Runs directly from index.html.
*/
(function(){
  'use strict';

  // ---------------------------
  // Constants & Utilities
  // ---------------------------
  const SCHEMA_VERSION = '1.0.0';
  const AUTOSAVE_KEY = 'roomplanner_autosave_v1';
  const MIN_ROOM_MM = 500;
  const MAX_ROOM_MM = 50000;
  const MIN_SIZE_MM = 1; // Strictly positive
  const DEFAULT_ROOM = { widthMm: 3000, heightMm: 4000 };
  const DEFAULT_STYLE = { fill: '#7ec8e3', borderColor: '#144663', borderMm: 10, showLabel: true, labelPx: 80, cornerMm: 0 };
  const ZOOM_MIN = 0.1; // 10%
  const ZOOM_MAX = 5.0; // 500%
  const ZOOM_STEP = 1.1; // multiplicative
  const NUDGE_MM = 10;
  const NUDGE_MM_FAST = 100;

  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const clampInt = (v, a, b) => Math.trunc(Math.min(Math.max(v, a), b));
  const isIntString = (s) => /^-?\d+$/.test(String(s).trim());
  const parseIntSafe = (s, fallback=0) => isIntString(s) ? parseInt(s, 10) : fallback;
  const normalizeDeg = (deg) => {
    let d = Math.round(deg) % 360; // keep integer degrees
    if (d < 0) d += 360;
    return d; // 0..359
  };

  function rad(deg){ return (deg*Math.PI)/180; }
  function cosd(deg){ return Math.cos(rad(deg)); }
  function sind(deg){ return Math.sin(rad(deg)); }

  function rotatedRectAABB(widthMm, heightMm, rotDeg){
    // Returns half extents in mm of axis-aligned bounding box for a rect rotated rotDeg around center
    const c = Math.abs(cosd(rotDeg));
    const s = Math.abs(sind(rotDeg));
    const halfW = (widthMm/2); const halfH = (heightMm/2);
    const aabbHalfW = Math.round(c*halfW + s*halfH);
    const aabbHalfH = Math.round(s*halfW + c*halfH);
    return { halfW: aabbHalfW, halfH: aabbHalfH };
  }

  function syncRoomInputs(){
    inputRoomW.value = String(state.room.widthMm);
    inputRoomH.value = String(state.room.heightMm);
  }

  function ensureInsideRoom(obj, room){
    // Clamp object center so its rotated AABB remains fully inside room bounds
    if (obj.type === 'circle'){
      const r = obj.radiusMm;
      obj.xMm = clampInt(obj.xMm, r, room.widthMm - r);
      obj.yMm = clampInt(obj.yMm, r, room.heightMm - r);
      return;
    }
    // rect or square
    const w = obj.type === 'square' ? obj.sizeMm : obj.widthMm;
    const h = obj.type === 'square' ? obj.sizeMm : obj.heightMm;
    let { halfW, halfH } = rotatedRectAABB(w, h, obj.rotationDeg);
    // If rotated AABB cannot fit inside room, proportionally shrink w/h to fit
    const maxHalfW = Math.floor(room.widthMm/2);
    const maxHalfH = Math.floor(room.heightMm/2);
    if (halfW > maxHalfW || halfH > maxHalfH){
      const fitScale = Math.min(maxHalfW / Math.max(1, halfW), maxHalfH / Math.max(1, halfH));
      const newW = Math.max(MIN_SIZE_MM, Math.floor(w * fitScale));
      const newH = Math.max(MIN_SIZE_MM, Math.floor(h * fitScale));
      if (obj.type === 'square'){
        obj.sizeMm = Math.min(newW, newH);
      } else {
        obj.widthMm = newW; obj.heightMm = newH;
      }
      const hh = rotatedRectAABB(obj.type==='square'?obj.sizeMm:obj.widthMm, obj.type==='square'?obj.sizeMm:obj.heightMm, obj.rotationDeg);
      halfW = hh.halfW; halfH = hh.halfH;
    }
    obj.xMm = clampInt(obj.xMm, halfW, room.widthMm - halfW);
    obj.yMm = clampInt(obj.yMm, halfH, room.heightMm - halfH);
  }

  function clampSizeToRoom(obj, room){
    // Ensure sizes are > 0 and not exceeding room such that center can be clamped inside
    if (obj.type === 'circle'){
      const maxR = Math.floor(Math.min(room.widthMm, room.heightMm)/2);
      obj.radiusMm = clampInt(obj.radiusMm, MIN_SIZE_MM, maxR);
      return;
    }
    let w = obj.type === 'square' ? obj.sizeMm : obj.widthMm;
    let h = obj.type === 'square' ? obj.sizeMm : obj.heightMm;
    // For rotation, we only can ensure that AABB <= room size; pick max allowed sizes given current center
    // To simplify: ensure AABB fits by clamping center after size change (caller should call ensureInsideRoom post size update)
    w = clampInt(w, MIN_SIZE_MM, room.widthMm);
    h = clampInt(h, MIN_SIZE_MM, room.heightMm);
    if (obj.type === 'square') obj.sizeMm = Math.min(w,h); else { obj.widthMm = w; obj.heightMm = h; }
  }

  function deepClone(obj){ return JSON.parse(JSON.stringify(obj)); }

  function downloadText(filename, text){
    const blob = new Blob([text], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function mmToPx(mm, state){ return mm * state.view.scale; }
  function pxToMm(px, state){ return px / state.view.scale; } // return float mm for smooth interactions; round at assignment as needed

  // ---------------------------
  // Application State
  // ---------------------------
  const state = {
    schemaVersion: SCHEMA_VERSION,
    room: { widthMm: DEFAULT_ROOM.widthMm, heightMm: DEFAULT_ROOM.heightMm },
    objects: [],
    nextId: 1,
    settings: {
      gridVisible: true,
      gridSpacingMm: 500,
      snapToGrid: false,
      snapRotation: false,
      showLabels: true,
    },
    view: {
      scale: 0.2, // pixels per mm initial zoom
      tx: 40,     // translation x in px
      ty: 40,     // translation y in px
      spacePanKeyDown: false,
    },
    interaction: {
      mode: 'idle', // idle|pan|drag|resize|rotate
      pointerId: null,
      start: null, // {x,y} in px
      objStart: null, // deep copy of object at start
      handle: null, // which handle name when resizing
      targetId: null,
    },
    selectionId: null,
  };

  // DOM refs
  const svgRoot = $('#svg-root');
  const viewportG = $('#viewport');
  const gridLayer = $('#grid-layer');
  const roomLayer = $('#room-layer');
  const objectLayer = $('#object-layer');
  const overlayLayer = $('#overlay-layer');

  const inputRoomW = $('#room-width');
  const inputRoomH = $('#room-height');
  const errRoomW = $('#room-width-err');
  const errRoomH = $('#room-height-err');
  const toggleGrid = $('#toggle-grid');
  const gridSpacingSel = $('#grid-spacing');
  const snapGridChk = $('#snap-grid');
  const snapRotChk = $('#snap-rotation');
  const btnRotateRoomLeft = $('#btn-rotate-room-left');
  const btnRotateRoomRight = $('#btn-rotate-room-right');
  const btnClearRoom = $('#btn-clear-room');
  const modalOverlay = $('#modal-overlay');
  const btnConfirmClear = $('#btn-confirm-clear');
  const btnCancelClear = $('#btn-cancel-clear');

  const btnAddRect = $('#add-rect');
  const btnAddSquare = $('#add-square');
  const btnAddCircle = $('#add-circle');

  const propsForm = $('#props-form');
  const noSelNotice = $('#no-selection');
  const propsFields = $('#props-fields');
  const objectList = $('#object-list');
  const propName = $('#prop-name');
  const propType = $('#prop-type');
  const propWidth = $('#prop-width');
  const propHeight = $('#prop-height');
  const propRadius = $('#prop-radius');
  const propX = $('#prop-x');
  const propY = $('#prop-y');
  const propRot = $('#prop-rot');
  const propFill = $('#prop-fill');
  const propStroke = $('#prop-stroke');
  const propThick = $('#prop-thick');
  const propLabel = $('#prop-label');
  const propLabelSize = $('#prop-label-size');
  const propCorner = $('#prop-corner');
  const errPW = $('#prop-width-err');
  const errPH = $('#prop-height-err');
  const errPR = $('#prop-radius-err');
  const errPX = $('#prop-x-err');
  const errPY = $('#prop-y-err');
  const errProt = $('#prop-rot-err');
  const errPTh = $('#prop-thick-err');
  const errPLS = $('#prop-label-size-err');
  const errPCorner = $('#prop-corner-err');

  const btnDuplicate = $('#btn-duplicate');
  const btnDelete = $('#btn-delete');
  const btnToFront = $('#btn-to-front');
  const btnForward = $('#btn-forward');
  const btnBackward = $('#btn-backward');
  const btnToBack = $('#btn-to-back');

  const btnExportJson = $('#btn-export-json');
  const importJsonInput = $('#import-json-input');
  const btnImportJson = $('#btn-import-json');
  const importJsonErr = $('#import-json-err');

  const btnExportJpeg = $('#btn-export-jpeg');
  const jpegWidthInput = $('#jpeg-width');
  const jpegErr = $('#jpeg-err');
  const jpegIncludeGrid = $('#jpeg-include-grid');
  const jpegIncludeLabels = $('#jpeg-include-labels');

  const zoomLevelOutput = $('#zoom-level');
  const zoomInBtn = $('#zoom-in');
  const zoomOutBtn = $('#zoom-out');
  const btnFit = $('#btn-fit');
  const btnResetView = $('#btn-reset-view');
  const canvasWrapper = $('#canvas-wrapper');

  const userGuideContainer = $('#user-guide-content');
  const layoutRoot = $('#app');
  const btnCollapseLeft = $('#btn-collapse-left');
  const btnCollapseRight = $('#btn-collapse-right');
  const btnExpandLeft = $('#btn-expand-left');
  const btnExpandRight = $('#btn-expand-right');

  // ---------------------------
  // Initialization
  // ---------------------------
  function init(){
    // Restore any autosaved model before wiring UI so fields reflect it
    try { loadAutosaveIfAny(); } catch(e) {}
    // set initial UI values
    inputRoomW.value = String(state.room.widthMm);
    inputRoomH.value = String(state.room.heightMm);
    toggleGrid.checked = state.settings.gridVisible;
    gridSpacingSel.value = String(state.settings.gridSpacingMm);
    snapGridChk.checked = state.settings.snapToGrid;
    snapRotChk.checked = state.settings.snapRotation;

    setZoomState(state.view.scale);
    updateViewportTransform();

    renderAll();
    updatePropsPanel();
    attachEventListeners();
    injectUserGuide();

    // keyboard shortcuts info: handled at document level

    // Restore collapsed panels state
    try {
      const s = JSON.parse(localStorage.getItem('roomplanner_panels_v1')||'{}');
      if (s.leftCollapsed) layoutRoot.classList.add('left-collapsed');
      if (s.rightCollapsed) layoutRoot.classList.add('right-collapsed');
    } catch{}
  }

  // ---------------------------
  // Rendering
  // ---------------------------
  function updateViewportTransform(){
    viewportG.setAttribute('transform', `translate(${state.view.tx},${state.view.ty}) scale(${state.view.scale})`);
  }

  function renderGrid(){
    gridLayer.innerHTML = '';
    if (!state.settings.gridVisible) { gridLayer.setAttribute('visibility','hidden'); return; }
    gridLayer.setAttribute('visibility','visible');

    const spacing = state.settings.gridSpacingMm;
    const w = state.room.widthMm;
    const h = state.room.heightMm;

    // Draw vertical lines
    const frag = document.createDocumentFragment();
    for (let x=0; x<=w; x+=spacing){
      const line = document.createElementNS('http://www.w3.org/2000/svg','line');
      line.setAttribute('class','grid-line');
      line.setAttribute('x1', String(x));
      line.setAttribute('x2', String(x));
      line.setAttribute('y1', '0');
      line.setAttribute('y2', String(h));
      frag.appendChild(line);
    }
    // Draw horizontal lines
    for (let y=0; y<=h; y+=spacing){
      const line = document.createElementNS('http://www.w3.org/2000/svg','line');
      line.setAttribute('class','grid-line');
      line.setAttribute('y1', String(y));
      line.setAttribute('y2', String(y));
      line.setAttribute('x1', '0');
      line.setAttribute('x2', String(w));
      frag.appendChild(line);
    }
    gridLayer.appendChild(frag);
  }

  function renderRoom(){
    roomLayer.innerHTML = '';
    const r = document.createElementNS('http://www.w3.org/2000/svg','rect');
    r.setAttribute('class','room-rect');
    r.setAttribute('x','0');
    r.setAttribute('y','0');
    r.setAttribute('width', String(state.room.widthMm));
    r.setAttribute('height', String(state.room.heightMm));
    roomLayer.appendChild(r);
  }

  function objectToGroup(obj){
    const g = document.createElementNS('http://www.w3.org/2000/svg','g');
    g.setAttribute('class', 'obj' + (state.selectionId === obj.id ? ' selected' : ''));
    g.setAttribute('data-id', String(obj.id));
    g.setAttribute('transform', `translate(${obj.xMm},${obj.yMm}) rotate(${obj.rotationDeg})`);

    const shape = document.createElementNS('http://www.w3.org/2000/svg', obj.type === 'circle' ? 'circle' : 'rect');
    shape.setAttribute('class','shape');
    shape.setAttribute('fill', obj.style.fill);
    shape.setAttribute('stroke', obj.style.borderColor);
    shape.setAttribute('stroke-width', String(obj.style.borderMm));

    if (obj.type === 'circle'){
      shape.setAttribute('r', String(obj.radiusMm));
      shape.setAttribute('cx', '0');
      shape.setAttribute('cy', '0');
    } else {
      const w = obj.type === 'square' ? obj.sizeMm : obj.widthMm;
      const h = obj.type === 'square' ? obj.sizeMm : obj.heightMm;
      shape.setAttribute('x', String(-Math.round(w/2)));
      shape.setAttribute('y', String(-Math.round(h/2)));
      shape.setAttribute('width', String(w));
      shape.setAttribute('height', String(h));
      // Clamp corner radius to half of the smaller side
      const requested = Math.max(0, Number(obj.style?.cornerMm) || 0);
      const maxRx = Math.floor(Math.min(w, h) / 2);
      const rx = Math.min(requested, maxRx);
      shape.setAttribute('rx', String(rx));
      shape.setAttribute('ry', String(rx));
    }

    g.appendChild(shape);

    if (obj.style.showLabel){
      const label = document.createElementNS('http://www.w3.org/2000/svg','text');
      label.setAttribute('class','label');
      label.setAttribute('x','0');
      label.setAttribute('y','0');
      if (Number.isInteger(obj.style.labelPx)){
        label.setAttribute('font-size', String(obj.style.labelPx));
      }
      label.textContent = obj.name || `${obj.type}#${obj.id}`;
      g.appendChild(label);
    }

    if (state.selectionId === obj.id){
      addHandlesToGroup(g, obj);
    }

    return g;
  }

  function addHandlesToGroup(g, obj){
    const handlesG = document.createElementNS('http://www.w3.org/2000/svg','g');
    handlesG.setAttribute('class','handles');
    const makeHandle = (name, x, y, cls='handle') => {
      const h = document.createElementNS('http://www.w3.org/2000/svg','rect');
      h.setAttribute('class', cls);
      h.setAttribute('data-handle', name);
      h.setAttribute('x', String(x-6));
      h.setAttribute('y', String(y-6));
      h.setAttribute('width', '12');
      h.setAttribute('height', '12');
      h.setAttribute('rx', '2');
      handlesG.appendChild(h);
    };

    if (obj.type === 'circle'){
      // radius handle on +X axis
      makeHandle('radius', obj.radiusMm, 0);
    } else {
      const w = obj.type === 'square' ? obj.sizeMm : obj.widthMm;
      const h = obj.type === 'square' ? obj.sizeMm : obj.heightMm;
      const hw = Math.round(w/2), hh = Math.round(h/2);
      makeHandle('nw', -hw, -hh);
      makeHandle('n', 0, -hh);
      makeHandle('ne', hw, -hh);
      makeHandle('e', hw, 0);
      makeHandle('se', hw, hh);
      makeHandle('s', 0, hh);
      makeHandle('sw', -hw, hh);
      makeHandle('w', -hw, 0);
    }
    // rotation handle above top center at -hh-40mm
    const rotY = obj.type === 'circle' ? -obj.radiusMm - 200 : -( (obj.type==='square'?obj.sizeMm:obj.heightMm)/2 ) - 200;
    const rotHandle = document.createElementNS('http://www.w3.org/2000/svg','circle');
    rotHandle.setAttribute('class','handle handle-rot');
    rotHandle.setAttribute('data-handle','rotate');
    rotHandle.setAttribute('r','32');
    rotHandle.setAttribute('cx','0');
    rotHandle.setAttribute('cy', String(Math.round(rotY)));
    handlesG.appendChild(rotHandle);

    // Rotate left/right buttons positioned near the rotation handle
    const mkRotBtn = (dir, x) => {
      const btnG = document.createElementNS('http://www.w3.org/2000/svg','g');
      btnG.setAttribute('class','rotate-btn');
      btnG.setAttribute('data-rotate', dir);
      const c = document.createElementNS('http://www.w3.org/2000/svg','rect');
      c.setAttribute('x', String(x-40));
      c.setAttribute('y', String(Math.round(rotY)-40));
      c.setAttribute('width','80');
      c.setAttribute('height','80');
      c.setAttribute('rx','6');
      c.setAttribute('fill','#0b1220');
      c.setAttribute('stroke','#22d3ee');
      c.setAttribute('stroke-width','1.5');
      const t = document.createElementNS('http://www.w3.org/2000/svg','text');
      t.setAttribute('class','rotate-btn-symbol');
      t.setAttribute('x', String(x));
      t.setAttribute('y', String(Math.round(rotY)));
      t.setAttribute('text-anchor','middle');
      t.setAttribute('dominant-baseline','central');
      t.setAttribute('fill','#e5e7eb');
      t.setAttribute('font-size','48');
      t.textContent = dir==='left' ? '↺' : '↻';
      btnG.appendChild(c); btnG.appendChild(t);
      handlesG.appendChild(btnG);
    };
    mkRotBtn('left', -160);
    mkRotBtn('right', 160);

    g.appendChild(handlesG);
  }

  function renderObjects(){
    objectLayer.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const obj of state.objects){
      const g = objectToGroup(obj);
      frag.appendChild(g);
    }
    objectLayer.appendChild(frag);
  }

  function renderAll(){
    renderGrid();
    renderRoom();
    renderObjects();
    updateZoomUI();
  }

  // ---------------------------
  // Object Creation & Selection
  // ---------------------------
  function addObject(type){
    const id = state.nextId++;
    let obj;
    const cx = Math.round(state.room.widthMm/2);
    const cy = Math.round(state.room.heightMm/2);
    if (type === 'circle'){
      obj = { id, type:'circle', name:`Circle ${id}`, xMm:cx, yMm:cy, radiusMm:500, rotationDeg:0, style: deepClone(DEFAULT_STYLE) };
    } else if (type === 'square'){
      obj = { id, type:'square', name:`Square ${id}`, xMm:cx, yMm:cy, sizeMm:1000, rotationDeg:0, style: deepClone(DEFAULT_STYLE) };
    } else {
      obj = { id, type:'rect', name:`Rect ${id}`, xMm:cx, yMm:cy, widthMm:1600, heightMm:1000, rotationDeg:0, style: deepClone(DEFAULT_STYLE) };
    }
    clampSizeToRoom(obj, state.room);
    ensureInsideRoom(obj, state.room);
    state.objects.push(obj);
    state.selectionId = id;
    renderAll();
    updatePropsPanel();
    renderObjectList();
    scheduleAutosave();
  }

  function getSelected(){ return state.objects.find(o=>o.id===state.selectionId) || null; }
  function selectById(id){ state.selectionId = id; renderAll(); updatePropsPanel(); }

  function renderObjectList(){
    if (!objectList) return;
    objectList.innerHTML = '';
    if (state.objects.length === 0) {
      objectList.innerHTML = '<li style="cursor:default; background:transparent; border:none; color:var(--muted); font-size:.85rem;">No objects yet</li>';
      return;
    }
    // Render in reverse order: last in array = top of z-order = front
    const reversed = [...state.objects].reverse();
    for (const obj of reversed){
      const li = document.createElement('li');
      li.setAttribute('data-id', String(obj.id));
      li.setAttribute('draggable', 'true');
      
      // Icon based on type
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'obj-icon');
      icon.setAttribute('viewBox', '0 0 20 20');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '2');
      
      if (obj.type === 'circle'){
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', '10');
        circle.setAttribute('cy', '10');
        circle.setAttribute('r', '7');
        icon.appendChild(circle);
      } else {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        if (obj.type === 'square'){
          rect.setAttribute('x', '3');
          rect.setAttribute('y', '3');
          rect.setAttribute('width', '14');
          rect.setAttribute('height', '14');
        } else {
          rect.setAttribute('x', '2');
          rect.setAttribute('y', '5');
          rect.setAttribute('width', '16');
          rect.setAttribute('height', '10');
        }
        rect.setAttribute('rx', '1');
        icon.appendChild(rect);
      }
      
      const name = document.createElement('span');
      name.className = 'obj-name';
      name.textContent = obj.name || `${obj.type}#${obj.id}`;
      
      li.appendChild(icon);
      li.appendChild(name);
      li.addEventListener('click', ()=> selectById(obj.id));
      
      // Drag and drop for reordering
      li.addEventListener('dragstart', (e)=> {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', obj.id);
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', ()=> {
        li.classList.remove('dragging');
      });
      li.addEventListener('dragover', (e)=> {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        li.classList.add('drag-over');
      });
      li.addEventListener('dragleave', ()=> {
        li.classList.remove('drag-over');
      });
      li.addEventListener('drop', (e)=> {
        e.preventDefault();
        li.classList.remove('drag-over');
        const draggedId = parseInt(e.dataTransfer.getData('text/plain'), 10);
        const targetId = obj.id;
        if (draggedId !== targetId) {
          reorderObject(draggedId, targetId);
        }
      });
      
      objectList.appendChild(li);
    }
  }

  // ---------------------------
  // Properties Panel Binding
  // ---------------------------
  function updatePropsPanel(){
    const obj = getSelected();
    if (!obj){
      noSelNotice.classList.remove('hidden');
      propsFields.classList.add('hidden');
      renderObjectList();
      return;
    }
    noSelNotice.classList.add('hidden');
    propsFields.classList.remove('hidden');

    // Do not overwrite fields the user is actively editing
    const setIfNotActive = (el, val)=>{ if (el && document.activeElement !== el) el.value = String(val); };

    setIfNotActive(propName, obj.name || '');
    if (document.activeElement !== propType) propType.value = obj.type;

    if (obj.type === 'circle'){
      $('#dim-rect').classList.add('hidden');
      $('#dim-circle').classList.remove('hidden');
      setIfNotActive(propRadius, obj.radiusMm);
      // Corner radius not applicable for circles
      $('#corner-rect').classList.add('hidden');
    } else {
      $('#dim-rect').classList.remove('hidden');
      $('#dim-circle').classList.add('hidden');
      setIfNotActive(propWidth, obj.type==='square'?obj.sizeMm:obj.widthMm);
      setIfNotActive(propHeight, obj.type==='square'?obj.sizeMm:obj.heightMm);
      // Show corner radius control for rect/square
      $('#corner-rect').classList.remove('hidden');
      if (propCorner) setIfNotActive(propCorner, Number.isInteger(obj.style?.cornerMm) ? obj.style.cornerMm : 0);
    }

    setIfNotActive(propX, obj.xMm);
    setIfNotActive(propY, obj.yMm);
    setIfNotActive(propRot, obj.rotationDeg);
    if (document.activeElement !== propFill) propFill.value = obj.style.fill;
    if (document.activeElement !== propStroke) propStroke.value = obj.style.borderColor;
    setIfNotActive(propThick, obj.style.borderMm);
    propLabel.checked = !!obj.style.showLabel;
    setIfNotActive(propLabelSize, Number.isInteger(obj.style.labelPx) ? obj.style.labelPx : 16);
  }

  function applyPropsChange(){
    const obj = getSelected(); if (!obj) return;
    obj.name = propName.value.trim();

    // Type change handling
    const newType = propType.value;
    if (newType !== obj.type){
      if (newType === 'circle'){
        // derive radius from min dimension
        const w = obj.type==='circle'? (obj.radiusMm*2) : (obj.type==='square'?obj.sizeMm:obj.widthMm);
        const h = obj.type==='circle'? (obj.radiusMm*2) : (obj.type==='square'?obj.sizeMm:obj.heightMm);
        const r = Math.max(MIN_SIZE_MM, Math.round(Math.min(w,h)/2));
        obj.type = 'circle';
        delete obj.widthMm; delete obj.heightMm; delete obj.sizeMm;
        obj.radiusMm = r;
      } else if (newType === 'square'){
        const w = obj.type==='circle'? (obj.radiusMm*2) : (obj.type==='square'?obj.sizeMm:obj.widthMm);
        const h = obj.type==='circle'? (obj.radiusMm*2) : (obj.type==='square'?obj.sizeMm:obj.heightMm);
        const s = Math.max(MIN_SIZE_MM, Math.min(w,h));
        obj.type = 'square';
        delete obj.widthMm; delete obj.heightMm; delete obj.radiusMm;
        obj.sizeMm = s;
      } else { // rect
        const w = obj.type==='circle'? (obj.radiusMm*2) : (obj.type==='square'?obj.sizeMm:obj.widthMm);
        const h = obj.type==='circle'? (obj.radiusMm*2) : (obj.type==='square'?obj.sizeMm:obj.heightMm);
        obj.type = 'rect';
        delete obj.sizeMm; delete obj.radiusMm;
        obj.widthMm = Math.max(MIN_SIZE_MM, w);
        obj.heightMm = Math.max(MIN_SIZE_MM, h);
      }
    }

    // Clear errors
    errPW.textContent = errPH.textContent = errPR.textContent = '';
    errPX.textContent = errPY.textContent = errProt.textContent = errPTh.textContent = errPLS.textContent = (errPCorner ? '' : '');
    if (errPCorner) errPCorner.textContent = '';

    // Dimensions
    if (obj.type === 'circle'){
      const rStr = propRadius.value.trim();
      if (!/^\d+$/.test(rStr)) { errPR.textContent = 'Numbers only'; }
      else {
        const r = parseInt(rStr,10);
        obj.radiusMm = Math.max(MIN_SIZE_MM, r);
      }
    } else if (obj.type === 'square'){
      const wStr = propWidth.value.trim();
      const hStr = propHeight.value.trim();
      let validW = /^\d+$/.test(wStr); let validH = /^\d+$/.test(hStr);
      if (!validW) errPW.textContent = 'Numbers only';
      if (!validH) errPH.textContent = 'Numbers only';
      if (validW && validH){
        const w = parseInt(wStr,10); const h = parseInt(hStr,10);
        const s = Math.max(MIN_SIZE_MM, Math.min(w,h));
        obj.sizeMm = s;
      }
    } else {
      const wStr = propWidth.value.trim();
      const hStr = propHeight.value.trim();
      let validW = /^\d+$/.test(wStr); let validH = /^\d+$/.test(hStr);
      if (!validW) errPW.textContent = 'Numbers only';
      if (!validH) errPH.textContent = 'Numbers only';
      if (validW){ obj.widthMm = Math.max(MIN_SIZE_MM, parseInt(wStr,10)); }
      if (validH){ obj.heightMm = Math.max(MIN_SIZE_MM, parseInt(hStr,10)); }
    }

    // Position
    const xStr = propX.value.trim(); const yStr = propY.value.trim();
    if (!/^\d+$/.test(xStr)) { errPX.textContent = 'Numbers only'; }
    else { obj.xMm = parseInt(xStr,10); }
    if (!/^\d+$/.test(yStr)) { errPY.textContent = 'Numbers only'; }
    else { obj.yMm = parseInt(yStr,10); }

    // Rotation
    const rotStr = propRot.value.trim();
    if (!/^-?\d+$/.test(rotStr)) { errProt.textContent = 'Integer degrees only'; }
    else {
      let r = parseInt(rotStr,10);
      if (r < -360 || r > 360){
        errProt.textContent = 'Range −360 to 360';
      } else {
        obj.rotationDeg = normalizeDeg(r);
      }
    }

    // Styles
    obj.style.fill = propFill.value;
    obj.style.borderColor = propStroke.value;
    const thickStr = propThick.value.trim();
    if (!/^\d+$/.test(thickStr)) { errPTh.textContent = 'Numbers only'; }
    else { obj.style.borderMm = Math.max(0, parseInt(thickStr,10)); }
    // Corner radius for rect/square only
    if (obj.type !== 'circle' && propCorner){
      const cStr = propCorner.value.trim();
      if (!/^\d+$/.test(cStr)) { if (errPCorner) errPCorner.textContent = 'Numbers only'; }
      else {
        obj.style.cornerMm = Math.max(0, parseInt(cStr,10));
        // Clamp to half of the smaller side
        const wNow = obj.type==='square' ? obj.sizeMm : obj.widthMm;
        const hNow = obj.type==='square' ? obj.sizeMm : obj.heightMm;
        const maxRxNow = Math.floor(Math.min(wNow, hNow) / 2);
        obj.style.cornerMm = Math.min(obj.style.cornerMm, maxRxNow);
        propCorner.value = String(obj.style.cornerMm);
      }
    }
    obj.style.showLabel = !!propLabel.checked;
    const labelStr = propLabelSize.value.trim();
    if (!/^\d+$/.test(labelStr)) { errPLS.textContent = 'Numbers only'; }
    else { obj.style.labelPx = Math.max(6, parseInt(labelStr,10)); }

    clampSizeToRoom(obj, state.room);
    ensureInsideRoom(obj, state.room);

    renderAll();
    updatePropsPanel();
    scheduleAutosave();
  }

  // ---------------------------
  // Event Handling
  // ---------------------------
  function attachEventListeners(){
    // Room inputs
    inputRoomW.addEventListener('input', onRoomInput);
    inputRoomH.addEventListener('input', onRoomInput);
    toggleGrid.addEventListener('change', ()=>{ state.settings.gridVisible = !!toggleGrid.checked; renderGrid(); scheduleAutosave(); });
    gridSpacingSel.addEventListener('change', ()=>{ state.settings.gridSpacingMm = parseIntSafe(gridSpacingSel.value, state.settings.gridSpacingMm); renderGrid(); scheduleAutosave(); });
    snapGridChk.addEventListener('change', ()=>{ state.settings.snapToGrid = !!snapGridChk.checked; scheduleAutosave(); });
    snapRotChk.addEventListener('change', ()=>{ state.settings.snapRotation = !!snapRotChk.checked; scheduleAutosave(); });

    // Room rotation
    if (btnRotateRoomLeft) btnRotateRoomLeft.addEventListener('click', ()=> rotateRoom(-90));
    if (btnRotateRoomRight) btnRotateRoomRight.addEventListener('click', ()=> rotateRoom(90));

    // Clear room modal
    if (btnClearRoom) btnClearRoom.addEventListener('click', openClearModal);
    if (btnCancelClear) btnCancelClear.addEventListener('click', closeClearModal);
    if (modalOverlay) modalOverlay.addEventListener('click', (e)=>{ if (e.target === modalOverlay) closeClearModal(); });
    if (btnConfirmClear) btnConfirmClear.addEventListener('click', ()=>{
      state.objects = [];
      state.selectionId = null;
      renderAll();
      updatePropsPanel();
      renderObjectList();
      scheduleAutosave();
      closeClearModal();
    });

    // Create
    btnAddRect.addEventListener('click', ()=> addObject('rect'));
    btnAddSquare.addEventListener('click', ()=> addObject('square'));
    btnAddCircle.addEventListener('click', ()=> addObject('circle'));

    // Props form: avoid applying while a numeric field is cleared; commit when valid or on change/blur
    const numericInputs = [propWidth, propHeight, propRadius, propX, propY, propRot, propThick, propLabelSize, propCorner].filter(Boolean);
    const isNumericField = (el)=> numericInputs.includes(el);
    propsForm.addEventListener('input', (e)=>{
      const el = e.target;
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement)) return;
      if (isNumericField(el)){
        const val = el.value;
        // Allow empty or '-' (for rotation) while typing; don't apply yet
        if (val === '' || val === '-') return;
      }
      applyPropsChange();
    });
    // Commit numeric fields on change and blur
    numericInputs.forEach(inp => {
      inp.addEventListener('change', ()=> applyPropsChange());
      inp.addEventListener('blur', ()=> { if (inp.value !== '' && inp.value !== '-') applyPropsChange(); });
    });

    btnDuplicate.addEventListener('click', duplicateSelected);
    btnDelete.addEventListener('click', deleteSelected);

    // Z-order controls
    if (btnToFront) btnToFront.addEventListener('click', (e)=> { e.preventDefault(); moveToFront(); });
    if (btnForward) btnForward.addEventListener('click', (e)=> { e.preventDefault(); moveForward(); });
    if (btnBackward) btnBackward.addEventListener('click', (e)=> { e.preventDefault(); moveBackward(); });
    if (btnToBack) btnToBack.addEventListener('click', (e)=> { e.preventDefault(); moveToBack(); });

    // Object selection and manipulation
    objectLayer.addEventListener('pointerdown', onObjectPointerDown);
    overlayLayer.addEventListener('pointerdown', onObjectPointerDown);
    svgRoot.addEventListener('pointermove', onPointerMove);
    svgRoot.addEventListener('pointerup', onPointerUp);
    svgRoot.addEventListener('pointercancel', onPointerUp);

    // Background panning
    canvasWrapper.addEventListener('pointerdown', onBackgroundPointerDown);

    // Zoom controls
    zoomInBtn.addEventListener('click', ()=> zoomAtWrapperCenter(ZOOM_STEP));
    zoomOutBtn.addEventListener('click', ()=> zoomAtWrapperCenter(1/ZOOM_STEP));
    btnFit.addEventListener('click', fitToRoom);
    btnResetView.addEventListener('click', resetView);

    // Wheel zoom
    canvasWrapper.addEventListener('wheel', (e)=>{
      // Trackpad/mouse wheel behaviour: Ctrl/Meta + wheel => zoom, otherwise pan
      e.preventDefault();
      const rect = canvasWrapper.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey){
        const factor = e.deltaY > 0 ? (1/ZOOM_STEP) : ZOOM_STEP;
        const cx = e.clientX - rect.left; const cy = e.clientY - rect.top;
        zoomAtPoint(factor, cx, cy);
      } else {
        // Pan by wheel deltas
        state.view.tx -= e.deltaX;
        state.view.ty -= e.deltaY;
        updateViewportTransform();
      }
    }, { passive: false });

    // Keyboard shortcuts removed as requested: no global key handlers

    // Import/Export JSON
    btnExportJson.addEventListener('click', doExportJSON);
    btnImportJson.addEventListener('click', ()=> importJsonInput.click());
    importJsonInput.addEventListener('change', doImportJSONFromFile);

    // JPEG export
    btnExportJpeg.addEventListener('click', doExportJPEG);

    // Numeric input arrow adjustments disabled to avoid keyboard interference

    // Panel collapse/expand
    if (btnCollapseLeft){ btnCollapseLeft.addEventListener('click', ()=> togglePanel('left', true)); }
    if (btnCollapseRight){ btnCollapseRight.addEventListener('click', ()=> togglePanel('right', true)); }
    if (btnExpandLeft){ btnExpandLeft.addEventListener('click', ()=> togglePanel('left', false)); }
    if (btnExpandRight){ btnExpandRight.addEventListener('click', ()=> togglePanel('right', false)); }
  }

  function savePanelState(){
    try {
      const s = {
        leftCollapsed: layoutRoot.classList.contains('left-collapsed'),
        rightCollapsed: layoutRoot.classList.contains('right-collapsed'),
      };
      localStorage.setItem('roomplanner_panels_v1', JSON.stringify(s));
    } catch{}
  }

  function togglePanel(side, collapse){
    if (!layoutRoot) return;
    if (side === 'left'){
      layoutRoot.classList.toggle('left-collapsed', !!collapse);
      if (btnExpandLeft) btnExpandLeft.setAttribute('aria-expanded', String(!collapse));
      if (btnCollapseLeft) btnCollapseLeft.setAttribute('aria-expanded', String(!collapse));
    } else if (side === 'right'){
      layoutRoot.classList.toggle('right-collapsed', !!collapse);
      if (btnExpandRight) btnExpandRight.setAttribute('aria-expanded', String(!collapse));
      if (btnCollapseRight) btnCollapseRight.setAttribute('aria-expanded', String(!collapse));
    }
    savePanelState();
  }

  function openClearModal(){ if (modalOverlay) modalOverlay.classList.remove('hidden'); }
  function closeClearModal(){ if (modalOverlay) modalOverlay.classList.add('hidden'); }

  function rotateRoom(angleDeg){
    if (!angleDeg) return;
    
    // For 90° rotations, swap room dimensions
    const is90Deg = Math.abs(angleDeg) % 90 === 0 && Math.abs(angleDeg) % 180 !== 0;
    
    const oldW = state.room.widthMm;
    const oldH = state.room.heightMm;
    const oldCx = oldW / 2;
    const oldCy = oldH / 2;
    
    if (is90Deg) {
      // Swap room dimensions for 90° or 270° rotations
      state.room.widthMm = oldH;
      state.room.heightMm = oldW;
    }
    
    const newCx = state.room.widthMm / 2;
    const newCy = state.room.heightMm / 2;
    const rad = (angleDeg * Math.PI) / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);

    // Rotate all objects around old room center, then translate to new center
    for (const obj of state.objects){
      const dx = obj.xMm - oldCx;
      const dy = obj.yMm - oldCy;
      const rotX = dx * cosA - dy * sinA;
      const rotY = dx * sinA + dy * cosA;
      obj.xMm = Math.round(newCx + rotX);
      obj.yMm = Math.round(newCy + rotY);
      obj.rotationDeg = normalizeDeg(obj.rotationDeg + angleDeg);
      ensureInsideRoom(obj, state.room);
    }
    
    // Update UI inputs
    syncRoomInputs();
    renderAll();
    updatePropsPanel();
    scheduleAutosave();
  }

  function onRoomInput(){
    const wStr = inputRoomW.value.trim();
    const hStr = inputRoomH.value.trim();
    errRoomW.textContent = '';
    errRoomH.textContent = '';

    let valid = true;
    if (!/^\d+$/.test(wStr)) { errRoomW.textContent = 'Numbers only'; valid=false; }
    if (!/^\d+$/.test(hStr)) { errRoomH.textContent = 'Numbers only'; valid=false; }

    if (!valid) return;

    let w = parseInt(wStr,10); let h = parseInt(hStr,10);
    if (w < MIN_ROOM_MM) { errRoomW.textContent = `Min ${MIN_ROOM_MM}`; valid=false; }
    if (w > MAX_ROOM_MM) { errRoomW.textContent = `Max ${MAX_ROOM_MM}`; valid=false; }
    if (h < MIN_ROOM_MM) { errRoomH.textContent = `Min ${MIN_ROOM_MM}`; valid=false; }
    if (h > MAX_ROOM_MM) { errRoomH.textContent = `Max ${MAX_ROOM_MM}`; valid=false; }
    if (!valid) return;

    state.room.widthMm = w; state.room.heightMm = h;

    // Clamp all objects into new room
    for (const obj of state.objects){
      clampSizeToRoom(obj, state.room);
      ensureInsideRoom(obj, state.room);
    }
    renderAll();
    scheduleAutosave();
  }

  // ---------------------------
  // Selection & Interaction Handlers
  // ---------------------------
  function findObjectGFromEventTarget(target){
    let el = target;
    while (el && el !== objectLayer){
      if (el.tagName === 'g' && el.classList.contains('obj')) return el;
      el = el.parentNode;
    }
    return null;
  }

  function svgPointFromClient(xClient, yClient){
    const pt = svgRoot.createSVGPoint();
    pt.x = xClient; pt.y = yClient;
    const ctm = svgRoot.getScreenCTM();
    if (!ctm) return { x:0, y:0 };
    const inv = ctm.inverse();
    const svgPt = pt.matrixTransform(inv);
    return { x: svgPt.x, y: svgPt.y };
  }

  function onObjectPointerDown(e){
    const g = findObjectGFromEventTarget(e.target);
    if (!g) return; // handled by background if not on object
    e.preventDefault();
    const id = parseInt(g.getAttribute('data-id'),10);
    selectById(id);
    const obj = getSelected();

    const handleName = e.target.getAttribute('data-handle');
    const rotateDir = e.target.closest('[data-rotate]')?.getAttribute('data-rotate') || null;

    if (rotateDir){
      // Immediate rotate by ±90° on click
      const delta = rotateDir === 'left' ? -90 : 90;
      obj.rotationDeg = normalizeDeg(obj.rotationDeg + delta);
      ensureInsideRoom(obj, state.room);
      renderObjects();
      updatePropsPanel();
      scheduleAutosave();
      return; // do not start a drag interaction or capture pointer
    }
    state.interaction.pointerId = e.pointerId;
    state.interaction.start = { x: e.clientX, y: e.clientY };
    state.interaction.objStart = deepClone(obj);
    state.interaction.targetId = id;

    if (handleName){
      if (handleName === 'rotate'){ state.interaction.mode = 'rotate'; }
      else if (handleName === 'radius' || ['n','s','e','w','nw','ne','se','sw'].includes(handleName)){
        state.interaction.mode = 'resize';
        state.interaction.handle = handleName;
      }
    } else {
      state.interaction.mode = 'drag';
    }

    svgRoot.setPointerCapture(e.pointerId);
  }

  function onBackgroundPointerDown(e){
    // Start panning only when clicked on empty space
    if (e.target.closest('.obj')) return; // let object handler manage
    e.preventDefault();
    state.interaction.mode = 'pan';
    state.interaction.pointerId = e.pointerId;
    state.interaction.start = { x: e.clientX, y: e.clientY };
    state.interaction.objStart = { tx: state.view.tx, ty: state.view.ty };
    svgRoot.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e){
    if (!state.interaction.pointerId) return;
    const mode = state.interaction.mode;
    if (mode === 'idle') return;
    e.preventDefault();

    const dxPx = e.clientX - state.interaction.start.x;
    const dyPx = e.clientY - state.interaction.start.y;

    if (mode === 'pan'){
      state.view.tx = state.interaction.objStart.tx + dxPx;
      state.view.ty = state.interaction.objStart.ty + dyPx;
      updateViewportTransform();
      return;
    }

    const obj = state.objects.find(o=>o.id===state.interaction.targetId);
    if (!obj) return;

    if (mode === 'drag'){
      const dxMm = pxToMm(dxPx, state);
      const dyMm = pxToMm(dyPx, state);
      obj.xMm = Math.round(state.interaction.objStart.xMm + dxMm);
      obj.yMm = Math.round(state.interaction.objStart.yMm + dyMm);
      if (state.settings.snapToGrid){
        const s = state.settings.gridSpacingMm;
        obj.xMm = Math.round(obj.xMm / s) * s;
        obj.yMm = Math.round(obj.yMm / s) * s;
      }
      ensureInsideRoom(obj, state.room);
      renderObjects();
      updatePropsPanel();
      scheduleAutosave();
    } else if (mode === 'resize'){
      resizeWithPointer(obj, dxPx, dyPx);
      renderObjects();
      updatePropsPanel();
      scheduleAutosave();
    } else if (mode === 'rotate'){
      const svgPt = svgPointFromClient(e.clientX, e.clientY);
      // object transform: group is translated to (xMm,yMm) then rotated rot
      const angle = Math.atan2(svgPt.y - obj.yMm, svgPt.x - obj.xMm) * 180/Math.PI; // angle relative to +X axis
      let deg = Math.round(angle);
      if (state.settings.snapRotation){
        // snap to nearest 90
        deg = Math.round(deg/90)*90;
      }
      obj.rotationDeg = normalizeDeg(deg);
      ensureInsideRoom(obj, state.room);
      renderObjects();
      updatePropsPanel();
      scheduleAutosave();
    }
  }

  function resizeWithPointer(obj, dxPx, dyPx){
    const start = state.interaction.objStart;
    const handle = state.interaction.handle;

    if (obj.type === 'circle'){
      const deltaLocalXmm = pxToMm(dxPx, state); // assuming handle on +X axis in object local space
      let r = start.radiusMm + deltaLocalXmm;
      obj.radiusMm = Math.max(MIN_SIZE_MM, r);
      clampSizeToRoom(obj, state.room);
      ensureInsideRoom(obj, state.room);
      return;
    }

    // For rect/square: convert pointer delta to local object space by inverse rotation
    const angle = rad(-start.rotationDeg);
    const cosA = Math.cos(angle), sinA = Math.sin(angle);
    const dxMm = pxToMm(dxPx, state), dyMm = pxToMm(dyPx, state);
    const dlx = Math.round(dxMm * cosA - dyMm * sinA); // local x
    const dly = Math.round(dxMm * sinA + dyMm * cosA); // local y

    let w0 = start.type==='square'?start.sizeMm:start.widthMm;
    let h0 = start.type==='square'?start.sizeMm:start.heightMm;
    let cx = start.xMm, cy = start.yMm;

    function applyWH(w,h,cxNew,cyNew){
      if (obj.type==='square'){
        const s = Math.max(MIN_SIZE_MM, Math.min(w,h));
        obj.sizeMm = s; // keep square
        obj.xMm = cxNew; obj.yMm = cyNew;
      } else {
        obj.widthMm = Math.max(MIN_SIZE_MM, w);
        obj.heightMm = Math.max(MIN_SIZE_MM, h);
        obj.xMm = cxNew; obj.yMm = cyNew;
      }
      clampSizeToRoom(obj, state.room);
      ensureInsideRoom(obj, state.room);
    }

    // Determine resize per-handle in local space
    let w=w0, h=h0, cxN=cx, cyN=cy;
    const hw0 = Math.round(w0/2), hh0 = Math.round(h0/2);

    switch (handle){
      case 'e': w = w0 + dlx; cxN = cx + Math.round(dlx/2 * Math.cos(rad(start.rotationDeg))); cyN = cy + Math.round(dlx/2 * Math.sin(rad(start.rotationDeg))); break;
      case 'w': w = w0 - dlx; cxN = cx - Math.round(dlx/2 * Math.cos(rad(start.rotationDeg))); cyN = cy - Math.round(dlx/2 * Math.sin(rad(start.rotationDeg))); break;
      case 's': h = h0 + dly; cxN = cx + Math.round(dly/2 * -Math.sin(rad(start.rotationDeg))); cyN = cy + Math.round(dly/2 * Math.cos(rad(start.rotationDeg))); break;
      case 'n': h = h0 - dly; cxN = cx - Math.round(dly/2 * -Math.sin(rad(start.rotationDeg))); cyN = cy - Math.round(dly/2 * Math.cos(rad(start.rotationDeg))); break;
      case 'ne': w = w0 + dlx; h = h0 - dly; {
        const dxHalf = Math.round(dlx/2), dyHalf = Math.round(-dly/2);
        const rot = rad(start.rotationDeg);
        cxN = cx + Math.round(dxHalf*Math.cos(rot) + dyHalf*-Math.sin(rot));
        cyN = cy + Math.round(dxHalf*Math.sin(rot) + dyHalf*Math.cos(rot));
      } break;
      case 'nw': w = w0 - dlx; h = h0 - dly; {
        const dxHalf = Math.round(-dlx/2), dyHalf = Math.round(-dly/2);
        const rot = rad(start.rotationDeg);
        cxN = cx + Math.round(dxHalf*Math.cos(rot) + dyHalf*-Math.sin(rot));
        cyN = cy + Math.round(dxHalf*Math.sin(rot) + dyHalf*Math.cos(rot));
      } break;
      case 'se': w = w0 + dlx; h = h0 + dly; {
        const dxHalf = Math.round(dlx/2), dyHalf = Math.round(dly/2);
        const rot = rad(start.rotationDeg);
        cxN = cx + Math.round(dxHalf*Math.cos(rot) + dyHalf*-Math.sin(rot));
        cyN = cy + Math.round(dxHalf*Math.sin(rot) + dyHalf*Math.cos(rot));
      } break;
      case 'sw': w = w0 - dlx; h = h0 + dly; {
        const dxHalf = Math.round(-dlx/2), dyHalf = Math.round(dly/2);
        const rot = rad(start.rotationDeg);
        cxN = cx + Math.round(dxHalf*Math.cos(rot) + dyHalf*-Math.sin(rot));
        cyN = cy + Math.round(dxHalf*Math.sin(rot) + dyHalf*Math.cos(rot));
      } break;
    }

    applyWH(w,h,cxN,cyN);
  }

  function onPointerUp(e){
    // Deselect on tap/click if we're in pan mode and haven't moved much
    if (state.interaction.mode === 'pan' && state.interaction.start) {
      const dx = e.clientX - state.interaction.start.x;
      const dy = e.clientY - state.interaction.start.y;
      const dist = Math.sqrt(dx*dx + dy*dy);
      // If moved less than 5px, treat as a tap to deselect
      if (dist < 5 && state.selectionId !== null) {
        state.selectionId = null;
        renderAll();
        updatePropsPanel();
      }
    }
    
    if (state.interaction.pointerId){
      try { svgRoot.releasePointerCapture(state.interaction.pointerId); } catch{}
    }
    state.interaction.mode = 'idle';
    state.interaction.pointerId = null;
    state.interaction.start = null;
    state.interaction.objStart = null;
    state.interaction.handle = null;
    state.interaction.targetId = null;
  }

  function onKeyDown(e){
    const obj = getSelected();
    // Zoom shortcuts
    if ((e.key === '+' || e.key === '=') && !e.altKey){ e.preventDefault(); zoomAtWrapperCenter(ZOOM_STEP); return; }
    if ((e.key === '-' || e.key === '_') && !e.altKey){ e.preventDefault(); zoomAtWrapperCenter(1/ZOOM_STEP); return; }
    if (e.key.toLowerCase() === 'f'){ e.preventDefault(); fitToRoom(); return; }
    if (e.key.toLowerCase() === 'r'){ e.preventDefault(); resetView(); return; }

    if (!obj) return;

    // Delete
    if (e.key === 'Delete' || e.key === 'Backspace'){
      e.preventDefault(); deleteSelected(); return;
    }
    // Duplicate
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='d'){
      e.preventDefault(); duplicateSelected(); return; }

    // Nudge
    const step = e.shiftKey ? NUDGE_MM_FAST : NUDGE_MM;
    let changed = false;
    if (e.key === 'ArrowLeft'){ obj.xMm -= step; changed = true; }
    else if (e.key === 'ArrowRight'){ obj.xMm += step; changed = true; }
    else if (e.key === 'ArrowUp'){ obj.yMm -= step; changed = true; }
    else if (e.key === 'ArrowDown'){ obj.yMm += step; changed = true; }

    if (changed){
      if (state.settings.snapToGrid){ const s = state.settings.gridSpacingMm; obj.xMm = Math.round(obj.xMm/s)*s; obj.yMm = Math.round(obj.yMm/s)*s; }
      ensureInsideRoom(obj, state.room);
      renderObjects(); updatePropsPanel();
    }
  }

  // Provide arrow-key +/- adjustments on numeric text inputs to match mm nudge behaviour
  function setupNumericArrowAdjustments(){
    const numericInputs = [
      inputRoomW, inputRoomH,
      propWidth, propHeight, propRadius, propX, propY, propRot, propThick, propLabelSize
    ].filter(Boolean);
    numericInputs.forEach(inp => {
      inp.addEventListener('keydown', (e)=>{
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const fast = e.shiftKey ? NUDGE_MM_FAST : NUDGE_MM;
        const sign = e.key === 'ArrowUp' ? 1 : -1;
        const isRotation = inp === propRot;
        const base = isIntString(inp.value) ? parseInt(inp.value,10) : 0;
        let next = base + sign * fast;
        if (isRotation){
          // Accept within [-360,360]
          next = clampInt(next, -360, 360);
        } else if (inp === inputRoomW || inp === inputRoomH){
          next = clampInt(next, MIN_ROOM_MM, MAX_ROOM_MM);
        } else if (inp === propThick){
          next = Math.max(0, next);
        } else {
          next = Math.max(MIN_SIZE_MM, next);
        }
        inp.value = String(next);
        // Trigger corresponding handlers
        if (inp === inputRoomW || inp === inputRoomH){ onRoomInput(); }
        else { applyPropsChange(); }
      });
    });
  }

  function deleteSelected(){
    const obj = getSelected(); if (!obj) return;
    state.objects = state.objects.filter(o=>o.id!==obj.id);
    state.selectionId = null;
    renderAll(); updatePropsPanel(); renderObjectList(); scheduleAutosave();
  }

  function duplicateSelected(){
    const obj = getSelected(); if (!obj) return;
    const dup = deepClone(obj);
    dup.id = state.nextId++;
    dup.name = (dup.name||'') + ' copy';
    dup.xMm += 200; dup.yMm += 200;
    ensureInsideRoom(dup, state.room);
    state.objects.push(dup);
    state.selectionId = dup.id;
    renderAll(); updatePropsPanel(); renderObjectList(); scheduleAutosave();
  }

  // ---------------------------
  // Z-order management
  // ---------------------------
  function moveToFront(){
    const obj = getSelected(); if (!obj) return;
    const idx = state.objects.findIndex(o=>o.id===obj.id);
    if (idx === -1 || idx === state.objects.length - 1) return;
    state.objects.splice(idx, 1);
    state.objects.push(obj);
    renderAll(); renderObjectList(); scheduleAutosave();
  }

  function moveForward(){
    const obj = getSelected(); if (!obj) return;
    const idx = state.objects.findIndex(o=>o.id===obj.id);
    if (idx === -1 || idx === state.objects.length - 1) return;
    [state.objects[idx], state.objects[idx + 1]] = [state.objects[idx + 1], state.objects[idx]];
    renderAll(); renderObjectList(); scheduleAutosave();
  }

  function moveBackward(){
    const obj = getSelected(); if (!obj) return;
    const idx = state.objects.findIndex(o=>o.id===obj.id);
    if (idx === -1 || idx === 0) return;
    [state.objects[idx], state.objects[idx - 1]] = [state.objects[idx - 1], state.objects[idx]];
    renderAll(); renderObjectList(); scheduleAutosave();
  }

  function moveToBack(){
    const obj = getSelected(); if (!obj) return;
    const idx = state.objects.findIndex(o=>o.id===obj.id);
    if (idx === -1 || idx === 0) return;
    state.objects.splice(idx, 1);
    state.objects.unshift(obj);
    renderAll(); renderObjectList(); scheduleAutosave();
  }

  function reorderObject(draggedId, targetId){
    const draggedIdx = state.objects.findIndex(o=>o.id===draggedId);
    const targetIdx = state.objects.findIndex(o=>o.id===targetId);
    if (draggedIdx === -1 || targetIdx === -1) return;
    
    const [draggedObj] = state.objects.splice(draggedIdx, 1);
    // Since list is reversed (front to back), we need to insert at target position
    // The visual order is reversed, so dragging down in the list = moving back in z-order
    state.objects.splice(targetIdx, 0, draggedObj);
    
    renderAll(); renderObjectList(); scheduleAutosave();
  }

  // ---------------------------
  // Zoom & Pan helpers
  // ---------------------------
  function setZoomState(scale){
    state.view.scale = clamp(scale, ZOOM_MIN, ZOOM_MAX);
    zoomLevelOutput.textContent = Math.round(state.view.scale*100) + '%';
  }

  function zoomAtPoint(factor, cxPx, cyPx){
    // Keep (cxPx,cyPx) in wrapper space fixed in room space
    const beforeScale = state.view.scale;
    const afterScale = clamp(beforeScale * factor, ZOOM_MIN, ZOOM_MAX);
    if (afterScale === beforeScale) return;

    const rect = canvasWrapper.getBoundingClientRect();
    const sx = (cxPx - state.view.tx) / beforeScale; // room mm at cursor before
    const sy = (cyPx - state.view.ty) / beforeScale;

    state.view.scale = afterScale;
    state.view.tx = cxPx - sx * afterScale;
    state.view.ty = cyPx - sy * afterScale;

    updateViewportTransform();
    updateZoomUI();
  }
  function zoomAtWrapperCenter(factor){
    const rect = canvasWrapper.getBoundingClientRect();
    zoomAtPoint(factor, rect.width/2, rect.height/2);
  }
  function fitToRoom(){
    const rect = canvasWrapper.getBoundingClientRect();
    const marginPx = 40;
    const availW = rect.width - marginPx*2;
    const availH = rect.height - marginPx*2;
    const scaleX = availW / state.room.widthMm;
    const scaleY = availH / state.room.heightMm;
    const scale = clamp(Math.min(scaleX, scaleY), ZOOM_MIN, ZOOM_MAX);
    state.view.scale = scale;
    state.view.tx = marginPx + (availW - state.room.widthMm*scale)/2;
    state.view.ty = marginPx + (availH - state.room.heightMm*scale)/2;
    updateViewportTransform();
    updateZoomUI();
  }
  function resetView(){
    state.view.scale = 0.2; state.view.tx = 40; state.view.ty = 40; updateViewportTransform(); updateZoomUI();
  }
  function updateZoomUI(){
    zoomLevelOutput.textContent = Math.round(state.view.scale*100)+'%';
  }

  // ---------------------------
  // Import/Export JSON
  // ---------------------------
  function currentModel(){
    return {
      schemaVersion: SCHEMA_VERSION,
      room: deepClone(state.room),
      objects: deepClone(state.objects),
      settings: {
        gridVisible: !!state.settings.gridVisible,
        gridSpacingMm: state.settings.gridSpacingMm,
        snapToGrid: !!state.settings.snapToGrid,
        snapRotation: !!state.settings.snapRotation,
      },
    };
  }

  // ---------------------------
  // Autosave (localStorage)
  // ---------------------------
  let autosaveTimer = null;
  function saveAutosave(){
    try {
      const data = currentModel();
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(data));
    } catch(e){ /* ignore quota/privacy errors */ }
  }
  function scheduleAutosave(){
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(saveAutosave, 300);
  }
  function loadAutosaveIfAny(){
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return;
    try {
      const model = JSON.parse(raw);
      const errs = validateModel(model);
      if (errs.length) return;
      state.room = deepClone(model.room);
      state.objects = deepClone(model.objects);
      if (model.settings){
        state.settings.gridVisible = !!model.settings.gridVisible;
        if (Number.isInteger(model.settings.gridSpacingMm)) state.settings.gridSpacingMm = model.settings.gridSpacingMm;
        if (typeof model.settings.snapToGrid === 'boolean') state.settings.snapToGrid = model.settings.snapToGrid;
        if (typeof model.settings.snapRotation === 'boolean') state.settings.snapRotation = model.settings.snapRotation;
      }
      state.selectionId = null;
      let maxId = 0; for (const o of state.objects){ if (o.id>maxId) maxId=o.id; }
      state.nextId = maxId+1;
    } catch(_) { /* ignore parse errors */ }
  }

  function validateModel(model){
    const errs = [];
    if (!model || model.schemaVersion !== SCHEMA_VERSION){ errs.push('Unsupported or missing schemaVersion.'); }
    if (!model.room) errs.push('Missing room.');
    if (!Number.isInteger(model.room?.widthMm) || !Number.isInteger(model.room?.heightMm)) errs.push('Room dimensions must be integers.');
    if (model.room.widthMm < MIN_ROOM_MM || model.room.widthMm > MAX_ROOM_MM) errs.push('Room width out of range.');
    if (model.room.heightMm < MIN_ROOM_MM || model.room.heightMm > MAX_ROOM_MM) errs.push('Room height out of range.');
    if (!Array.isArray(model.objects)) errs.push('Objects missing or invalid.');

    for (const [i,o] of (model.objects||[]).entries()){
      if (!['rect','square','circle'].includes(o.type)) errs.push(`Object ${i}: invalid type`);
      if (!Number.isInteger(o.xMm) || !Number.isInteger(o.yMm)) errs.push(`Object ${i}: xMm/yMm must be integers`);
      if (!Number.isInteger(o.rotationDeg)) errs.push(`Object ${i}: rotationDeg must be integer`);
      if (o.type==='circle'){
        if (!Number.isInteger(o.radiusMm) || o.radiusMm < MIN_SIZE_MM) errs.push(`Object ${i}: radius invalid`);
      } else if (o.type==='square'){
        if (!Number.isInteger(o.sizeMm) || o.sizeMm < MIN_SIZE_MM) errs.push(`Object ${i}: size invalid`);
      } else {
        if (!Number.isInteger(o.widthMm) || o.widthMm < MIN_SIZE_MM) errs.push(`Object ${i}: width invalid`);
        if (!Number.isInteger(o.heightMm) || o.heightMm < MIN_SIZE_MM) errs.push(`Object ${i}: height invalid`);
      }
      if (!o.style) errs.push(`Object ${i}: missing style`);
      if (!Number.isInteger(o.style?.borderMm) || o.style.borderMm < 0) errs.push(`Object ${i}: border thickness invalid`);
      if (o.style && o.style.labelPx != null){
        if (!Number.isInteger(o.style.labelPx) || o.style.labelPx < 1) errs.push(`Object ${i}: label size invalid`);
      }
      if (o.style && o.style.cornerMm != null){
        if (!Number.isInteger(o.style.cornerMm) || o.style.cornerMm < 0) errs.push(`Object ${i}: corner radius invalid`);
      }
    }
    // Optional settings validation
    if (model.settings){
      if (typeof model.settings.gridVisible !== 'boolean') errs.push('settings.gridVisible must be boolean.');
      if (!Number.isInteger(model.settings.gridSpacingMm)) errs.push('settings.gridSpacingMm must be integer.');
      if (typeof model.settings.snapToGrid !== 'boolean') errs.push('settings.snapToGrid must be boolean.');
      if (typeof model.settings.snapRotation !== 'boolean') errs.push('settings.snapRotation must be boolean.');
    }
    return errs;
  }

  function doExportJSON(){
    const data = currentModel();
    downloadText('roomplanner-layout.json', JSON.stringify(data, null, 2));
  }

  function doImportJSONFromFile(){
    importJsonErr.textContent = '';
    const file = importJsonInput.files && importJsonInput.files[0];
    if (!file){ importJsonErr.textContent = 'No file selected.'; return; }
    const reader = new FileReader();
    reader.onerror = ()=> importJsonErr.textContent = 'Failed to read file.';
    reader.onload = ()=>{
      try {
        const model = JSON.parse(String(reader.result));
        const errs = validateModel(model);
        if (errs.length){ importJsonErr.textContent = errs.join(' '); return; }
        // apply model
        state.room = deepClone(model.room);
        state.objects = deepClone(model.objects);
        if (model.settings){
          state.settings.gridVisible = !!model.settings.gridVisible;
          if (Number.isInteger(model.settings.gridSpacingMm)) state.settings.gridSpacingMm = model.settings.gridSpacingMm;
          if (typeof model.settings.snapToGrid === 'boolean') state.settings.snapToGrid = model.settings.snapToGrid;
          if (typeof model.settings.snapRotation === 'boolean') state.settings.snapRotation = model.settings.snapRotation;
          // Sync UI controls with imported settings
          toggleGrid.checked = state.settings.gridVisible;
          gridSpacingSel.value = String(state.settings.gridSpacingMm);
          snapGridChk.checked = state.settings.snapToGrid;
          snapRotChk.checked = state.settings.snapRotation;
        }
        // Backward compatibility: ensure style.labelPx exists
        for (const o of state.objects){
          if (!o.style) o.style = deepClone(DEFAULT_STYLE);
          if (!Number.isInteger(o.style.labelPx)) o.style.labelPx = DEFAULT_STYLE.labelPx;
          if (!Number.isInteger(o.style.cornerMm)) o.style.cornerMm = DEFAULT_STYLE.cornerMm;
        }
        state.selectionId = null;
        // recompute nextId
        let maxId = 0; for (const o of state.objects){ if (o.id>maxId) maxId=o.id; }
        state.nextId = maxId+1;
        renderAll(); updatePropsPanel(); syncRoomInputs(); fitToRoom(); scheduleAutosave();
      } catch(err){
        importJsonErr.textContent = 'Invalid JSON.';
      }
    };
    reader.readAsText(file);
    importJsonInput.value = '';
  }

  // ---------------------------
  // JPEG Export via SVG rasterization
  // ---------------------------
  function inlineStylesForSVGExport(svg){
    // Embed essential CSS into SVG for consistent rasterization
    const style = document.createElementNS('http://www.w3.org/2000/svg','style');
    style.textContent = `
      .room-rect{ fill:#0f172a; stroke:#eab308; stroke-width:2; vector-effect: non-scaling-stroke; }
      .grid-line{ stroke:#374151; stroke-width:.5; shape-rendering:crispEdges; vector-effect: non-scaling-stroke; }
      .shape{ }
      .label{ fill:#e5e7eb; text-anchor:middle; dominant-baseline:central; font-family: sans-serif; }
      .handle, .handle-rot, .rotate-btn{ display:none; }
    `;
    const defs = svg.querySelector('defs') || document.createElementNS('http://www.w3.org/2000/svg','defs');
    defs.appendChild(style);
    if (!svg.querySelector('defs')) svg.insertBefore(defs, svg.firstChild);
  }

  function snapshotSVG(includeGrid, includeLabels){
    const svgClone = svgRoot.cloneNode(true);
    // Toggle grid and labels visibility based on export options
    const grid = svgClone.querySelector('#grid-layer');
    if (grid) grid.setAttribute('visibility', includeGrid ? 'visible' : 'hidden');
    if (!includeLabels){
      svgClone.querySelectorAll('.label').forEach(el=> el.parentNode && el.parentNode.removeChild(el));
    }
    inlineStylesForSVGExport(svgClone);

    // Ensure exported SVG has explicit pixel dimensions matching visible canvas
    const rect = canvasWrapper.getBoundingClientRect();
    svgClone.setAttribute('width', String(Math.round(rect.width)));
    svgClone.setAttribute('height', String(Math.round(rect.height)));

    // Serialize
    const ser = new XMLSerializer();
    const src = ser.serializeToString(svgClone);
    const svg64 = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(src);
    return { dataUrl: svg64 };
  }

  function doExportJPEG(){
    jpegErr.textContent = '';
    const pxWidth = parseIntSafe(jpegWidthInput.value, 2000);
    if (!Number.isInteger(pxWidth) || pxWidth < 100){ jpegErr.textContent = 'Width must be an integer >= 100.'; return; }

    const includeGrid = !!jpegIncludeGrid.checked;
    const includeLabels = !!jpegIncludeLabels.checked;

    const snap = snapshotSVG(includeGrid, includeLabels);
    const img = new Image();
    img.onload = ()=>{
      const aspect = img.height / img.width;
      const canvas = document.createElement('canvas');
      canvas.width = pxWidth; canvas.height = Math.round(pxWidth * aspect);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob)=>{
        if (!blob){ jpegErr.textContent = 'Export failed.'; return; }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'roomplanner-layout.jpg';
        a.click();
        setTimeout(()=> URL.revokeObjectURL(a.href), 1000);
      }, 'image/jpeg', 0.92);
    };
    img.onerror = ()=>{ jpegErr.textContent = 'Rasterization failed.'; };
    img.src = snap.dataUrl;
  }

  // ---------------------------
  // Helpers
  // ---------------------------
  function injectUserGuide(){
    userGuideContainer.innerHTML = `
      <p><strong>Define Room:</strong> Enter width and height in millimetres (500–50,000). The canvas resizes immediately and objects are clamped inside the room.</p>
      <p><strong>Create Objects:</strong> Use Rectangle, Square, or Circle. Objects store a name, dimensions, centre coordinates, and rotation. All values are integer millimetres internally.</p>
      <p><strong>Select & Manipulate:</strong> Click an object to select. Drag to move. Use handles to resize from edges/corners or rotate using the round handle above the object. Rotation accepts −360 to +360 input; values are normalized to 0–359 internally. Optional snapping aligns rotation to 90° and positions to the grid intersections.</p>
      <p><strong>Zoom & Pan:</strong> Scroll to zoom around the cursor (10%–500%). Drag background or hold Space and drag to pan. Zoom does not alter stored measurements.</p>
      <p><strong>Grid & Snapping:</strong> Toggle grid visibility and pick spacing (100/250/500/1000 mm). Enable snapping to constrain positions to grid intersections. Grid never affects stored values.</p>
      <p><strong>Properties:</strong> With an object selected, edit name, shape, dimensions, coordinates, rotation, fill, border & thickness, and label visibility. Changes update the SVG immediately.</p>
      <p><strong>Export/Import:</strong> Export JSON to capture schema version, room, objects, and styling precisely. Import validates the schema and reconstructs layouts exactly. Export JPEG to capture the current visible canvas at your chosen pixel width, optionally including grid and labels.</p>
      <p><strong>Keyboard:</strong> Arrows nudge by 10mm (Shift for 100mm). Cmd/Ctrl+D duplicates. Delete removes. F fits the room. R resets view. +/- zoom.</p>
      <p><strong>Accessibility:</strong> All controls are keyboard navigable with clear focus rings. Numeric fields accept arrow keys for step changes (browser default). Touch and mouse interactions are supported.</p>
    `;
  }

  // ---------------------------
  // Boot
  // ---------------------------
  init();
})();
