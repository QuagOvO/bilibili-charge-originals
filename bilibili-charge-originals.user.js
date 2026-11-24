// ==UserScript==
// @name         B站充电动态原图保存（20912836）
// @namespace    local.bilibili.charge-originals
// @version      1.2.2
// @description  勾选并批量保存已登录动态页上的原图。
// @match        https://space.bilibili.com/20912836/*
// @noframes
// @run-at       document-idle
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
  'use strict';

  const SCAN_INTERVAL = 3_000;
  const REFRESH_INTERVAL = 10 * 60_000;
  const RETRY_INTERVAL = 60_000;
  const CARD = '.bili-dyn-list__item, .bili-dyn-item:not(.bili-dyn-list__item .bili-dyn-item)';
  const GALLERY = '.bili-album, .bili-dyn-gallery, .horizontal-scroll-album, .opus-module-top__album__cover';
  const FORWARD = '.bili-dyn-content__forward, .bili-dyn-forward, .bili-dyn-item__forward';
  const BLOCKED = '.dyn-blocked-mask, .bili-dyn-blocked';
  const LABEL = /^(?:充电专属(?:动态|内容)?|充電專屬(?:動態|內容)?)$/;
  const CHARGE_BADGE_PATH = '/bfs/activity-plat/static/20230112/3b3c5705bda98d50983f6f47df360fef/IN4E1b8HNg.png';
  const AUTO_REFRESH_KEY = 'auto-refresh';
  const AUTO_SAVE_KEY = 'auto-save';
  const buttons = new WeakMap();
  const retryAt = new Map();
  let pageButton;
  let picker;
  let previous = '';
  let tabBusy = false;
  let nextRefresh = Date.now() + REFRESH_INTERVAL;

  function onDynamicPage() {
    return /^\/20912836\/dynamic\/?$/.test(location.pathname);
  }

  function visible(element) {
    return element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
  }

  function own(card, child) {
    return child.closest(CARD) === card && !child.closest(FORWARD);
  }

  function isBlocked(card) {
    return [...card.querySelectorAll(BLOCKED)].some((node) => own(card, node) && visible(node));
  }

  function isChargeBadgeUrl(value) {
    if (!value?.includes(CHARGE_BADGE_PATH)) return false;
    try {
      const url = new URL(value, location.href);
      return url.protocol === 'https:' && /^i\d+\.hdslb\.com$/i.test(url.hostname) &&
        url.pathname.split('@')[0] === CHARGE_BADGE_PATH;
    } catch {
      return false;
    }
  }

  function hasChargeLabel(card) {
    // B 站空间的充电图文动态使用没有 alt 文字的图片角标。
    const badges = card.querySelectorAll(
      `img[src*="${CHARGE_BADGE_PATH}"], img[data-src*="${CHARGE_BADGE_PATH}"], img[srcset*="${CHARGE_BADGE_PATH}"]`,
    );
    for (const badge of badges) {
      if (!own(card, badge) || !visible(badge) ||
          badge.closest(`${GALLERY}, .bili-rich-text, .bili-dyn-item__footer`)) continue;
      if ([badge.currentSrc, badge.getAttribute('src'), badge.getAttribute('data-src')]
        .some(isChargeBadgeUrl)) return true;
    }
    const candidates = card.querySelectorAll(
      '[class*="badge"], [class*="tag"], [class*="label"], [class*="charge"], [class*="exclusive"], [title], [aria-label], [alt]',
    );
    return [...candidates].some((node) => {
      if (!own(card, node) || !visible(node) || node.closest('.bili-rich-text, .bili-dyn-item__footer')) {
        return false;
      }
      return [node.textContent, node.getAttribute('title'), node.getAttribute('aria-label'), node.getAttribute('alt')]
        .some((value) => LABEL.test(value?.replace(/\s+/g, '') ?? ''));
    });
  }

  function isPinned(card) {
    const badges = card.querySelectorAll(
      '.bili-dyn-item__top, .bili-dyn-item__pinned, [class*="badge"], [class*="tag"]',
    );
    return [...badges].some((node) =>
      own(card, node) && visible(node) && /^(?:置顶|置頂)$/.test(node.textContent.trim()),
    );
  }

  function originalUrl(value) {
    // 只接受图集里的 B 站图片 CDN 地址。保留原扩展名和查询参数。
    if (!value || !/^(?:https:)?\/\//i.test(value)) return null;
    const url = new URL(value, location.href);
    if (url.protocol !== 'https:' || url.username || url.password ||
        !/^i\d+\.hdslb\.com$/i.test(url.hostname)) return null;
    const path = url.pathname.replace(/@[^/]*$/, '');
    if (!/^\/bfs\/(?:new_dyn|album)\/[^/]+\.(?:jpe?g|png|webp|gif|avif|bmp)$/i.test(path)) return null;
    url.pathname = path;
    url.hash = '';
    return url.href;
  }

  function imageAsset(image) {
    const srcset = image.getAttribute('srcset') ?? '';
    const sources = image.closest('picture')?.querySelectorAll('source[srcset]') ?? [];
    const candidates = [
      image.currentSrc,
      image.getAttribute('src'),
      image.getAttribute('data-src'),
      image.getAttribute('data-original'),
      srcset.trim().split(/\s|,/)[0],
      ...Array.from(sources, (source) => source.getAttribute('srcset').trim().split(/\s|,/)[0]),
    ];
    for (const candidate of candidates) {
      try {
        const url = originalUrl(candidate);
        if (url) return { url, preview: new URL(candidate, location.href).href };
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    }
    return null;
  }

  function albumImages(card) {
    const images = new Set();
    for (const gallery of card.querySelectorAll(GALLERY)) {
      if (!own(card, gallery) || !visible(gallery)) continue;
      for (const image of gallery.querySelectorAll('img')) {
        if (own(card, image) && visible(image)) images.add(image);
      }
    }
    if (images.size) return [...images].map(imageAsset);
    // B 站替换图集类名时，从同一张动态卡片的正文寻找配图。
    const content = card.querySelector('.bili-dyn-content__orig__major') ??
      card.querySelector('.bili-dyn-item__body') ?? card;
    return [...content.querySelectorAll('img')]
      .filter((image) => own(card, image) && visible(image) &&
        !image.closest('[class*="comment"], .bili-rich-text, .bili-dyn-item__footer'))
      .map(imageAsset)
      .filter(Boolean);
  }

  function downloadKey(card, images) {
    const id = card.dataset.did ?? card.querySelector('.bili-dyn-item[data-did]')?.dataset.did;
    if (/^\d+$/.test(id)) return id;
    // 同一图集的首张可识别配图可作为没有动态 ID 时的文件名和去重键。
    const first = images.find(Boolean)?.url;
    return first ? 'album_' + new URL(first).pathname.split('/').at(-1).replace(/[^\w.-]/g, '_') : '';
  }

  function download(url, filename) {
    return new Promise((resolve, reject) => {
      let transfer;
      const timer = setTimeout(() => {
        reject(new Error('下载超时'));
        transfer?.abort();
      }, 90_000);
      function finish(error) {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      }
      try {
        transfer = GM_download({
          url,
          name: filename,
          saveAs: false,
          conflictAction: 'uniquify',
          onload: () => finish(),
          onerror: (details) => finish(new Error(details?.error || '下载失败')),
        });
      } catch (error) {
        finish(error);
      }
    });
  }

  async function save(id, selection, { report, skipSaved }) {
    const key = 'saved:' + id;
    const savedUrls = new Set(GM_getValue(key, []));
    let count = 0;
    let failures = 0;
    let lastError = '';
    for (const { index, url } of selection) {
      if (skipSaved && savedUrls.has(url)) continue;
      const number = String(index + 1).padStart(2, '0');
      const extension = new URL(url).pathname.split('.').at(-1).toLowerCase();
      report?.('正在下载第 ' + (index + 1) + ' 张…');
      try {
        await download(url, `bili_${id}_${number}.${extension}`);
        if (!savedUrls.has(url)) {
          savedUrls.add(url);
          GM_setValue(key, [...savedUrls]);
        }
        count += 1;
      } catch (error) {
        console.warn('[B站原图] 第 ' + (index + 1) + ' 张下载失败', error);
        lastError = error.message;
        failures += 1;
      }
    }
    if (failures) retryAt.set(id, Date.now() + RETRY_INTERVAL);
    else retryAt.delete(id);
    if (failures) return `已保存 ${count} 张，${failures} 张失败（${lastError}）。可重试。`;
    return count ? `已保存 ${count} 张原图，在浏览器的「下载内容」中查看。` : '所选原图都已保存。';
  }

  async function requestSave(card, images, selection, { report, skipSaved = false } = {}) {
    if (tabBusy) return '正在保存其他图片，请稍后重试。';
    if (!onDynamicPage() || !card.isConnected || isBlocked(card)) return '这条动态的配图当前不可用。';
    if (!selection.length) return '请至少勾选一张图。';
    const id = downloadKey(card, images);
    tabBusy = true;
    try {
      if (navigator.locks) {
        return await navigator.locks.request('bilibili-charge-originals', { ifAvailable: true }, (lock) =>
          lock ? save(id, selection, { report, skipSaved }) : '另一个动态页正在下载，请稍后重试。',
        );
      }
      return await save(id, selection, { report, skipSaved });
    } finally {
      tabBusy = false;
    }
  }

  function choiceButton(text) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.style.cssText = 'font:inherit;cursor:pointer;padding:4px 10px;';
    return button;
  }

  function showPicker(card, images, trigger) {
    if (!images.length || isBlocked(card)) {
      alert('未找到已显示的配图，请等动态加载后再试。');
      return;
    }
    picker?.close();
    const dialog = document.createElement('dialog');
    picker = dialog;
    dialog.setAttribute('aria-label', '选择要保存的原图');
    dialog.style.cssText = 'width:min(650px,90vw);max-height:85vh;box-sizing:border-box;' +
      'border:1px solid GrayText;border-radius:12px;padding:18px;color-scheme:light dark;' +
      'color:CanvasText;background:Canvas;overflow:auto;';
    const title = document.createElement('h2');
    title.textContent = '选择要保存的原图';
    title.style.cssText = 'margin:0 0 12px;font-size:18px;';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:10px;';
    const selectAll = choiceButton('全选');
    const clearAll = choiceButton('取消全选');
    const count = document.createElement('span');
    count.setAttribute('aria-live', 'polite');
    actions.append(selectAll, clearAll, count);
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(120px,100%),1fr));gap:8px;';
    const downloadButton = choiceButton('下载所选原图');
    const close = choiceButton('关闭');
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.style.margin = '10px 0 0';
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;';
    footer.append(downloadButton, close);
    const options = images.map((image, index) => {
      const label = document.createElement('label');
      label.style.cssText = 'display:grid;gap:5px;padding:6px;border:1px solid GrayText;border-radius:6px;cursor:pointer;';
      if (image) {
        const thumbnail = document.createElement('img');
        thumbnail.src = image.preview;
        thumbnail.alt = '';
        thumbnail.style.cssText = 'width:100%;aspect-ratio:1;object-fit:contain;display:block;';
        label.append(thumbnail);
      }
      const name = document.createElement('span');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(image);
      checkbox.disabled = !image;
      checkbox.addEventListener('change', updateCount);
      name.append(checkbox, ` 第 ${index + 1} 张${image ? '' : '（配图未加载）'}`);
      label.append(name);
      grid.append(label);
      return { checkbox, image, index };
    });
    function selected() {
      return options.filter(({ checkbox }) => checkbox.checked);
    }
    function updateCount() {
      const total = selected().length;
      count.textContent = `已选 ${total} / ${images.length}`;
      downloadButton.disabled = !total;
    }
    function setAll(checked) {
      for (const { checkbox, image } of options) checkbox.checked = Boolean(image) && checked;
      updateCount();
    }
    selectAll.addEventListener('click', () => setAll(true));
    clearAll.addEventListener('click', () => setAll(false));
    close.addEventListener('click', () => dialog.close());
    downloadButton.addEventListener('click', async () => {
      const selection = selected().map(({ image, index }) => ({ index, url: image.url }));
      downloadButton.disabled = true;
      selectAll.disabled = true;
      clearAll.disabled = true;
      for (const { checkbox } of options) checkbox.disabled = true;
      const report = (message) => { status.textContent = message; };
      try {
        report(await requestSave(card, images, selection, { report }));
      } catch (error) {
        report(error.message || '下载失败，请重试。');
      } finally {
        selectAll.disabled = false;
        clearAll.disabled = false;
        for (const { checkbox, image } of options) checkbox.disabled = !image;
        updateCount();
      }
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (picker === dialog) picker = undefined;
      if (trigger?.isConnected) trigger.focus();
    });
    updateCount();
    dialog.append(title, actions, grid, footer, status);
    document.body.append(dialog);
    dialog.showModal();
  }

  function addButton(card) {
    if (buttons.get(card)?.isConnected) return;
    const footer = card.querySelector('.bili-dyn-item__footer') ?? card;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '选择保存图片';
    button.style.cssText = 'font:inherit;color:inherit;background:transparent;border:1px solid currentColor;' +
      'border-radius:4px;padding:2px 8px;cursor:pointer;';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showPicker(card, albumImages(card), button);
    });
    footer.append(button);
    buttons.set(card, button);
  }

  function findLatest() {
    let firstPinned = null;
    let latest = null;
    for (const card of document.querySelectorAll(CARD)) {
      if (!visible(card) || isBlocked(card)) continue;
      const images = albumImages(card);
      if (!images.length) continue;
      addButton(card);
      if (latest || !hasChargeLabel(card)) continue;
      const target = { card, images };
      if (!isPinned(card)) latest = target;
      else firstPinned ??= target;
    }
    return latest ?? firstPinned;
  }

  function selectLatest() {
    if (tabBusy || !onDynamicPage()) return;
    const target = findLatest();
    if (target) showPicker(target.card, target.images, pageButton);
    else alert('没有识别到充电专属图集。可以点目标动态下方的「选择保存图片」。');
  }

  function showPageButton() {
    if (pageButton?.isConnected) return;
    pageButton = document.createElement('button');
    pageButton.type = 'button';
    pageButton.textContent = '选择最新充电原图';
    pageButton.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:10000;' +
      'background:#0076a3;color:#fff;border:0;border-radius:8px;padding:9px 14px;font:inherit;cursor:pointer;';
    pageButton.addEventListener('click', selectLatest);
    document.body.append(pageButton);
  }

  function scan() {
    if (!onDynamicPage()) {
      pageButton?.remove();
      picker?.close();
      previous = '';
      nextRefresh = Date.now() + REFRESH_INTERVAL;
      return;
    }
    showPageButton();
    if (tabBusy) return;
    const target = findLatest();
    const id = target ? downloadKey(target.card, target.images) : '';
    const signature = id && target.images.every(Boolean)
      ? JSON.stringify([id, target.images.map(({ url }) => url)])
      : '';
    if (GM_getValue(AUTO_SAVE_KEY, false) && !picker?.open &&
        signature && signature === previous && Date.now() >= (retryAt.get(id) ?? 0)) {
      const selection = target.images.map(({ url }, index) => ({ index, url }));
      const saved = new Set(GM_getValue('saved:' + id, []));
      if (selection.some(({ url }) => !saved.has(url))) {
        void requestSave(target.card, target.images, selection, { skipSaved: true }).catch(console.warn);
      }
    }
    previous = signature;
    if (!tabBusy && !picker?.open && GM_getValue(AUTO_REFRESH_KEY, false) && Date.now() >= nextRefresh) {
      nextRefresh = Date.now() + REFRESH_INTERVAL;
      location.reload();
    }
  }

  GM_registerMenuCommand('立即检查最新充电动态', scan);
  GM_registerMenuCommand('选择最新充电原图', selectLatest);
  GM_registerMenuCommand('切换自动保存全部原图', () => {
    const enabled = !GM_getValue(AUTO_SAVE_KEY, false);
    GM_setValue(AUTO_SAVE_KEY, enabled);
    alert(enabled ? '已开启自动保存。识别到最新充电图集后会下载全部原图。' : '已关闭自动保存。可以勾选图片后下载。');
  });
  GM_registerMenuCommand('切换每 10 分钟刷新动态页', () => {
    const enabled = !GM_getValue(AUTO_REFRESH_KEY, false);
    GM_setValue(AUTO_REFRESH_KEY, enabled);
    nextRefresh = Date.now() + REFRESH_INTERVAL;
    alert(enabled ? '已开启。请保持 UP 主的动态页标签打开。' : '已关闭定时刷新。');
  });
  scan();
  setInterval(scan, SCAN_INTERVAL);
})();
