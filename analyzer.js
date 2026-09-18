/* 情绪显微镜 · 本地规则分析引擎
 * 严格按 PRD 4.1 数据规则计算；不做心理诊断。
 */
(function (global) {
  'use strict';

  const D = global.DICT;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const round = v => Math.round(v);
  const trim = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : (s || ''));

  /* ---------- 原文哈希播种 ----------
     本地规则引擎降级时，回复话术/CBT/行动清单不能所有样本共用一套固定模板。
     用聊天原文做确定性种子：同一份记录每次分析一致，不同记录必然得到不同的措辞组合。 */
  function hashSeed(str) {
    let h = 2166136261 >>> 0;
    str = String(str || '');
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffleRand(arr, rand) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  function countHits(text, words) {
    let n = 0;
    for (const w of words) {
      let idx = text.indexOf(w);
      while (idx !== -1) { n++; idx = text.indexOf(w, idx + w.length); }
    }
    return n;
  }

  function delayText(min) {
    if (min == null) return '无时间戳';
    if (min < 60) return round(min) + ' 分钟';
    if (min < 60 * 24) return (min / 60).toFixed(min % 60 === 0 ? 0 : 1) + ' 小时';
    return (min / 1440).toFixed(1) + ' 天';
  }

  function analyze(parsed, context) {
    const { messages, turns, sessions, hasTimestamp } = parsed;
    const scene = context.scene, relation = context.relation, goal = context.goal;

    // 基于原文+场景+目标的确定性随机源：本地降级输出也随原文变化
    const seedRaw = (context && context.raw)
      || (messages.map(m => m.speaker + ':' + m.text).join('|'));
    const rand = mulberry32(hashSeed(seedRaw + '|' + scene + '|' + relation + '|' + goal));
    const pickRand = pool => pool[Math.floor(rand() * pool.length)];
    const pickNRand = (pool, n) => shuffleRand(pool, rand).slice(0, n);

    /* ---------- 1. 基础统计 ---------- */
    const stats = {
      count: { me: 0, other: 0 },
      chars: { me: 0, other: 0 },
      neg: { me: 0, other: 0 },
      negCat: { me: {}, other: {} },
      labor: { me: 0, other: 0 },
      laborCat: { me: {}, other: {} },
      empathy: { me: 0, other: 0 },
      care: { me: 0, other: 0 },
      questions: { me: 0, other: 0 },
      vague: 0, shutdown: 0, short: 0,
      guilt: 0,
      power: 0
    };

    const quotes = {
      meNeg: [], otherNeg: [], meLabor: [], meFeeling: [],
      otherShort: [], otherVague: [], otherCare: [],
      otherEmpathy: [], myNeeds: [], gaps: [], otherThreat: []
    };

    function tally(speaker, text) {
      stats.count[speaker]++;
      stats.chars[speaker] += global.Parser.countChars(text);

      for (const key of Object.keys(D.NEGATIVE)) {
        const n = countHits(text, D.NEGATIVE[key].words);
        if (n) {
          stats.neg[speaker] += n;
          stats.negCat[speaker][key] = (stats.negCat[speaker][key] || 0) + n;
          if (speaker === 'other') quotes.otherNeg.push({ cat: key, text });
          else quotes.meNeg.push({ cat: key, text });
          if (speaker === 'other' && (key === 'threat' || key === 'command')) {
            stats.power += n;
            if (key === 'threat') quotes.otherThreat.push(text);
          }
        }
      }

      for (const key of Object.keys(D.LABOR)) {
        const n = countHits(text, D.LABOR[key].words);
        if (n) {
          stats.labor[speaker] += n;
          stats.laborCat[speaker][key] = (stats.laborCat[speaker][key] || 0) + n;
          if (speaker === 'me') quotes.meLabor.push({ cat: key, text });
        }
      }

      const recog = countHits(text, D.EMPATHY.recognize);
      const care = countHits(text, D.EMPATHY.care);
      const q = (text.match(/[?？]/g) || []).length;
      stats.empathy[speaker] += recog;
      stats.care[speaker] += care;
      stats.questions[speaker] += q;
      if (speaker === 'other') {
        if (recog) quotes.otherEmpathy.push(text);
        if (care) quotes.otherCare.push(text);
      }

      if (speaker === 'me') {
        if (D.MY_FEELINGS.some(w => text.includes(w))) quotes.meFeeling.push(text);
        if (/我(需要|希望|想要|不想|不愿意)|我的底线|我不接受/.test(text)) quotes.myNeeds.push(text);
      } else {
        const v = countHits(text, D.AVOID.vague);
        const sh = countHits(text, D.AVOID.shutdown);
        stats.vague += v; stats.shutdown += sh;
        if (v) quotes.otherVague.push(text);
        const bare = text.replace(/[\s，。！？、….!?,~～哈啊吧呢嘛的了]/g, '');
        if (D.SHORT_REPLIES.some(w => text.trim() === w) || bare.length <= 1) {
          stats.short++;
          if (quotes.otherShort.length < 4) quotes.otherShort.push(text.trim());
        }
        const g = countHits(text, D.GUILT);
        stats.guilt += g; stats.power += g;
        if (g) quotes.otherNeg.push({ cat: 'guilt', text });
      }
    }

    messages.forEach(m => tally(m.speaker, m.text));

    /* ---------- 2. 发起 / 收尾 ---------- */
    const startBy = { me: 0, other: 0 };
    const endBy = { me: 0, other: 0 };
    sessions.forEach(s => {
      if (s[0]) startBy[s[0].speaker]++;
      if (s[s.length - 1]) endBy[s[s.length - 1].speaker]++;
    });
    // 已读不回代理指标：以我方收尾、且之后 >2 小时无回应的会话
    const hangings = endBy.me;

    /* ---------- 3. 回复延迟 ---------- */
    function delaysFor(speaker) {
      const arr = [];
      for (let i = 1; i < turns.length; i++) {
        if (turns[i].speaker !== speaker || turns[i - 1].speaker === speaker) continue;
        if (turns[i].startMinute != null && turns[i - 1].endMinute != null) {
          const d = turns[i].startMinute - turns[i - 1].endMinute;
          if (d >= 0 && d <= 60 * 72) arr.push(d);
        }
      }
      return arr;
    }
    const otherDelays = delaysFor('other');
    const myDelays = delaysFor('me');
    const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const otherAvg = avg(otherDelays), myAvg = avg(myDelays);
    const otherMax = otherDelays.length ? Math.max.apply(null, otherDelays) : null;

    /* ---------- 4. 共情缺口：我表达感受 → 对方下一条 ---------- */
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].speaker !== 'me') continue;
      if (!D.MY_FEELINGS.some(w => messages[i].text.includes(w))) continue;
      for (let j = i + 1; j < messages.length && j <= i + 3; j++) {
        if (messages[j].speaker === 'me') break;
        const t = messages[j].text;
        const ack = D.EMOTION_ACK.some(w => t.includes(w)) || /[?？]/.test(t) || global.Parser.countChars(t) >= 15;
        if (!ack) quotes.gaps.push({ mine: messages[i].text, reply: t });
        break;
      }
    }

    /* ---------- 4.5 内容锚点：为本地降级输出找"逐字原文"
       临床缺口检测只认明确情绪词，覆盖面窄；这里放宽到负向评价/实质发言/需求句，
       用于让自动思维、替代想法、价值证据、行动清单必然引用本次对话原文 ---------- */
    const myMsgTexts = messages.filter(m => m.speaker === 'me').map(m => m.text.replace(/\s+/g, ' ').trim());
    const mySubstantive = myMsgTexts
      .filter(t => global.Parser.countChars(t) >= 6)
      .sort((a, b) => b.length - a.length)[0] || '';
    const contentQuote = {
      neg: quotes.otherNeg[0] ? trim(String(quotes.otherNeg[0].text || quotes.otherNeg[0]).replace(/\s+/g, ' '), 20) : '',
      mine: quotes.gaps[0]
        ? String(quotes.gaps[0].mine).replace(/\s+/g, ' ').trim()
        : (quotes.myNeeds[0]
          || myMsgTexts.find(t => D.MY_FEELINGS.some(w => t.includes(w)))
          || mySubstantive),
      need: quotes.myNeeds[0] ? trim(String(quotes.myNeeds[0]).replace(/\s+/g, ' '), 22) : ''
    };

    /* ---------- 5. 派生比例 ---------- */
    const totalChars = stats.chars.me + stats.chars.other;
    const totalCount = stats.count.me + stats.count.other;
    const myShare = totalChars ? stats.chars.me / totalChars : 0.5;
    const myCountShare = totalCount ? stats.count.me / totalCount : 0.5;
    const negRate = {
      me: stats.chars.me ? stats.neg.me / stats.chars.me * 100 : 0,
      other: stats.chars.other ? stats.neg.other / stats.chars.other * 100 : 0
    };
    const otherShortRatio = stats.count.other ? stats.short / stats.count.other : 0;

    /* ---------- 6. 不对等指数分量（PRD 4.1） ---------- */
    const wordScore = clamp((myShare - 0.5) / 0.5 * 100, 0, 100);

    let delayScore = null;
    if (hasTimestamp && otherAvg != null) {
      const level = Math.min(otherAvg / 360, 1) * 60;                 // 均回 6 小时→满分此项
      const asym = myAvg == null ? 15 : clamp((otherAvg - myAvg) / Math.max(otherAvg, 1), 0, 1) * 25;
      const hang = Math.min(hangings / 3, 1) * 15;
      delayScore = clamp(level + asym + hang, 0, 100);
    }

    const negScore = clamp((negRate.other - negRate.me) / 6 * 100, 0, 100);

    const laborTotal = stats.labor.me + stats.labor.other;
    const laborAsym = laborTotal ? clamp((stats.labor.me - stats.labor.other) / laborTotal, 0, 1) : 0;
    const laborFreq = clamp(stats.labor.me / 8, 0, 1);
    const laborScore = clamp(50 * laborAsym + 50 * laborFreq, 0, 100);

    const closeScore = sessions.length ? hangings / sessions.length * 100 : 0;

    const parts = [
      { name: '字数差', value: wordScore, weight: 0.30 },
      { name: '延迟差', value: delayScore, weight: 0.25 },
      { name: '负面比差', value: negScore, weight: 0.20 },
      { name: '情绪劳动差', value: laborScore, weight: 0.15 },
      { name: '收尾差', value: closeScore, weight: 0.10 }
    ];
    const usable = parts.filter(p => p.value !== null);
    const wSum = usable.reduce((s, p) => s + p.weight, 0);
    let score = 0;
    usable.forEach(p => { score += p.value * (p.weight / wSum); });
    score = round(clamp(score, 0, 100));
    parts.forEach(p => { if (p.value !== null) p.value = round(p.value); });

    const risk = score <= 30 ? '低' : score <= 60 ? '中' : score <= 85 ? '高' : '高';

    /* ---------- 7. 情绪画像标签 ---------- */
    const tags = [];
    const addTag = (tone, title, evidence, meaning, strength) =>
      tags.push({ tone, title, evidence, meaning, strength });

    const q = (who, text) => ({ who, text: trim(text, 46) });
    const firstQ = (arr, who) => arr.length ? [q(who, arr[0].text || arr[0])] : [];

    // 7.1 权力压制
    if (stats.power >= 2 || (stats.negCat.other.command || 0) >= 2) {
      const ev = [];
      if (quotes.otherThreat.length) ev.push(q('对方', quotes.otherThreat[0]));
      const cmd = quotes.otherNeg.find(x => x.cat === 'command' || x.cat === 'guilt');
      if (cmd) ev.push(q('对方', cmd.text));
      addTag('neg', '权力压制信号',
        ev,
        `记录中命令/威胁/愧疚诱导类表达共 ${stats.power} 次。这类表达把问题定义权交给对方，压缩你的协商空间。倾向判断，不代表人的全部。`,
        90);
    }

    // 7.2 贬低/阴阳
    const bel = (stats.negCat.other.belittle || 0) + (stats.negCat.other.sarcasm || 0);
    if (bel >= 2) {
      const ev = quotes.otherNeg.filter(x => x.cat === 'belittle' || x.cat === 'sarcasm')
        .slice(0, 2).map(x => q('对方', x.text));
      addTag('neg', '贬低与阴阳倾向',
        ev,
        `识别到贬低/冷嘲 ${bel} 次。用评价代替事实，会让被评价方持续自我怀疑。注意区分“就事论事的批评”和“对人的否定”。`,
        80 + bel * 2);
    }

    // 7.3 情绪未被接住
    if (quotes.gaps.length) {
      const g = quotes.gaps[0];
      addTag('neg', '情绪表达未被接住',
        [q('我', g.mine), q('对方', g.reply)],
        `你表达难受后，对方下一条没有回应感受，而是反驳、单字或转移。共出现 ${quotes.gaps.length} 次。反复如此，人会习惯性先自我审查。`,
        85);
    }

    // 7.4 高回避
    if (otherShortRatio >= 0.25 || stats.vague + stats.shutdown >= 2) {
      const ev = [];
      if (quotes.otherShort.length) ev.push(q('对方', quotes.otherShort[0]));
      if (quotes.otherVague.length) ev.push(q('对方', quotes.otherVague[0]));
      addTag('neg', '高回避倾向',
        ev,
        `对方单字/极简回应占 ${round(otherShortRatio * 100)}%，模糊或终止类表达 ${stats.vague + stats.shutdown} 次。回避不等于你做错了什么，它是对方处理冲突的方式。`,
        70 + round(otherShortRatio * 20));
    }

    // 7.5 延迟失联
    if (delayScore >= 55) {
      addTag('neg', '延迟回应与失联感',
        [],
        `对方平均 ${delayText(otherAvg)} 才回复，最长 ${delayText(otherMax)}，${hangings} 次对话停在你发出的消息上。注意：延迟本身可能有客观原因，模式才是信号。`,
        65);
    }

    // 7.6 自证循环
    const explainN = (stats.laborCat.me.explain || 0) + (stats.laborCat.me.confirm || 0)
      + (stats.laborCat.me.esteem || 0);
    if (explainN >= 3) {
      const ev = quotes.meLabor
        .filter(x => ['explain', 'confirm', 'esteem', 'apology'].includes(x.cat))
        .slice(0, 2).map(x => q('我', x.text));
      addTag('neg', '自证与反复确认循环',
        ev,
        `你有 ${explainN} 次解释、确认或自我否定表达，而核心需求未因此被讨论。自证的成本由你承担，问题却没有推进。`,
        60 + explainN * 3);
    }

    // 7.7 单边输出
    if (wordScore >= 35 || myCountShare >= 0.68) {
      const longest = messages.filter(m => m.speaker === 'me')
        .reduce((a, b) => (b.text.length > (a ? a.text.length : 0) ? b : a), null);
      addTag('neg', '沟通输出单边倾斜',
        longest ? [q('我', longest.text)] : [],
        `你贡献了 ${round(myShare * 100)}% 的字数与 ${round(myCountShare * 100)}% 的消息条数，且 ${startBy.me}/${sessions.length} 次由你发起。长期单向输出，是情绪内耗的直接来源之一。`,
        40 + wordScore * 0.4);
    }

    // 7.8 情绪劳动单边
    if (laborScore >= 40) {
      const ev = quotes.meLabor.slice(0, 2).map(x => q('我', x.text));
      addTag('neg', '情绪劳动单边承担',
        ev,
        `道歉、解释、讨好、安抚类表达：你 ${stats.labor.me} 次，对方 ${stats.labor.other} 次。维护对话温度的工作主要由你完成。`,
        laborScore * 0.8);
    }

    // ---- 正向 / 中性标签 ----
    const otherEmpathyTotal = stats.empathy.other + stats.care.other + stats.questions.other;
    if (otherEmpathyTotal >= 3 && quotes.gaps.length === 0) {
      const ev = [];
      if (quotes.otherCare.length) ev.push(q('对方', quotes.otherCare[0]));
      else if (quotes.otherEmpathy.length) ev.push(q('对方', quotes.otherEmpathy[0]));
      addTag('pos', '存在共情互动',
        ev,
        `记录中识别到认可、具体关心或提问共 ${otherEmpathyTotal} 次，你表达感受时有被回应。保留这些正向证据，避免非黑即白地概括整段关系。`,
        30);
    }
    if (score < 30) {
      addTag('pos', '互动总体对等',
        [],
        `字数、回应频率与负面表达均未出现明显倾斜。单次样本不能代表整段关系，若你仍然难受，值得继续观察具体事件而非逼自己“别计较”。`,
        20);
    }

    tags.sort((a, b) => b.strength - a.strength);
    const finalTags = tags.filter(t => t.strength >= 50).slice(0, 5);
    if (finalTags.length < 3) {
      // 补足 3 个：弱信号以中性方式呈现
      if (bel >= 1) {
        const x = quotes.otherNeg.find(x => x.cat === 'belittle' || x.cat === 'sarcasm');
        finalTags.push({ tone: 'neu', title: '偶发评价性表达', evidence: [q('对方', x.text)],
          meaning: '出现 1 次贬低/冷嘲，单次可能是情绪失控，是否构成模式要看是否反复出现。', strength: 30 });
      }
      if (stats.labor.me >= 2 && !finalTags.some(t => t.title.includes('情绪劳动'))) {
        finalTags.push({ tone: 'neu', title: '你承担了较多解释', evidence: firstQ(quotes.meLabor, '我'),
          meaning: `样本中你有 ${stats.labor.me} 次解释/安抚表达。解释本身不是错，关键是它有没有换来对问题本身的讨论。`, strength: 28 });
      }
      if (finalTags.length < 3) {
        finalTags.push({ tone: 'neu', title: '样本信号较弱', evidence: [],
          meaning: '这段记录里没有出现稳定的不对等模式。如果难受感来自更长时间的积累，建议提供最近一次完整冲突记录再分析。', strength: 10 });
      }
    }

    /* ---------- 8. 一句话结论 ---------- */
    let conclusion;
    const negTags = finalTags.filter(t => t.tone === 'neg');
    if (risk === '高' && negTags.length) {
      conclusion = `样本显示：这段对话中出现 ${negTags.map(t => t.title.replace(/信号|倾向|感/g, '')).slice(0, 2).join('、')}等模式，你承担了 ${round(myShare * 100)}% 的输出和 ${stats.labor.me} 次情绪劳动，而回应主要由回避或评价构成。事实如此，不是你“太敏感”。`;
    } else if (risk === '中') {
      const focus = negTags[0] ? negTags[0].title : '情绪劳动倾斜';
      conclusion = `样本显示：双方有来有回，但存在“${focus}”——你输出与解释的比例高于对方，情绪劳动向你倾斜。还不到下结论定性关系的程度，但值得明确边界并继续观察。`;
    } else if (finalTags.some(t => t.title === '互动总体对等')) {
      conclusion = `样本显示：这段对话的输出量、回应频率基本对等，未识别到稳定的压制或回避模式。单段记录不代表全部，难受时优先核对具体事件。`;
    } else {
      conclusion = `样本显示：有轻度不对等信号（如 ${finalTags[0].title}），但证据强度有限。它更像一个提醒：观察模式，而不是立刻给关系定性。`;
    }

    /* ---------- 9. 高姿态回复（多变体） ----------
       本地降级时：每条话术池扩展到 5-7 条并按原文哈希洗牌，且尽量锚定对方具体原话，
       不同聊天记录看到的首条话术不同 */
    const lastOther = [...messages].reverse().find(m => m.speaker === 'other');
    const anchor = lastOther ? `“${trim(lastOther.text.replace(/\n/g, ' '), 24)}”` : '这段对话';
    const negRaw = quotes.otherNeg.find(x => x.cat !== 'guilt');
    const negQuote = negRaw ? `“${trim(negRaw.text.replace(/\n/g, ' '), 20)}”` : anchor;
    const isWork = scene === '职场';

    const gentleWorkAnchored = [
      `${anchor}——对事我可以复盘改进，但我不接受对人的评价。如果有具体问题，请列出事项与预期标准，我们按事情沟通。`,
      `${negQuote}这句话我不接。复盘可以，但请把事项、标准、截止时间列清楚，我们只谈这三项。`
    ];
    const gentleWorkGeneric = [
      `我收到你的反馈。区分一下：工作上的具体问题我负责改，带贬损的表达方式我不接受。后续我们对事沟通。`,
      `这件事我可以配合推进，也会承担我该承担的部分。同时我需要明确：沟通请基于事实和数据，不用指责性措辞。`,
      `我可以就结果负责，但不接受情绪性评价。后续这类消息我不再回应，请走书面事项沟通。`,
      `先把结论放前面：事情我配合改，对人的定义我不接。我们约 15 分钟，只过具体事项。`
    ];
    const gentleLoveAnchored = [
      `${anchor}——我以前看到这种话会立刻解释自己。现在我想说事实：这段对话里大多是我在主动沟通，我的感受没有被回应。我希望我们就事本身谈一次。`,
      `${negQuote}——这句话让我停了很久。我不需要你认错，我需要你回应我说的事情本身。`
    ];
    const gentleLoveGeneric = [
      `我理解你有你的节奏。但连续很久才回、或只用单字和“再说吧”，会让我觉得我的需求不值得被认真对待。约个时间说清楚，可以吗？`,
      `我不想争对错。我只明确一件事：我表达需求不等于事多，你可以不接受，但请正面回应，而不是回避或否定我的感受。`,
      `我不再追问你为什么不回。我只说一次：我的感受是真的，敷衍和单字回应我会直接当作拒绝沟通。`,
      `我把话说具体：这段时间主动开口的人是我，结束对话的人总是你。我们要不要继续，先看这个事实怎么改。`
    ];

    const coldAnchored = [
      `${anchor}——这条我先不回。等你愿意正面沟通时再说。`,
      `你这句${negQuote}我收到了，但不解释也不追问。冷静后请直接回应问题本身。`
    ];
    const coldGeneric = [
      `这个话题先到这里。等能就事论事的时候，我们再谈。`,
      `我看到了，今天先不回复。冷静之后请直接回应问题本身。`,
      `嗯。我不接受这种沟通方式，先不展开。`,
      `话先停在这。你想谈具体问题时，发事项，不发情绪。`,
      `我先撤了。不是赌气，是这种回复方式没有信息量。`,
      `不追问了。等你有完整答复再说。`
    ];

    const showdownWorkAnchored = [
      `${anchor}——把话说明确：第一，我对具体工作结果负责，不接受贬低和命令式沟通；第二，请给我书面的改进事项与标准；第三，再出现人身评价，我会按公司流程向上反馈并留痕。`,
      `${negQuote}我视为越界沟通。下次再出现，我会当场中止对话并邮件留痕；具体工作事项我照常推进。`
    ];
    const showdownWorkGeneric = [
      `我需要稳定、对事的沟通方式。给彼此一周：你指出具体事项，我执行改进；情绪性评价我不再回应，也不会再自证。`,
      `这是我的底线：工作问题走流程、看结果；人格评价和威胁性措辞到此为止。继续这样，我会保留记录并通过正式渠道处理。`,
      `三件事书面确认：评价标准、责任边界、升级路径。在此之前，口头指责我不回应。`
    ];
    const showdownLoveAnchored = [
      `${anchor}——我需要的是稳定的回应和基本的尊重。如果继续用回避或打压的方式处理问题，我会按我的底线重新评估这段关系。`,
      `${negQuote}这类话到此为止。再收到一次，我会中断对话 24 小时；一周内没有正面沟通，我按自己的决定走。`
    ];
    const showdownLoveGeneric = [
      `说清楚三件事：我不接受贬低和命令；我愿意一起解决具体问题；再出现一次长时间冷处理，我会暂停联系，把注意力收回给自己。`,
      `这段时间的沟通让我持续内耗。我给彼此一周：你正面回应问题，我停止反复解释。一周后没有变化，我执行已经想好的决定。`,
      `我不吵也不猜了。我的底线就两条：不接人格评价，不要已读不回。能不能做到，下周用行为回答。`
    ];

    // 首条永远取"锚点句"（含对方原话，不同原文必然不同）；第 2、3 条从通用句池按原文哈希抽取
    const gentleVariants = [pickRand(isWork ? gentleWorkAnchored : gentleLoveAnchored)]
      .concat(pickNRand(isWork ? gentleWorkGeneric : gentleLoveGeneric, 2));
    const coldVariants = [pickRand(coldAnchored)].concat(pickNRand(coldGeneric, 2));
    const showdownVariants = [pickRand(isWork ? showdownWorkAnchored : showdownLoveAnchored)]
      .concat(pickNRand(isWork ? showdownWorkGeneric : showdownLoveGeneric, 2));

    const replies = [
      {
        kind: '温柔反击',
        variants: gentleVariants,
        fit: isWork
          ? '适用于：你仍想维持协作关系，需要在不激化上下级矛盾的前提下立住边界。建议工作时间发送，只陈述事实与规则。'
          : '适用于：你还想给沟通一次机会，目标是“被认真对待”而不是赢。发送前先确认对方无暴力倾向。',
        reaction: '可能的反应：继续回避、反过来说你“太较真/太敏感”，或短暂认真回应。任何一种都是信息——看行为，不看承诺。',
        dont: '不要追加小作文、不要解释“我为什么有资格提需求”、不要连发三条以上、不要撤回。'
      },
      {
        kind: '边界冷处理',
        variants: coldVariants,
        fit: '适用于：你已多次解释、情绪被拖着走；此刻目标是停止情绪劳动，而不是解决问题。可只读后回复。',
        reaction: '可能的反应：对方不适应突然的断供，转而试探或指责“你什么态度”。不接这个钩子。',
        dont: '不要补一句“你别生气”、不要解释你为什么冷淡、不要在 2 小时内主动打破沉默。'
      },
      {
        kind: '直接摊牌',
        variants: showdownVariants,
        fit: '适用于：你已确认模式反复出现，并想好了可执行的后果。底线必须是你真的会执行的事，否则只写不做会削弱边界。',
        reaction: '可能的反应：短暂收敛后故态复萌、倒打一耙、或真正开始谈判。按一周后的行为做决定，而不是当场的态度。',
        dont: '不要写你做不到的后果、不要用“你是不是不爱我了/你信不信我离职”试探、不要在深夜或冲突峰值发送。'
      }
    ];

    /* ---------- 10. CBT（自动思维/替代想法/价值清单均按原文哈希轮换） ---------- */
    const autoThoughtPools = {
      '想确认是否内耗': [
        '“是不是我太敏感了，也许真的是我做得不够好。”',
        '“他这么冷淡，一定是我哪里出了问题。”',
        '“只要我再懂事一点，他就不会这样对我了。”'
      ],
      '想沟通': [
        '“只要我解释得再清楚一点、态度再好一点，他总会理解我。”',
        '“他没回，一定是我哪句话说错了，我得赶紧补一句。”',
        '“我再多说一点，他总能看到我的诚意。”'
      ],
      '想反击': [
        '“我必须证明错的是他，不然这段关系里我就输了。”',
        '“这次不顶回去，以后他更不把我当回事。”',
        '“我要说赢他，不然这些委屈就白受了。”'
      ],
      '想离开': [
        '“离开是不是说明我太绝情？也许再忍忍就好了。”',
        '“是不是我再坚持一下，他就会变？”',
        '“走了就证明我是那个放弃的人，我不能当这个人。”'
      ]
    };
    let autoThought = pickNRand(autoThoughtPools[goal] || autoThoughtPools['想确认是否内耗'], 1)[0];
    // 自动思维锚定本次原文：缺口原话 > 对方负向原话 > 我的实质发言，保证不同记录不同
    if (quotes.gaps.length) {
      autoThought = `“我说了‘${trim(quotes.gaps[0].mine.replace(/\n/g, ' '), 18)}’，他那样回，是不是我不值得被认真对待。”`;
    } else if (contentQuote.neg) {
      autoThought = `“他一句‘${contentQuote.neg}’，我就开始想：是不是我哪里真的不够好。”`;
    } else if (contentQuote.mine) {
      autoThought = `“我说了‘${trim(contentQuote.mine, 18)}’他却那样回应，会不会是我要求太多了。”`;
    }

    const distortions = [];
    if (delayScore >= 40 || stats.vague + stats.shutdown >= 2)
      distortions.push('读心术：把“回复慢/单字”直接翻译成“他讨厌我、我不重要”——对方没有说出口的动机，你无法确知。');
    if ((stats.laborCat.me.apology || 0) + (stats.laborCat.me.esteem || 0) >= 1 || goal === '想确认是否内耗')
      distortions.push('个人化：把对方的回避与情绪一律归因于“我不够好”，忽略其沟通习惯、压力与选择权。');
    if (goal === '想反击')
      distortions.push('非黑即白：把关系简化成“谁对谁错、谁输谁赢”，忽略了“我可以选择如何被对待”这第三条路。');
    if (goal === '想离开')
      distortions.push('灾难化：把结束或疏远想象成无法承受的崩塌，实际上生活半径、社交与能力不会随一次决定消失。');
    if (!distortions.length)
      distortions.push('情绪推理：“我感觉很糟，所以一定是出了大问题/一定是我的错”——情绪是信号，不是证据。');

    const forEvidence = [];
    quotes.gaps.slice(0, 1).forEach(g =>
      forEvidence.push(`你说“${trim(g.mine, 30)}”，对方回应“${trim(g.reply, 20)}”——感受确实没有被接住。`));
    if (stats.short) forEvidence.push(`对方有 ${stats.short} 条单字/极简回应，占其消息 ${round(otherShortRatio * 100)}%。`);
    if (otherAvg != null && otherAvg >= 120)
      forEvidence.push(`对方平均 ${delayText(otherAvg)} 回复，${hangings} 次对话停在你的消息上。`);
    const otherNegSample = quotes.otherNeg.filter(x => x.cat !== 'guilt')[0];
    if (otherNegSample) forEvidence.push(`出现“${trim(otherNegSample.text, 30)}”这类评价性表达。`);
    if (!forEvidence.length) forEvidence.push('记录中没有支持“我很糟糕/全是我的错”这一想法的直接证据。');

    const againstEvidence = [];
    if (quotes.myNeeds.length)
      againstEvidence.push(`你明确表达过需求：“${trim(quotes.myNeeds[0], 34)}”——能说出需求，不是“事多”，是健康沟通能力。`);
    if (quotes.otherCare.length)
      againstEvidence.push(`对方也有过具体关心：“${trim(quotes.otherCare[0], 30)}”——关系不是单一颜色，这条证据防止非黑即白。`);
    if (quotes.otherEmpathy.length)
      againstEvidence.push(`对方曾回应过情绪：“${trim(quotes.otherEmpathy[0], 30)}”。`);
    const logicPool = [
      '逻辑检验：回复速度与措辞只证明对方当下的沟通方式，不能推导出“你的价值低”。',
      `逻辑检验：需要为双方的情绪负责的是两个人，情绪劳动你已承担了 ${stats.labor.me} 次。`,
      '逻辑检验：单字与回避是对方的行为选择，行为可以被观察和设限，但不能用来给你这个人打分。'
    ];
    againstEvidence.push(pickRand(logicPool));

    const alternativePool = [
      '“他的回应方式让我难受，这是事实；难受的原因是模式不对等，不等于我不够好。”',
      '“我不需要用更多解释换来重视。我能控制的是：说清需求、设定期限，然后按底线行动。”',
      '“这一次的记录只是切片。我可以继续观察行为，而不是逼自己立刻给关系或给自己定罪。”',
      '“他的单字和回避是他的沟通选择，我可以选择不再追着这个选择自我归因。”',
      '“难受不需要谁批准。我可以一边承认难受，一边不把它解释成‘我很差’。”'
    ];
    // 第一条替代想法永远锚定本次原文（需求句/缺口/负向评价），第二条从池里按哈希抽取
    let anchoredAlt = '';
    if (contentQuote.need) {
      anchoredAlt = `“我想要的是‘${contentQuote.need}’，这是具体的需求，不需要谁批准我才有资格提。”`;
    } else if (quotes.gaps.length) {
      anchoredAlt = `“我那句‘${trim(quotes.gaps[0].mine.replace(/\n/g, ' '), 18)}’没有被回应，只说明这次沟通断了，不说明我不值得。”`;
    } else if (contentQuote.neg) {
      anchoredAlt = `“‘${contentQuote.neg}’是他的评价，不是事实；我可以检查自己的行为，但不必认领这个人设。”`;
    } else if (contentQuote.mine) {
      anchoredAlt = `“我说‘${trim(contentQuote.mine, 18)}’是在解决问题，沟通没有效果不是我一个人的责任。”`;
    }
    const alternative = anchoredAlt
      ? anchoredAlt + '\n' + pickRand(alternativePool)
      : pickNRand(alternativePool, 2).join('\n');

    const worthPool = [
      `你在记录中 ${stats.labor.me} 次尝试修复与解释——你在为关系负责，这是能力，不是亏欠。`,
      '你能把对话粘贴出来做客观核对，而不是跟着情绪行动——自我觉察和延迟反应是稀缺能力。',
      '你的难受不需要谁批准。情绪是边界被触碰时发出的信号。',
      '你有权决定回复的节奏、沟通的地点和继续与否——主动权在你，不在等待框里。',
      '你没有在冲突里升级措辞、没有威胁对方——在情绪高点保持克制，是实打实的能力。',
      '你能区分“我想要被回应”和“我很差所以不配被回应”——前者是需求，后者不是事实。',
      '记录里你多次给了对方台阶，没有堵死沟通——你保留了解决问题的意愿。'
    ];
    const worthContent = [];
    if (quotes.myNeeds.length) {
      worthContent.push(`你清楚自己要什么（“${trim(quotes.myNeeds[0], 24)}”），知道自己需求的人不该被说成“难搞”。`);
    } else if (mySubstantive) {
      // 无明确需求句时，用本次记录里最实质的一句发言做锚点
      worthContent.push(`你能说出“${trim(mySubstantive, 24)}”这样具体的话，说明你在描述事实、尝试解决问题——这不是卑微，是能力。`);
    }
    const worth = worthContent.concat(pickNRand(worthPool, 5 - worthContent.length)).slice(0, 5);

    /* ---------- 11. 行动清单（结构固定：身体/边界/证据/目标/场景 各 1 条，具体条目按原文哈希轮换） ---------- */
    const bodyActions = [
      '离开屏幕 15 分钟：散步、拉伸或冷水洗脸，让身体先退出应激状态。',
      '现在喝一杯温水，做 3 分钟缓慢呼吸，把手机放到另一个房间。',
      '出门走 10 分钟，不戴耳机，只数路过的门牌号，先让身体离开等待状态。',
      '做一组拉伸或俯卧撑到微微出汗，把“等回复”的劲儿用掉。',
      '站起来做 10 次缓慢的耸肩放松，喝一大口水，闭眼两分钟。'
    ];
    const boundaryActions = [
      '把对方备注改为“观察对象”，设 2 小时计时器，期间不点开对话框。',
      '关闭该对话的消息通知 2 小时，把手机屏幕朝下放。',
      '写下此刻最想发的 3 句话存进备忘录，今天不发送。',
      '把“直接摊牌”话术复制到备忘录，48 小时后情绪平稳了再决定是否发送。',
      '取消该对话的置顶并静音，手机放到伸手够不到的位置，计时 1 小时。'
    ];
    const evidenceActions = [
      '给一位安全的朋友发：“我今天有点内耗，陪我聊 10 分钟就好。”',
      '拿一张纸分两列：“我能控制的”和“我控制不了的”，各写 3 条，只对左列行动。',
      '把这段记录里对方的原话和你的原话各抄 3 句到纸上，只读事实，不读脑补。',
      '写下这次你最想要的一个具体回应，标注：这是需求，不是乞讨。',
      '用语音备忘录给自己录 60 秒：只描述刚才发生了什么，不评价自己，录完不听。'
    ];
    const goalActions = goal === '想离开'
      ? ['写下“如果一周不变我会做的 3 个决定”，折好放抽屉，只当备份不宣布。',
         '把共同群聊和朋友圈入口收进文件夹 24 小时，减少反复查看。']
      : goal === '想反击'
        ? ['打开备忘录写一封不寄出的信，把最狠的话写在里面，写完关掉。',
           '把想反驳的点列成“事实-证据-请求”三列，只保留有证据的。']
        : goal === '想沟通'
          ? ['把想说的话缩到三句：事实、感受、请求，写在备忘录里，今晚不发。',
             '预设一个 20 分钟的沟通时间窗，时间一到就结束，不延长。']
          : ['设一个今晚 21:00 的闹钟，标题写“今天的观察到此为止”，响了就锁屏。',
             '记录今天每次点对话框的次数，只计数不评判，先看见习惯。'];
    const sceneActions = isWork
      ? ['把记录分成“具体事项”和“情绪评价”两列，本周只回应事项列，评价列不接话。',
         '用一句话写下你的岗位职责边界，贴在工位：哪些是我负责，哪些不是。',
         '把沟通全部转到书面工具，口头评价不接话，只回“请在工单里写清楚”。']
      : ['回顾近一个月：列出 2 次“好好沟通过”的时刻和 2 次“被回避”的时刻，用事实代替感觉做判断。',
         '给一位知道你们关系的朋友发记录截图，只问一句：“换你会怎么解读这几句？”',
         '把你们最近一次和平相处的场景写 3 行细节，存进备忘录当作对照样本。'];
    const evidenceAnchored = contentQuote.neg
      ? `把对方那句“${contentQuote.neg}”和你当时的回应各抄一遍到纸上，只读事实，不读脑补。`
      : (contentQuote.mine
        ? `重读你那句“${trim(contentQuote.mine, 20)}”之后的对话，只记录发生了什么，不给自己贴标签。`
        : '');
    const actions = [
      pickRand(bodyActions),
      pickRand(boundaryActions),
      evidenceAnchored || pickRand(evidenceActions),
      pickRand(goalActions),
      pickRand(sceneActions)
    ];

    /* ---------- 12. 汇总 ---------- */
    return {
      risk,
      score,
      conclusion,
      insufficient: parsed.rounds < 5 || totalCount < 10,
      metrics: {
        myChars: stats.chars.me, otherChars: stats.chars.other,
        myCount: stats.count.me, otherCount: stats.count.other,
        myShare: round(myShare * 100), myCountShare: round(myCountShare * 100),
        negRate: { me: round(negRate.me * 10) / 10, other: round(negRate.other * 10) / 10 },
        negMe: stats.neg.me, negOther: stats.neg.other,
        negCatOther: stats.negCat.other,
        laborMe: stats.labor.me, laborOther: stats.labor.other,
        laborCatMe: stats.laborCat.me,
        empathyOther: stats.empathy.other + stats.care.other,
        questionsOther: stats.questions.other,
        short: stats.short, shortRatio: round(otherShortRatio * 100),
        vague: stats.vague, shutdown: stats.shutdown,
        power: stats.power, guilt: stats.guilt,
        hangings, sessions: sessions.length,
        startByMe: startBy.me,
        otherAvg, otherMax, myAvg, hasTimestamp
      },
      scoreParts: parts,
      tags: finalTags,
      replies,
      cbt: { autoThought, distortions, forEvidence, againstEvidence, alternative, worth },
      actions,
      delayText
    };
  }

  global.Analyzer = { analyze };
})(window);
