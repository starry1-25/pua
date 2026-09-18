/* 图片聊天记录 OCR
 * 纯前端 Tesseract.js：中文(chi_sim)+英文，识别行带坐标，
 * 按"左气泡=对方 / 右气泡=我"做方位判定与同气泡行聚合。
 * 截图数据不离开浏览器。
 */
(function (global) {
  'use strict';

  // 本地语言包（随站点分发，避免 CDN 下载缓慢）；file:// 打开时退回 CDN
  const LOCAL_LANG = location.protocol.startsWith('http')
    ? location.origin.replace(/\/$/, '') + '/vendor/tesseract'
    : null;

  const CDNS = [
    {
      root: 'https://cdn.jsdelivr.net/npm',
      worker: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
      core: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1',
      lang: LOCAL_LANG || 'https://cdn.jsdelivr.net/npm/tesseract-lang@1.0.0'
    },
    {
      root: 'https://unpkg.com',
      worker: 'https://unpkg.com/tesseract.js@5.1.1/dist/worker.min.js',
      core: 'https://unpkg.com/tesseract.js-core@5.1.1',
      lang: 'https://unpkg.com/tesseract-lang@1.0.0'
    },
    {
      root: 'https://cdnjs.cloudflare.com/ajax/libs',
      worker: 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/worker.min.js',
      core: 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1',
      lang: 'https://cdn.jsdelivr.net/npm/tesseract-lang@1.0.0'
    }
  ];

  let scriptTried = 0;
  function loadTesseract() {
    if (global.Tesseract) return Promise.resolve(global.Tesseract);
    return new Promise((resolve, reject) => {
      const tryNext = () => {
        if (global.Tesseract) return resolve(global.Tesseract);
        if (scriptTried >= CDNS.length) return reject(new Error('OCR 引擎加载失败：所有 CDN 均不可用，请检查网络后重试'));
        const src = CDNS[scriptTried].root + '/tesseract.js@5.1.1/dist/tesseract.min.js';
        scriptTried++;
        const s = document.createElement('script');
        s.src = src; s.async = true;
        s.onload = () => global.Tesseract ? resolve(global.Tesseract) : tryNext();
        s.onerror = () => { s.remove(); tryNext(); };
        document.head.appendChild(s);
      };
      tryNext();
    });
  }

  /* ---------- 图片 → 增强 canvas ---------- */
  function fileToImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }

  function enhance(img, doEnhance) {
    // 小图放大，利于 OCR（单字气泡对分辨率敏感）；
    // 进一步提高放大倍数：长边不足 1600px 时按比例放大到 1600px（上限 3.5x）
    const targetLongEdge = 1600;
    const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
    let scale = 1;
    if (longEdge < targetLongEdge) {
      scale = Math.min(3.5, targetLongEdge / longEdge);
    }
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // 高质量重采样：先关闭平滑后开，配合 imageSmoothingQuality
    ctx.imageSmoothingEnabled = true;
    try { ctx.imageSmoothingQuality = 'high'; } catch (e) {}
    ctx.drawImage(img, 0, 0, w, h);
    if (doEnhance) {
      const imgData = ctx.getImageData(0, 0, w, h);
      const d = imgData.data;
      const n = w * h;

      // 1. 灰度化到独立缓冲
      const gray = new Uint8ClampedArray(n);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        gray[j] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
      }

      // 1.5 3x3 中值滤波去噪：在锐化前消除孤立噪点，避免锐化放大噪声
      const denoised = new Uint8ClampedArray(n);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1;
          const ym = y > 0 ? y - 1 : 0, yp = y < h - 1 ? y + 1 : h - 1;
          const vals = [
            gray[ym * w + xm], gray[ym * w + x], gray[ym * w + xp],
            gray[y * w + xm],  gray[y * w + x],  gray[y * w + xp],
            gray[yp * w + xm], gray[yp * w + x], gray[yp * w + xp]
          ].sort((a, b) => a - b);
          denoised[y * w + x] = vals[4];
        }
      }

      // 2. 3x3 锐化卷积（拉普拉斯核），增强字符边缘
      //    边界采用复制填充（clamp），避免黑边
      const sharp = new Uint8ClampedArray(n);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1;
          const ym = y > 0 ? y - 1 : 0, yp = y < h - 1 ? y + 1 : h - 1;
          const c = denoised[y * w + x];
          const l = denoised[y * w + xm], r = denoised[y * w + xp];
          const u = denoised[ym * w + x], dn = denoised[yp * w + x];
          // 拉普拉斯核 [0,-1,0;-1,5,-1;0,-1,0]
          let s = 5 * c - l - r - u - dn;
          sharp[y * w + x] = s < 0 ? 0 : s > 255 ? 255 : s;
        }
      }

      // 3. 基于直方图百分位（0.5%/99.5%）的对比度拉伸：消除残余灰雾，让 Tesseract 内部 Otsu 更稳
      //    放宽到 0.5%/99.5% 以更激进地切除残余背景灰雾
      const hist = new Array(256).fill(0);
      for (let i = 0; i < n; i++) hist[sharp[i]]++;
      let acc = 0;
      const loTh = n * 0.005;
      let lo = 0;
      for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= loTh) { lo = i; break; } }
      acc = 0;
      const hiTh = n * 0.005;
      let hi = 255;
      for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= hiTh) { hi = i; break; } }
      if (hi - lo < 8) { lo = 0; hi = 255; }
      const invRange = 255 / (hi - lo);

      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        let g = (sharp[j] - lo) * invRange;
        g = g < 0 ? 0 : g > 255 ? 255 : g;
        d[i] = d[i + 1] = d[i + 2] = g;
      }
      ctx.putImageData(imgData, 0, 0);
    }
    return { canvas, width: w, height: h, scale };
  }

  /* ---------- 文本清洗 ---------- */
  function cleanText(t) {
    let s = (t || '')
      .replace(/[ \t]+/g, ' ')
      .replace(/^[\s|·•\-—_=<>~^"']+/g, '')
      .replace(/[\s|·•\-—_=<>~^"']+$/g, '')
      .trim();
    // 中文 OCR 常见伪影：汉字/中文标点之间被插入空格
    for (let i = 0; i < 3; i++) {
      s = s.replace(/([一-龥])\s+(?=[一-龥，。！？、；：""''（）])/g, '$1');
      s = s.replace(/([一-龥])\s+(?=[0-9])/g, '$1');   // 第 3 页 → 第3页
      s = s.replace(/([0-9])\s+(?=[一-龥])/g, '$1');   // 3 页 → 3页
    }
    s = s.replace(/\s*([，。！？、；：])\s*/g, '$1');
    // 中文语境里被误识成半角的标点 → 全角（汉字在前即可；数字千分位/时间冒号前是数字，不受影响）
    const fw = { ',': '，', '?': '？', '!': '！', ';': '；', ':': '：' };
    for (let i = 0; i < 3; i++) {
      s = s.replace(/([一-龥])\s*([,?!;:])\s*/g, (m, a, p) => a + fw[p]);
    }
    return s.trim();
  }

  const TIME_RE = /^(?:\d{2,4}[-/.年]\d{1,2}[-/.月]\d{0,2}日?\s*)?(?:昨天|前天|今天|刚刚|星期[一二三四五六日天]|周[一二三四五六日天]|(?:上午|下午|早上|晚上|凌晨|傍晚))?\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:上午|下午|早上|晚上|凌晨|傍晚))?$/;
  const SYSTEM_RE = /^(以下|以上|对方正在输入|撤回了一条消息|消息已发出|你已添加|现在可以开始聊天|对方已拒绝|未读消息|\d+条消息|\[图片\]|\[语音\]|\[视频\]|\[表情包\]|\[位置\]|\[文件\])/;

  /* ---------- 行方位判定 ---------- */
  function sideOf(line, W) {
    const cx = (line.x0 + line.x1) / 2 / W;
    const leftEdge = line.x0 / W;
    const rightEdge = line.x1 / W;
    // 明确的左右气泡
    if (rightEdge >= 0.78 && cx > 0.5) return 'me';
    if (leftEdge <= 0.22 && cx < 0.5) return 'other';
    // 短气泡或裁切不完整时按中心判定
    if (cx >= 0.55) return 'me';
    if (cx <= 0.45) return 'other';
    return cx >= 0.5 ? 'me' : 'other';
  }

  function isTimeOrSystem(text, line, W) {
    const t = text.replace(/\s/g, '');
    if (!t) return true;
    const cx = (line.x0 + line.x1) / 2 / W;
    if (TIME_RE.test(t) && cx > 0.3 && cx < 0.7) return true;
    if (t.length <= 14 && cx > 0.32 && cx < 0.68 && SYSTEM_RE.test(t)) return true;
    return false;
  }

  /* ---------- 同气泡行聚合 ----------
     改进：置信度按文本长度加权聚合（更长的行在平均置信度里占更大权重），
     避免短噪声行把整气泡置信度拉低；空文本与置信度<5 的行不参与均值 */
  function cluster(lines) {
    const out = [];
    let cur = null;
    for (const ln of lines) {
      const lh = Math.max(14, ln.y1 - ln.y0);
      if (cur && cur.side === ln.side) {
        const gap = ln.y0 - cur.y1;
        const xShift = Math.abs(ln.x0 - cur.x0);
        // 行间距小，或间距中等但左缘对齐 → 同一气泡
        const same = gap <= lh * 0.45 || (gap <= lh * 0.95 && xShift < lh * 0.8);
        if (same) {
          cur.texts.push(ln.text);
          cur.y1 = ln.y1;
          cur.x0 = Math.min(cur.x0, ln.x0);
          cur.x1 = Math.max(cur.x1, ln.x1);
          // 长度加权：text.length 作为权重；置信度<5 的行视为噪声，权重置 0
          const w = ln.text.length > 0 && (ln.confidence || 0) >= 5 ? ln.text.length : 0;
          cur.confSum += (ln.confidence || 0) * w;
          cur.confW += w;
          cur.confN++;
          continue;
        }
      }
      cur = {
        side: ln.side,
        texts: [ln.text],
        x0: ln.x0, x1: ln.x1, y0: ln.y0, y1: ln.y1,
        // 初始权重用首行文本长度
        confSum: (ln.confidence || 0) * (ln.text.length > 0 && (ln.confidence || 0) >= 5 ? ln.text.length : 0),
        confW: (ln.text.length > 0 && (ln.confidence || 0) >= 5 ? ln.text.length : 0),
        confN: 1
      };
      out.push(cur);
    }
    return out.map(c => {
      // 若全部行置信度都<5（极端噪声），退回简单均值；否则用加权均值
      let conf;
      if (c.confW > 0) conf = c.confSum / c.confW;
      else conf = c.confN > 0 ? c.confSum / c.confN : 0;
      return {
        side: c.side,
        text: c.texts.join('\n'),
        confidence: conf
      };
    }).filter(m => m.text.length > 0);
  }

  /* ---------- 创建 worker（CDN 容灾 + SIMD 回退） ---------- */
  let cachedWorker = null;
  async function createWorker(onLog) {
    if (cachedWorker) return cachedWorker;
    await loadTesseract();
    let lastErr = null;
    for (let i = 0; i < CDNS.length; i++) {
      const cdn = CDNS[i];
      // SIMD 优先，失败回退普通版
      const cores = [`${cdn.core}/tesseract-core-simd.wasm.js`, `${cdn.core}/tesseract-core.wasm.js`];
      for (const corePath of cores) {
        try {
          onLog && onLog(`正在加载识别引擎（${corePath.includes('simd') ? 'SIMD' : '兼容'}版）…`, 0.04);
          cachedWorker = await Tesseract.createWorker('chi_sim+eng', 1, {
            workerPath: cdn.worker,
            corePath,
            langPath: cdn.lang,
            gzip: true,
            logger: m => {
              if (!onLog || typeof m.status !== 'string') return;
              if (m.status === 'recognizing text') onLog('正在识别截图文字…', 0.5 + (m.progress || 0) * 0.48);
              else if (m.status.includes('traineddata')) onLog('正在加载中文语言包…', 0.12);
              else if (m.status.includes('core')) onLog('正在加载识别引擎…', 0.07);
            }
          });
          return cachedWorker;
        } catch (e) {
          lastErr = e;
          cachedWorker = null;
        }
      }
    }
    throw lastErr || new Error('识别引擎初始化失败');
  }

  /* 单遍识别，返回清洗后的行（含坐标） */
  async function runPass(worker, canvas, psm, onLog, base) {
    const PSM = Tesseract.PSM || {};
    const psmVal = psm === 11
      ? (PSM.SPARSE_TEXT || 11)
      : psm === 3
        ? (PSM.AUTO || 3)
        : (PSM.SINGLE_BLOCK || 6);
    // user_defined_dpi=300 帮助 Tesseract 判断字符大小，提升识别稳定性
    await worker.setParameters({
      tessedit_pageseg_mode: psmVal,
      preserve_interword_spaces: '0',
      user_defined_dpi: '300'
    });
    const ret = await worker.recognize(canvas);
    const out = [];
    const pushLine = l => {
      if (!l || !l.bbox) return;
      const text = cleanText(l.text);
      if (!text) return;
      out.push({
        text,
        x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1,
        confidence: l.confidence || 0
      });
    };
    const blocks = (ret.data && ret.data.blocks) || [];
    blocks.forEach(b => (b.paragraphs || []).forEach(p => (p.lines || []).forEach(pushLine)));
    // 个别行可能挂在 blocks 树外：补入 data.lines 中垂直位置不重合的行
    if (ret.data && Array.isArray(ret.data.lines)) {
      ret.data.lines.forEach(l => {
        if (!l || !l.bbox) return;
        const cy = (l.bbox.y0 + l.bbox.y1) / 2;
        const dup = out.some(a => Math.abs(((a.y0 + a.y1) / 2) - cy) < Math.max((a.y1 - a.y0) * 0.7, 14));
        if (!dup) pushLine(l);
      });
    }
    return out;
  }

  /* 多遍结果按垂直位置聚类，每簇择优：含汉字候选优先 → 置信度 → 文本长度 → 来源顺序
     多遍一致候选：boost 置信度（最多 +6），让"被多次确认"的结果反映到最终置信度上 */
  function mergeAll(passArr) {
    const all = [];
    passArr.forEach((lines, pi) => lines.forEach(l => all.push({ l, pi })));
    all.sort((a, b) => a.l.y0 - b.l.y0);
    const clusters = [];
    all.forEach(o => {
      const cy = (o.l.y0 + o.l.y1) / 2;
      const g = clusters.find(c => Math.abs(((c.y0 + c.y1) / 2) - cy) < Math.max((c.y1 - c.y0) * 0.7, 14));
      if (g) { g.items.push(o); g.y0 = Math.min(g.y0, o.l.y0); g.y1 = Math.max(g.y1, o.l.y1); }
      else clusters.push({ y0: o.l.y0, y1: o.l.y1, items: [o] });
    });
    return clusters.map(g => {
      let items = g.items;
      if (items.some(i => /[一-龥]/.test(i.l.text))) {
        items = items.filter(i => /[一-龥]/.test(i.l.text));  // 丢弃 "B"/"CA" 这类纯拉丁短误识
      }
      items.sort((a, b) => {
        if (Math.abs(a.l.confidence - b.l.confidence) > 4) return b.l.confidence - a.l.confidence;
        if (a.l.text.length !== b.l.text.length) return b.l.text.length - a.l.text.length;
        return a.pi - b.pi;
      });
      const best = Object.assign({}, items[0].l);
      // 多遍一致候选 boost：相同文本被 ≥2 遍识别时提升最终置信度
      const textCounts = new Map();
      items.forEach(i => {
        const t = i.l.text;
        textCounts.set(t, (textCounts.get(t) || 0) + 1);
      });
      const topCount = textCounts.get(best.text) || 1;
      if (topCount >= 2) {
        // 每多一遍一致，置信度 +3，最多 +6；上限 99
        const boost = Math.min(6, (topCount - 1) * 3);
        best.confidence = Math.min(99, (best.confidence || 0) + boost);
      }
      return best;
    });
  }

  /* 反色画布：右侧深底白字气泡在浅色页面里易漏识，反色后补扫一遍 */
  function invertCanvas(src) {
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const img = ctx.createImageData(c.width, c.height);
    const o = img.data;
    for (let i = 0; i < d.length; i += 4) {
      // 源图已是灰度，RGB 相同
      const g = 255 - d[i];
      o[i] = o[i + 1] = o[i + 2] = g;
      o[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /* 孤立短气泡（1-2 个汉字）整版模式极易误识（如深底白字"忙"→"国"）：
     裁剪放大 3 倍后，在 正常 + 反色 两个画布上分别用单字/单词模式复验，
     识别期间屏蔽拉丁字母与数字噪声；候选按「出现次数 → 置信度」投票择优 */
  async function rescueShortLines(worker, canvas, invCanvas, lines, onLog) {
    const PSM = Tesseract.PSM || {};
    const psmChar = PSM.SINGLE_CHAR || 10;
    const psmWord = PSM.SINGLE_WORD || 8;
    try {
      await worker.setParameters({
        tessedit_pageseg_mode: psmChar,
        preserve_interword_spaces: '0',
        tessedit_char_blacklist: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
      });
    } catch (e) { return; }

    const cropZoom = (src, ln) => {
      const lh = Math.max(14, ln.y1 - ln.y0);
      const pad = Math.round(lh * 0.55) + 10;
      const x = Math.max(0, Math.floor(ln.x0 - pad));
      const y = Math.max(0, Math.floor(ln.y0 - pad));
      const w = Math.min(src.width - x, Math.ceil(ln.x1 - ln.x0 + pad * 2));
      const h = Math.min(src.height - y, Math.ceil(lh + pad * 2));
      const zoom = 3;
      const c = document.createElement('canvas');
      c.width = Math.max(8, w * zoom); c.height = Math.max(8, h * zoom);
      const cc = c.getContext('2d', { willReadFrequently: true });
      cc.imageSmoothingEnabled = true;
      cc.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
      return c;
    };

    for (const ln of lines) {
      const cjkLen = (ln.text.match(/[一-龥]/g) || []).length;
      if (cjkLen < 1 || cjkLen > 2 || /[a-zA-Z0-9]/.test(ln.text)) continue;
      const attempts = [];
      const sources = invCanvas ? [canvas, invCanvas] : [canvas];
      for (const src of sources) {
        const crop = cropZoom(src, ln);
        for (const psm of [psmChar, psmWord]) {
          try {
            await worker.setParameters({ tessedit_pageseg_mode: psm });
            const ret = await worker.recognize(crop);
            const first = ((ret.data && ret.data.text || '').split(/\r?\n/).map(cleanText).filter(Boolean)[0]) || '';
            const conf = (ret.data && typeof ret.data.confidence === 'number') ? ret.data.confidence : 0;
            if (/^[一-龥]{1,2}$/.test(first)) attempts.push({ text: first, conf });
          } catch (e) { /* 单遍复验失败继续下一遍 */ }
        }
      }
      if (!attempts.length) continue;
      // 投票：多遍一致的候选优先，其次取最高置信度
      const votes = new Map();
      attempts.forEach(a => {
        const g = votes.get(a.text) || { text: a.text, conf: 0, n: 0 };
        if (a.conf > g.conf) g.conf = a.conf;
        g.n++;
        votes.set(a.text, g);
      });
      const best = Array.from(votes.values()).sort((a, b) => (b.n - a.n) || (b.conf - a.conf))[0];
      const accept = best.text !== ln.text && (
        (best.n >= 2 && best.conf >= ln.confidence - 6) ||      // 多遍一致，可小幅容忍置信度差
        best.conf > ln.confidence + 8 ||                        // 显著更优
        (ln.confidence < 60 && best.conf > ln.confidence) ||    // 原结果本就不可信
        (best.conf >= 88 && best.conf > ln.confidence)          // 高置信候选压过
      );
      if (accept) {
        ln.text = best.text;
        ln.confidence = best.conf;
      }
    }
    // 复原参数（worker 会被缓存并用于后续图片，黑名单必须清空）
    try {
      await worker.setParameters({ tessedit_pageseg_mode: (PSM.SINGLE_BLOCK || 6), tessedit_char_blacklist: '' });
    } catch (e) {}
    onLog && onLog('正在补抓短句气泡…', 0.96);
  }

  /**
   * 识别单张图片（双遍：整版模式保质量 + 稀疏模式补孤立气泡）
   * @returns {{messages:Array, confidence:number, width:number, height:number, dropped:number}}
   */
  async function recognize(file, opts) {
    opts = opts || {};
    const img = await fileToImage(file);
    const { canvas, width, height } = enhance(img, opts.enhance !== false);

    const worker = await createWorker(opts.onProgress);
    opts.onProgress && opts.onProgress('正在识别截图文字（整版模式）…', 0.5);
    let mainLines, autoLines = [], sparseLines = [], invLines = [];
    let invCanvas = null;
    try {
      mainLines = await runPass(worker, canvas, 6, opts.onProgress);
    } catch (e) {
      throw new Error('识别失败：' + (e.message || e));
    }
    try {
      opts.onProgress && opts.onProgress('自动版式补扫（第 2 遍）…', 0.66);
      autoLines = await runPass(worker, canvas, 3, opts.onProgress);
    } catch (e) { /* 自动版式失败不阻塞 */ }
    try {
      opts.onProgress && opts.onProgress('稀疏文本补扫（第 3 遍）…', 0.78);
      sparseLines = await runPass(worker, canvas, 11, opts.onProgress);
    } catch (e) { /* 稀疏遍失败不阻塞 */ }
    try {
      opts.onProgress && opts.onProgress('正在反色补扫深色气泡…', 0.88);
      invCanvas = invertCanvas(canvas);
      invLines = await runPass(worker, invCanvas, 6, opts.onProgress);
    } catch (e) { invCanvas = null; /* 反色遍失败不阻塞 */ }

    // 四遍结果按行位聚类择优（auto 版式在混排截图上更稳，平局时优先）
    const rawLines = mergeAll([autoLines, mainLines, sparseLines, invLines].map(a => a || []));
    // 第三遍：孤立 1-2 字短气泡裁剪放大，正常+反色双画布四路复验投票
    if (rawLines.some(l => (l.text.match(/[一-龥]/g) || []).length >= 1 && (l.text.match(/[一-龥]/g) || []).length <= 2 && !/[a-zA-Z0-9]/.test(l.text))) {
      try {
        opts.onProgress && opts.onProgress('正在复验单字气泡…', 0.9);
        await rescueShortLines(worker, canvas, invCanvas, rawLines, opts.onProgress);
      } catch (e) { /* 复验失败不阻塞 */ }
    }
    rawLines.sort((a, b) => a.y0 - b.y0);

    let dropped = 0;
    const lines = [];
    rawLines.sort((a, b) => a.y0 - b.y0).forEach(l => {
      if (isTimeOrSystem(l.text, l, width)) { dropped++; return; }
      lines.push(Object.assign(l, { side: sideOf(l, width) }));
    });

    const messages = cluster(lines);
    const confidence = messages.length
      ? messages.reduce((s, m) => s + m.confidence, 0) / messages.length
      : 0;

    return {
      messages,
      confidence: Math.round(confidence),
      width, height,
      dropped,
      lineCount: rawLines.length
    };
  }

  global.OCR = { recognize, loadTesseract };
})(window);
