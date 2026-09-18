/* 聊天记录处理台 · 交互逻辑 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const SESSION_KEY = 'emicro_proc_session_v1';
  const HANDOFF_KEY = 'emicro_pending_chat';

  const state = {
    messages: [],          // {role:'me'|'other', name, text, source, conf?}
    images: [],            // {id,file,url,status,result,active,imported}
    activeImg: null,
    ocrBusy: false
  };

  /* ============ 基础工具 ============ */
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('hidden'), 2200);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function saveSession() {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(state.messages)); } catch (e) {}
  }

  /* ============ 模式切换 ============ */
  document.querySelectorAll('.seg').forEach(seg => {
    seg.onclick = () => {
      document.querySelectorAll('.seg').forEach(s => s.classList.remove('active'));
      document.querySelectorAll('.mode-panel').forEach(p => p.classList.remove('active'));
      seg.classList.add('active');
      $('mode' + (seg.dataset.mode === 'text' ? 'Text' : 'Image')).classList.add('active');
    };
  });

  /* ============ 文字解析 ============ */
  const TS_RE = /^\s*[\[]?\s*(?:\d{4}[-/.年]\d{1,2}[-/.月]\d{0,2}日?\s+|\d{1,2}月\d{1,2}日\s*)?(?:(?:上午|下午|早上|晚上|凌晨|傍晚)\s*)?\d{1,2}:\d{2}(?::\d{2})?[\]]?\s*/;

  function parseText(raw) {
    const lines = raw.split(/\r?\n/);
    const out = [];
    const nameOrder = [];
    const roleOfName = new Map();
    let last = null;

    for (let rawLine of lines) {
      let line = rawLine.replace(/\s+$/, '');
      if (!line.trim()) continue;
      line = line.replace(TS_RE, '');
      if (!line.trim()) continue;

      // 第一个中英文冒号；左侧需像发言人名称（1-12 字符、无空白）
      const ci = Math.min(
        line.indexOf(':') === -1 ? Infinity : line.indexOf(':'),
        line.indexOf('：') === -1 ? Infinity : line.indexOf('：')
      );
      let name = null, text = line.trim();
      if (ci !== Infinity && ci <= 12) {
        const left = line.slice(0, ci).trim();
        if (left && left.length <= 12 && !/\s/.test(left)) {
          name = left;
          text = line.slice(ci + 1).trim();
        }
      }

      if (name !== null) {
        if (!roleOfName.has(name)) {
          // 规则：第一位发言的用户默认为「我」，其余为「对方」
          const role = nameOrder.length === 0 ? 'me' : 'other';
          nameOrder.push(name);
          roleOfName.set(name, role);
        }
        last = { role: roleOfName.get(name), name, text, source: 'text' };
        out.push(last);
      } else if (last) {
        // 无冒号续行，并入上一条
        last.text += '\n' + text;
      }
    }
    return { messages: out, names: nameOrder, roleOfName };
  }

  const TEXT_SAMPLE = `[9月12日 21:03] 张三：在吗？你今天怎么一直没回我
[21:47] 李四：忙
张三：可是你连一句话都没有，我等了一整天
李四：呵呵，你能不能别这么敏感
张三：我只是希望你忙的时候说一声
李四：行行行，都是我的错
张三：对不起，是我太情绪化了
李四：对了，有事打我助理电话 13812345678
张三：好
李四：心理援助热线是 12356，紧急情况拨 110/120`;

  $('btnTextSample').onclick = () => { $('textInput').value = TEXT_SAMPLE; toast('已填入示例'); };
  $('btnTextClear').onclick = () => { $('textInput').value = ''; };
  $('btnParseText').onclick = () => {
    const raw = $('textInput').value.trim();
    if (!raw) { toast('请先粘贴聊天记录'); return; }
    const { messages } = parseText(raw);
    if (!messages.length) {
      toast('未识别到冒号格式的对话，请检查（示例：张三：你好）');
      return;
    }
    state.messages = messages;
    saveSession();
    renderResult();
    toast(`解析完成：${messages.length} 条，共 ${new Set(messages.map(m => m.name)).size} 位发言人`);
  };

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  /* ============ 对话渲染 ============ */
  function renderResult() {
    const list = $('bubbleList');
    const empty = $('chatEmpty');
    list.innerHTML = '';
    empty.style.display = state.messages.length ? 'none' : '';

    state.messages.forEach((m, i) => {
      const li = document.createElement('li');
      li.className = 'bubble ' + m.role;
      const avatar = document.createElement('div');
      avatar.className = 'bubble-avatar';
      avatar.textContent = (m.name === '我' ? '我' : (m.name || '对'))[0] || '对';
      const body = document.createElement('div');
      body.className = 'bubble-body';
      const name = document.createElement('div');
      name.className = 'bubble-name';
      name.innerHTML = `${escapeHtml(m.name || (m.role === 'me' ? '我' : '对方'))}` +
        `<span class="role-tag">${m.role === 'me' ? '默认为我' : '对方'}</span>`;
      const content = document.createElement('div');
      content.className = 'bubble-content';
      content.textContent = m.text;
      body.appendChild(name);
      body.appendChild(content);
      if (m.source === 'image') {
        const src = document.createElement('div');
        src.className = 'bubble-src';
        src.textContent = '来自图片识别' + (m.conf ? ` · 置信度 ${m.conf}%` : '');
        body.appendChild(src);
      }
      li.appendChild(avatar);
      li.appendChild(body);
      list.appendChild(li);
    });

    const n = state.messages.length;
    const meN = state.messages.filter(m => m.role === 'me').length;
    $('resultMeta').textContent = n
      ? `共 ${n} 条 · 我 ${meN} 条 / 对方 ${n - meN} 条 · ${new Set(state.messages.map(m => m.name)).size} 位发言人`
      : '尚未解析';
    ['btnCopyAll', 'btnToAnalyzer', 'btnResultClear'].forEach(id => $(id).disabled = !n);
  }

  function toPlainText() {
    return state.messages.map(m =>
      `${m.role === 'me' ? '我' : '对方'}：${m.text.replace(/\n/g, ' ')}`).join('\n');
  }

  $('btnCopyAll').onclick = () => {
    copyText(toPlainText()).then(() => toast('已复制全部对话（我/对方 格式）'));
  };
  $('btnResultClear').onclick = () => {
    state.messages = [];
    saveSession();
    renderResult();
  };
  $('btnToAnalyzer').onclick = () => {
    if (!state.messages.length) return;
    try { localStorage.setItem(HANDOFF_KEY, toPlainText()); } catch (e) {}
    window.location.href = 'index.html';
  };

  /* ============ 图片输入 ============ */
  const dz = $('dropzone');
  const imgInput = $('imgInput');

  /* ---------- 识别引擎：本地（默认，隐私）/ 云端高精度（上传，需同意） ---------- */
  const ENGINE_KEY = 'emicro_ocr_engine_v1';
  const ocrEngine = { current: localStorage.getItem(ENGINE_KEY) === 'cloud' ? 'cloud' : 'local' };

  function syncEngineUI() {
    document.querySelectorAll('.engine-seg').forEach(b =>
      b.classList.toggle('active', b.dataset.engine === ocrEngine.current));
    $('optEnhance').parentElement.style.display = ocrEngine.current === 'local' ? '' : 'none';
    const cloudCard = $('cloudConsentBox');
    cloudCard.classList.toggle('active', ocrEngine.current === 'cloud');
    const tip = $('ocrTip');
    tip.textContent = ocrEngine.current === 'cloud'
      ? '云端模式：图片将上传至 Agnes AI 视觉模型识别，适合单字、多行、模糊截图；繁忙时会自动重试。'
      : '首次使用需下载中文语言包（约 15MB），仅在本浏览器缓存一次。';
  }
  document.querySelectorAll('.engine-seg').forEach(b => {
    b.onclick = () => {
      ocrEngine.current = b.dataset.engine;
      localStorage.setItem(ENGINE_KEY, ocrEngine.current);
      syncEngineUI();
      if (ocrEngine.current === 'cloud' && $('cloudConsent').checked) pumpQueue();
    };
  });
  $('cloudConsent').onchange = () => { if ($('cloudConsent').checked) pumpQueue(); };

  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('图片读取失败'));
      fr.readAsDataURL(file);
    });
  }
  function imageSize(url) {
    return new Promise(resolve => {
      const im = new Image();
      im.onload = () => resolve({ width: im.naturalWidth, height: im.naturalHeight });
      im.onerror = () => resolve({ width: 0, height: 0 });
      im.src = url;
    });
  }

  async function cloudRecognize(file, url, onStep) {
    const dataUrl = await fileToDataURL(file);
    const dims = await imageSize(url);
    let lastErr = '云端识别失败';
    for (let attempt = 1; attempt <= 4; attempt++) {
      onStep(attempt === 1 ? '正在上传到云端识别…' : `服务繁忙，第 ${attempt - 1} 次重试…`, attempt === 1 ? 35 : 70);
      let resp;
      try {
        resp = await fetch('/api/ocr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataUrl })
        });
      } catch (e) { lastErr = '无法连接本地服务，请确认通过 server.ps1 启动'; break; }
      if (resp.ok) {
        const data = await resp.json();
        let raw = String(data.content || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
        let parsed;
        try { parsed = JSON.parse(raw); } catch (e) { throw new Error('云端返回格式异常，请重试或改用本地识别'); }
        const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
        const messages = msgs
          .filter(m => m && typeof m.text === 'string' && m.text.trim())
          .map(m => ({
            side: m.side === 'right' ? 'me' : 'other',
            text: String(m.text).replace(/\r/g, '').trim(),
            confidence: null
          }));
        if (!messages.length) throw new Error('云端未识别到气泡文字，请换更清晰的截图');
        return {
          messages,
          confidence: null,
          width: dims.width, height: dims.height,
          dropped: 0, lineCount: messages.length,
          engine: 'cloud'
        };
      }
      if (resp.status === 429 || resp.status >= 500) {
        const wait = 10 * attempt + 5;
        onStep(`云端繁忙（${resp.status}），${wait} 秒后重试…`, 75);
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      let detail = '';
      try { detail = (await resp.json()).error.message || ''; } catch (e) {}
      lastErr = '云端识别失败（' + resp.status + '）' + (detail ? '：' + detail : '');
      break;
    }
    throw new Error(lastErr);
  }

  ['dragenter', 'dragover'].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => {
    const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('image/'));
    if (files.length) addImages(files);
  });
  imgInput.addEventListener('change', e => {
    addImages(Array.from(e.target.files || []));
    imgInput.value = '';
  });
  window.addEventListener('paste', e => {
    if (!$('modeImage').classList.contains('active')) return;
    const files = Array.from(e.clipboardData.files || []).filter(f => f.type.startsWith('image/'));
    if (files.length) { addImages(files); toast('已接收粘贴的截图'); }
  });

  $('btnImgClear').onclick = () => {
    state.images.forEach(im => im.url && URL.revokeObjectURL(im.url));
    state.images = [];
    state.activeImg = null;
    $('thumbStrip').innerHTML = '';
    $('thumbStrip').classList.add('hidden');
    $('ocrReviewCard').classList.add('hidden');
    $('ocrProgress').classList.add('hidden');
    $('btnImgClear').disabled = true;
  };

  function addImages(files) {
    if (ocrEngine.current === 'cloud' && !$('cloudConsent').checked) {
      toast('请先勾选同意上传图片到云端识别');
      $('cloudConsentBox').classList.add('flash');
      setTimeout(() => $('cloudConsentBox').classList.remove('flash'), 1200);
    }
    files.forEach(f => {
      state.images.push({
        id: 'img' + Date.now() + Math.random().toString(36).slice(2, 6),
        file: f,
        url: URL.createObjectURL(f),
        status: 'pending',   // pending | working | done | error
        pct: 0,
        result: null,
        imported: false
      });
    });
    $('btnImgClear').disabled = false;
    renderThumbs();
    pumpQueue();
  }

  function renderThumbs(activeId) {
    const strip = $('thumbStrip');
    strip.classList.toggle('hidden', state.images.length === 0);
    strip.innerHTML = '';
    state.images.forEach(im => {
      const d = document.createElement('div');
      d.className = 'thumb' + (state.activeImg === im.id ? ' active' : '');
      d.innerHTML = `<img src="${im.url}" alt=""><span class="thumb-status ${im.status === 'error' ? 'err' : ''}"></span><span class="thumb-remove">×</span>`;
      const status = d.querySelector('.thumb-status');
      status.textContent = im.status === 'pending' ? '待识别'
        : im.status === 'working' ? `识别中 ${im.pct}%`
        : im.status === 'error' ? '失败'
        : im.imported ? '已导入'
        : `已识别${im.result && im.result.confidence != null ? ' ' + im.result.confidence + '%' : ''}${im.result && im.result.engine === 'cloud' ? ' · 云端' : ''}`;
      d.onclick = e => {
        if (e.target.classList.contains('thumb-remove')) {
          im.url && URL.revokeObjectURL(im.url);
          state.images = state.images.filter(x => x.id !== im.id);
          if (state.activeImg === im.id) state.activeImg = null;
          if (!state.images.length) $('ocrReviewCard').classList.add('hidden');
          renderThumbs();
          return;
        }
        if (im.status === 'done') { state.activeImg = im.id; renderThumbs(); renderReview(); }
        else if (im.status === 'error') { im.status = 'pending'; renderThumbs(); pumpQueue(); }
      };
      strip.appendChild(d);
    });
  }

  async function pumpQueue() {
    if (state.ocrBusy) return;
    state.ocrBusy = true;
    let im;
    while ((im = state.images.find(x => x.status === 'pending'))) {
      const useCloud = ocrEngine.current === 'cloud';
      if (useCloud && !$('cloudConsent').checked) break;  // 等待勾选同意
      im.engine = useCloud ? 'cloud' : 'local';
      im.status = 'working';
      renderThumbs();
      try {
        let result;
        if (useCloud) {
          showProgress(im, '正在上传到云端识别…', 30);
          result = await cloudRecognize(im.file, im.url, (step, pct) => {
            im.pct = pct;
            $('ocrStep').textContent = step;
            $('ocrPct').textContent = im.pct + '%';
            $('ocrBar').style.width = im.pct + '%';
            renderThumbs();
          });
        } else {
          showProgress(im, '正在加载识别引擎…', 4);
          result = await OCR.recognize(im.file, {
            enhance: $('optEnhance').checked,
            onProgress: (step, pct) => {
              im.pct = Math.round((pct || 0) * 100);
              $('ocrStep').textContent = step;
              $('ocrPct').textContent = im.pct + '%';
              $('ocrBar').style.width = im.pct + '%';
              renderThumbs();
            }
          });
        }
        im.status = 'done';
        im.result = result;
        im.pct = 100;
        // 跟随最新完成的图：队列串行处理时，校正面板始终显示刚识别完的这张
        state.activeImg = im.id;
        renderThumbs();
        renderReview();
      } catch (err) {
        im.status = 'error';
        im.pct = 0;
        renderThumbs();
        $('ocrStep').textContent = '识别失败，点击缩略图重试';
        $('ocrPct').textContent = '';
        toast(err.message || '识别失败，请检查网络后重试');
      }
    }
    $('ocrProgress').classList.add('hidden');
    state.ocrBusy = false;
  }
  function showProgress(im, step, pct) {
    $('ocrProgress').classList.remove('hidden');
    $('ocrStep').textContent = step;
    $('ocrPct').textContent = pct + '%';
    $('ocrBar').style.width = pct + '%';
  }

  /* ---------- OCR 结果校正 ---------- */
  function currentImage() {
    return state.images.find(x => x.id === state.activeImg) || null;
  }

  function renderReview() {
    const im = currentImage();
    if (!im || !im.result) { $('ocrReviewCard').classList.add('hidden'); return; }
    $('ocrReviewCard').classList.remove('hidden');
    const { messages, confidence, lineCount, dropped, width, height, engine } = im.result;
    const engineTag = engine === 'cloud'
      ? `<span class="ocr-engine-tag cloud">云端高精度</span>`
      : `<span class="ocr-engine-tag local">本地识别</span>`;
    const confText = confidence != null
      ? `平均置信度 <b>${confidence}%</b>，`
      : `云端模型不提供逐字置信度，`;
    const filterText = engine === 'cloud'
      ? `已按气泡识别 ${messages.length} 条消息，`
      : `原始 ${lineCount} 行，自动滤除时间/系统提示 ${dropped} 行，识别 <b>${messages.length}</b> 条消息，`;
    $('ocrConf').innerHTML =
      engineTag + filterText + confText +
      (width && height ? `截图分辨率 ${width}×${height}。` : '') +
      `导入前请逐条核对，尤其核对单字、数字与人名。`;

    const ul = $('ocrLines');
    ul.innerHTML = '';
    messages.forEach((m, i) => {
      const row = document.createElement('div');
      row.className = 'ocr-line side-' + m.side;
      const sideBtn = document.createElement('button');
      sideBtn.type = 'button';
      sideBtn.className = 'ocr-side-btn';
      sideBtn.textContent = m.side === 'me' ? '右 · 我' : '左 · 对方';
      sideBtn.onclick = () => {
        m.side = m.side === 'me' ? 'other' : 'me';
        row.className = 'ocr-line side-' + m.side;
        sideBtn.textContent = m.side === 'me' ? '右 · 我' : '左 · 对方';
      };
      const input = document.createElement('input');
      input.className = 'ocr-text';
      input.value = m.text;
      input.oninput = () => { m.text = input.value; };
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ocr-del';
      del.textContent = '×';
      del.title = '删除此行';
      del.onclick = () => { messages.splice(i, 1); renderReview(); };
      row.appendChild(sideBtn);
      row.appendChild(input);
      row.appendChild(del);
      ul.appendChild(row);
    });

    $('btnOcrConfirm').textContent = im.imported ? '已导入（再次追加）' : '导入为对话';
  }

  $('btnOcrConfirm').onclick = () => {
    const im = currentImage();
    if (!im || !im.result) return;
    const valid = im.result.messages.filter(m => m.text.trim());
    if (!valid.length) { toast('没有可导入的消息'); return; }
    valid.forEach(m => {
      state.messages.push({
        role: m.side,
        name: m.side === 'me' ? '我' : '对方',
        text: m.text.trim(),
        source: 'image',
        conf: m.confidence
      });
    });
    im.imported = true;
    saveSession();
    renderResult();
    renderThumbs();
    renderReview();
    toast(`已导入 ${valid.length} 条消息，可在右侧预览核对`);
  };

  $('btnOcrRescan').onclick = () => {
    const im = currentImage();
    if (!im) return;
    im.status = 'pending';
    im.result = null;
    im.imported = false;
    renderThumbs();
    pumpQueue();
  };

  /* ============ 恢复上次会话 ============ */
  syncEngineUI();
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (Array.isArray(saved) && saved.length) {
      state.messages = saved;
      renderResult();
    }
  } catch (e) {}
})();
