/* 情绪显微镜 · UI 控制器 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const state = {
    scene: '恋爱', relation: '恋人', goal: '想确认是否内耗',
    result: null, ctx: null, savedId: null,
    anonymous: false, replyVariant: [0, 0, 0],
    lastCtx: null,            // 供 regen-reply / regen-cbt / regen-actions 复用的上下文（scene/relation/goal/bg/score/metrics/messages）
    regenInFlight: { reply: [false, false, false], cbt: false, actions: false }
  };

  /* ============ 工具 ============ */
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('hidden'), 2200);
  }

  function fmtDelay(min) {
    if (min == null) return '无时间戳';
    if (min < 60) return Math.round(min) + ' 分钟';
    if (min < 1440) return (min / 60).toFixed(min % 60 === 0 ? 0 : 1) + ' 小时';
    return (min / 1440).toFixed(1) + ' 天';
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast('已复制，发送前请再读一遍'),
        () => fallbackCopy(text));
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制'); } catch (e) { toast('复制失败，请长按选择'); }
    document.body.removeChild(ta);
  }

  function showPage(name) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    $('page-' + name).classList.add('active');
    document.querySelectorAll('.tabbar-item').forEach(b =>
      b.classList.toggle('active', b.dataset.page === name));
    window.scrollTo(0, 0);
  }

  let confirmResolver = null;
  function openConfirm(title, text, okText, danger) {
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmOk').textContent = okText || '确认';
    $('confirmOk').className = 'btn small ' + (danger ? 'danger-ghost' : 'primary');
    $('confirmModal').classList.remove('hidden');
    return new Promise(resolve => { confirmResolver = resolve; });
  }
  function closeConfirm(val) {
    $('confirmModal').classList.add('hidden');
    if (confirmResolver) { confirmResolver(val); confirmResolver = null; }
  }
  $('confirmCancel').onclick = () => closeConfirm(false);
  $('confirmOk').onclick = () => closeConfirm(true);

  /* ============ 示例数据 ============ */
  const SAMPLE = `[9月12日 21:03] 我：在吗？你今天怎么一直没回我
[21:47] 对方：忙
[21:48] 我：可是你连一句话都没有，我等了一整天，是不是我哪里做错了
[21:48] 我：对不起，我不是想催你，就是有点难受
[22:30] 对方：呵呵，你能不能别这么敏感
[22:31] 我：我不是敏感，我只是希望你忙的时候说一声，这要求很过分吗
[22:55] 对方：行行行，都是我的错，满意了？
[22:56] 我：我没有这个意思……你别生气，是我不好，我不该逼你
[23:20] 对方：我要睡了
[9月13日 09:10] 我：早安，昨晚是我太情绪化了，我们好好说话好吗
[12:40] 对方：嗯
[12:42] 我：那你晚上还一起吃饭吗
[13:50] 对方：再说吧
[13:52] 我：你最近总是这样，我真的很难受
[18:05] 对方：就你事多
[20:12] 我：我到底要怎么做你才满意
[9月14日 08:01] 对方：你能不能成熟一点，我工作很忙
[08:15] 我：好，我等你忙完，我们好好谈一次可以吗
[9月14日 12:20] 我：在吗
[12:21] 我：回我一下好不好`;

  /* ============ 输入页交互 ============ */
  document.querySelectorAll('.chips').forEach(group => {
    group.addEventListener('click', e => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      group.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
      btn.classList.add('selected');
      state[group.dataset.group] = btn.dataset.value;
    });
  });

  $('bgInput').addEventListener('input', e => {
    $('bgCount').textContent = e.target.value.length;
  });

  $('btnSample').onclick = () => {
    $('chatInput').value = SAMPLE;
    scanPrivacyNow();
    toast('已填入 20 轮示例记录');
  };
  $('btnClearInput').onclick = async () => {
    if (!$('chatInput').value.trim()) return;
    if (await openConfirm('清空记录', '清空后输入内容无法恢复，确定吗？', '清空', true)) {
      $('chatInput').value = '';
      $('privacyWarn').classList.add('hidden');
    }
  };
  $('btnDesensitize').onclick = () => {
    $('chatInput').value = Parser.maskText($('chatInput').value);
    $('privacyWarn').classList.add('hidden');
    toast('已对可识别信息做脱敏处理');
  };
  $('btnMaskNow').onclick = () => $('btnDesensitize').click();
  $('btnIgnoreWarn').onclick = () => $('privacyWarn').classList.add('hidden');

  let scanTimer = null;
  function scanPrivacyNow() {
    const settings = Store.getSettings();
    const warn = $('privacyWarn');
    if (!settings.maskHint) { warn.classList.add('hidden'); return; }
    const hits = Parser.scanPrivacy($('chatInput').value);
    if (!hits.length) { warn.classList.add('hidden'); return; }
    const count = hits.reduce((s, h) => s + h.count, 0);
    $('privacyCount').textContent = count;
    $('privacyDetail').innerHTML = hits.map(h =>
      `${h.label} ${h.count} 处（如 ${h.samples.map(s => `<b>${s}</b>`).join('、')}）`).join('；');
    warn.classList.remove('hidden');
  }
  $('chatInput').addEventListener('input', () => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanPrivacyNow, 700);
  });

  /* ============ 分析流程 ============ */
  async function runAnalysis(anonymous) {
    const raw = $('chatInput').value.trim();
    if (!raw) { toast('请先粘贴聊天记录'); return; }

    // 1. 危机词优先
    const crisisHits = Parser.detectCrisis(raw + '\n' + $('bgInput').value);
    if (crisisHits.length) {
      $('crisisModal').classList.remove('hidden');
      return;
    }

    // 2. 隐私闸门
    const hits = Parser.scanPrivacy(raw);
    if (hits.length && Store.getSettings().maskHint) {
      const ok = await openConfirm(
        '发现隐私信息',
        `检测到 ${hits.reduce((s, h) => s + h.count, 0)} 处手机号/证件/机构/地址类信息。建议先脱敏再分析。`,
        '仍要继续', false);
      if (!ok) { $('btnDesensitize').click(); return; }
    }

    // 3. 解析
    let workText = raw;
    let parsed = Parser.parseChat(workText);
    if (!parsed.messages.length) {
      toast('未识别到「我：/对方：」格式，请检查后重试');
      return;
    }
    if (parsed.messages.length > 200) {
      toast('样本较长，仅分析最近 200 条');
      workText = workText.split(/\r?\n/).slice(-240).join('\n');
      parsed = Parser.parseChat(workText);
    }

    state.anonymous = anonymous;
    state.ctx = {
      scene: state.scene, relation: state.relation, goal: state.goal,
      bg: $('bgInput').value.trim(), raw: workText
    };
    state.savedId = null;
    state.replyVariant = [0, 0, 0];

    // 4. 本地事实层：统计、风险分数、标签阈值全部本机计算
    const result = Analyzer.analyze(parsed, state.ctx);

    // 5. 加载动画 + 可选 AI 深度解读（失败自动回退本地结果）
    const useAI = Store.getSettings().aiRead !== false;
    const steps = useAI
      ? ['正在本地计算统计与风险分数…', '正在调用 Agnes AI 生成深度解读（通常 15–40 秒，上游繁忙时可能更久，请勿关闭页面）…', '正在核对引用原文…', '正在整理回复话术与行动清单…']
      : ['正在提取消息条数…', '正在计算回复延迟…', '正在识别负面词汇…', '正在比对情绪劳动…', '正在生成情绪画像…'];
    $('loadingOverlay').classList.remove('hidden');
    $('loadingExtra').classList.toggle('hidden', parsed.messages.length <= 120);
    const bar = $('loadingBar');
    bar.style.width = '12%';
    $('loadingStep').textContent = steps[0];
    await new Promise(r => setTimeout(r, 350));
    bar.style.width = '28%';

    if (useAI) {
      try {
        $('loadingStep').textContent = steps[1];
        bar.style.width = '45%';
        const ai = await cloudAnalyze(parsed, state.ctx, result);
        bar.style.width = '78%';
        $('loadingStep').textContent = steps[2];
        await new Promise(r => setTimeout(r, 250));
        mergeAiResult(result, ai, parsed);
        result.cloudFailed = false;
        bar.style.width = '92%';
        $('loadingStep').textContent = steps[3];
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        // 云端失败：保留本机规则结果，但明确标记为"降级内容"，结果页显示原因与一键重试
        result.engine = 'local';
        result.cloudFailed = true;
        state.cloudErr = (err && err.message) || '网络错误';
        setTimeout(() => toast('AI 解读暂不可用，已展示本机备用内容：' + state.cloudErr), 400);
      }
    } else {
      result.engine = 'local';
      result.cloudFailed = false;
      for (let i = 1; i < steps.length; i++) {
        await new Promise(r => setTimeout(r, 320));
        $('loadingStep').textContent = steps[i];
        bar.style.width = (28 + i * 16) + '%';
      }
    }
    bar.style.width = '100%';
    await new Promise(r => setTimeout(r, 200));
    $('loadingOverlay').classList.add('hidden');

    // 保存重生成上下文（供 /api/regen-reply 与 /api/regen-cbt 复用）
    state.lastParsed = parsed;
    state.lastCtx = {
      scene: state.ctx.scene,
      relation: state.ctx.relation,
      goal: state.ctx.goal,
      bg: state.ctx.bg,
      score: result.score,
      metrics: result.metrics,
      messages: parsed.messages.map(m => ({ speaker: m.speaker, time: m.time || null, text: m.text }))
    };

    state.result = result;

    // 6. 自动保存（非匿名且设置开启）
    if (!anonymous && Store.getSettings().saveRecord) {
      const rec = buildRecord(result);
      Store.add(rec);
      state.savedId = rec.id;
    }

    renderResult(result);
    showPage('result');
  }

  /* ============ Agnes AI 云端解读（本地统计为事实层） ============ */
  async function cloudAnalyze(parsed, context, localResult) {
    const controller = new AbortController();
    // 服务端最坏 3 次重试约 183 秒，前端必须等得到（旧值 85s 会在服务端仍在重试时误判失败）
    const timer = setTimeout(() => controller.abort(), 200000);
    try {
      const resp = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          scene: context.scene || '',
          relation: context.relation || '',
          goal: context.goal || '',
          bg: context.bg || '',
          score: localResult.score,
          metrics: localResult.metrics,
          messages: parsed.messages.map(m => ({
            speaker: m.speaker,
            time: m.time || null,
            text: m.text
          }))
        })
      });
      if (!resp.ok) {
        let msg = 'HTTP ' + resp.status;
        try { msg = (await resp.json()).error.message || msg; } catch (e) {}
        throw new Error(msg);
      }
      const data = await resp.json();
      const raw = String(data.content || '').trim()
        .replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      try {
        return JSON.parse(raw);
      } catch (e) {
        throw new Error('云端返回内容解析失败（可能因输出过长被截断），请点"重新调用云端生成"再试一次');
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('等待云端响应超时（已等待约 200 秒）：上游可能持续繁忙，请稍后点"重新调用云端生成"');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // 用 AI 内容替换解读层；统计/分数/风险等级/不对等分量保留本地结果
  function mergeAiResult(result, ai, parsed) {
    const norm = s => String(s || '').replace(/[\s，。！？、…,.!?~～]/g, '');
    const findWho = quote => {
      const q = norm(quote);
      if (!q) return '原文';
      for (const m of parsed.messages) {
        if (norm(m.text).includes(q.slice(0, Math.min(q.length, 12)))) {
          return m.speaker === 'me' ? '我' : '对方';
        }
      }
      return '原文';
    };
    const asArr = (v, n) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : []).slice(0, n || 5);
    const trimQ = s => String(s || '').slice(0, 46);

    if (ai.conclusion && typeof ai.conclusion === 'string' && ai.conclusion.trim()) {
      result.conclusion = ai.conclusion.trim().slice(0, 120);
    }
    if (Array.isArray(ai.portraits) && ai.portraits.length) {
      const tags = ai.portraits.slice(0, 5).map((p, i) => ({
        tone: ['neg', 'neu', 'pos'].includes(p.tone) ? p.tone : 'neu',
        title: String(p.title || '模式信号').slice(0, 14),
        evidence: asArr(p.evidence, 2).map(t => ({ who: findWho(t), text: trimQ(t) })),
        meaning: String(p.meaning || '').slice(0, 120),
        strength: 80 - i * 6
      })).filter(t => t.meaning || t.evidence.length);
      if (tags.length) result.tags = tags;
    }
    const rk = ai.replies;
    if (rk && typeof rk === 'object') {
      const kindMap = [['gentle', '温柔反击'], ['cold', '边界冷处理'], ['direct', '直接摊牌']];
      const built = kindMap.map(([key, kind], i) => {
        const g = rk[key];
        if (!g || !Array.isArray(g.variants) || !g.variants.length) return result.replies[i];
        return {
          kind,
          variants: asArr(g.variants, 3),
          fit: String(g.fit || result.replies[i].fit),
          reaction: String(g.reaction || result.replies[i].reaction),
          dont: String(g.dont || result.replies[i].dont)
        };
      });
      if (built.every(Boolean)) result.replies = built;
    }
    if (ai.cbt && typeof ai.cbt === 'object') {
      const c = ai.cbt;
      result.cbt = {
        autoThought: String(c.autoThought || result.cbt.autoThought),
        distortions: asArr(c.distortions, 4).length ? asArr(c.distortions, 4) : result.cbt.distortions,
        forEvidence: asArr(c.forEvidence, 4).length ? asArr(c.forEvidence, 4) : result.cbt.forEvidence,
        againstEvidence: asArr(c.againstEvidence, 5).length ? asArr(c.againstEvidence, 5) : result.cbt.againstEvidence,
        alternative: String(c.alternative || result.cbt.alternative),
        worth: asArr(c.worth, 5).length ? asArr(c.worth, 5) : result.cbt.worth
      };
    }
    if (Array.isArray(ai.actions) && ai.actions.length) {
      result.actions = asArr(ai.actions, 5).map(s => String(s).slice(0, 80));
    }
    result.engine = 'cloud';
  }

  /* ============ 云端解读失败后一键重试：重新调用 /api/analyze 并就地替换解读层 ============ */
  async function retryCloud() {
    if (!state.lastParsed || !state.result || !state.ctx) { toast('上下文已失效，请重新粘贴记录分析'); return; }
    const btn = $('btnRetryCloud');
    if (btn) { btn.disabled = true; btn.classList.add('loading'); btn.textContent = '正在调用云端…'; }
    $('loadingOverlay').classList.remove('hidden');
    $('loadingExtra').classList.add('hidden');
    $('loadingBar').style.width = '30%';
    $('loadingStep').textContent = '正在重新调用Agnes AI 生成深度解读…';
    try {
      const ai = await cloudAnalyze(state.lastParsed, state.ctx, state.result);
      $('loadingBar').style.width = '85%';
      mergeAiResult(state.result, ai, state.lastParsed);
      state.result.cloudFailed = false;
      state.cloudErr = '';
      // 云端返回的新行动清单同样重置当日勾选，避免错位
      Store.clearActionsDone();
      persistCurrent();
      renderResult(state.result);
      toast('云端解读已生成，话术 / CBT / 行动清单已按原文更新');
    } catch (err) {
      state.cloudErr = (err && err.message) || '网络错误';
      toast('云端仍不可用：' + state.cloudErr + '（可稍后再试，本机备用内容仍可使用）');
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.textContent = '重新调用云端生成'; }
      $('cloudFallbackReason').textContent = '（' + state.cloudErr + '）';
    } finally {
      $('loadingOverlay').classList.add('hidden');
    }
  }

  /* ============ 重新生成：单条回复话术（每次调用 API，输出不同） ============ */
  async function regenReply(i) {
    if (!state.lastCtx) { toast('无可用上下文，请重新分析后再试'); return; }
    if (state.regenInFlight.reply[i]) { toast('正在生成中，请稍候'); return; }
    const r = state.result;
    if (!r || !r.replies || !r.replies[i]) return;
    const rep = r.replies[i];
    const kindKey = rep.kind === '温柔反击' ? 'gentle' : rep.kind === '边界冷处理' ? 'cold' : 'direct';
    const btn = document.querySelector(`#replyList .reply-card:nth-child(${i + 1}) button[data-act="regen"]`);
    const textEl = $('replyText' + i);
    if (btn) { btn.disabled = true; btn.classList.add('loading'); btn.textContent = '正在生成…'; }
    state.regenInFlight.reply[i] = true;
    const oldText = textEl.textContent;
    textEl.textContent = oldText + '\n（正在重新生成…）';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 130000);
    try {
      const resp = await fetch('/api/regen-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ kind: kindKey, ...state.lastCtx })
      });
      if (!resp.ok) {
        let msg = 'HTTP ' + resp.status;
        try { msg = (await resp.json()).error.message || msg; } catch (e) {}
        throw new Error(msg);
      }
      const data = await resp.json();
      const text = String(data.content || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      if (!text || text.length < 4) throw new Error('生成内容为空');
      // 追加到 variants 池（不再循环取模，而是累加新内容）
      rep.variants.push(text);
      state.replyVariant[i] = rep.variants.length - 1;
      textEl.textContent = text;
      persistCurrent();
      toast('已生成新话术');
    } catch (err) {
      const emsg = (err && err.name === 'AbortError') ? '云端响应超时，请稍后重试' : ((err && err.message) || '网络错误');
      textEl.textContent = oldText;
      // 失败回退：仍允许本地 variants 循环
      if (rep.variants.length > 1) {
        state.replyVariant[i] = (state.replyVariant[i] + 1) % rep.variants.length;
        textEl.textContent = rep.variants[state.replyVariant[i]];
        toast('AI 暂不可用，已切换到本地话术：' + emsg);
      } else {
        toast('AI 暂不可用，请稍后重试：' + emsg);
      }
    } finally {
      clearTimeout(timer);
      state.regenInFlight.reply[i] = false;
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.textContent = '换一种说法'; }
    }
  }

  /* ============ 重新生成：CBT 全量内容（每次调用 API，输出不同） ============ */
  async function regenCbt() {
    if (!state.lastCtx) { toast('无可用上下文，请重新分析后再试'); return; }
    if (state.regenInFlight.cbt) { toast('正在生成中，请稍候'); return; }
    const r = state.result;
    if (!r) return;
    const btn = $('btnCbtRegen');
    if (btn) { btn.disabled = true; btn.classList.add('loading'); btn.textContent = '正在重新生成…'; }
    state.regenInFlight.cbt = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200000);
    try {
      const resp = await fetch('/api/regen-cbt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(state.lastCtx)
      });
      if (!resp.ok) {
        let msg = 'HTTP ' + resp.status;
        try { msg = (await resp.json()).error.message || msg; } catch (e) {}
        throw new Error(msg);
      }
      const data = await resp.json();
      const raw = String(data.content || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      const obj = JSON.parse(raw);
      const asArr = (v, n) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : []).slice(0, n || 5);
      r.cbt = {
        autoThought: String(obj.autoThought || r.cbt.autoThought),
        distortions: asArr(obj.distortions, 4).length ? asArr(obj.distortions, 4) : r.cbt.distortions,
        forEvidence: asArr(obj.forEvidence, 4).length ? asArr(obj.forEvidence, 4) : r.cbt.forEvidence,
        againstEvidence: asArr(obj.againstEvidence, 5).length ? asArr(obj.againstEvidence, 5) : r.cbt.againstEvidence,
        alternative: String(obj.alternative || r.cbt.alternative),
        worth: asArr(obj.worth, 5).length ? asArr(obj.worth, 5) : r.cbt.worth
      };
      renderCbt(r);
      persistCurrent();
      toast('已重新生成 CBT 急救内容');
    } catch (err) {
      const emsg = (err && err.name === 'AbortError') ? '云端响应超时，请稍后重试' : ((err && err.message) || '网络错误');
      toast('CBT 重新生成失败：' + emsg);
    } finally {
      clearTimeout(timer);
      state.regenInFlight.cbt = false;
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.textContent = '重新生成 CBT'; }
    }
  }

  /* ============ 重新生成：今日不内耗行动清单（每次调用 Agnes AI，基于原文重新分析） ============ */
  async function regenActions() {
    if (!state.lastCtx) { toast('无可用上下文，请重新分析后再试'); return; }
    if (state.regenInFlight.actions) { toast('正在生成中，请稍候'); return; }
    const r = state.result;
    if (!r) return;
    const btn = $('btnActionsRegen');
    if (btn) { btn.disabled = true; btn.classList.add('loading'); btn.textContent = '正在重新生成…'; }
    state.regenInFlight.actions = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 160000);
    try {
      // 把当前行动清单作为 previousActions 传入，让模型明确避开重复
      const resp = await fetch('/api/regen-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ ...state.lastCtx, previousActions: r.actions || [] })
      });
      if (!resp.ok) {
        let msg = 'HTTP ' + resp.status;
        try { msg = (await resp.json()).error.message || msg; } catch (e) {}
        throw new Error(msg);
      }
      const data = await resp.json();
      const raw = String(data.content || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      const obj = JSON.parse(raw);
      const arr = (Array.isArray(obj.actions) ? obj.actions : [])
        .filter(x => typeof x === 'string' && x.trim())
        .map(s => String(s).slice(0, 80));
      if (!arr.length) throw new Error('生成内容为空');
      r.actions = arr.slice(0, 5);
      // 已勾选状态因清单更新而重置（避免错位）
      Store.clearActionsDone();
      renderActions(r);
      persistCurrent();
      toast('已重新生成行动清单，可勾选完成项');
    } catch (err) {
      const emsg = (err && err.name === 'AbortError') ? '云端响应超时，请稍后重试' : ((err && err.message) || '网络错误');
      toast('行动清单重新生成失败：' + emsg);
    } finally {
      clearTimeout(timer);
      state.regenInFlight.actions = false;
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.textContent = '重新生成行动清单'; }
    }
  }

  $('btnAnalyze').onclick = () => runAnalysis(false);
  $('btnAnonymous').onclick = () => runAnalysis(true);
  $('btnBackHome').onclick = () => showPage('home');
  function buildRecord(result) {
    return {
      id: 'r' + Date.now() + Math.floor(Math.random() * 100),
      ts: Date.now(),
      name: `${state.ctx.scene} · ${result.risk}风险 · ${new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
      scene: state.ctx.scene,
      relation: state.ctx.relation,
      goal: state.ctx.goal,
      raw: state.ctx.raw,
      bg: state.ctx.bg,
      result
    };
  }

  /* ============ 结果渲染 ============ */
  function riskClass(r) { return { '低': 'low', '中': 'mid', '高': 'high', '危机': 'crisis' }[r]; }
  function ringColor(r) { return { '低': '#5b8a72', '中': '#c08a3e', '高': '#b5534f' }[r]; }

  function renderResult(r) {
    const m = r.metrics;

    // 结论卡
    const badge = $('riskBadge');
    badge.textContent = '风险：' + r.risk;
    badge.className = 'risk-badge ' + riskClass(r.risk);
    $('sampleTag').classList.toggle('hidden', !r.insufficient);
    $('conclusionText').textContent = r.conclusion;
    const src = $('engineSource');
    if (r.engine === 'cloud') {
      src.className = 'engine-source cloud';
      src.textContent = '解读由Agnes AI 生成 · 统计与风险分数在本机计算 · 非心理诊断';
    } else {
      src.className = 'engine-source local';
      src.textContent = '本地规则分析 · 统计与解读均在本机完成 · 非心理诊断';
    }

    // 云端解读失败降级条：明确告知用户当前是本机备用内容，并提供一键重试
    const fb = $('cloudFallback');
    if (fb) {
      const show = !!r.cloudFailed;
      fb.classList.toggle('hidden', !show);
      if (show) {
        $('cloudFallbackReason').textContent = state.cloudErr ? '（' + state.cloudErr + '）' : '';
        const btn = $('btnRetryCloud');
        btn.disabled = false;
        btn.classList.remove('loading');
        btn.textContent = '重新调用云端生成';
        btn.onclick = () => retryCloud();
      }
    }

    const CIRC = 326.7;
    const ring = $('ringFg');
    ring.style.stroke = ringColor(r.risk);
    ring.style.strokeDashoffset = CIRC;
    $('scoreNum').textContent = r.score;
    requestAnimationFrame(() => {
      setTimeout(() => { ring.style.strokeDashoffset = CIRC * (1 - r.score / 100); }, 60);
    });
    $('scoreNote').textContent = r.score <= 30
      ? '0–30 低：未见明显不对等模式'
      : r.score <= 60
        ? '31–60 中：存在情绪劳动倾斜，值得设立边界'
        : r.score <= 85
          ? '61–85 高：不对等模式明显，建议停止自证、执行边界'
          : '86–100：严重不对等，请优先保护自己并寻求支持';

    // 关键数据
    const cells = [
      [m.myShare + '%', '我的字数占比'],
      [`${m.myCount}/${m.otherCount}`, '消息条数(我/对方)'],
      [fmtDelay(m.otherAvg), '对方平均回复'],
      [String(m.hangings), '无回应收尾次数'],
      [String(m.negOther), '对方负面表达(次)'],
      [String(m.laborMe), '我的情绪劳动(次)']
    ];
    $('statGrid').innerHTML = cells.map(c =>
      `<div class="stat-cell"><div class="stat-num">${c[0]}</div><div class="stat-name">${c[1]}</div></div>`).join('');

    renderTags(r);
    renderCharts(r);
    renderReplies(r);
    renderCbt(r);
    renderActions(r);
    renderCalc(r);

    $('btnSaveReport').textContent = state.savedId ? '已保存（再存一次）' : '保存报告';
  }

  function renderTags(r) {
    $('tagList').innerHTML = r.tags.map(t => `
      <div class="tag-item ${t.tone}">
        <div class="tag-head">
          <span class="tag-pill">${t.tone === 'pos' ? '正向证据' : t.tone === 'neu' ? '中性信号' : '消耗信号'}</span>
          <span class="tag-title">${t.title}</span>
        </div>
        ${t.evidence.length ? `<div class="tag-evidence">${t.evidence.map(e =>
          `<div class="ev-quote"><span class="who">${e.who === '我' ? '我' : '对方'}：</span>${escapeHtml(e.text)}</div>`).join('')}</div>` : ''}
        <p class="tag-meaning">${t.meaning}</p>
      </div>`).join('');
  }

  function barRow(label, leftName, leftVal, rightName, rightVal, leftPct, rightPct, note) {
    return `<div class="chart-row">
      <div class="chart-label"><span>${label}</span><span>${note || ''}</span></div>
      <div class="bar-track">
        <div class="bar-me" style="width:${leftPct}%"></div>
        <div class="bar-other" style="width:${rightPct}%"></div>
      </div>
      <div class="bar-legend">
        <span><span class="legend-dot" style="background:#6d8f8c"></span>${leftName} ${leftVal}</span>
        <span><span class="legend-dot" style="background:#c9b35f"></span>${rightName} ${rightVal}</span>
      </div>
    </div>`;
  }

  function renderCharts(r) {
    const m = r.metrics;
    let html = '';
    html += barRow('字数比', '我', m.myChars + ' 字', '对方', m.otherChars + ' 字',
      m.myShare, 100 - m.myShare, `我 ${m.myShare}%｜对方 ${100 - m.myShare}%`);

    html += barRow('消息条数比', '我', m.myCount + ' 条', '对方', m.otherCount + ' 条',
      m.myCountShare, 100 - m.myCountShare,
      `发起 ${m.startByMe}/${m.sessions} 次`);

    const negMax = Math.max(m.negRate.me, m.negRate.other, 1);
    html += barRow('负面词汇密度（每百字）', '我', m.negRate.me + `（${m.negMe} 次）`, '对方', m.negRate.other + `（${m.negOther} 次）`,
      Math.round(m.negRate.me / negMax * 100), Math.round(m.negRate.other / negMax * 100));

    const laborMax = Math.max(m.laborMe, m.laborOther, 1);
    html += barRow('情绪劳动次数', '我', m.laborMe + ' 次', '对方', m.laborOther + ' 次',
      Math.round(m.laborMe / laborMax * 100), Math.round(m.laborOther / laborMax * 100));

    html += `<div class="chart-row">
      <div class="chart-text">
        <b>回复延迟：</b>${m.hasTimestamp
          ? `对方平均 ${fmtDelay(m.otherAvg)}，最长 ${fmtDelay(m.otherMax)}；${m.hangings} 次对话停在你的消息上（&gt;2 小时无回应）`
          : '记录中没有时间戳，无法计算。下次带上时间（如 [21:03]）可获得延迟指标。'}<br>
        <b>回避信号：</b>单字/极简回应 ${m.short} 条（占对方消息 ${m.shortRatio}%），模糊/终止表达 ${m.vague + m.shutdown} 次<br>
        <b>共情信号：</b>对方认可/关心 ${m.empathyOther} 次，主动提问 ${m.questionsOther} 次<br>
        <b>权力信号：</b>命令/威胁/愧疚诱导共 ${m.power} 次
      </div>
    </div>`;

    $('chartCard').innerHTML = html;
  }

  function renderCalc(r) {
    const rows = r.scoreParts.map(p =>
      p.value === null
        ? `<li>“${p.name}”无数据（未提供时间戳），其 ${p.weight * 100}% 权重已按比例分配给其余项</li>`
        : `<li>“${p.name}”分量 ${p.value} 分 × 权重 ${p.weight * 100}%</li>`).join('');
    $('calcDetail').innerHTML =
      `<b style="color:var(--ink-2)">不对等指数计算依据：</b><ul style="margin:6px 0 0;padding-left:18px;list-style:disc">${rows}</ul>` +
      `<div style="margin-top:6px">公式：0.30×字数差 + 0.25×延迟差 + 0.20×负面比差 + 0.15×情绪劳动差 + 0.10×收尾差，归一化至 0–100。</div>`;
  }

  function renderReplies(r) {
    state.replyVariant = [0, 0, 0];
    $('replyList').innerHTML = r.replies.map((rep, i) => `
      <div class="reply-card">
        <span class="reply-kind">${rep.kind}</span>
        <div class="reply-text" id="replyText${i}"></div>
        <div class="reply-meta">
          <b>适用场景：</b>${rep.fit}<br>
          <b>可能反应：</b>${rep.reaction}<br>
          <b>不要追加：</b>${rep.dont}
        </div>
        <div class="reply-ops">
          <button class="mini-btn" data-act="copy" data-i="${i}">复制话术</button>
          <button class="mini-btn" data-act="regen" data-i="${i}">换一种说法</button>
        </div>
      </div>`).join('');

    r.replies.forEach((rep, i) => {
      $('replyText' + i).textContent = rep.variants[0];
    });

    $('replyList').onclick = e => {
      const btn = e.target.closest('button');
      if (!btn || btn.disabled) return;
      const i = +btn.dataset.i;
      if (btn.dataset.act === 'copy') {
        copyText($('replyText' + i).textContent);
      } else if (btn.dataset.act === 'regen') {
        regenReply(i);
      }
    };
  }

  function renderCbt(r) {
    const c = r.cbt;
    $('cbtCard').innerHTML = `
      <div class="cbt-regen-bar">
        <button class="mini-btn cbt-regen-btn" id="btnCbtRegen">重新生成 CBT</button>
        <span class="cbt-regen-hint">每次调用Agnes AI 生成不同内容，基于原文重新分析</span>
      </div>
      <div class="cbt-section">
        <div class="cbt-q">1. 自动思维：你脑中反复出现的那句话</div>
        <div class="cbt-a">${escapeHtml(c.autoThought)}</div>
      </div>
      <div class="cbt-section">
        <div class="cbt-q">2. 认知歪曲</div>
        <div class="distort-tags">${c.distortions.map(d =>
          `<span class="distort-tag" title="${escapeHtml(d.split('：')[1] || '')}">${escapeHtml(d.split('：')[0])}</span>`).join('')}</div>
        <div class="cbt-a" style="margin-top:8px">${c.distortions.map(d => `· ${escapeHtml(d)}`).join('\n')}</div>
      </div>
      <div class="cbt-section">
        <div class="cbt-q">3. 支持这个想法的“证据”</div>
        <ul class="evidence-list">${c.forEvidence.map(x => `<li class="for">${escapeHtml(x)}</li>`).join('')}</ul>
      </div>
      <div class="cbt-section">
        <div class="cbt-q">4. 反对这个想法的证据 / 逻辑检验</div>
        <ul class="evidence-list">${c.againstEvidence.map(x => `<li class="against">${escapeHtml(x)}</li>`).join('')}</ul>
      </div>
      <div class="cbt-section">
        <div class="cbt-q">5. 替代性想法（更平衡、更保护自己）</div>
        <div class="cbt-a">${escapeHtml(c.alternative)}</div>
      </div>
      <div class="cbt-section">
        <div class="cbt-q">6. 自我价值证据清单（可编辑）</div>
        <ul class="worth-list" id="worthView">${c.worth.map(x =>
          `<li><span class="worth-check">✓</span><span>${escapeHtml(x)}</span></li>`).join('')}</ul>
        <button class="cbt-edit" id="btnWorthEdit">编辑清单</button>
      </div>`;

    const regenBtn = $('btnCbtRegen');
    if (regenBtn) regenBtn.onclick = () => regenCbt();

    $('btnWorthEdit').onclick = () => {
      const list = $('worthView');
      if (list.style.display === 'none') return;
      list.style.display = 'none';
      const ta = document.createElement('textarea');
      ta.className = 'worth-editor';
      ta.id = 'worthEditor';
      ta.value = c.worth.join('\n');
      list.after(ta);
      $('btnWorthEdit').textContent = '保存清单';
      $('btnWorthEdit').onclick = () => {
        c.worth = ta.value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 6);
        ta.remove();
        list.style.display = '';
        renderCbt(r);
        persistCurrent();
        toast('清单已更新');
      };
    };
  }

  function renderActions(r) {
    const done = new Set(Store.getActionsDone());
    $('actionList').innerHTML = r.actions.map((a, i) => `
      <li data-i="${i}" class="${done.has(a) ? 'done' : ''}">
        <span class="action-check">✓</span>
        <span class="action-text">${i + 1}. ${escapeHtml(a)}</span>
      </li>`).join('');
    $('actionDone').textContent = r.actions.filter(a => done.has(a)).length;
    $('actionPraise').textContent = done.size ? '今日不内耗 +' + done.size : '先勾选第一项开始';

    const regenBtn = $('btnActionsRegen');
    if (regenBtn) regenBtn.onclick = () => regenActions();

    $('actionList').onclick = e => {
      const li = e.target.closest('li');
      if (!li) return;
      const text = r.actions[+li.dataset.i];
      const nowDone = Store.toggleAction(text);
      li.classList.toggle('done', nowDone.includes(text));
      const n = r.actions.filter(a => nowDone.includes(a)).length;
      $('actionDone').textContent = n;
      $('actionPraise').textContent = n ? '今日不内耗 +' + n : '先勾选第一项开始';
      if (n === r.actions.length) toast('全部完成。今天到此为止，你做得够多了');
    };
  }

  function persistCurrent() {
    if (state.savedId) Store.update(state.savedId, { result: state.result });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  // 结果页 Tab
  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $('tab-' + tab.dataset.tab).classList.add('active');
    };
  });

  // 保存 / 重分析 / 删除
  $('btnSaveReport').onclick = () => {
    if (!state.result) return;
    if (state.savedId) {
      persistCurrent();
      toast('报告已更新');
    } else {
      const rec = buildRecord(state.result);
      Store.add(rec);
      state.savedId = rec.id;
      $('btnSaveReport').textContent = '已保存（再存一次）';
      toast('报告已保存在本浏览器');
    }
  };
  $('btnReanalyze').onclick = () => showPage('home');
  $('btnDeleteCurrent').onclick = async () => {
    if (!state.result) return;
    if (await openConfirm('删除本次记录', '将删除这份报告及保存的原文，删除后不可恢复。', '删除', true)) {
      if (state.savedId) Store.remove(state.savedId);
      state.result = null; state.savedId = null;
      showPage('home');
      toast('已删除');
    }
  };

  /* ============ 历史页 ============ */
  function renderHistory() {
    const scene = $('filterScene').value;
    const risk = $('filterRisk').value;
    let all = Store.list();
    if (scene) all = all.filter(r => r.scene === scene);
    if (risk) all = all.filter(r => r.result.risk === risk);

    $('historyEmpty').classList.toggle('hidden', all.length > 0);
    $('historyList').innerHTML = all.map(r => `
      <div class="history-item" data-id="${r.id}">
        <div class="hi-main">
          <div class="hi-title">
            <span class="hi-dot ${riskClass(r.result.risk)}"></span>
            <span class="hi-name">${escapeHtml(r.name)}</span>
          </div>
          <div class="hi-meta">
            ${r.relation} · 目标：${r.goal}
            ${r.result.insufficient ? '<span class="opaque-tag">样本不足</span>' : ''}
            ${r.result.score >= 61 ? '<span class="opaque-tag">不对等明显</span>' : ''}
          </div>
          <div class="hi-ops">
            <button class="mini-btn" data-op="open">查看</button>
            <button class="mini-btn" data-op="rename">重命名</button>
            <button class="mini-btn" data-op="delete">删除</button>
          </div>
        </div>
        <div class="hi-score">${r.result.score}</div>
      </div>`).join('');

    $('historyList').onclick = async e => {
      const item = e.target.closest('.history-item');
      const btn = e.target.closest('button');
      if (!item || !btn) return;
      const id = item.dataset.id;
      const rec = Store.get(id);
      if (!rec) return;
      if (btn.dataset.op === 'open') {
        state.result = rec.result;
        state.ctx = { scene: rec.scene, relation: rec.relation, goal: rec.goal, bg: rec.bg, raw: rec.raw };
        state.savedId = rec.id;
        state.anonymous = false;
        state.replyVariant = [0, 0, 0];
        // 回放时重建重生成上下文（重新解析原文以拿到 messages 数组）
        const reparsed = Parser.parseChat(rec.raw || '');
        state.lastParsed = reparsed;
        state.cloudErr = '';
        state.lastCtx = {
          scene: rec.scene, relation: rec.relation, goal: rec.goal, bg: rec.bg,
          score: rec.result.score, metrics: rec.result.metrics,
          messages: reparsed.messages.map(m => ({ speaker: m.speaker, time: m.time || null, text: m.text }))
        };
        $('chatInput').value = rec.raw || '';
        $('bgInput').value = rec.bg || '';
        $('bgCount').textContent = (rec.bg || '').length;
        setChips('scene', rec.scene);
        setChips('relation', rec.relation);
        setChips('goal', rec.goal);
        renderResult(rec.result);
        showPage('result');
      } else if (btn.dataset.op === 'rename') {
        const name = window.prompt('为这份报告命名', rec.name);
        if (name && name.trim()) { Store.update(id, { name: name.trim() }); renderHistory(); }
      } else if (btn.dataset.op === 'delete') {
        if (await openConfirm('删除报告', '本地原文与报告会一并删除，不可恢复。', '删除', true)) {
          Store.remove(id);
          if (state.savedId === id) { state.savedId = null; state.result = null; }
          renderHistory();
          toast('已删除');
        }
      }
    };
  }

  function setChips(group, value) {
    const g = document.querySelector(`.chips[data-group="${group}"]`);
    g.querySelectorAll('.chip').forEach(c =>
      c.classList.toggle('selected', c.dataset.value === value));
    state[group] = value;
  }

  $('filterScene').onchange = renderHistory;
  $('filterRisk').onchange = renderHistory;

  $('btnExport').onclick = () => {
    const data = Store.list().map(r => ({
      时间: new Date(r.ts).toLocaleString('zh-CN'),
      场景: r.scene, 关系: r.relation, 目标: r.goal,
      风险等级: r.result.risk, 不对等指数: r.result.score,
      结论: r.result.conclusion, 聊天记录: r.raw
    }));
    if (!data.length) { toast('暂无可导出的记录'); return; }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '情绪显微镜报告导出_' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  /* ============ 设置页 ============ */
  function loadSettings() {
    const s = Store.getSettings();
    $('setSave').checked = s.saveRecord;
    $('setMask').checked = s.maskHint;
    $('setAi').checked = s.aiRead !== false;
    $('setImprove').checked = s.improve;
  }
  $('setSave').onchange = e => {
    const s = Store.getSettings(); s.saveRecord = e.target.checked; Store.saveSettings(s);
  };
  $('setMask').onchange = e => {
    const s = Store.getSettings(); s.maskHint = e.target.checked; Store.saveSettings(s);
  };
  $('setAi').onchange = e => {
    const s = Store.getSettings(); s.aiRead = e.target.checked; Store.saveSettings(s);
    toast(e.target.checked ? '已开启 AI 深度解读（文本将经本机服务发送给Agnes AI）' : '已关闭，使用纯本地规则分析');
  };
  $('setImprove').onchange = e => {
    const s = Store.getSettings(); s.improve = e.target.checked; Store.saveSettings(s);
    if (e.target.checked) toast('当前版本数据仍只保存在本机');
  };
  $('btnWipeAll').onclick = async () => {
    if (await openConfirm('删除全部本地数据', '所有历史报告、勾选记录将从本浏览器清除，不可恢复。', '全部删除', true)) {
      Store.wipe();
      renderHistory();
      toast('本地数据已清空');
    }
  };

  /* ============ 危机弹窗：三个拨号动作 ============ */
  // 静默复制（不触发话术专用 toast）
  function copySilent(text) {
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (e) {}
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(fallback);
    } else fallback();
  }
  // 调起系统电话；num 为空时只打开拨号盘，不预填任何数字
  function openDialer(num) {
    const a = document.createElement('a');
    a.href = 'tel:' + (num || '');
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { a.remove(); } catch (e) {} }, 2000);
  }

  $('btnCrisisSafe').onclick = () => $('crisisModal').classList.add('hidden');

  // 1) 上方拨打：复制 12356 并跳转
  $('btnCall12356').onclick = () => {
    const num = '12356';
    copySilent(num);          // 必须在点击手势同步周期内发起
    openDialer(num);
    toast('已复制 12356，正在打开电话应用');
  };

  // 2) 下方拨打：随机复制 110 或 120 并跳转
  $('btnCall110120').onclick = () => {
    const num = Math.random() < 0.5 ? '110' : '120';
    copySilent(num);
    openDialer(num);
    toast('已复制 ' + num + '，正在打开电话应用');
  };

  // 3) 联系信任的人：只打开电话应用，不复制、不预填任何数字
  $('btnCrisisTrust').onclick = () => {
    openDialer('');
    toast('正在打开电话应用，请自行输入或选择联系人号码');
  };

  /* ============ 隐私说明 & 首次同意 ============ */
  $('privacyEntry').onclick = () => {
    openConfirm('聊天记录隐私说明',
      '1. 条数、字数、风险分数等统计在本机浏览器完成，不上传。\n2. 开启「AI 深度解读」时，聊天文本会经本机服务转发给Agnes AI 生成解读，可随时在设置中关闭。\n3. 删除记录会清除本设备数据，不可恢复；分享前请先脱敏。\n4. 出现自伤、暴力、威胁等内容时，优先展示安全干预信息。',
      '我知道了', false);
  };

  function showConsent() {
    $('confirmTitle').textContent = '使用前请阅读';
    $('confirmText').innerHTML =
      '这是一个基于文本模式识别的<b>自助工具，不是心理诊断或医疗、法律建议</b>。<br><br>' +
      '· 条数、字数、风险分数在本机计算；开启 AI 深度解读时，文本会经本机服务发送给Agnes AI，可在设置中关闭；<br>' +
      '· 请先删除姓名、电话、公司、地址等隐私；<br>' +
      '· 若你正处于暴力、威胁或自伤风险中，请立即点击弹窗中的热线求助（<b>12356</b> / 110 / 120）。';
    $('confirmOk').textContent = '同意并开始';
    $('confirmOk').className = 'btn primary';
    $('confirmCancel').classList.add('hidden');
    $('confirmModal').classList.remove('hidden');
    $('confirmOk').onclick = () => {
      Store.setAgreed();
      $('confirmModal').classList.add('hidden');
      // 还原通用 confirm 绑定
      $('confirmOk').onclick = () => closeConfirm(true);
      $('confirmCancel').classList.remove('hidden');
    };
  }

  /* ============ 底部导航 ============ */
  document.querySelectorAll('.tabbar-item').forEach(btn => {
    btn.onclick = () => {
      const p = btn.dataset.page;
      if (p === 'history') renderHistory();
      showPage(p);
    };
  });

  /* ============ 初始化 ============ */
  loadSettings();
  // 接收处理台转来的对话
  try {
    const pending = localStorage.getItem('emicro_pending_chat');
    if (pending) {
      localStorage.removeItem('emicro_pending_chat');
      $('chatInput').value = pending;
      setTimeout(() => toast('已从聊天记录处理台导入对话，可直接开始分析'), 400);
    }
  } catch (e) {}
  if (!Store.hasAgreed()) showConsent();
})();
