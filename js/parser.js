/* 聊天记录解析 + 隐私检测 + 危机词扫描 */
(function (global) {
  'use strict';

  const SPEAKER_ALIASES = {
    '我': 'me', '本人': 'me', 'me': 'me',
    '对方': 'other', '他': 'other', '她': 'other', 'ta': 'other',
    'TA': 'other', 'Ta': 'other', '对方（他）': 'other'
  };

  // 提取行首时间戳，返回 { ts: Date|null, rest: string }
  function extractTimestamp(line) {
    const patterns = [
      // [2026-09-10 21:03:00] 或 2026/9/10 21:03
      /^\s*[\[]?\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?[\]]?\s*/,
      // 9月10日 21:03
      /^\s*[\[]?\s*(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})(?::(\d{2}))?[\]]?\s*/,
      // [21:03] 或 21:03
      /^\s*[\[]?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?[\]]?\s*/
    ];
    for (let i = 0; i < patterns.length; i++) {
      const m = line.match(patterns[i]);
      if (m) {
        let d;
        if (i === 0) {
          d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
        } else if (i === 1) {
          d = new Date(1970, 0, 1, +m[3], +m[4], +(m[5] || 0));
          d._md = [+m[1], +m[2]];
        } else {
          d = new Date(1970, 0, 1, +m[1], +m[2], +(m[3] || 0));
        }
        return { date: d, rest: line.slice(m[0].length) };
      }
    }
    return { date: null, rest: line };
  }

  // 提取发言人：基于冒号的对话解析
  // 规则：
  //   1. 行内出现第一个中英文冒号（: 或 ：）即识别为对话内容标记
  //   2. 冒号左边（去除空白）作为发言人名称，要求 1-12 字符且无内部空白
  //   3. 冒号右边作为发言内容
  //   4. 第一位发言人默认标记为 "我"（me），后续新发言人按出现顺序映射为 other / other2 / other3 ...
  //   5. 显式别名（我/本人/me）优先识别为 me；显式别名（对方/他/她/ta）识别为 other
  // roleOfName 跨行维护，由调用方传入；若不传则在内部分配
  function extractSpeaker(line, ctx) {
    // ctx = { roleOfName: Map, nameOrder: Array } 跨行复用
    const c = ctx || { roleOfName: new Map(), nameOrder: [] };
    // 找第一个中英文冒号
    const ciEn = line.indexOf(':');
    const ciCn = line.indexOf('：');
    const ci = (ciEn === -1 ? Infinity : ciEn) < (ciCn === -1 ? Infinity : ciCn)
      ? (ciEn === -1 ? Infinity : ciEn)
      : (ciCn === -1 ? Infinity : ciCn);
    if (ci === Infinity || ci === 0 || ci > 12) {
      return { speaker: null, name: null, rest: line, ctx: c };
    }
    const left = line.slice(0, ci).trim();
    // 左侧需为 1-12 字符且无内部空白（避免误把句子里的冒号当作对话标记）
    if (!left || left.length > 12 || /\s/.test(left)) {
      return { speaker: null, name: null, rest: line, ctx: c };
    }
    const text = line.slice(ci + 1).trim();
    // 别名优先：直接识别为 me / other
    if (SPEAKER_ALIASES.hasOwnProperty(left)) {
      return { speaker: SPEAKER_ALIASES[left], name: left, rest: text, ctx: c };
    }
    // 按出现顺序：第一位默认为 me，其余为 other（多对方场景暂统一为 other）
    if (!c.roleOfName.has(left)) {
      const role = c.nameOrder.length === 0 ? 'me' : 'other';
      c.nameOrder.push(left);
      c.roleOfName.set(left, role);
    }
    return { speaker: c.roleOfName.get(left), name: left, rest: text, ctx: c };
  }

  // 计算中文字数（去空白；英文按单词近似计数）
  function countChars(text) {
    if (!text) return 0;
    const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const words = (text.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
    return cjk + words;
  }

  /**
   * 解析聊天记录
   * 支持：基于冒号的对话解析（任意发言人名称）；第一位发言人默认为「我」
   * @returns {{messages:Array, turns:Array, sessions:Array, hasTimestamp:boolean, rounds:number}}
   */
  function parseChat(raw) {
    const lines = raw.split(/\r?\n/);
    const messages = [];
    let dayOffset = 0;
    let lastTime = null; // 分钟数
    let lastMd = null;
    // 跨行维护 name→role 映射
    const speakerCtx = { roleOfName: new Map(), nameOrder: [] };

    for (let rawLine of lines) {
      let line = rawLine.trim();
      if (!line) continue;

      const tsResult = extractTimestamp(line);
      line = tsResult.rest;
      const spResult = extractSpeaker(line, speakerCtx);

      if (!spResult.speaker) {
        // 无说话人：作为上一条消息的换行续接
        if (messages.length && !/^\s*[-=*]{3,}/.test(rawLine)) {
          messages[messages.length - 1].text += '\n' + line;
        }
        continue;
      }

      let date = tsResult.date;
      let minuteOfDay = null;
      let dayIndex = dayOffset;

      if (date) {
        minuteOfDay = date.getHours() * 60 + date.getMinutes();
        if (date._md) {
          // 9月10日格式：用月日标识
          const md = date._md.join('-');
          if (lastMd !== null && md !== lastMd) dayOffset++;
          lastMd = md;
          dayIndex = dayOffset;
        } else if (date.getFullYear() === 1970 && date.getMonth() === 0 && date.getDate() === 1) {
          // 仅时分：时间回退视为跨天
          if (lastTime !== null && minuteOfDay < lastTime - 180) dayOffset++;
          dayIndex = dayOffset;
        } else {
          dayIndex = Math.floor(date.getTime() / 86400000);
        }
        lastTime = minuteOfDay;
      }

      messages.push({
        speaker: spResult.speaker,
        name: spResult.name,
        text: spResult.rest.trim(),
        minuteOfDay,
        dayIndex: date ? dayIndex : null,
        absMinute: date ? dayIndex * 1440 + minuteOfDay : null
      });
    }

    // 合并同一人连续消息为 turn
    const turns = [];
    for (const msg of messages) {
      const last = turns[turns.length - 1];
      if (last && last.speaker === msg.speaker) {
        last.texts.push(msg.text);
        last.chars += countChars(msg.text);
        last.endMinute = msg.absMinute ?? last.endMinute;
        if (last.startMinute === null) last.startMinute = msg.absMinute;
      } else {
        turns.push({
          speaker: msg.speaker,
          texts: [msg.text],
          chars: countChars(msg.text),
          startMinute: msg.absMinute,
          endMinute: msg.absMinute
        });
      }
    }

    // 会话切分：相邻消息间隔 > 120 分钟
    const sessions = [];
    let current = [];
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (current.length && t.startMinute !== null) {
        const prev = turns[i - 1];
        if (prev.endMinute !== null && t.startMinute - prev.endMinute > 120) {
          sessions.push(current);
          current = [];
        }
      }
      current.push(t);
    }
    if (current.length) sessions.push(current);

    // 轮次：对方 turn 中，紧跟我方 turn 的数量
    let rounds = 0;
    for (let i = 1; i < turns.length; i++) {
      if (turns[i].speaker === 'other' && turns[i - 1].speaker === 'me') rounds++;
    }

    return {
      messages,
      turns,
      sessions,
      hasTimestamp: messages.some(m => m.absMinute !== null),
      rounds
    };
  }

  /* ============ 危机词扫描 ============ */
  function detectCrisis(text) {
    const hits = [];
    for (const w of global.DICT.CRISIS) {
      let idx = text.indexOf(w);
      while (idx !== -1) {
        hits.push({ word: w, context: text.slice(Math.max(0, idx - 12), idx + w.length + 12) });
        idx = text.indexOf(w, idx + w.length);
      }
    }
    return hits;
  }

  /* ============ 隐私检测 ============ */
  const PRIVACY_PATTERNS = [
    { key: 'phone', label: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
      mask: m => m.slice(0, 3) + '****' + m.slice(7) },
    { key: 'idcard', label: '身份证号', re: /(?<!\d)\d{17}[\dXx](?!\d)/g,
      mask: m => m.slice(0, 4) + '**********' + m.slice(-2) },
    { key: 'email', label: '邮箱', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      mask: m => { const [a, b] = m.split('@'); return a[0] + '***@' + b; } },
    { key: 'org', label: '公司/机构/学校',
      re: /[一-龥A-Za-z0-9（）()]{2,20}(?:有限责任公司|股份有限公司|有限公司|集团公司|科技公司|集团|公司|银行|大学|学院|研究所|医院|派出所|局机关)/g,
      mask: () => '[机构]' },
    { key: 'addr', label: '具体地址',
      re: /[一-龥]{2,8}(?:路|街|巷|大道|小区|花园|大厦|公寓|新村|家园)\d*[号栋幢室]?(?:\d{1,4}(?:室|号)?)?/g,
      mask: () => '[地址]' }
  ];

  function scanPrivacy(text) {
    const results = [];
    for (const p of PRIVACY_PATTERNS) {
      const matches = text.match(p.re);
      if (matches && matches.length) {
        results.push({ key: p.key, label: p.label, count: matches.length, samples: matches.slice(0, 3) });
      }
    }
    return results;
  }

  function maskText(text) {
    let out = text;
    for (const p of PRIVACY_PATTERNS) {
      out = out.replace(p.re, p.mask);
    }
    return out;
  }

  global.Parser = { parseChat, countChars, detectCrisis, scanPrivacy, maskText, extractSpeaker };
})(window);
