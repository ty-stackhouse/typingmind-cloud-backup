/*TypingMind Cloud Sync by ITCON, AU and our awesome community
Features:
- Extensible provider architecture (S3, Google Drive, etc.)
- Sync typingmind database with a cloud storage provider
- Snapshots on demand
- Automatic daily backups
- Backup management in Extension config UI
- Detailed logging in console
- Memory-efficient data processing
- Attachment Sync and backup support (by Enjoy) [2025-10-13]
- Incremental update implementation idea (by YATSE, 2024)
- AWS Endpoint Configuration to support S3 compatible services (by hang333) [2024-11-26]

Contributors (Docs & Fixes):
- Andrew Ong (README improvements) [2026-01-01]
- Maksim Kirillov (Compatible S3 storages list update) [2025-07-18]
- Ben Coldham (CORS policy JSON fix) [2025-07-19]
- Shigeki1120 (Syntax error fix) [2024-12-12]
- Thinh Dinh (Multipart upload fix) [2024-11-21]
- Martin Wehner (UI Integration using MutationObserver) [2025-12-24]
- McQuade (Stability improvements) [2025-12-28]
- Jeff G aka Ken Harris (Various fixes and improvements) [2026-03-04]
- Ty Stackhouse (Security: PBKDF2 key derivation + SRI script pinning) [2026-04-03]
*/

const TCS_BUILD_VERSION = "2026-04-03.2";

