var app = angular.module('cloudApp', []);

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

  $scope.allTags     = [];
  $scope.activeTags  = [];
  $scope.searchQuery = '';
  $scope.sortBy      = 'date-desc';

  // Wrapping transient inputs in an object prevents ng-if child-scope shadowing.
  // Without the dot, ng-model inside ng-if writes to the child scope and the
  // parent controller never sees the typed value.
  $scope.ui       = { newTag: '' };
  $scope.cardEdit = { fileId: null, value: '' };

  $scope.previewFile        = null;
  $scope.previewType        = null;
  $scope.previewTextContent = '';
  $scope.trustedPreviewUrl  = '';

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
    });
  };

  $scope.toggleTagFilter = function(tag) {
    var i = $scope.activeTags.indexOf(tag);
    if (i > -1) $scope.activeTags.splice(i, 1); else $scope.activeTags.push(tag);
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
  $scope.loadFolders = function() {
    $http.get('/api/folders').then(function(r) {
      $scope.folders = r.data;
      if ($scope.currentFolder && $scope.folders.indexOf($scope.currentFolder) === -1)
        $scope.currentFolder = null;
    });
  };

  $scope.navigateFolder = function(folder) { $scope.currentFolder = folder; $scope.activeTags = []; };

  $scope.createFolder = function() {
    var name = ($scope.newFolderName || '').trim();
    if (!name) return;
    $http.post('/api/folders', { name: name }).then(function() {
      $scope.loadFolders();
      $scope.currentFolder   = name;
      $scope.newFolderName   = '';
      $scope.showFolderInput = false;
    }, function() { $scope.showToast('Could not create folder', 'error'); });
  };

  $scope.folderKeydown = function(e) {
    if (e.which === 13) $scope.createFolder();
    if (e.which === 27) { $scope.showFolderInput = false; $scope.newFolderName = ''; }
  };

  $scope.moveFileToFolder = function(file) {
    $http.patch('/api/files/' + file.id, { folder: file.folder || null }).then(function() {
      $scope.loadFolders();
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
    }, function() {
      $scope.loading = false;
      $scope.showToast('Could not load files — is the server running?', 'error');
    });
  };

  $scope.filteredFiles = function() {
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
    switch ($scope.sortBy) {
      case 'name-asc':  r.sort(function(a,b){ return a.name.localeCompare(b.name); }); break;
      case 'name-desc': r.sort(function(a,b){ return b.name.localeCompare(a.name); }); break;
      case 'size-desc': r.sort(function(a,b){ return b.size - a.size; }); break;
      case 'size-asc':  r.sort(function(a,b){ return a.size - b.size; }); break;
      case 'date-asc':  r.sort(function(a,b){ return new Date(a.uploadedAt) - new Date(b.uploadedAt); }); break;
      default:          r.sort(function(a,b){ return new Date(b.uploadedAt) - new Date(a.uploadedAt); });
    }
    return r;
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
        progress: function(e) {
          if (e.lengthComputable)
            $scope.$apply(function() { $scope.uploadProgress = Math.round((e.loaded / e.total) * 100); });
        }
      }
    }).then(function(r) {
      $scope.uploading = false; $scope.uploadProgress = 0;
      r.data.files.forEach(function(f) { $scope.files.unshift(f); });
      $scope.refreshTags(); $scope.loadServerInfo();
      var n = r.data.files.length;
      $scope.showToast(n + ' file' + (n > 1 ? 's' : '') + ' uploaded', 'success');
    }, function(err) {
      $scope.uploading = false;
      $scope.showToast((err.data && err.data.error) || 'Upload failed', 'error');
    });
  };

  $scope.triggerFileInput = function() { document.getElementById('fileInput').click(); };

  $scope.downloadFile = function(file) {
    var a = document.createElement('a');
    a.href = '/api/files/' + file.id + '/download'; a.download = file.name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  $scope.deleteFile = function(file) {
    if (!confirm('Delete "' + file.name + '"? This cannot be undone.')) return;
    $http.delete('/api/files/' + file.id).then(function() {
      $scope.files.splice($scope.files.indexOf(file), 1);
      $scope.refreshTags(); $scope.loadFolders(); $scope.loadServerInfo();
      $scope.showToast('"' + file.name + '" deleted', 'info');
    }, function() { $scope.showToast('Delete failed', 'error'); });
  };

  // ── Preview modal ─────────────────────────────────────────────────────────
  $scope.openPreview = function(file) {
    $scope.previewFile       = file;
    $scope.previewTextContent = '';
    $scope.ui.newTag         = '';
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

  // ── Init ──────────────────────────────────────────────────────────────────
  $scope.loadServerInfo();
  $scope.loadFolders();
  $scope.loadFiles();

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
