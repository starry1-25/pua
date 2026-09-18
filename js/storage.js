/* 本地存储：设置、历史报告、当日行动勾选 */
(function (global) {
  'use strict';

  const KEYS = {
    records: 'emicro_records_v1',
    settings: 'emicro_settings_v1',
    actions: 'emicro_actions_v1',
    agreed: 'emicro_consent_v1'
  };

  const DEFAULT_SETTINGS = {
    saveRecord: true,
    maskHint: true,
    aiRead: true,
    improve: false
  };

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  const Store = {
    KEYS,

    /* ---- 设置 ---- */
    getSettings() { return Object.assign({}, DEFAULT_SETTINGS, read(KEYS.settings, {})); },
    saveSettings(s) { write(KEYS.settings, s); },

    hasAgreed() { return !!read(KEYS.agreed, false); },
    setAgreed() { write(KEYS.agreed, true); },

    /* ---- 历史 ---- */
    list() { return read(KEYS.records, []); },
    get(id) { return this.list().find(r => r.id === id) || null; },
    add(record) {
      const all = this.list();
      all.unshift(record);
      write(KEYS.records, all);
    },
    update(id, patch) {
      const all = this.list();
      const i = all.findIndex(r => r.id === id);
      if (i !== -1) {
        all[i] = Object.assign(all[i], patch);
        write(KEYS.records, all);
      }
    },
    remove(id) {
      write(KEYS.records, this.list().filter(r => r.id !== id));
    },
    wipe() {
      localStorage.removeItem(KEYS.records);
      localStorage.removeItem(KEYS.actions);
    },

    /* ---- 当日行动清单 ---- */
    getActionsDone() {
      const data = read(KEYS.actions, {});
      const today = new Date().toISOString().slice(0, 10);
      return data[today] || [];
    },
    toggleAction(text) {
      const data = read(KEYS.actions, {});
      const today = new Date().toISOString().slice(0, 10);
      const set = new Set(data[today] || []);
      if (set.has(text)) set.delete(text); else set.add(text);
      data[today] = Array.from(set);
      write(KEYS.actions, data);
      return data[today];
    },
    // 重新生成行动清单后调用：清空当日勾选状态，避免错位
    clearActionsDone() {
      const data = read(KEYS.actions, {});
      const today = new Date().toISOString().slice(0, 10);
      data[today] = [];
      write(KEYS.actions, data);
    }
  };

  global.Store = Store;
})(window);