if (window.typingMindCloudSync) {
  console.log("TypingMind Cloud Sync already loaded");
} else {
  window.typingMindCloudSync = true;

  // ─────────────────────────────────────────────────────────────────────────
  // UTILITY: retryAsync
  // ─────────────────────────────────────────────────────────────────────────
  async function retryAsync(operation, options = {}) {
    const {
      maxRetries = 3,
      delay = 1000,
      isRetryable = () => true,
      onRetry = () => {},
    } = options;
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt === maxRetries || !isRetryable(error)) {
          throw error;
        }
        const retryDelay = Math.min(
          delay * Math.pow(2, attempt) + Math.random() * 1000,
          30000
        );
        onRetry(error, attempt + 1, retryDelay);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
    throw lastError;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CLASS: ConfigManager
  // ─────────────────────────────────────────────────────────────────────────
  class ConfigManager {
    constructor() {
      this.PEPPER = "tcs-v3-pepper-!@#$%^&*()";
      this.config = this.loadConfig();
      this.exclusions = this.loadExclusions();
    }
    _obfuscate(str, key) {
      if (!str || !key) return str;
      const combinedKey = key + this.PEPPER;
      let output = "";
      for (let i = 0; i < str.length; i++) {
        const charCode =
          str.charCodeAt(i) ^ combinedKey.charCodeAt(i % combinedKey.length);
        output += String.fromCharCode(charCode);
      }
      return btoa(output);
    }
    _deobfuscate(b64str, key) {
      if (!b64str || !key) return b64str;
      const combinedKey = key + this.PEPPER;
      let output = "";
      const decodedStr = atob(b64str);
      for (let i = 0; i < decodedStr.length; i++) {
        const charCode =
          decodedStr.charCodeAt(i) ^
          combinedKey.charCodeAt(i % combinedKey.length);
        output += String.fromCharCode(charCode);
      }
      return output;
    }
    loadConfig() {
      const defaults = {
        storageType: "s3",
        syncInterval: 15,
        bucketName: "",
        region: "",
        accessKey: "",
        secretKey: "",
        endpoint: "",
        encryptionKey: "",
        googleClientId: "",
      };
      const stored = {};
      const encryptionKey = localStorage.getItem("tcs_encryptionkey") || "";

      const keyMap = {
        storageType: "tcs_storagetype",
        syncInterval: "tcs_aws_syncinterval",
        bucketName: "tcs_aws_bucketname",
        region: "tcs_aws_region",
        accessKey: "tcs_aws_accesskey",
        secretKey: "tcs_aws_secretkey",
        endpoint: "tcs_aws_endpoint",
        encryptionKey: "tcs_encryptionkey",
        googleClientId: "tcs_google_clientid",
      };

      Object.keys(defaults).forEach((key) => {
        const storageKey = keyMap[key];
        if (!storageKey) return;

        let value = localStorage.getItem(storageKey);
        if (
          (key === "accessKey" || key === "secretKey") &&
          value?.startsWith("enc::")
        ) {
          if (encryptionKey) {
            try {
              value = this._deobfuscate(value.substring(5), encryptionKey);
            } catch (e) {
              console.warn(
                `[TCS] Could not decrypt key "${key}". It might be corrupted or the encryption key is wrong.`
              );
            }
          } else {
            console.warn(
              `[TCS] Found encrypted key "${key}" but no encryption key is configured.`
            );
          }
        }

        if (value !== null) {
          stored[key] = key === "syncInterval" ? parseInt(value) || 15 : value;
        }
      });
      return { ...defaults, ...stored };
    }
    loadExclusions() {
      const exclusions = localStorage.getItem("tcs_sync-exclusions");
      const userExclusions = exclusions
        ? exclusions
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : [];
      const systemExclusions = [
        "tcs_storagetype",
        "tcs_aws_bucketname",
        "tcs_aws_accesskey",
        "tcs_aws_secretkey",
        "tcs_aws_region",
        "tcs_aws_endpoint",
        "tcs_google_clientid",
        "tcs_google_access_token",
        "tcs_google_token_expiry",
        "gsi_client_id",
        "tcs_encryptionkey",
        "tcs_last-cloud-sync",
        "tcs_last-daily-backup",
        "tcs_backup-size",
        "tcs_sync-exclusions",
        "tcs_local-metadata",
        "tcs_localMigrated",
        "tcs_migrationBackup",
        "tcs_last-tombstone-cleanup",
        "tcs_autosync_enabled",
        "referrer",
        "TM_useLastVerifiedToken",
        "TM_useStateUpdateHistory",
        "INSTANCE_ID",
        "eruda-console",
      ];
      return [...systemExclusions, ...userExclusions];
    }
    get(key) {
      return this.config[key];
    }
    set(key, value) {
      this.config[key] = value;
    }
    save() {
      const encryptionKey = this.config.encryptionKey;
      const keyMap = {
        storageType: "tcs_storagetype",
        syncInterval: "tcs_aws_syncinterval",
        bucketName: "tcs_aws_bucketname",
        region: "tcs_aws_region",
        accessKey: "tcs_aws_accesskey",
        secretKey: "tcs_aws_secretkey",
        endpoint: "tcs_aws_endpoint",
        encryptionKey: "tcs_encryptionkey",
        googleClientId: "tcs_google_clientid",
      };

      Object.keys(this.config).forEach((key) => {
        const storageKey = keyMap[key];
        if (!storageKey) return;

        let valueToStore = this.config[key]?.toString() || "";

        if (
          (key === "accessKey" || key === "secretKey") &&
          valueToStore &&
          encryptionKey
        ) {
          valueToStore = "enc::" + this._obfuscate(valueToStore, encryptionKey);
        }
        localStorage.setItem(storageKey, valueToStore);
      });
    }
    shouldExclude(key) {
      const always = key.startsWith("tcs_");
      return (
        this.exclusions.includes(key) ||
        always ||
        key.startsWith("gsi_") ||
        key.includes("eruda")
      );
    }
    reloadExclusions() {
      this.exclusions = this.loadExclusions();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CLASS: Logger
  // ─────────────────────────────────────────────────────────────────────────
  class Logger {
    constructor() {
      const urlParams = new URLSearchParams(window.location.search);
      this.enabled = urlParams.get("log") === "true" || urlParams.has("log");
      this.icons = {
        info: "ℹ️",
        success: "✅",
        warning: "⚠️",
        error: "❌",
        start: "🔄",
        skip: "⏭️",
      };
      if (this.enabled) {
        this.loadEruda();
      }
    }
    loadEruda() {
      const isMobile =
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
          navigator.userAgent
        );
      if (!isMobile) return;
      if (document.getElementById("eruda-script")) return;
      const script = document.createElement("script");
      script.id = "eruda-script";
      // [SECURITY FIX #2] SRI hash pins eruda@3.0.1 — browser rejects any tampered version
      script.src = "https://cdn.jsdelivr.net/npm/eruda@3.0.1/eruda.min.js";
      script.integrity = "sha384-w/A/l37lVZcDe8Gez0uMpKrqQN7uZKAAABRKTHRVAZkIl3kEPj7VFa7OOVQM9b6";
      script.crossOrigin = "anonymous";
      script.onload = () => {
        window.eruda?.init();
      };
      document.head.appendChild(script);
    }
    destroyEruda() {
      window.eruda?.destroy();
      document.getElementById("eruda-script")?.remove();
    }
    log(type, message, data = null) {
      if (!this.enabled) return;
      const timestamp = new Date().toLocaleTimeString();
      const icon = this.icons[type] || "ℹ️";
      const logMessage = `${icon} [${timestamp}] ${message}`;
      switch (type) {
        case "error":
          console.error(logMessage, data || "");
          break;
        case "warning":
          console.warn(logMessage, data || "");
          break;
        default:
          console.log(logMessage, data || "");
      }
    }
    setEnabled(enabled) {
      this.enabled = enabled;
      const url = new URL(window.location);
      if (enabled) {
        url.searchParams.set("log", "");
        this.loadEruda();
      } else {
        url.searchParams.delete("log");
        this.destroyEruda();
      }
      window.history.replaceState({}, "", url);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CLASS: DataService
  // ─────────────────────────────────────────────────────────────────────────
  function detectMimeFromBytes(data) {
    let bytes = null;
    if (data instanceof Uint8Array) bytes = data;
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (data instanceof Blob) return data.type || "application/octet-stream";
    if (!bytes || bytes.length < 4) return "application/octet-stream";
    if (bytes[0]===0x89 && bytes[1]===0x50 && bytes[2]===0x4E && bytes[3]===0x47) return "image/png";
    if (bytes[0]===0xFF && bytes[1]===0xD8 && bytes[2]===0xFF) return "image/jpeg";
    if (bytes[0]===0x47 && bytes[1]===0x49 && bytes[2]===0x46) return "image/gif";
    if (bytes[0]===0x52 && bytes[1]===0x49 && bytes[2]===0x46 && bytes[3]===0x46
      && bytes.length>=12 && bytes[8]===0x57 && bytes[9]===0x45 && bytes[10]===0x42 && bytes[11]===0x50) return "image/webp";
    if (bytes[0]===0x25 && bytes[1]===0x50 && bytes[2]===0x44 && bytes[3]===0x46) return "application/pdf";
    return "application/octet-stream";
  }

  class DataService {
    constructor(configManager, logger, operationQueue = null) {
      this.config = configManager;
      this.logger = logger;
      this.operationQueue = operationQueue;
      this.dbPromise = null;
      this.streamBatchSize = 200;
      this.memoryThreshold = 100 * 1024 * 1024;
      this.throttleDelay = 10;
    }
    async getDB() {
      if (!this.dbPromise) {
        this.dbPromise = new Promise((resolve, reject) => {
          const request = indexedDB.open("keyval-store");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(new Error("Failed to open IndexedDB"));
        });
      }
      return this.dbPromise;
    }
    async estimateDataSize() {
      let totalSize = 0;
      let itemCount = 0;
      let excludedItemCount = 0;
      const db = await this.getDB();
      const transaction = db.transaction(["keyval"], "readonly");
      const store = transaction.objectStore("keyval");
      await new Promise((resolve) => {
        const request = store.openCursor();
        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            const key = cursor.key;
            const value = cursor.value;
            if (
              typeof key === "string" &&
              value !== undefined &&
              !this.config.shouldExclude(key)
            ) {
              totalSize += this.estimateItemSize(value);
              itemCount++;
            } else if (typeof key === "string") {
              excludedItemCount++;
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        request.onerror = () => resolve();
      });
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && !this.config.shouldExclude(key)) {
          const value = localStorage.getItem(key);
          if (value !== null) {
            totalSize += value.length * 2;
            itemCount++;
          }
        } else if (key) {
          excludedItemCount++;
        }
      }
      return { totalSize, itemCount, excludedItemCount };
    }
    async *streamAllItemsInternal() {
      const pageSize = this.streamBatchSize;
      let idbProcessed = 0;
      try {
        const db = await this.getDB();
        let lastKey = undefined;
        let hasMore = true;

        while (hasMore) {
          const page = await new Promise((resolve, reject) => {
            const tx = db.transaction(["keyval"], "readonly");
            const store = tx.objectStore("keyval");
            const range = lastKey !== undefined
              ? IDBKeyRange.lowerBound(lastKey, true)
              : undefined;
            const items = [];
            const request = store.openCursor(range);
            request.onsuccess = (event) => {
              const cursor = event.target.result;
              if (!cursor || items.length >= pageSize) {
                resolve(items);
                return;
              }
              const key = cursor.key;
              const value = cursor.value;
              if (value instanceof Blob) {
                items.push({
                  id: key,
                  data: value,
                  type: "blob",
                  blobType: value.type,
                  size: value.size,
                });
              } else if (
                typeof key === "string" &&
                value !== undefined &&
                !this.config.shouldExclude(key)
              ) {
                items.push({ id: key, data: value, type: "idb" });
              }
              cursor.continue();
            };
            request.onerror = () => reject(request.error);
          });

          if (page.length === 0) {
            hasMore = false;
          } else {
            lastKey = page[page.length - 1].id;
            idbProcessed += page.length;
            if (idbProcessed % 2000 === 0) {
              this.logger.log(
                "info",
                `Processed ${idbProcessed} IndexedDB items`
              );
            }
            yield page;
            await this.forceGarbageCollection();
            if (page.length < pageSize) {
              hasMore = false;
            }
          }
        }

        let lsBatch = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && !this.config.shouldExclude(key)) {
            const value = localStorage.getItem(key);
            if (value !== null) {
              lsBatch.push({ id: key, data: { key, value }, type: "ls" });
              if (lsBatch.length >= pageSize) {
                yield lsBatch;
                lsBatch = [];
                await this.forceGarbageCollection();
              }
            }
          }
        }
        if (lsBatch.length > 0) {
          yield lsBatch;
          lsBatch = null;
          await this.forceGarbageCollection();
        }
      } catch (error) {
        this.logger.log(
          "error",
          `Error in streamAllItemsInternal: ${error.message}`
        );
        throw error;
      }
    }
    async getAllItemsEfficient() {
      const { totalSize } = await this.estimateDataSize();
      if (totalSize > this.memoryThreshold) {
        this.logger.log(
          "info",
          `Large dataset detected (${this.formatSize(
            totalSize
          )}), using memory-efficient processing`
        );
        return this.streamAllItemsInternal();
      } else {
        this.logger.log(
          "info",
          `Small dataset (${this.formatSize(
            totalSize
          )}), using standard loading`
        );
        return [await this.getAllItems()];
      }
    }
    estimateItemSize(data) {
      if (typeof data === "string") return data.length * 2;
      if (data instanceof Blob) return data.size;
      if (data && typeof data === "object") {
        return Object.keys(data).length * 50;
      }
      return 1000;
    }
    formatSize(bytes) {
      if (bytes === 0) return "0 B";
      const k = 1024;
      const sizes = ["B", "KB", "MB", "GB"];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    }
    async forceGarbageCollection() {
      if (window?.gc) {
        window.gc();
      } else if (typeof global !== "undefined" && global?.gc) {
        global.gc();
      }
      await new Promise((resolve) => setTimeout(resolve, this.throttleDelay));
    }
    async getAllItems() {
      const items = new Map();
      const db = await this.getDB();
      const transaction = db.transaction(["keyval"], "readonly");
      const store = transaction.objectStore("keyval");
      let totalIDB = 0;
      let includedIDB = 0;
      let excludedIDB = 0;
      await new Promise((resolve) => {
        const request = store.openCursor();
        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            const key = cursor.key;
            const value = cursor.value;
            totalIDB++;
            if (
              typeof key === "string" &&
              value !== undefined &&
              !this.config.shouldExclude(key)
            ) {
              items.set(key, {
                id: key,
                data: value,
                type: "idb",
              });
              includedIDB++;
            } else {
              excludedIDB++;
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        request.onerror = () => resolve();
      });
      const urlParams = new URLSearchParams(window.location.search);
      const debugEnabled =
        urlParams.get("log") === "true" || urlParams.has("log");
      let totalLS = 0;
      let excludedLS = 0;
      let includedLS = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        totalLS++;
        if (key && !this.config.shouldExclude(key)) {
          const value = localStorage.getItem(key);
          if (value !== null) {
            items.set(key, { id: key, data: { key, value }, type: "ls" });
            includedLS++;
          }
        } else {
          excludedLS++;
        }
      }
      if (debugEnabled) {
        console.log(
          `📊 IndexedDB Stats: Total=${totalIDB}, Included=${includedIDB}, Excluded=${excludedIDB}`
        );
        console.log(
          `📊 localStorage Stats: Total=${totalLS}, Included=${includedLS}, Excluded=${excludedLS}`
        );
        console.log(`📊 Total items to sync: ${items.size} (IDB + LS)`);
      }
      const chatItems = Array.from(items.keys()).filter((id) =>
        id.startsWith("CHAT_")
      );
      const otherItems = Array.from(items.keys()).filter(
        (id) => !id.startsWith("CHAT_")
      );
      this.logger.log("success", "📋 Retrieved all items for deletion check", {
        totalItems: items.size,
        idbStats: {
          total: totalIDB,
          included: includedIDB,
          excluded: excludedIDB,
        },
        lsStats: { total: totalLS, included: includedLS, excluded: excludedLS },
        chatCount: chatItems.length,
        otherCount: otherItems.length,
      });
      return Array.from(items.values());
    }
    async getAllItemKeys() {
      const itemKeys = new Set();
      const db = await this.getDB();
      const transaction = db.transaction(["keyval"], "readonly");
      const store = transaction.objectStore("keyval");
      await new Promise((resolve) => {
        const request = store.openKeyCursor();
        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            const key = cursor.key;
            if (typeof key === "string" && !this.config.shouldExclude(key)) {
              itemKeys.add(key);
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        request.onerror = () => resolve();
      });
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && !this.config.shouldExclude(key)) {
          itemKeys.add(key);
        }
      }
      return itemKeys;
    }
    async getItem(itemId, type) {
      if (type === "idb") {
        const db = await this.getDB();
        const transaction = db.transaction(["keyval"], "readonly");
        const store = transaction.objectStore("keyval");
        return new Promise((resolve) => {
          const request = store.get(itemId);
          request.onsuccess = () => {
            const result = request.result;
            resolve(result || null);
          };
          request.onerror = () => resolve(null);
        });
      } else if (type === "ls") {
        const value = localStorage.getItem(itemId);
        return value !== null ? { key: itemId, value } : null;
      } else if (type === "blob") {
        const db = await this.getDB();
        const tx = db.transaction(["keyval"], "readonly");
        const store = tx.objectStore("keyval");
        return new Promise(res => {
          const req = store.get(itemId);
          req.onsuccess = () => res(req.result || null);
          req.onerror   = () => res(null);
        });
      }
      return null;
    }
    async saveItem(item, type, itemKey = null) {
      if (type === "idb") {
        const db = await this.getDB();
        const transaction = db.transaction(["keyval"], "readwrite");
        const store = transaction.objectStore("keyval");
        const itemId = itemKey || item?.id;
        const itemData = item;
        return new Promise((resolve) => {
          const request = store.put(itemData, itemId);
          request.onsuccess = () => resolve(true);
          request.onerror = () => resolve(false);
        });
      } else if (type === "ls") {
        try {
          localStorage.setItem(item.key, item.value);
          return true;
        } catch {
          return false;
        }
      } else if (type === "blob") {
        let mimeType = item.blobType || "application/octet-stream";
        if (mimeType === "application/octet-stream") {
          mimeType = detectMimeFromBytes(item);
        }
        const blob = new Blob([item], { type: mimeType });
        return this.saveItem(blob, "idb", itemKey);
      }
      return false;
    }
    async deleteItem(itemId, type) {
      const success = await this.performDelete(itemId, type);
      if (success) {
        this.createTombstone(itemId, type, "manual-delete");
      }
      return success;
    }
    async performDelete(itemId, type) {
      if (type === "idb") {
        const db = await this.getDB();
        const transaction = db.transaction(["keyval"], "readwrite");
        const store = transaction.objectStore("keyval");
        return new Promise((resolve) => {
          const request = store.delete(itemId);
          request.onsuccess = () => resolve(true);
          request.onerror = () => resolve(false);
        });
      } else if (type === "ls") {
        try {
          localStorage.removeItem(itemId);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
    createTombstone(itemId, type, source = "unknown") {
      const orchestrator = window.cloudSyncApp?.syncOrchestrator;
      if (!orchestrator) {
        this.logger.log(
          "error",
          "❌ Cannot create tombstone: SyncOrchestrator not found."
        );
        return null;
      }
      const timestamp = Date.now();
      const tombstone = {
        deleted: timestamp,
        deletedAt: timestamp,
        type: type,
        source: source,
        tombstoneVersion: 1,
      };
      this.logger.log("start", "🪦 Creating tombstone in metadata", {
        itemId: itemId,
        type: type,
        source: source,
      });
      const existingItem = orchestrator.metadata.items[itemId];
      if (existingItem?.deleted) {
        tombstone.tombstoneVersion = (existingItem.tombstoneVersion || 0) + 1;
        this.logger.log(
          "info",
          "📈 Incrementing existing tombstone version in metadata",
          {
            newVersion: tombstone.tombstoneVersion,
          }
        );
      }
      orchestrator.metadata.items[itemId] = {
        ...tombstone,
        synced: 0,
      };
      orchestrator.saveMetadata();
      this.logger.log("success", "✅ Tombstone created in metadata", {
        itemId: itemId,
        version: tombstone.tombstoneVersion,
      });
      this.operationQueue?.add(
        `tombstone-sync-${itemId}`,
        () => this.syncTombstone(itemId),
        "high"
      );
      return tombstone;
    }
    _sanitizeTombstoneItemId(itemId) {
      while (itemId.startsWith("tcs_tombstone_")) {
        itemId = itemId.slice("tcs_tombstone_".length);
      }
      return itemId;
    }
    getTombstoneFromStorage(itemId) {
      try {
        itemId = this._sanitizeTombstoneItemId(itemId);
        const storageKey = `tcs_tombstone_${itemId}`;
        const stored = localStorage.getItem(storageKey);
        if (stored) {
          const tombstone = JSON.parse(stored);
          return tombstone;
        } else {
          return null;
        }
      } catch (error) {
        this.logger.log("error", "❌ Error reading tombstone from storage", {
          itemId: itemId,
          error: error.message,
        });
        return null;
      }
    }
    saveTombstoneToStorage(itemId, tombstone) {
      try {
        itemId = this._sanitizeTombstoneItemId(itemId);
        const storageKey = `tcs_tombstone_${itemId}`;
        localStorage.setItem(storageKey, JSON.stringify(tombstone));
        const verification = localStorage.getItem(storageKey);
        if (verification) {
          this.logger.log(
            "success",
            "✅ Tombstone successfully saved and verified",
            {
              itemId: itemId,
              storageKey: storageKey,
            }
          );
        } else {
          this.logger.log("error", "❌ Tombstone save verification failed", {
            itemId: itemId,
            storageKey: storageKey,
          });
        }
      } catch (error) {
        this.logger.log("error", "❌ Failed to save tombstone to storage", {
          itemId: itemId,
          error: error.message,
        });
      }
    }
    getAllTombstones() {
      const tombstones = new Map();
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith("tcs_tombstone_")) {
          const rawItemId = key.slice("tcs_tombstone_".length);
          const itemId = this._sanitizeTombstoneItemId(rawItemId);
          if (rawItemId !== itemId) {
            localStorage.removeItem(key);
            this.logger.log(
              "warning",
              `🧹 Removed nested tombstone key: ${key} (clean id: ${itemId})`
            );
            continue;
          }
          try {
            const tombstone = JSON.parse(localStorage.getItem(key));
            tombstones.set(itemId, tombstone);
          } catch {
            continue;
          }
        }
      }
      return tombstones;
    }
    async syncTombstone(itemId) {
      this.logger.log("info", `🔄 Triggering sync for tombstone ${itemId}`);
      if (window.cloudSyncApp?.syncOrchestrator) {
        try {
          await window.cloudSyncApp.syncOrchestrator.syncToCloud();
          this.logger.log(
            "success",
            `✅ Tombstone sync completed for ${itemId}`
          );
        } catch (error) {
          this.logger.log(
            "error",
            `❌ Tombstone sync failed for ${itemId}`,
            error.message
          );
          throw error;
        }
      } else {
        this.logger.log(
          "warning",
          `⚠️ Sync orchestrator not available for ${itemId}`
        );
      }
    }
    cleanup() {
      this.logger?.log("info", "🧹 DataService cleanup starting");
      try {
        if (this.dbPromise) {
          this.dbPromise
            .then((db) => {
              if (db) {
                db.close();
                this.logger?.log("info", "✅ IndexedDB connection closed");
              }
            })
            .catch((error) => {
              this.logger?.log(
                "warning",
                `IndexedDB close error: ${error.message}`
              );
            });
        }
        this.dbPromise = null;
        this.config = null;
        this.operationQueue = null;
        if (this.forceGarbageCollection) {
          this.forceGarbageCollection().catch(() => {});
        }
        this.logger?.log("success", "✅ DataService cleanup completed");
        this.logger = null;
      } catch (error) {
        console.warn("DataService cleanup error:", error);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CLASS: CryptoService
  // Derives AES-256-GCM keys using PBKDF2 (SHA-256, 100k iterations, random
  // 16-byte salt stored with ciphertext). New ciphertext layout:
  //   [16-byte salt][12-byte IV][AES-GCM ciphertext]
  // Legacy format (no salt, SHA-256 only) is auto-detected and decrypted
  // for backward compatibility with existing cloud data.
  // ─────────────────────────────────────────────────────────────────────────
  class CryptoService {
    constructor(configManager, logger) {
      this.config = configManager;
      this.logger = logger;
      // Cache maps passphrase -> { key, salt } for PBKDF2 keys
      // and passphrase -> CryptoKey for legacy SHA-256 keys
      this.keyCache = new Map();
      this.legacyKeyCache = new Map();
      this.maxCacheSize = 10;
      this.lastCacheCleanup = Date.now();
      this.largeArrayKeys = ["TM_useUserCharacters"];
      // PBKDF2 parameters
      this.PBKDF2_ITERATIONS = 100000;
      this.SALT_BYTES = 16;
    }

    // [SECURITY FIX #1] PBKDF2 key derivation with a provided salt.
    // Used during encrypt() (fresh random salt) and decrypt() (stored salt).
    async _deriveKeyPBKDF2(password, salt) {
      const enc = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
      );
      return crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt: salt,
          iterations: this.PBKDF2_ITERATIONS,
          hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
    }

    // Legacy SHA-256 path — used only for decrypting existing cloud data.
    async _deriveKeyLegacy(password) {
      if (this.legacyKeyCache.has(password)) return this.legacyKeyCache.get(password);
      const data = new TextEncoder().encode(password);
      const hash = await crypto.subtle.digest("SHA-256", data);
      const key = await crypto.subtle.importKey(
        "raw",
        hash,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"]
      );
      if (this.legacyKeyCache.size >= this.maxCacheSize) {
        this.legacyKeyCache.delete(this.legacyKeyCache.keys().next().value);
      }
      this.legacyKeyCache.set(password, key);
      return key;
    }

    // Public deriveKey kept for any callers that expect the old signature;
    // internally now routes to PBKDF2 with a caller-supplied salt.
    async deriveKey(password, salt) {
      if (!salt) {
        // Fallback: generate a one-off salt (should not normally happen)
        salt = crypto.getRandomValues(new Uint8Array(this.SALT_BYTES));
      }
      const cacheKey = password + "|" + btoa(String.fromCharCode(...salt));
      if (this.keyCache.has(cacheKey)) return this.keyCache.get(cacheKey);
      const now = Date.now();
      if (now - this.lastCacheCleanup > 30 * 60 * 1000) {
        this.cleanupKeyCache();
        this.lastCacheCleanup = now;
      }
      if (this.keyCache.size >= this.maxCacheSize) {
        this.keyCache.delete(this.keyCache.keys().next().value);
      }
      const key = await this._deriveKeyPBKDF2(password, salt);
      this.keyCache.set(cacheKey, key);
      return key;
    }

    cleanupKeyCache() {
      if (this.keyCache.size > this.maxCacheSize / 2) {
        const keysToRemove = Math.floor(this.keyCache.size / 2);
        const keyIterator = this.keyCache.keys();
        for (let i = 0; i < keysToRemove; i++) {
          const oldestKey = keyIterator.next().value;
          if (oldestKey) {
            this.keyCache.delete(oldestKey);
          }
        }
      }
    }

    _createJsonStreamForArray(array) {
      let i = 0;
      const encoder = new TextEncoder();
      const logger = this.logger;
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("["));
        },
        pull(controller) {
          if (i >= array.length) {
            controller.enqueue(encoder.encode("]"));
            controller.close();
            return;
          }
          try {
            const chunk = JSON.stringify(array[i]);
            if (i < array.length - 1) {
              controller.enqueue(encoder.encode(chunk + ","));
            } else {
              controller.enqueue(encoder.encode(chunk));
            }
            i++;
          } catch (e) {
            logger.log(
              "error",
              `Streaming serialization failed for element ${i}`,
              e
            );
            controller.error(e);
          }
        },
      });
    }

    async encrypt(data, key = null) {
      const encryptionKey = this.config.get("encryptionKey");
      if (!encryptionKey) throw new Error("No encryption key configured");

      // Generate fresh random salt and IV per operation
      const salt = crypto.getRandomValues(new Uint8Array(this.SALT_BYTES));
      const cryptoKey = await this.deriveKey(encryptionKey, salt);

      let dataStream;
      if (key && this.largeArrayKeys.includes(key) && Array.isArray(data)) {
        this.logger.log(
          "info",
          `Using streaming serialization for large array: ${key}`
        );
        dataStream = this._createJsonStreamForArray(data);
      } else {
        const encodedData = new TextEncoder().encode(JSON.stringify(data));
        dataStream = new Blob([encodedData]).stream();
      }

      let processedStream = dataStream;
      try {
        if (window.CompressionStream) {
          processedStream = dataStream.pipeThrough(
            new CompressionStream("deflate-raw")
          );
        } else {
          this.logger.log(
            "warning",
            "CompressionStream API not supported, uploading uncompressed."
          );
        }
      } catch (e) {
        this.logger.log(
          "warning",
          "Could not compress data, uploading uncompressed.",
          e
        );
      }

      const finalData = new Uint8Array(
        await new Response(processedStream).arrayBuffer()
      );

      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        cryptoKey,
        finalData
      );

      // Layout: [16-byte salt][12-byte IV][ciphertext]
      const result = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
      result.set(salt, 0);
      result.set(iv, salt.length);
      result.set(new Uint8Array(encrypted), salt.length + iv.length);
      return result;
    }

    async encryptBytes(data) {
      const encryptionKey = this.config.get("encryptionKey");
      if (!encryptionKey) throw new Error("No encryption key configured");

      const salt = crypto.getRandomValues(new Uint8Array(this.SALT_BYTES));
      const cryptoKey = await this.deriveKey(encryptionKey, salt);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        cryptoKey,
        data
      );

      // Layout: [16-byte salt][12-byte IV][ciphertext]
      const result = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
      result.set(salt, 0);
      result.set(iv, salt.length);
      result.set(new Uint8Array(encrypted), salt.length + iv.length);
      return result;
    }

    async decrypt(encryptedData) {
      const encryptionKey = this.config.get("encryptionKey");
      if (!encryptionKey) throw new Error("No encryption key configured");

      let decrypted;
      // Attempt PBKDF2 path first (new format: salt[16] + IV[12] + ct)
      try {
        const salt = encryptedData.slice(0, this.SALT_BYTES);
        const iv   = encryptedData.slice(this.SALT_BYTES, this.SALT_BYTES + 12);
        const data = encryptedData.slice(this.SALT_BYTES + 12);
        const key  = await this.deriveKey(encryptionKey, salt);
        decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
      } catch (_pbkdf2Err) {
        // Fall back to legacy SHA-256 path (old format: IV[12] + ct)
        const iv   = encryptedData.slice(0, 12);
        const data = encryptedData.slice(12);
        const key  = await this._deriveKeyLegacy(encryptionKey);
        decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
      }

      try {
        if (window.DecompressionStream) {
          const stream = new Blob([decrypted])
            .stream()
            .pipeThrough(new DecompressionStream("deflate-raw"));
          const text = await new Response(stream).text();
          return JSON.parse(text);
        } else {
          this.logger.log(
            "warning",
            "DecompressionStream API not supported, decoding as text."
          );
          return JSON.parse(new TextDecoder().decode(decrypted));
        }
      } catch (e) {
        return JSON.parse(new TextDecoder().decode(decrypted));
      }
    }

    async decryptBytes(encryptedData) {
      const encryptionKey = this.config.get("encryptionKey");
      if (!encryptionKey) throw new Error("No encryption key configured");

      // Attempt PBKDF2 path first (new format)
      try {
        const salt = encryptedData.slice(0, this.SALT_BYTES);
        const iv   = encryptedData.slice(this.SALT_BYTES, this.SALT_BYTES + 12);
        const data = encryptedData.slice(this.SALT_BYTES + 12);
        const key  = await this.deriveKey(encryptionKey, salt);
        const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
        return new Uint8Array(decrypted);
      } catch (_pbkdf2Err) {
        // Fall back to legacy SHA-256 path
        const iv   = encryptedData.slice(0, 12);
        const data = encryptedData.slice(12);
        const key  = await this._deriveKeyLegacy(encryptionKey);
        const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
        return new Uint8Array(decrypted);
      }
    }

    cleanup() {
      this.logger?.log("info", "🧹 CryptoService cleanup starting");
      try {
        if (this.keyCache) {
          this.keyCache.clear();
        }
        if (this.legacyKeyCache) {
          this.legacyKeyCache.clear();
        }
        this.keyCache = null;
        this.legacyKeyCache = null;
        this.lastCacheCleanup = 0;
        this.config = null;
        this.logger?.log("success", "✅ CryptoService cleanup completed");
        this.logger = null;
      } catch (error) {
        console.warn("CryptoService cleanup error:", error);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CLASS: IStorageProvider  (abstract base)
  // ─────────────────────────────────────────────────────────────────────────
  class IStorageProvider {
    constructor(configManager, cryptoService, logger) {
      if (this.constructor === IStorageProvider) {
        throw new Error("Cannot instantiate abstract class IStorageProvider.");
      }
      this.config = configManager;
      this.crypto = cryptoService;
      this.logger = logger;
    }

    static get displayName() {
      return "Unnamed Provider";
    }

    static getConfigurationUI() {
      return {
        html: '<p class="text-zinc-400">This provider has no specific configuration.</p>',
        setupEventListeners: () => {},
      };
    }

    async deleteFolder(folderPath) {
      throw new Error("Method 'deleteFolder()' must be implemented.");
    }

    isConfigured() {
      throw new Error("Method 'isConfigured()' must be implemented.");
    }

    async initialize() {
      throw new Error("Method 'initialize()' must be implemented.");
    }

    async handleAuthentication() {
      this.logger.log(
        "info",
        `${this.constructor.name} does not require interactive authentication.`
      );
      return Promise.resolve();
    }

    async upload(key, data, isMetadata = false) {
      throw new Error("Method 'upload()' must be implemented.");
    }

    async download(key, isMetadata = false) {
      throw new Error("Method 'download()' must be implemented.");
    }

    async delete(key) {
      throw new Error("Method 'delete()' must be implemented.");
    }

    async list(prefix = "") {
      throw new Error("Method 'list()' must be implemented.");
    }

    async downloadWithResponse(key) {
      throw new Error("Method 'downloadWithResponse()' must be implemented.");
    }

    async copyObject(sourceKey, destinationKey) {
      throw new Error("Method 'copyObject()' must be implemented.");
    }

    async verify() {
      this.logger.log(
        "info",
        `Verifying connection for ${this.constructor.name}...`
      );
      await this.list("");
      this.logger.log(
        "success",
        `Connection for ${this.constructor.name} verified.`
      );
    }

    async ensurePathExists(path) {
      throw new Error("Method 'ensurePathExists()' must be implemented.");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CLASS: S3Service  (extends IStorageProvider)
  // ─────────────────────────────────────────────────────────────────────────
  class S3Service extends IStorageProvider {
    constructor(configManager, cryptoService, logger) {
      super(configManager, cryptoService, logger);
      this.client = null;
      this.sdkLoaded = false;
    }

    static get displayName() {
      return "Amazon S3 (or S3-Compatible)";
    }

    static getConfigurationUI() {
      const html = `
        <div class="space-y-2">
          <div class="flex space-x-4">
            <div class="w-2/3">
              <label for="aws-bucket" class="block text-sm font-medium text-zinc-300">Bucket Name <span class="text-red-400">*</span></label>
              <input id="aws-bucket" name="aws-bucket" type="text" class="w-full px-2 py-1.5 border border-zinc-600 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-zinc-700 text-white" autocomplete="off" required>
            </div>
            <div class="w-1/3">
              <label for="aws-region" class="block text-sm font-medium text-zinc-300">Region <span class="text-red-400">*</span></label>
              <input id="aws-region" name="aws-region" type="text" class="w-full px-2 py-1.5 border border-zinc-600 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-zinc-700 text-white" autocomplete="off" required>
            </div>
          </div>
          <div>
            <label for="aws-access-key" class="block text-sm font-medium text-zinc-300">Access Key <span class="text-red-400">*</span></label>
            <input id="aws-access-key" name="aws-access-key" type="password" class="w-full px-2 py-1.5 border border-zinc-600 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-zinc-700 text-white" autocomplete="off" required>
          </div>
          <div>
            <label for="aws-secret-key" class="block text-sm font-medium text-zinc-300">Secret Key <span class="text-red-400">*</span></label>
            <input id="aws-secret-key" name="aws-secret-key" type="password" class="w-full px-2 py-1.5 border border-zinc-600 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-zinc-700 text-white" autocomplete="off" required>
          </div>
          <div>
            <label for="aws-endpoint" class="block text-sm font-medium text-zinc-300">S3 Compatible Storage Endpoint</label>
            <input id="aws-endpoint" name="aws-endpoint" type="text" class="w-full px-2 py-1.5 border border-zinc-600 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-zinc-700 text-white" autocomplete="off">
          </div>
        </div>
      `;

      const setupEventListeners = (container, providerInstance, config) => {
        container.querySelector("#aws-bucket").value =
          config.get("bucketName") || "";
        container.querySelector("#aws-region").value =
          config.get("region") || "";
        container.querySelector("#aws-access-key").value =
          config.get("accessKey") || "";
        container.querySelector("#aws-secret-key").value =
          config.get("secretKey") || "";
        container.querySelector("#aws-endpoint").value =
          config.get("endpoint") || "";
      };

      return { html, setupEventListeners };
    }

    isConfigured() {
      return !!(
        this.config.get("accessKey") &&
        this.config.get("secretKey") &&
        this.config.get("region") &&
        this.config.get("bucketName")
      );
    }

    async initialize() {
      if (!this.isConfigured()) throw new Error("AWS configuration incomplete");
      await this.loadSDK();
      const config = this.config.config;
      const s3Config = {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
        region: config.region,
      };
      if (config.endpoint) {
        s3Config.endpoint = config.endpoint;
        s3Config.s3ForcePathStyle = true;
      }
      AWS.config.update(s3Config);
      this.client = new AWS.S3();
    }

    async loadSDK() {
      if (this.sdkLoaded || window.AWS) {
        this.sdkLoaded = true;
        return;
      }
      return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        // [SECURITY FIX #2] SRI hash pins aws-sdk-2.1692.0.min.js — browser
        // rejects any tampered or version-swapped file from the CDN.
        script.src = "https://sdk.amazonaws.com/js/aws-sdk-2.1692.0.min.js";
        script.integrity = "sha384-bsVTXMkiEcKq19RTnCBVL0C8BoR4wvtdH4dISM+Ufr9VVPFAuoZPJwmyDYbcFe2";
        script.crossOrigin = "anonymous";
        script.onload = () => {
          this.sdkLoaded = true;
          resolve();
        };
        script.onerror = () => reject(new Error("Failed to load AWS SDK"));
        document.head.appendChild(script);
      });
    }
  }
}
