// ==UserScript==
// @name         AI 对话转发器
// @name:en      AI Conversation Forwarder
// @namespace    https://github.com/qiduo-lab
// @version      0.5.0
// @author       七朵 / Qiduo
// @description  像微信合并转发一样：勾选 AI 对话里的几条消息，一键复制，粘贴给另一个 AI。全部在本地浏览器完成，不上传任何内容。
// @description:en Select messages in an AI chat like WeChat's "forward chat history", copy them with source and speaker labels, and paste into another AI. Runs entirely in your browser.
// @match        https://claude.ai/*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// @license      MIT
// @homepageURL  https://github.com/qiduo-lab/ai-conversation-forwarder
// @supportURL   https://github.com/qiduo-lab/ai-conversation-forwarder/issues
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '0.5.0';

  /* =====================================================================
   * 一、通用小工具（各平台适配都会用到）
   * ===================================================================*/

  function textLen(n) {
    return (n.textContent || '').trim().length;
  }

  // 不算按钮上的字
  function contentLen(n) {
    let len = textLen(n);
    n.querySelectorAll('button').forEach((b) => (len -= textLen(b)));
    return len;
  }

  // 只保留最外层的匹配（去掉嵌套在另一个匹配里面的）
  function topLevel(nodes, sel) {
    return nodes.filter((n) => !n.parentElement || !n.parentElement.closest(sel));
  }

  function visibleRect(n) {
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  }

  // 网页上不属于消息正文的东西：隐藏文字、折叠开关、思考过程、按钮等
  function isNoise(n) {
    if (n.classList.contains('acf-ui')) return true;
    if (n.getAttribute('aria-hidden') === 'true') return true;
    if (n.hasAttribute('aria-expanded')) return true; // 折叠/展开开关（如思考过程）
    const role = n.getAttribute('role');
    if (role === 'button' || role === 'toolbar' || role === 'menu') return true;
    const marks = (n.getAttribute('class') || '') + ' ' + (n.getAttribute('data-testid') || '');
    if (/sr-only|visually-hidden|screen-reader/i.test(marks)) return true;
    if (/think|reasoning/i.test(marks)) return true;
    try {
      const cs = getComputedStyle(n);
      // 注意：display:contents 的外壳本身不占位置，但里面的内容是看得见的，不能跳过
      if (cs.display === 'none') return true;
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
      if (cs.position === 'absolute' && cs.width === '1px' && cs.height === '1px') return true; // 给读屏软件用的隐藏文字
    } catch (e) { /* 忽略 */ }
    return false;
  }

  // 从 el 往上到 stop（不含）之间，有没有一层是杂质
  function insideNoise(el, stop) {
    for (let n = el; n && n !== stop; n = n.parentElement) {
      if (isNoise(n)) return true;
    }
    return false;
  }

  // 找输入框所在的那一块区域（操作栏要浮在它上方）
  function findComposerRect() {
    let best = null;
    let bestRect = null;
    document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]').forEach((n) => {
      if (n.closest('.acf-ui')) return;
      const r = visibleRect(n);
      if (!r || r.width < 200) return;
      if (!bestRect || r.bottom > bestRect.bottom) {
        best = n;
        bestRect = r;
      }
    });
    if (!best) return null;
    let cur = best;
    let curRect = bestRect;
    const maxW = Math.min(window.innerWidth * 0.95, 1100);
    for (let i = 0; i < 6 && cur.parentElement && cur.parentElement !== document.body; i++) {
      const pr = cur.parentElement.getBoundingClientRect();
      if (pr.height > 360 || pr.width > maxW) break;
      cur = cur.parentElement;
      curRect = pr;
    }
    return curRect;
  }

  /* =====================================================================
   * 二、平台适配：每个平台只回答四件事
   *     1. 哪些是用户消息、哪些是 AI 回复（按页面顺序）
   *     2. 对话标题
   *     3. AI 回复里哪部分是正文
   *     4. 诊断信息（只含网页结构，不含对话文字）
   * ===================================================================*/

  const Claude = (() => {
    const USER_SEL = '[data-testid="user-message"]';
    const AI_SEL =
      '[class*="font-claude-response"], [class*="font-claude-message"], [data-message-author-role="assistant"]';
    // AI 回复里放正文的容器
    const BODY_SEL =
      '[class*="standard-markdown"], [class*="progressive-markdown"], [class*="font-claude-response-body"], .prose, [class*="markdown"]';

    function findUsers() {
      return topLevel(Array.from(document.querySelectorAll(USER_SEL)), USER_SEL);
    }

    function repliesBySelector() {
      return topLevel(Array.from(document.querySelectorAll(AI_SEL)), AI_SEL).filter(
        (n) => textLen(n) > 0 && !n.closest(USER_SEL) && !n.querySelector(USER_SEL)
      );
    }

    // "消息列表"：所有用户消息共同所在的最近一层
    function turnList(users) {
      if (!users.length) return null;
      if (users.length >= 2) {
        let lca = users[0].parentElement;
        while (lca && !users.every((u) => lca.contains(u))) lca = lca.parentElement;
        return lca;
      }
      let n = users[0];
      for (let i = 0; i < 12 && n.parentElement && n.parentElement !== document.body; i++) {
        const p = n.parentElement;
        if (Array.from(p.children).some((c) => c !== n && textLen(c) > 40)) return p;
        n = p;
      }
      return null;
    }

    function looksLikeReply(c) {
      if (contentLen(c) === 0) return false;
      if (c.matches('button, input, textarea, form, nav, header, footer')) return false;
      if (c.querySelector('textarea, [contenteditable="true"]')) return false; // 输入框
      return true;
    }

    // 消息列表里，不含用户消息、又有文字的块，就是 Claude 的回复
    function repliesByStructure(users) {
      const list = turnList(users);
      if (!list) return [];
      const out = [];
      const visit = (container, depth) => {
        for (const c of container.children) {
          const inside = users.filter((u) => c.contains(u));
          if (!inside.length) {
            if (looksLikeReply(c)) out.push(c);
          } else if (depth < 3 && !inside.includes(c)) {
            // 问答被包在同一块里时，往里再找一层
            const hasOther = Array.from(c.children).some(
              (k) => !inside.some((u) => k.contains(u)) && contentLen(k) > 80
            );
            if (inside.length > 1 || hasOther) visit(c, depth + 1);
          }
        }
      };
      visit(list, 0);
      return out;
    }

    return {
      id: 'claude',
      name: 'Claude',
      accent: { light: '#c96442', dark: '#d97757' },
      onAccent: { light: '#fff', dark: '#fff' },
      matches: (host) => /(^|\.)claude\.ai$/.test(host),

      findMessages() {
        const users = findUsers();
        // 两种找法合在一起，同一条回复只留最外层那一块，避免漏掉或重复
        const cands = repliesBySelector()
          .concat(users.length ? repliesByStructure(users) : [])
          .filter((r) => !users.some((u) => r.contains(u) || u.contains(r)));
        const replies = cands.filter((r, i) => cands.indexOf(r) === i && !cands.some((o) => o !== r && o.contains(r)));
        const out = users.map((el) => ({ el, role: 'user' }));
        replies.forEach((el) => out.push({ el, role: 'ai' }));
        out.sort((a, b) => (a.el.compareDocumentPosition(b.el) & 4 ? -1 : 1));
        return out;
      },

      // 勾选框排成一列时，以这个区域的左边为准
      column() {
        return turnList(findUsers());
      },

      title() {
        const t = document.title.replace(/\s*[-–—|]\s*Claude\s*$/i, '').trim();
        return t && t.toLowerCase() !== 'claude' ? t : '';
      },

      // 要转成文字的部分：用户消息取整条；AI 回复优先只取正文容器，避开思考过程、按钮、时间等
      textRoots(el, role) {
        return role === 'user' ? [el] : this.replyRoots(el);
      },

      replyRoots(el) {
        const roots = topLevel(Array.from(el.querySelectorAll(BODY_SEL)), BODY_SEL).filter(
          (r) => textLen(r) > 0 && !insideNoise(r, el)
        );
        return roots.length ? roots : [el];
      },

      diagnose() {
        const users = findUsers();
        const bySel = repliesBySelector();
        const byStruct = repliesByStructure(users);
        const lines = [
          `用户消息 ${users.length} 条；按样式找到回复 ${bySel.length} 条；按结构找到回复 ${byStruct.length} 条`,
        ];
        const list = turnList(users);
        if (list) {
          lines.push('消息列表：' + describe(list) + ` 子元素=${list.children.length}`);
          Array.from(list.children)
            .slice(0, 8)
            .forEach((c, i) => {
              lines.push(`  [${i}] ${describe(c)}${users.some((u) => c.contains(u)) ? ' （含用户消息）' : ''}`);
              lines.push(...structureHints(c));
            });
        }
        const first = (bySel.length ? bySel : byStruct)[0];
        if (first) {
          const roots = this.replyRoots(first);
          lines.push(`第一条回复：正文容器 ${roots[0] === first ? 0 : roots.length} 个`);
        }
        return lines;
      },
    };
  })();

  const ChatGPT = (() => {
    // ChatGPT 网页改过好几次，这里准备了四种认法，依次尝试：
    //   1. 每条消息上的角色标记 data-message-author-role（旧版）
    //   2. 新版标记：用户消息气泡 data-user-message-bubble、回复上的 data-conversation-role（2026 年 10 月实测）
    //   3. 每一轮上的角色标记 data-turn
    //   4. "conversation-turn-数字"这样的轮次容器，角色靠读屏标题或有没有正文排版来判断
    const ROLE_SEL = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
    const NEW_USER_SEL = '[data-conversation-role="user"], [data-user-message-bubble="true"], [class*="group/user-message"]';
    const NEW_AI_SEL = '[data-conversation-role="assistant"], [class*="ResponseRoot"]';
    const DATA_TURN_SEL = '[data-turn="user"], [data-turn="assistant"]';
    const TURN_SEL = 'article[data-testid^="conversation-turn"], [data-testid^="conversation-turn-"]';
    // 正文排版容器（新版叫 MarkdownRoot，大小写不同，所以不区分大小写地找）
    const BODY_SEL = '.markdown, [class*="markdown" i], .prose';
    const USER_TEXT_SEL = '.whitespace-pre-wrap, [class*="whitespace-pre-wrap"], [data-user-message-bubble="true"]';
    let usedWay = '';

    function attrRole(n) {
      const a = n.getAttribute('data-message-author-role') || n.getAttribute('data-turn');
      return a ? (a === 'user' ? 'user' : 'ai') : null;
    }

    function guessRole(unit) {
      const own = attrRole(unit);
      if (own) return own;
      const inner = unit.querySelector('[data-message-author-role], [data-turn]');
      if (inner && attrRole(inner)) return attrRole(inner);
      const h = unit.querySelector('h1, h2, h3, h4, h5, h6');
      const ht = h ? h.textContent : '';
      if (/you said|你说|您说/i.test(ht)) return 'user';
      if (/said|说/i.test(ht)) return 'ai';
      return unit.querySelector(BODY_SEL) ? 'ai' : 'user';
    }

    function roleEls() {
      return topLevel(Array.from(document.querySelectorAll(ROLE_SEL)), ROLE_SEL).filter((n) => textLen(n) > 0);
    }

    // 认法 1：以"一轮"为单位，一轮里可能有好几段回复（比如先搜索再回答），合成一条
    function byRoleMark() {
      const out = [];
      const seen = new Set();
      for (const r of roleEls()) {
        const turn = r.closest(TURN_SEL) || r.closest(DATA_TURN_SEL);
        let unit = r;
        // 只有当这一轮里全是同一个角色时，才把整轮当成一条（防止把问和答合在一起）
        if (turn && !Array.from(turn.querySelectorAll(ROLE_SEL)).some((x) => attrRole(x) !== attrRole(r))) unit = turn;
        if (seen.has(unit)) continue;
        seen.add(unit);
        out.push({ el: unit, role: attrRole(r) });
      }
      return out;
    }

    function qsa(sel, root) {
      return Array.from((root || document).querySelectorAll(sel));
    }

    // 认法 2：新版标记
    function byNewMarks() {
      const users = topLevel(qsa(NEW_USER_SEL), NEW_USER_SEL).filter((n) => contentLen(n) > 0);
      let ais = topLevel(qsa(NEW_AI_SEL), NEW_AI_SEL);
      // 如果"回复"标记打在了一问一答的外层，就改用里面的正文块
      ais = ais.flatMap((a) => {
        if (!users.some((u) => a.contains(u))) return [a];
        const inner = '[class*="ResponseRoot"], [class*="markdown" i]';
        return topLevel(qsa(inner, a), inner).filter((r) => !users.some((u) => r.contains(u) || u.contains(r)));
      });
      ais = ais.filter((a) => contentLen(a) > 0);
      return users
        .filter((u) => !ais.some((a) => a.contains(u)))
        .map((el) => ({ el, role: 'user' }))
        .concat(ais.map((el) => ({ el, role: 'ai' })));
    }

    // 认法 3 和 4
    function byUnits(sel) {
      return topLevel(Array.from(document.querySelectorAll(sel)), sel)
        .filter((n) => contentLen(n) > 0)
        .map((el) => ({ el, role: guessRole(el) }));
    }

    function partsOf(el) {
      if (el.matches(ROLE_SEL)) return [el];
      const parts = topLevel(Array.from(el.querySelectorAll(ROLE_SEL)), ROLE_SEL);
      return parts.length ? parts : [el];
    }

    function count(sel) {
      return document.querySelectorAll(sel).length;
    }

    return {
      id: 'chatgpt',
      name: 'ChatGPT',
      accent: { light: '#0d0d0d', dark: '#ececec' },
      onAccent: { light: '#fff', dark: '#0d0d0d' },
      matches: (host) => /(^|\.)(chatgpt\.com|chat\.openai\.com)$/.test(host),

      findMessages() {
        let out = byRoleMark();
        usedWay = '认法1（消息角色标记）';
        if (!out.length) {
          out = byNewMarks();
          usedWay = '认法2（新版标记）';
        }
        if (!out.length) {
          out = byUnits(DATA_TURN_SEL);
          usedWay = '认法3（轮次角色标记）';
        }
        if (!out.length) {
          out = byUnits(TURN_SEL);
          usedWay = '认法4（轮次容器）';
        }
        if (!out.length) usedWay = '四种认法都没找到';
        out.sort((a, b) => (a.el.compareDocumentPosition(b.el) & 4 ? -1 : 1));
        return out;
      },

      column() {
        const t =
          document.querySelector(TURN_SEL) ||
          document.querySelector(DATA_TURN_SEL) ||
          document.querySelector(ROLE_SEL) ||
          document.querySelector(NEW_AI_SEL);
        return t ? t.parentElement : null;
      },

      title() {
        const t = document.title
          .replace(/^\s*ChatGPT\s*[-–—|:：]\s*/i, '')
          .replace(/\s*[-–—|]\s*ChatGPT\s*$/i, '')
          .trim();
        return t && !/^chatgpt$/i.test(t) ? t : '';
      },

      // 用户消息优先取正文那一块；回复优先取正文（markdown）容器，避开"已思考 X 秒"、按钮等
      textRoots(el, role) {
        const parts = partsOf(el);
        const roots = [];
        for (const part of parts) {
          const sel = role === 'user' ? USER_TEXT_SEL : BODY_SEL;
          const bodies = topLevel(Array.from(part.querySelectorAll(sel)), sel).filter(
            (b) => textLen(b) > 0 && !insideNoise(b, part)
          );
          roots.push(...(bodies.length ? bodies : [part]));
        }
        return roots;
      },

      diagnose() {
        const found = this.findMessages();
        const users = found.filter((f) => f.role === 'user').length;
        const lines = [
          `用的是：${usedWay}；找到 我 ${users} 条，ChatGPT ${found.length - users} 条`,
          `各种标记的数量：消息角色 ${count(ROLE_SEL)}，新版用户 ${count(NEW_USER_SEL)}，新版回复 ${count(NEW_AI_SEL)}，轮次角色 ${count(DATA_TURN_SEL)}，轮次容器 ${count(TURN_SEL)}，正文排版 ${count(BODY_SEL)}`,
          `标题：${this.title() ? '读到了' : '没读到'}`,
        ];
        const col = this.column();
        if (col) {
          lines.push('消息列表：' + describe(col) + ` 子元素=${col.children.length}`);
          Array.from(col.children)
            .slice(0, 6)
            .forEach((c, i) => {
              lines.push(`  [${i}] ${describe(c)}`);
              lines.push(...structureHints(c));
            });
        }
        return lines;
      },
    };
  })();

  const PLATFORMS = [Claude, ChatGPT];

  /* =====================================================================
   * 三、公共部分：界面、勾选、转换文字、复制
   * ===================================================================*/

  const P = PLATFORMS.find((p) => p.matches(location.hostname));
  if (!P) return;

  const FONT =
    '-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif';

  // ---------- 样式 ----------
  const css = `
    .acf-ui{--acf-accent:${P.accent.light};--acf-on-accent:${P.onAccent.light};--acf-bg:#fff;--acf-fg:#2f2e2b;--acf-muted:#6f6c66;--acf-line:rgba(0,0,0,.10);--acf-hover:rgba(0,0,0,.045);--acf-ring:rgba(0,0,0,.28);--acf-toast-bg:#2f2e2b;--acf-toast-fg:#fff;font-family:${FONT};-webkit-font-smoothing:antialiased;box-sizing:border-box}
    html[data-acf-theme="dark"] .acf-ui{--acf-accent:${P.accent.dark};--acf-on-accent:${P.onAccent.dark};--acf-bg:#30302e;--acf-fg:#eceae4;--acf-muted:#a8a59d;--acf-line:rgba(255,255,255,.12);--acf-hover:rgba(255,255,255,.06);--acf-ring:rgba(255,255,255,.38);--acf-toast-bg:#eceae4;--acf-toast-fg:#262624}

    .acf-fab{position:fixed;top:60px;right:16px;z-index:2147483000;display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 11px 0 9px;border-radius:999px;border:1px solid var(--acf-line);background:var(--acf-bg);color:var(--acf-muted);font-size:12.5px;line-height:1;cursor:pointer;opacity:.75;transition:opacity .15s,color .15s}
    .acf-fab:hover{opacity:1;color:var(--acf-fg)}
    .acf-fab svg{width:13px;height:13px;flex:none}
    html[data-acf-on] .acf-fab{display:none}

    .acf-layer{position:fixed;inset:0;z-index:2147482990;pointer-events:none;display:none}
    html[data-acf-on] .acf-layer{display:block}
    .acf-hl{position:fixed;border-radius:10px;pointer-events:none;transition:background-color .12s}
    .acf-hl.is-hover{background:var(--acf-hover)}
    .acf-hl.is-on{background:color-mix(in srgb,var(--acf-accent) 8%,transparent)}
    .acf-check{position:fixed;width:18px;height:18px;border-radius:50%;border:1.5px solid var(--acf-ring);background:var(--acf-bg);pointer-events:auto;cursor:pointer;transition:background-color .12s,border-color .12s}
    .acf-check:hover{border-color:var(--acf-accent)}
    .acf-check.is-on{background:var(--acf-accent);border-color:var(--acf-accent)}
    .acf-check.is-on::after{content:"";position:absolute;left:4.5px;top:1.5px;width:4px;height:8px;border:solid var(--acf-on-accent);border-width:0 2px 2px 0;transform:rotate(45deg)}

    .acf-bar{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483001;display:none;align-items:center;gap:2px;padding:5px 5px 5px 14px;border-radius:12px;border:1px solid var(--acf-line);background:var(--acf-bg);color:var(--acf-fg);font-size:13px;line-height:1;white-space:nowrap;box-shadow:0 2px 12px rgba(0,0,0,.06)}
    html[data-acf-on] .acf-bar{display:flex}
    .acf-count{color:var(--acf-muted);margin-right:8px}
    .acf-btn{appearance:none;border:0;background:transparent;color:var(--acf-fg);font:inherit;padding:7px 10px;border-radius:8px;cursor:pointer}
    .acf-btn:hover{background:var(--acf-hover)}
    .acf-btn.is-primary{background:var(--acf-accent);color:var(--acf-on-accent);padding:7px 14px;margin:0 4px;font-weight:500}
    .acf-btn.is-primary:hover{filter:brightness(1.07)}
    .acf-btn:disabled{opacity:.4;cursor:default;filter:none}

    .acf-toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,6px);z-index:2147483002;padding:9px 16px;border-radius:999px;background:var(--acf-toast-bg);color:var(--acf-toast-fg);font-size:13px;line-height:1.4;opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;white-space:nowrap}
    .acf-toast.is-show{opacity:1;transform:translate(-50%,0)}
  `;
  if (typeof GM_addStyle === 'function') {
    GM_addStyle(css);
  } else {
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ---------- 界面元素 ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function btn(text, extra) {
    const b = el('button', 'acf-btn' + (extra ? ' ' + extra : ''), text);
    b.type = 'button';
    return b;
  }
  function checkIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', '8');
    c.setAttribute('cy', '8');
    c.setAttribute('r', '6.25');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M5.3 8.2l1.9 1.9 3.6-3.8');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(c, p);
    return svg;
  }

  const fab = el('button', 'acf-ui acf-fab');
  fab.type = 'button';
  fab.title = `勾选几条消息，复制后粘贴给另一个 AI（Esc 退出）`;
  fab.append(checkIcon(), document.createTextNode('勾选转发'));

  const layer = el('div', 'acf-ui acf-layer');

  const bar = el('div', 'acf-ui acf-bar');
  const countEl = el('span', 'acf-count');
  const btnAll = btn('全选');
  const btnClear = btn('清空');
  const btnCopy = btn('复制转发', 'is-primary');
  const btnCancel = btn('取消');
  bar.append(countEl, btnAll, btnClear, btnCopy, btnCancel);

  const toastEl = el('div', 'acf-ui acf-toast');

  function mount() {
    for (const n of [layer, fab, bar, toastEl]) {
      if (!n.isConnected) document.body.appendChild(n);
    }
  }

  // ---------- 跟随网站的浅色 / 深色 ----------
  function parseColor(s) {
    const m = (s || '').match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const v = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 };
  }
  function updateTheme() {
    let dark = null;
    let n = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    for (; n; n = n.parentElement) {
      const c = parseColor(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.5) {
        dark = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255 < 0.45;
        break;
      }
    }
    if (dark === null) dark = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
    const want = dark ? 'dark' : 'light';
    if (document.documentElement.getAttribute('data-acf-theme') !== want) {
      document.documentElement.setAttribute('data-acf-theme', want);
    }
  }

  mount();
  updateTheme();
  setInterval(() => {
    mount();
    updateTheme();
  }, 1500);

  // ---------- 提示 ----------
  let toastTimer;
  let lastBarBottom = 24;
  function toast(msg, ms) {
    toastEl.textContent = msg;
    // 操作栏还在的时候，提示放在它上面，不叠在一起
    toastEl.style.bottom = lastBarBottom + (selecting ? 52 : 0) + 'px';
    toastEl.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-show'), ms || 2000);
  }

  // ---------- 选择状态 ----------
  let selecting = false;
  let lastClicked = null;
  let lastUrl = location.href;
  let frame = 0;
  let msgs = []; // 按页面顺序的消息元素
  let column = null;
  const roles = new Map(); // 消息元素 -> 'user' | 'ai'
  const selected = new Set();
  const marks = new Map(); // 消息元素 -> { hl, check }
  let hovered = null;
  let mouseX = -1;
  let mouseY = -1;

  function scan() {
    const found = P.findMessages();
    msgs = found.map((f) => f.el);
    roles.clear();
    found.forEach((f) => roles.set(f.el, f.role));
    column = P.column ? P.column() : null;
    const alive = new Set(msgs);
    for (const [m, mk] of marks) {
      if (!alive.has(m)) {
        mk.hl.remove();
        mk.check.remove();
        marks.delete(m);
        selected.delete(m);
      }
    }
    for (const m of msgs) {
      if (marks.has(m)) continue;
      const hl = el('div', 'acf-hl');
      const check = el('div', 'acf-check');
      check.title = roles.get(m) === 'user' ? '我的消息' : `${P.name} 的回复`;
      check.addEventListener('mousedown', (e) => e.preventDefault());
      check.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(m, e.shiftKey);
      });
      layer.append(hl, check);
      marks.set(m, { hl, check });
    }
  }

  function toggle(m, shift) {
    const want = !selected.has(m);
    if (shift && lastClicked && msgs.includes(lastClicked)) {
      const a = msgs.indexOf(lastClicked);
      const z = msgs.indexOf(m);
      for (let i = Math.min(a, z); i <= Math.max(a, z); i++) {
        if (want) selected.add(msgs[i]);
        else selected.delete(msgs[i]);
      }
    } else if (want) {
      selected.add(m);
    } else {
      selected.delete(m);
    }
    lastClicked = m;
    paint();
  }

  function paint() {
    for (const [m, mk] of marks) {
      const on = selected.has(m);
      mk.check.classList.toggle('is-on', on);
      mk.hl.classList.toggle('is-on', on);
      mk.hl.classList.toggle('is-hover', !on && m === hovered);
    }
    const n = selected.size;
    countEl.textContent = n ? `已选 ${n} 条` : '选择要转发的消息';
    btnCopy.disabled = n === 0;
  }

  // 有的外层容器本身不占位置，这时用它里面内容的范围来定位
  function rectOf(m) {
    let r = m.getBoundingClientRect();
    if (r.height > 0 && r.width > 0) return r;
    try {
      const range = document.createRange();
      range.selectNodeContents(m);
      r = range.getBoundingClientRect();
    } catch (e) { /* 用原来的 */ }
    return r;
  }

  function place() {
    const h = window.innerHeight;
    const comp = findComposerRect();
    const visibleBottom = comp ? comp.top : h;
    // 操作栏浮在输入框上方
    lastBarBottom = comp ? Math.max(16, Math.min(h * 0.6, h - comp.top + 12)) : 24;
    bar.style.bottom = lastBarBottom + 'px';
    // 消息滚到输入框后面时，不再显示勾选框和底色
    layer.style.clipPath = comp ? `inset(0 0 ${Math.max(0, h - visibleBottom)}px 0)` : '';

    let colLeft = Infinity;
    const colRect = column && column.isConnected ? column.getBoundingClientRect() : null;
    const rects = new Map();
    for (const m of marks.keys()) {
      const r = rectOf(m);
      rects.set(m, r);
      if (r.height > 0) colLeft = Math.min(colLeft, r.left);
    }
    if (colRect && colRect.width > 0) colLeft = Math.min(colLeft, colRect.left);
    const checkLeft = colLeft === Infinity ? 6 : Math.max(6, colLeft - 30);

    for (const [m, mk] of marks) {
      const r = rects.get(m);
      const show = r.height > 0 && r.bottom > 0 && r.top < visibleBottom;
      mk.hl.style.display = mk.check.style.display = show ? 'block' : 'none';
      if (!show) continue;
      Object.assign(mk.hl.style, {
        left: r.left - 8 + 'px',
        top: r.top - 6 + 'px',
        width: r.width + 16 + 'px',
        height: r.height + 12 + 'px',
      });
      // 长消息滚动时，勾选框停在可见区域顶部，直到这条消息滚出去
      const top = Math.min(Math.max(r.top + 2, 8), Math.min(r.bottom, visibleBottom) - 24);
      mk.check.style.top = top + 'px';
      mk.check.style.left = checkLeft + 'px';
    }
  }

  function msgAt(t) {
    if (!t) return null;
    const own = t.closest && t.closest('.acf-check');
    if (own) {
      for (const [m, mk] of marks) if (mk.check === own) return m;
    }
    for (const m of msgs) if (m === t || m.contains(t)) return m;
    return null;
  }

  function tick() {
    if (!selecting) return;
    if (location.href !== lastUrl) {
      setMode(false); // 换了对话，直接退出
      return;
    }
    if (frame++ % 15 === 0) scan();
    if (mouseX >= 0) {
      const h = msgAt(document.elementFromPoint(mouseX, mouseY));
      if (h !== hovered) hovered = h;
    }
    place();
    paint();
    requestAnimationFrame(tick);
  }

  function clearSel() {
    selected.clear();
    lastClicked = null;
    paint();
  }

  function setMode(on) {
    if (on === selecting) return;
    selecting = on;
    if (on) {
      document.documentElement.setAttribute('data-acf-on', '');
      lastUrl = location.href;
      frame = 0;
      scan();
      paint();
      place();
      if (!msgs.length) {
        toast('没找到消息。可以在篡改猴菜单里点「复制诊断信息」', 4000);
      }
      requestAnimationFrame(tick);
    } else {
      document.documentElement.removeAttribute('data-acf-on');
      selected.clear();
      lastClicked = null;
      hovered = null;
      for (const mk of marks.values()) {
        mk.hl.remove();
        mk.check.remove();
      }
      marks.clear();
    }
  }

  // ---------- 点消息本身也能选中 ----------
  document.addEventListener(
    'click',
    (e) => {
      if (!selecting) return;
      const t = e.target;
      if (!(t instanceof Element) || t.closest('.acf-bar, .acf-fab, .acf-check')) return;
      const m = msgAt(t);
      if (!m) return;
      const sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return; // 正在拖选文字，不算点击
      e.preventDefault(); // 选择模式下点到链接也不跳走
      e.stopPropagation();
      toggle(m, e.shiftKey);
    },
    true
  );
  document.addEventListener(
    'mousemove',
    (e) => {
      if (!selecting) return;
      mouseX = e.clientX;
      mouseY = e.clientY;
    },
    { passive: true, capture: true }
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (selecting && e.key === 'Escape') {
        e.stopPropagation();
        setMode(false);
      }
    },
    true
  );

  /* =====================================================================
   * 四、把网页内容转成文字（尽量保留换行、列表、代码块、表格、公式）
   * ===================================================================*/

  let filterNoise = true; // 关掉时只做最基本的转换，用作兜底
  const SKIP_TAGS = new Set(['BUTTON', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'TEMPLATE', 'SVG', 'TIME']);
  // 回复末尾的时间（"前天""14:57"之类），不属于消息正文
  const TIME_LINE = /\n+\s*(刚刚|今天|昨天|前天|\d{1,2}:\d{2}|\d+\s*(秒|分钟|小时|天|周|个月|年)前|\d{1,2}月\d{1,2}日[^\n]{0,8}|\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?[^\n]{0,8}|(Just now|Yesterday|Today)|\d+\s*(minutes?|hours?|days?)\s+ago)\s*$/i;

  function keepsWhitespace(textNode) {
    const p = textNode.parentElement;
    if (!p) return false;
    try {
      return /^(pre|break-spaces)/.test(getComputedStyle(p).whiteSpace || '');
    } catch (e) {
      return false;
    }
  }

  function kids(n) {
    let s = '';
    for (const c of n.childNodes) s += walk(c);
    return s;
  }

  function tidy(s) {
    return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  }

  function block(s) {
    const t = s.trim();
    return t ? '\n\n' + t + '\n\n' : '';
  }

  function wrap(s, mark) {
    const t = s.trim();
    if (!t) return '';
    return (/^\s/.test(s) ? ' ' : '') + mark + t + mark + (/\s$/.test(s) ? ' ' : '');
  }

  function pre(n) {
    const code = n.querySelector('code') || n;
    const m = (code.getAttribute('class') || '').match(/language-([\w+#.-]+)/);
    const text = code.textContent.replace(/\n+$/, '');
    return '\n\n```' + (m ? m[1] : '') + '\n' + text + '\n```\n\n';
  }

  function list(n, ordered) {
    let i = parseInt(n.getAttribute('start') || '1', 10);
    if (isNaN(i)) i = 1;
    const items = [];
    for (const c of n.children) {
      if (c.tagName.toUpperCase() !== 'LI') continue;
      const marker = ordered ? `${i++}. ` : '- ';
      const body = tidy(kids(c).trim()).replace(/\n\n(?=\s*(?:- |\d+\. ))/g, '\n');
      const pad = ' '.repeat(marker.length);
      items.push(marker + body.split('\n').map((l, k) => (k === 0 || !l ? l : pad + l)).join('\n'));
    }
    return items.length ? '\n\n' + items.join('\n') + '\n\n' : '';
  }

  function table(n) {
    const rows = Array.from(n.querySelectorAll('tr'));
    if (!rows.length) return block(kids(n));
    const cells = rows.map((r) =>
      Array.from(r.children)
        .filter((c) => /^(TD|TH)$/i.test(c.tagName))
        .map((c) => kids(c).replace(/\s*\n\s*/g, ' ').trim().replace(/\|/g, '\\|'))
    );
    const w = Math.max(1, ...cells.map((r) => r.length));
    const line = (r) => '| ' + Array.from({ length: w }, (_, k) => r[k] || '').join(' | ') + ' |';
    const out = [line(cells[0]), '| ' + Array(w).fill('---').join(' | ') + ' |', ...cells.slice(1).map(line)];
    return '\n\n' + out.join('\n') + '\n\n';
  }

  function walk(n) {
    if (n.nodeType === 3) {
      return keepsWhitespace(n) ? n.nodeValue : n.nodeValue.replace(/\s+/g, ' ');
    }
    if (n.nodeType !== 1) return '';
    const tag = n.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return '';

    // 数学公式：取 LaTeX 原文（要在杂质判断之前，因为公式的显示层是隐藏给读屏软件的）
    if (n.classList.contains('katex')) {
      const ann = n.querySelector('annotation[encoding="application/x-tex"]');
      if (ann) {
        const tex = ann.textContent.trim();
        return n.closest('.katex-display') ? '\n\n$$' + tex + '$$\n\n' : '$' + tex + '$';
      }
    }
    if (filterNoise ? isNoise(n) : n.classList.contains('acf-ui')) return '';

    // 代码块上方单独一行的语言标签（如 "python"），代码块本身已经带了，跳过
    const next = n.nextElementSibling;
    if (next && next.tagName.toUpperCase() === 'PRE' && !n.querySelector('pre')) {
      const code = next.querySelector('code') || next;
      const lang = (code.getAttribute('class') || '').match(/language-([\w+#.-]+)/);
      if (lang && n.textContent.trim().toLowerCase() === lang[1].toLowerCase()) return '';
    }

    switch (tag) {
      case 'BR':
        return '\n';
      case 'HR':
        return '\n\n---\n\n';
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
        return block('#'.repeat(+tag[1]) + ' ' + kids(n).trim());
      case 'P': case 'DIV': case 'SECTION': case 'ARTICLE': case 'HEADER': case 'FOOTER':
      case 'FIGURE': case 'DETAILS': case 'SUMMARY': case 'LI':
        return block(kids(n));
      case 'STRONG': case 'B':
        return wrap(kids(n), '**');
      case 'EM': case 'I':
        return wrap(kids(n), '*');
      case 'DEL': case 'S':
        return wrap(kids(n), '~~');
      case 'CODE':
        return n.closest('pre') ? n.textContent : '`' + n.textContent + '`';
      case 'PRE':
        return pre(n);
      case 'A': {
        const t = kids(n).trim();
        const href = n.getAttribute('href') || '';
        return href && !href.startsWith('#') && t && t !== href ? `[${t}](${href})` : t;
      }
      case 'UL':
        return list(n, false);
      case 'OL':
        return list(n, true);
      case 'BLOCKQUOTE': {
        const t = tidy(kids(n).trim());
        return t ? '\n\n' + t.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n') + '\n\n' : '';
      }
      case 'TABLE':
        return table(n);
      case 'IMG':
        return n.alt ? `[图片：${n.alt}]` : '[图片]';
      default:
        return kids(n);
    }
  }

  function toText(root) {
    return tidy(kids(root)).trim();
  }

  function filteredText(m) {
    const roots = P.textRoots ? P.textRoots(m, roles.get(m)) : [m];
    return roots.map(toText).filter(Boolean).join('\n\n');
  }

  function messageText(m) {
    let body = filteredText(m);
    // 保险：如果过滤后什么都没剩，但这条消息明明有字，就不做杂质过滤，原样取文字
    if (!body && textLen(m) > 0) {
      filterNoise = false;
      try {
        body = toText(m);
      } finally {
        filterNoise = true;
      }
    }
    return roles.get(m) === 'user' ? body : body.replace(TIME_LINE, '').trim();
  }

  function buildText(picked) {
    const title = P.title();
    const head = `【以下转自 ${P.name} 对话${title ? `《${title}》` : ''}，共 ${picked.length} 条】`;
    const parts = [head];
    for (const m of picked) {
      const label = roles.get(m) === 'user' ? '【我】' : `【${P.name}】`;
      parts.push(label + '\n' + (messageText(m) || '[这条消息没有文字内容]'));
    }
    return parts.join('\n\n');
  }

  /* =====================================================================
   * 五、复制
   * ===================================================================*/

  async function copyText(t) {
    try {
      if (typeof GM_setClipboard === 'function') {
        await GM_setClipboard(t, 'text');
        return true;
      }
    } catch (e) { /* 换下一种方式 */ }
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch (e) { /* 换下一种方式 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  async function doCopy() {
    scan();
    const picked = msgs.filter((m) => selected.has(m));
    if (!picked.length) return;
    const ok = await copyText(buildText(picked));
    if (ok) {
      setMode(false);
      toast(`已复制 ${picked.length} 条消息`);
    } else {
      toast('没能复制，请再点一次「复制转发」');
    }
  }

  btnCopy.addEventListener('click', doCopy);
  btnCancel.addEventListener('click', () => setMode(false));
  btnClear.addEventListener('click', clearSel);
  btnAll.addEventListener('click', () => {
    scan();
    msgs.forEach((m) => selected.add(m));
    paint();
  });
  fab.addEventListener('click', () => setMode(true));

  /* =====================================================================
   * 六、诊断信息：只含网页结构，不含任何对话文字
   * ===================================================================*/

  function describe(n) {
    const cls = (n.getAttribute('class') || '').slice(0, 160);
    const attrs = Array.from(n.attributes)
      .filter((a) => a.name.startsWith('data-') || a.name === 'role' || a.name.startsWith('aria-'))
      .filter((a) => !a.name.startsWith('data-acf'))
      .map((a) => `${a.name}=${a.value.slice(0, 40)}`)
      .join(' ');
    const r = n.getBoundingClientRect();
    return `<${n.tagName.toLowerCase()}> class="${cls}" ${attrs} | 字数=${textLen(n)} 高=${Math.round(r.height)}`;
  }

  function structureHints(n) {
    const classes = new Set();
    const ids = new Set();
    let expanders = 0;
    n.querySelectorAll('[class], [data-testid], [aria-expanded]').forEach((d) => {
      (d.getAttribute('class') || '').split(/\s+/).forEach((k) => {
        if (/font|message|response|prose|markdown|assistant|claude|think|reason|sr-only/i.test(k)) classes.add(k);
      });
      const t = d.getAttribute('data-testid');
      if (t) ids.add(t);
      if (d.hasAttribute('aria-expanded')) expanders++;
    });
    const out = [];
    if (classes.size) out.push('      样式：' + Array.from(classes).slice(0, 14).join(' '));
    if (ids.size) out.push('      testid：' + Array.from(ids).slice(0, 12).join(' '));
    if (expanders) out.push(`      折叠开关：${expanders} 个`);
    return out;
  }

  function diagnose() {
    // 每条消息只报字数，不报内容
    const found = P.findMessages();
    const counts = found.slice(0, 8).map((f, i) => {
      roles.set(f.el, f.role);
      return `  消息${i + 1}（${f.role === 'user' ? '我' : P.name}）：网页字数 ${textLen(f.el)}，过滤后 ${filteredText(f.el).length}，最终 ${messageText(f.el).length}`;
    });
    return [
      `【AI 对话转发器 诊断信息 v${VERSION}｜${P.name}】`,
      '页面：' + location.pathname.replace(/[0-9a-z_-]{16,}/gi, '…'),
      ...P.diagnose(),
      '提取结果：',
      ...(counts.length ? counts : ['  一条都没找到', ...survey()]),
    ].join('\n');
  }

  // 找不到消息时，概括一下整个页面的结构（只有标记名和数量，不含任何文字）
  function survey() {
    const lines = ['页面概况：'];
    const attrs = new Map();
    const ids = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    document.querySelectorAll('body *').forEach((n) => {
      if (n.closest('.acf-ui')) return;
      for (const a of n.attributes) {
        if (/message|turn|author|role|chat|conversation|thread/i.test(a.name)) {
          bump(attrs, a.name + (a.value.length <= 20 && !/\d{3,}|[0-9a-f]{8}/i.test(a.value) ? '=' + a.value : ''));
        }
      }
      const t = n.getAttribute('data-testid');
      if (t) bump(ids, t.replace(/\d+/g, '#'));
    });
    const top = (m, k) =>
      Array.from(m.entries())
        .sort((x, y) => y[1] - x[1])
        .slice(0, k)
        .map(([name, c]) => `${name}×${c}`)
        .join('  ');
    lines.push('  相关属性：' + (top(attrs, 18) || '无'));
    lines.push('  testid：' + (top(ids, 24) || '无'));
    lines.push(`  article ${document.querySelectorAll('article').length} 个；正文排版 ${document.querySelectorAll('[class*="markdown" i], .prose').length} 个`);

    // 最大的那块可滚动区域，一般就是对话区
    let box = null;
    let area = 0;
    document.querySelectorAll('main, div, section').forEach((n) => {
      if (n.closest('.acf-ui') || n.scrollHeight <= n.clientHeight + 100) return;
      const oy = getComputedStyle(n).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') return;
      const a = n.clientWidth * n.clientHeight;
      if (a > area) {
        area = a;
        box = n;
      }
    });
    if (!box) box = document.querySelector('main');
    if (box) {
      for (let i = 0; i < 12 && box.children.length === 1; i++) box = box.children[0];
      lines.push('  对话区：' + describe(box) + ` 子元素=${box.children.length}`);
      Array.from(box.children)
        .slice(0, 6)
        .forEach((c, i) => {
          lines.push(`    [${i}] ${describe(c)}`);
          lines.push(...structureHints(c));
        });
    }
    return lines;
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('开始勾选转发', () => setMode(true));
    GM_registerMenuCommand('复制诊断信息（不含对话内容）', async () => {
      const ok = await copyText(diagnose());
      toast(ok ? '诊断信息已复制' : '没能复制诊断信息');
    });
  }
})();
