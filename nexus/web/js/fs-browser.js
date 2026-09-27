/*!
 * NEXUS — adaptador de la File System Access API (Chrome/Edge).
 * Permite leer ~/.claude directamente desde el navegador, sin servidor.
 */
(function (root) {
  'use strict';

  function createBrowserAdapter(rootHandle) {
    var dirs = new Map();

    function forget(rel) {
      dirs.forEach(function (_, k) {
        if (k === rel || k.indexOf(rel + '/') === 0) dirs.delete(k);
      });
    }

    async function dir(rel) {
      if (!rel) return rootHandle;
      if (dirs.has(rel)) return dirs.get(rel);
      var i = rel.lastIndexOf('/');
      var parent = await dir(i < 0 ? '' : rel.slice(0, i));
      var h = await parent.getDirectoryHandle(i < 0 ? rel : rel.slice(i + 1));
      dirs.set(rel, h);
      return h;
    }

    async function file(rel) {
      var i = rel.lastIndexOf('/');
      var d = await dir(i < 0 ? '' : rel.slice(0, i));
      var fh = await d.getFileHandle(i < 0 ? rel : rel.slice(i + 1));
      return fh.getFile();
    }

    return {
      name: rootHandle.name,
      list: async function (rel) {
        try {
          var d = await dir(rel);
          var out = [];
          for await (var entry of d.entries()) out.push({ name: entry[0], dir: entry[1].kind === 'directory' });
          return out;
        } catch (e) {
          forget(rel);
          return [];
        }
      },
      stat: async function (rel) {
        try {
          var f = await file(rel);
          return { size: f.size, mtime: f.lastModified };
        } catch (e) {
          return null;
        }
      },
      read: async function (rel, start, max) {
        try {
          var f = await file(rel);
          return new Uint8Array(await f.slice(start, start + max).arrayBuffer());
        } catch (e) {
          return new Uint8Array(0);
        }
      }
    };
  }

  var DB = 'nexus';
  var STORE = 'handles';

  function idb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function saveHandle(h) {
    try {
      var db = await idb();
      await new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(h, 'claude');
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
      });
    } catch (e) { /* sin IndexedDB: solo se pierde el atajo de reconexión */ }
  }

  async function loadHandle() {
    try {
      var db = await idb();
      return await new Promise(function (resolve) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get('claude');
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { resolve(null); };
      });
    } catch (e) {
      return null;
    }
  }

  async function forgetHandle() {
    try {
      var db = await idb();
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete('claude');
    } catch (e) { /* nada */ }
  }

  var supported = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

  function pick() {
    return window.showDirectoryPicker({ id: 'nexus-claude', mode: 'read' });
  }

  async function ensurePermission(h) {
    var o = { mode: 'read' };
    if (!h.queryPermission) return true;
    if ((await h.queryPermission(o)) === 'granted') return true;
    return (await h.requestPermission(o)) === 'granted';
  }

  async function looksLikeClaudeDir(h) {
    try {
      await h.getDirectoryHandle('projects');
      return true;
    } catch (e) {
      return false;
    }
  }

  root.NexusFS = {
    supported: supported,
    createBrowserAdapter: createBrowserAdapter,
    pick: pick,
    ensurePermission: ensurePermission,
    saveHandle: saveHandle,
    loadHandle: loadHandle,
    forgetHandle: forgetHandle,
    looksLikeClaudeDir: looksLikeClaudeDir
  };
})(typeof self !== 'undefined' ? self : this);
