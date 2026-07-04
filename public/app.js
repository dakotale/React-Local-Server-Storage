var app = angular.module('cloudApp', []);

// ── Accent color math ──────────────────────────────────────────────────────
// Everything themeable derives from a single hex value: --accent-hover is a
// darkened mix, --accent-light a whitened mix (for text on dark chips), and
// --accent-rgb/--accent-dim feed the rgba() based borders/shadows in CSS.
var ACCENT_STORAGE_KEY = 'cloudstorage-accent';
var DEFAULT_ACCENT     = '#8b5cf6';

function hexToRgb(hex) {
  hex = (hex || '').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(function(c) { return c + c; }).join('');
  var num = parseInt(hex, 16);
  if (isNaN(num)) return { r: 139, g: 92, b: 246 };
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function toHex(v) {
  v = Math.max(0, Math.min(255, Math.round(v)));
  var s = v.toString(16);
  return s.length === 1 ? '0' + s : s;
}

function mixHex(rgb, target, amount) {
  return '#' +
    toHex(rgb.r + (target.r - rgb.r) * amount) +
    toHex(rgb.g + (target.g - rgb.g) * amount) +
    toHex(rgb.b + (target.b - rgb.b) * amount);
}

function applyAccent(hex) {
  var rgb   = hexToRgb(hex);
  var root  = document.documentElement.style;
  root.setProperty('--accent',       hex);
  root.setProperty('--accent-hover', mixHex(rgb, { r: 0,   g: 0,   b: 0   }, 0.18));
  root.setProperty('--accent-light', mixHex(rgb, { r: 255, g: 255, b: 255 }, 0.45));
  root.setProperty('--accent-rgb',   rgb.r + ',' + rgb.g + ',' + rgb.b);
  root.setProperty('--accent-dim',   'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',.15)');
}

// ── Nested folder tree ──────────────────────────────────────────────────────
// Folders are stored server-side as flat "/"-joined path strings (e.g.
// "Work/Invoices") — no real hierarchy on disk, just a label. This turns
// that flat list into an ordered, indented row list the sidebar and folder
// <select>s can render directly, without needing recursive templates.
function buildFolderRows(paths) {
  var root = { children: {}, order: [] };
  paths.forEach(function(p) {
    var node = root;
    var acc  = '';
    p.split('/').forEach(function(part) {
      acc = acc ? acc + '/' + part : part;
      if (!node.children[part]) {
        node.children[part] = { name: part, path: acc, children: {}, order: [] };
        node.order.push(part);
      }
      node = node.children[part];
    });
  });
  var rows = [];
  (function flatten(node, depth) {
    node.order.forEach(function(key) {
      var child = node.children[key];
      rows.push({ name: child.name, path: child.path, depth: depth });
      flatten(child, depth + 1);
    });
  })(root, 0);
  return rows;
}

app.controller('MainCtrl', ['$scope', '$http', '$sce', '$timeout',
function($scope, $http, $sce, $timeout) {

  // ── State ─────────────────────────────────────────────────────────────────
  $scope.files          = [];
  $scope.loading        = false;
  $scope.uploading      = false;
  $scope.uploadProgress = 0;
  $scope.isDragging     = false;
  $scope.serverInfo     = null;
  $scope.toasts         = [];

  $scope.sidebarOpen     = true;
  $scope.currentFolder   = null;
  $scope.folders         = [];
  $scope.showFolderInput = false;
  $scope.newFolderName   = '';

  // ── Bulk selection ───────────────────────────────────────────────────────
  $scope.selectedIds     = {};
  $scope.bulk            = { tag: '', folder: '' };
  $scope.lastSelectedIdx = null; // anchor for shift-click range selection

  $scope.isSelected = function(file) { return !!$scope.selectedIds[file.id]; };

  $scope.toggleSelect = function(file, $event) {
    if ($event) $event.stopPropagation();
    if ($scope.selectedIds[file.id]) delete $scope.selectedIds[file.id];
    else $scope.selectedIds[file.id] = true;
    $scope.lastSelectedIdx = $scope.visibleFiles.indexOf(file);
  };

  $scope.selectionCount = function() { return Object.keys($scope.selectedIds).length; };

  $scope.clearSelection = function() { $scope.selectedIds = {}; $scope.lastSelectedIdx = null; };

  // Card click dispatcher: plain click opens the preview (existing
  // behavior); Ctrl/Cmd-click toggles just that file like a native file
  // manager; Shift-click selects the contiguous range from the last
  // clicked/checked card to this one.
  $scope.onCardClick = function(file, $event) {
    var idx = $scope.visibleFiles.indexOf(file);
    if ($event.shiftKey && $scope.lastSelectedIdx !== null) {
      var start = Math.min($scope.lastSelectedIdx, idx);
      var end   = Math.max($scope.lastSelectedIdx, idx);
      for (var i = start; i <= end; i++) $scope.selectedIds[$scope.visibleFiles[i].id] = true;
      $scope.lastSelectedIdx = idx;
      return;
    }
    if ($event.ctrlKey || $event.metaKey) {
      $scope.toggleSelect(file);
      return;
    }
    $scope.openPreview(file);
    $scope.lastSelectedIdx = idx;
  };

  $scope.bulkTagKeydown = function($event) {
    if ($event.which === 13) { $event.preventDefault(); $scope.applyBulkTag(); }
  };

  $scope.applyBulkTag = function() {
    var tag = ($scope.bulk.tag || '').trim().toLowerCase();
    var ids = Object.keys($scope.selectedIds);
    if (!tag || !ids.length) return;
    $http.patch('/api/bulk/update', { ids: ids, addTag: tag }).then(function() {
      $scope.files.forEach(function(f) {
        if ($scope.selectedIds[f.id] && (f.tags || []).indexOf(tag) === -1)
          f.tags = (f.tags || []).concat([tag]);
      });
      $scope.bulk.tag = '';
      $scope.refreshTags();
      $scope.recomputeVisibleFiles();
      $scope.showToast('Tagged ' + ids.length + ' file' + (ids.length > 1 ? 's' : ''), 'success');
    }, function() { $scope.showToast('Bulk tag failed', 'error'); });
  };

  $scope.applyBulkFolder = function() {
    var ids = Object.keys($scope.selectedIds);
    if (!ids.length) return;
    var folder = $scope.bulk.folder || null;
    $http.patch('/api/bulk/update', { ids: ids, folder: folder }).then(function() {
      $scope.files.forEach(function(f) { if ($scope.selectedIds[f.id]) f.folder = folder; });
      $scope.loadFolders();
      $scope.recomputeVisibleFiles();
      $scope.showToast('Moved ' + ids.length + ' file' + (ids.length > 1 ? 's' : ''), 'info');
    }, function() { $scope.showToast('Bulk move failed', 'error'); });
  };

  $scope.bulkDownload = function() {
    var ids = Object.keys($scope.selectedIds);
    if (!ids.length) return;
    var a = document.createElement('a');
    a.href = '/api/bulk/download?ids=' + ids.join(',');
    a.download = 'files.zip';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  $scope.bulkDelete = function() {
    var ids = Object.keys($scope.selectedIds);
    if (!ids.length) return;
    if (!confirm('Delete ' + ids.length + ' file' + (ids.length > 1 ? 's' : '') + '? This cannot be undone.')) return;
    $http.post('/api/bulk/delete', { ids: ids }).then(function() {
      $scope.files = $scope.files.filter(function(f) { return !$scope.selectedIds[f.id]; });
      $scope.clearSelection();
      $scope.refreshTags(); $scope.loadFolders(); $scope.loadServerInfo(); $scope.recomputeVisibleFiles();
      $scope.showToast(ids.length + ' file' + (ids.length > 1 ? 's' : '') + ' deleted', 'info');
    }, function() { $scope.showToast('Bulk delete failed', 'error'); });
  };

  // ── Theme (accent color) ─────────────────────────────────────────────────
  $scope.accentPresets = [
    { name: 'Violet', hex: '#8b5cf6' },
    { name: 'Blue',   hex: '#3b82f6' },
    { name: 'Teal',   hex: '#14b8a6' },
    { name: 'Pink',   hex: '#ec4899' },
    { name: 'Amber',  hex: '#f59e0b' },
    { name: 'Indigo', hex: '#6366f1' }
  ];
  $scope.theme = { open: false, accent: localStorage.getItem(ACCENT_STORAGE_KEY) || DEFAULT_ACCENT };
  applyAccent($scope.theme.accent);

  $scope.setAccent = function(hex) {
    $scope.theme.accent = hex;
    applyAccent(hex);
    localStorage.setItem(ACCENT_STORAGE_KEY, hex);
  };
  $scope.resetAccent      = function() { $scope.setAccent(DEFAULT_ACCENT); };
  $scope.toggleThemePanel = function($event) {
    if ($event) $event.stopPropagation();
    $scope.theme.open = !$scope.theme.open;
  };

  // ── Storage dashboard ────────────────────────────────────────────────────
  $scope.storageOpen = false;
  $scope.storageInfo = null;

  var CATEGORY_COLORS = { image: '#db2777', video: '#dc2626', audio: '#059669', pdf: '#ea580c', text: '#7c3aed', other: '#71717a' };
  $scope.categoryColor = function(cat) { return CATEGORY_COLORS[cat] || '#71717a'; };

  $scope.openStorageModal = function() {
    $scope.storageOpen = true;
    $http.get('/api/storage').then(function(r) { $scope.storageInfo = r.data; });
  };
  $scope.closeStorageModal = function() { $scope.storageOpen = false; };

  $scope.storageUsedPct = function() {
    if (!$scope.storageInfo || !$scope.storageInfo.disk || !$scope.storageInfo.disk.total) return 0;
    return Math.min(100, Math.round(($scope.storageInfo.disk.used / $scope.storageInfo.disk.total) * 100));
  };
  $scope.storagePct = function(size) {
    if (!$scope.storageInfo || !$scope.storageInfo.totalSize) return 0;
    return Math.round((size / $scope.storageInfo.totalSize) * 100);
  };

  $scope.allTags     = [];
  $scope.activeTags  = [];
  $scope.searchQuery = '';
  $scope.visibleFiles = [];
  $scope.breadcrumb   = [];

  // Wrapping transient inputs in an object prevents ng-if child-scope shadowing.
  // Without the dot, ng-model inside ng-if writes to the child scope and the
  // parent controller never sees the typed value. sortBy lives here (rather
  // than as $scope.sortBy) because its <select> sits inside the ng-if="files.length > 0"
  // toolbar — a bare ng-model there would silently shadow the real value.
  $scope.ui       = { newTag: '', sortBy: 'date-desc' };
  $scope.cardEdit = { fileId: null, value: '' };

  $scope.previewFile        = null;
  $scope.previewType        = null;
  $scope.previewTextContent = '';
  $scope.trustedPreviewUrl  = '';

  // ── Rename ────────────────────────────────────────────────────────────────
  // Wrapped in an object (like ui/theme/bulk above) — the rename input lives
  // inside ng-if="rename.active", and a bare ng-model there would shadow the
  // real value on a child scope instead of updating this one.
  $scope.rename = { active: false, value: '' };

  $scope.startRename = function(file, $event) {
    if ($event) $event.stopPropagation();
    $scope.rename.active = true;
    $scope.rename.value  = file.name;
    $timeout(function() { var el = document.getElementById('rename-input'); if (el) { el.focus(); el.select(); } }, 40);
  };

  $scope.cancelRename = function() { $scope.rename.active = false; $scope.rename.value = ''; };

  $scope.saveRename = function(file) {
    var name = ($scope.rename.value || '').trim();
    if (!name || name === file.name) { $scope.cancelRename(); return; }
    $http.patch('/api/files/' + file.id, { name: name }).then(function() {
      file.name = name;
      $scope.recomputeVisibleFiles();
      $scope.cancelRename();
    }, function(err) {
      $scope.showToast((err.data && err.data.error) || 'Rename failed', 'error');
    });
  };

  $scope.renameKeydown = function($event, file) {
    if ($event.which === 13) { $event.preventDefault(); $scope.saveRename(file); }
    if ($event.which === 27) { $event.stopPropagation(); $scope.cancelRename(); }
  };

  $scope.chatOpen    = false;
  $scope.chatMsgs    = [];
  $scope.chatInput   = '';
  $scope.chatLoading = false;

  // ── Toasts ────────────────────────────────────────────────────────────────
  $scope.showToast = function(msg, type) {
    var t = { msg: msg, type: type || 'info' };
    $scope.toasts.push(t);
    $timeout(function() { $scope.toasts.splice($scope.toasts.indexOf(t), 1); }, 3500);
  };

  // ── Tags ──────────────────────────────────────────────────────────────────
  $scope.refreshTags = function() {
    var set = {};
    $scope.files.forEach(function(f) { (f.tags || []).forEach(function(t) { set[t] = true; }); });
    $scope.allTags = Object.keys(set).sort();
  };

  var TAG_COLORS = ['#3b82f6','#8b5cf6','#ec4899','#10b981','#f59e0b','#06b6d4','#f97316'];
  $scope.tagColor = function(tag) {
    var h = 0;
    for (var i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) % TAG_COLORS.length;
    return TAG_COLORS[Math.abs(h)];
  };

  function applyTag(file, raw) {
    var tag = (raw || '').trim().toLowerCase();
    if (!tag || (file.tags || []).indexOf(tag) !== -1) return false;
    file.tags = (file.tags || []).concat([tag]);
    $http.patch('/api/files/' + file.id, { tags: file.tags }).then($scope.refreshTags);
    return true;
  }

  $scope.addTagFromModal = function(file) { if (applyTag(file, $scope.ui.newTag)) $scope.ui.newTag = ''; };
  $scope.modalTagKeydown = function(e, file) {
    if (e.which === 13 || e.which === 188) { e.preventDefault(); $scope.addTagFromModal(file); }
  };

  $scope.removeTagFromFile = function(file, tag) {
    file.tags = (file.tags || []).filter(function(t) { return t !== tag; });
    $http.patch('/api/files/' + file.id, { tags: file.tags }).then(function() {
      $scope.refreshTags();
      var i = $scope.activeTags.indexOf(tag);
      if (i > -1) $scope.activeTags.splice(i, 1);
      $scope.recomputeVisibleFiles();
    });
  };

  $scope.toggleTagFilter = function(tag) {
    var i = $scope.activeTags.indexOf(tag);
    if (i > -1) $scope.activeTags.splice(i, 1); else $scope.activeTags.push(tag);
    $scope.recomputeVisibleFiles();
  };
  $scope.isTagActive = function(tag) { return $scope.activeTags.indexOf(tag) !== -1; };

  // ── Card inline tag editor ────────────────────────────────────────────────
  $scope.openCardTagEdit = function(file, $event) {
    $event.stopPropagation();
    $scope.cardEdit.fileId = file.id;
    $scope.cardEdit.value  = '';
    $timeout(function() { var el = document.getElementById('ctag-' + file.id); if (el) el.focus(); }, 40);
  };

  $scope.saveCardTag = function(file, $event) {
    if ($event) $event.stopPropagation();
    applyTag(file, $scope.cardEdit.value);
    $scope.cardEdit.fileId = null;
    $scope.cardEdit.value  = '';
  };

  $scope.cardTagKeydown = function($event, file) {
    if ($event.which === 13) { $event.preventDefault(); $scope.saveCardTag(file, $event); }
    if ($event.which === 27) { $event.stopPropagation(); $scope.cardEdit.fileId = null; }
  };

  // ── Folders ───────────────────────────────────────────────────────────────
  $scope.folderRows = [];

  $scope.loadFolders = function() {
    $http.get('/api/folders').then(function(r) {
      $scope.folders    = r.data;
      $scope.folderRows = buildFolderRows(r.data);
      var stillExists = $scope.folderRows.some(function(row) { return row.path === $scope.currentFolder; });
      if ($scope.currentFolder && !stillExists) {
        $scope.currentFolder = null;
        $scope.recomputeVisibleFiles();
      }
    });
  };

  // Indent text prefix for folder <option> elements, which can't be styled
  // with real CSS padding cross-browser.
  $scope.folderIndent = function(depth) { return depth > 0 ? new Array(depth + 1).join(' ') : ''; };

  $scope.navigateFolder = function(folder) { $scope.currentFolder = folder; $scope.activeTags = []; $scope.recomputeVisibleFiles(); };

  $scope.clearActiveTags = function() { $scope.activeTags = []; $scope.recomputeVisibleFiles(); };

  $scope.createFolder = function() {
    var name = ($scope.newFolderName || '').trim();
    if (!name) return;
    if (name.indexOf('/') !== -1) { $scope.showToast('Folder name can\'t contain "/"', 'error'); return; }
    // Creating a folder while inside another one nests it there automatically.
    var fullPath = $scope.currentFolder ? $scope.currentFolder + '/' + name : name;
    $http.post('/api/folders', { name: fullPath }).then(function() {
      $scope.loadFolders();
      $scope.currentFolder   = fullPath;
      $scope.newFolderName   = '';
      $scope.showFolderInput = false;
      $scope.recomputeVisibleFiles();
    }, function() { $scope.showToast('Could not create folder', 'error'); });
  };

  $scope.folderKeydown = function(e) {
    if (e.which === 13) $scope.createFolder();
    if (e.which === 27) { $scope.showFolderInput = false; $scope.newFolderName = ''; }
  };

  $scope.deleteFolder = function(path, $event) {
    if ($event) $event.stopPropagation();
    if (!confirm('Delete folder "' + path + '"? Files inside (and in any subfolders) move to All Files — they are not deleted.')) return;
    $http.delete('/api/folders/' + encodeURIComponent(path)).then(function() {
      var prefix = path + '/';
      if ($scope.currentFolder === path || ($scope.currentFolder && $scope.currentFolder.indexOf(prefix) === 0))
        $scope.currentFolder = null;
      $scope.files.forEach(function(f) {
        if (f.folder === path || (f.folder && f.folder.indexOf(prefix) === 0)) f.folder = null;
      });
      $scope.loadFolders();
      $scope.recomputeVisibleFiles();
      $scope.showToast('Folder deleted', 'info');
    }, function() { $scope.showToast('Could not delete folder', 'error'); });
  };

  $scope.moveFileToFolder = function(file) {
    $http.patch('/api/files/' + file.id, { folder: file.folder || null }).then(function() {
      $scope.loadFolders();
      $scope.recomputeVisibleFiles();
      $scope.showToast('Moved to ' + (file.folder || 'All Files'), 'info');
    }, function() { $scope.showToast('Move failed', 'error'); });
  };

  // ── Files ─────────────────────────────────────────────────────────────────
  $scope.loadServerInfo = function() {
    $http.get('/api/info').then(function(r) { $scope.serverInfo = r.data; });
  };

  $scope.loadFiles = function() {
    $scope.loading = true;
    $http.get('/api/files').then(function(r) {
      $scope.files = r.data; $scope.loading = false; $scope.refreshTags();
      $scope.clearSelection();
      $scope.recomputeVisibleFiles();
    }, function() {
      $scope.loading = false;
      $scope.showToast('Could not load files — is the server running?', 'error');
    });
  };

  // Recomputed explicitly (rather than as a function called from the template)
  // because ng-repeat/interpolation expressions run on every digest cycle —
  // with a function that re-filters and re-sorts the whole file list, that
  // meant a full O(n log n) pass on nearly every click, keypress or timer.
  // Instead we cache the result in $scope.visibleFiles and only recompute it
  // where files/currentFolder/searchQuery/activeTags/sortBy actually change.
  $scope.recomputeVisibleFiles = function() {
    var r = $scope.files;
    if ($scope.currentFolder !== null)
      r = r.filter(function(f) { return f.folder === $scope.currentFolder; });
    if ($scope.searchQuery) {
      var q = $scope.searchQuery.toLowerCase();
      r = r.filter(function(f) {
        return f.name.toLowerCase().indexOf(q) !== -1 ||
               (f.tags || []).some(function(t) { return t.indexOf(q) !== -1; });
      });
    }
    if ($scope.activeTags.length)
      r = r.filter(function(f) {
        return $scope.activeTags.every(function(tag) { return (f.tags || []).indexOf(tag) !== -1; });
      });
    r = r.slice();
    switch ($scope.ui.sortBy) {
      case 'name-asc':  r.sort(function(a,b){ return a.name.localeCompare(b.name); }); break;
      case 'name-desc': r.sort(function(a,b){ return b.name.localeCompare(a.name); }); break;
      case 'size-desc': r.sort(function(a,b){ return b.size - a.size; }); break;
      case 'size-asc':  r.sort(function(a,b){ return a.size - b.size; }); break;
      case 'date-asc':  r.sort(function(a,b){ return new Date(a.uploadedAt) - new Date(b.uploadedAt); }); break;
      default:          r.sort(function(a,b){ return new Date(b.uploadedAt) - new Date(a.uploadedAt); });
    }
    $scope.visibleFiles = r;

    // Breadcrumb segments also depend only on currentFolder — computed here
    // (rather than as a function called from ng-repeat) because a function
    // that returns a fresh array every digest, with no track-by, makes
    // ng-repeat treat every item as new on every cycle. That churn can
    // itself trigger another digest, which computes yet another new array,
    // and so on until Angular gives up after 10 iterations with a
    // $rootScope:infdig error — this actually happened during testing.
    var acc = '';
    $scope.breadcrumb = $scope.currentFolder ? $scope.currentFolder.split('/').map(function(part) {
      acc = acc ? acc + '/' + part : part;
      return { name: part, path: acc };
    }) : [];
  };

  $scope.uploadFiles = function(fileList) {
    if (!fileList || !fileList.length) return;
    var fd = new FormData();
    for (var i = 0; i < fileList.length; i++) fd.append('files', fileList[i]);
    if ($scope.currentFolder) fd.append('folder', $scope.currentFolder);

    $scope.uploading = true; $scope.uploadProgress = 0;

    $http.post('/api/upload', fd, {
      headers: { 'Content-Type': undefined },
      uploadEventHandlers: {
        // $applyAsync (not $apply) — progress fires many times in quick
        // succession for larger/multi-file uploads, often while a digest
        // from the previous tick is still running. $apply would throw
        // $rootScope:inprog in that case; the scope value still gets set,
        // but the digest that would flush it to the progress-bar width
        // binding aborts, so the bar visually never leaves 0%. $applyAsync
        // coalesces rapid calls into the next digest instead of throwing.
        progress: function(e) {
          if (e.lengthComputable)
            $scope.$applyAsync(function() { $scope.uploadProgress = Math.round((e.loaded / e.total) * 100); });
        }
      }
    }).then(function(r) {
      $scope.uploading = false; $scope.uploadProgress = 0;
      r.data.files.forEach(function(f) { $scope.files.unshift(f); });
      $scope.refreshTags(); $scope.loadServerInfo(); $scope.recomputeVisibleFiles();
      var n = r.data.files.length;
      $scope.showToast(n + ' file' + (n > 1 ? 's' : '') + ' uploaded', 'success');
    }, function(err) {
      $scope.uploading = false;
      $scope.showToast((err.data && err.data.error) || 'Upload failed', 'error');
    });
  };

  $scope.triggerFileInput = function() { document.getElementById('fileInput').click(); };

  // ── Upload from URL ──────────────────────────────────────────────────────
  // Wrapped in an object — the url/loading fields are edited from inside
  // ng-if="urlUpload.open", so bare scalars would shadow (same reasoning as
  // rename/ui/theme/bulk above).
  $scope.urlUpload = { open: false, url: '', loading: false };

  $scope.toggleUrlInput = function($event) {
    if ($event) $event.stopPropagation();
    $scope.urlUpload.open = !$scope.urlUpload.open;
  };

  $scope.urlUploadKeydown = function($event) {
    if ($event.which === 13) { $event.preventDefault(); $scope.uploadFromUrl(); }
  };

  $scope.uploadFromUrl = function() {
    var url = ($scope.urlUpload.url || '').trim();
    if (!url || $scope.urlUpload.loading) return;
    $scope.urlUpload.loading = true;
    $http.post('/api/upload-url', { url: url, folder: $scope.currentFolder }).then(function(r) {
      $scope.urlUpload.loading = false;
      r.data.files.forEach(function(f) { $scope.files.unshift(f); });
      $scope.refreshTags(); $scope.loadServerInfo(); $scope.recomputeVisibleFiles();
      $scope.urlUpload.url  = '';
      $scope.urlUpload.open = false;
      $scope.showToast('Fetched from URL', 'success');
    }, function(err) {
      $scope.urlUpload.loading = false;
      $scope.showToast((err.data && err.data.error) || 'Fetch failed', 'error');
    });
  };

  $scope.downloadFile = function(file) {
    var a = document.createElement('a');
    a.href = '/api/files/' + file.id + '/download'; a.download = file.name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  $scope.deleteFile = function(file) {
    if (!confirm('Delete "' + file.name + '"? This cannot be undone.')) return;
    $http.delete('/api/files/' + file.id).then(function() {
      $scope.files.splice($scope.files.indexOf(file), 1);
      delete $scope.selectedIds[file.id];
      $scope.refreshTags(); $scope.loadFolders(); $scope.loadServerInfo(); $scope.recomputeVisibleFiles();
      $scope.showToast('"' + file.name + '" deleted', 'info');
    }, function() { $scope.showToast('Delete failed', 'error'); });
  };

  // ── Preview modal ─────────────────────────────────────────────────────────
  $scope.openPreview = function(file) {
    $scope.previewFile       = file;
    $scope.previewTextContent = '';
    $scope.ui.newTag         = '';
    $scope.cancelRename();
    var url = '/api/files/' + file.id + '/preview';
    $scope.trustedPreviewUrl = $sce.trustAsResourceUrl(url);
    $scope.previewType       = $scope.getFileCategory(file);
    if ($scope.previewType === 'text') {
      $http.get(url, { responseType: 'text' }).then(function(r) {
        var c = r.data || '';
        $scope.previewTextContent = c.length > 200000 ? c.substring(0, 200000) + '\n\n… (truncated)' : c;
      }, function() { $scope.previewTextContent = '(Could not load file content)'; });
    }
  };

  $scope.closePreview = function() {
    var media = document.querySelector('.preview-video, .preview-audio');
    if (media) { try { media.pause(); } catch(e) {} }
    $scope.previewFile = null; $scope.previewType = null;
    $scope.previewTextContent = ''; $scope.ui.newTag = '';
    $scope.cancelRename();
  };

  // ── File type helpers ─────────────────────────────────────────────────────
  $scope.getFileCategory = function(file) {
    if (!file) return 'other';
    var mime = (file.mimeType || '').toLowerCase();
    var ext  = (file.name || '').split('.').pop().toLowerCase();
    if (mime.startsWith('image/'))   return 'image';
    if (mime.startsWith('video/'))   return 'video';
    if (mime.startsWith('audio/'))   return 'audio';
    if (mime === 'application/pdf')  return 'pdf';
    if (mime.startsWith('text/'))    return 'text';
    var code = ['js','ts','py','java','c','cpp','h','cs','php','rb','go','rs','swift',
                'sh','bash','json','xml','yaml','yml','toml','md','html','css','sql'];
    if (code.indexOf(ext) !== -1)    return 'text';
    return 'other';
  };

  $scope.getFileIcon = function(file) {
    var cat = $scope.getFileCategory(file);
    if (cat === 'video') return '▶';
    if (cat === 'audio') return '♫';
    if (cat === 'pdf')   return 'PDF';
    if (cat === 'text')  return '{}';
    var ext = (file.name || '').split('.').pop().toUpperCase();
    return ext.length <= 4 ? ext : '⬛';
  };

  // ── Chat ──────────────────────────────────────────────────────────────────
  function scrollChat() {
    $timeout(function() { var el = document.getElementById('chat-messages'); if (el) el.scrollTop = el.scrollHeight; }, 30);
  }

  $scope.sendChat = function() {
    var text = ($scope.chatInput || '').trim();
    if (!text || $scope.chatLoading) return;
    $scope.chatMsgs.push({ role: 'user', content: text });
    $scope.chatInput = ''; $scope.chatLoading = true; scrollChat();

    var reply = { role: 'assistant', content: '' };
    $scope.chatMsgs.push(reply);

    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: $scope.chatMsgs.slice(0, -1).map(function(m) { return { role: m.role, content: m.content }; }) })
    }).then(function(response) {
      if (!response.ok) throw new Error('Server error');
      var reader = response.body.getReader(), decoder = new TextDecoder();
      function read() {
        reader.read().then(function(result) {
          if (result.done) { $scope.$apply(function() { $scope.chatLoading = false; }); return; }
          decoder.decode(result.value).split('\n').forEach(function(line) {
            if (!line.startsWith('data: ')) return;
            try {
              var evt = JSON.parse(line.slice(6));
              if (evt.type === 'content_block_delta' && evt.delta && evt.delta.text)
                $scope.$apply(function() { reply.content += evt.delta.text; scrollChat(); });
            } catch(e) {}
          });
          read();
        });
      }
      read();
    }).catch(function() {
      $scope.$apply(function() { $scope.chatLoading = false; reply.content = 'Something went wrong. Check that ANTHROPIC_API_KEY is set in .env'; });
    });
  };

  $scope.chatKeydown = function(e) { if (e.which === 13 && !e.shiftKey) { e.preventDefault(); $scope.sendChat(); } };

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  angular.element(document).on('keydown', function(e) {
    if (e.key === 'Escape' && $scope.previewFile)
      $scope.$apply(function() { $scope.closePreview(); });
  });

  // Close the theme panel on any click outside it. toggleThemePanel() and the
  // panel itself both stopPropagation(), so this only fires for genuine
  // outside clicks. $applyAsync (not $apply) — this fires during the bubble
  // phase of clicks that ng-click has already wrapped in its own $apply, so
  // $apply here would throw $rootScope:inprog (same issue as the upload
  // progress handler).
  angular.element(document).on('click', function() {
    if ($scope.theme.open) $scope.$applyAsync(function() { $scope.theme.open = false; });
  });

  // Paste an image/file straight from the clipboard (e.g. a screenshot).
  // Only clipboard items of kind "file" reach here — pasting text into the
  // search box or a tag input never has file-kind items, so this can't
  // accidentally hijack a normal text paste.
  angular.element(document).on('paste', function(e) {
    var clipboardData = e.originalEvent ? e.originalEvent.clipboardData : e.clipboardData;
    var items = clipboardData && clipboardData.items;
    if (!items) return;
    var files = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        var f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) $scope.$applyAsync(function() { $scope.uploadFiles(files); });
  });

  // ── Init ──────────────────────────────────────────────────────────────────
  $scope.loadServerInfo();
  $scope.loadFolders();
  $scope.loadFiles();

  // Search box has no natural "change" event of its own — wire it in directly
  // rather than watching $scope.searchQuery every digest.
  $scope.onSearchChange = $scope.recomputeVisibleFiles;
  $scope.onSortChange   = $scope.recomputeVisibleFiles;

}]);

// ── Directives ────────────────────────────────────────────────────────────────
app.directive('dropZone', function() {
  return {
    restrict: 'A',
    link: function(scope, element) {
      element.on('dragover',  function(e) { e.preventDefault(); e.stopPropagation(); scope.$apply(function() { scope.isDragging = true;  }); });
      element.on('dragleave', function(e) { e.preventDefault();                      scope.$apply(function() { scope.isDragging = false; }); });
      element.on('drop',      function(e) {
        e.preventDefault(); e.stopPropagation();
        scope.$apply(function() { scope.isDragging = false; var f = e.dataTransfer && e.dataTransfer.files; if (f && f.length) scope.uploadFiles(f); });
      });
    }
  };
});

app.directive('fileInput', function() {
  return {
    restrict: 'A',
    link: function(scope, element) {
      element.on('change', function(e) {
        scope.$apply(function() { scope.uploadFiles(e.target.files); e.target.value = ''; });
      });
    }
  };
});

// lazySrc directive — sets img[src] only when the element scrolls into view.
// Usage: <img lazy-src="/api/files/{{ file.id }}/thumb">
// The 100px rootMargin starts loading slightly before the image is visible,
// so there's no flash of empty space as the user scrolls.
app.directive('lazySrc', function() {
  return {
    restrict: 'A',
    link: function(scope, element, attrs) {
      var loaded     = false;
      var pendingSrc = null;

      // $observe resolves {{ }} interpolation in the attribute, then fires
      // whenever the value changes. Store it and set src if already visible.
      attrs.$observe('lazySrc', function(val) {
        pendingSrc = val;
        if (loaded && val) element[0].src = val;
      });

      var observer = new IntersectionObserver(function(entries) {
        if (entries[0].isIntersecting) {
          loaded = true;
          if (pendingSrc) element[0].src = pendingSrc;
          observer.disconnect();
        }
      }, { rootMargin: '100px' });

      observer.observe(element[0]);

      // Clean up if the card is removed from the DOM (e.g. filtered out).
      scope.$on('$destroy', function() { observer.disconnect(); });
    }
  };
});
