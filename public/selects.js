(() => {
  'use strict';

  const states = new Map();
  const dirty = new Set();
  let active = null;
  let sequence = 0;
  let flushPending = false;
  let positionFrame = 0;
  const supportsPopover = typeof HTMLElement.prototype.showPopover === 'function';

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(path, className) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS(svg.namespaceURI, 'path');
    line.setAttribute('d', path);
    svg.append(line);
    return svg;
  }

  // A wrapping label also contains the native options; those are values, not its name.
  function labelText(node) {
    if (!node) return '';
    const copy = node.cloneNode(true);
    copy.querySelectorAll('select, button, input, textarea, .relay-select, .relay-select-popup, [aria-hidden="true"]').forEach(child => child.remove());
    return copy.textContent.replace(/\s+/g, ' ').trim();
  }

  function accessibleName(select) {
    const references = (select.getAttribute('aria-labelledby') || '').trim().split(/\s+/);
    const named = references.map(id => labelText(document.getElementById(id))).filter(Boolean).join(' ');
    return named || select.getAttribute('aria-label') || Array.from(select.labels || [], labelText).filter(Boolean).join(' ') || select.title || 'انتخاب گزینه';
  }

  function schedule(state) {
    if (state) dirty.add(state);
    if (flushPending) return;
    flushPending = true;
    queueMicrotask(() => {
      flushPending = false;
      for (const item of Array.from(dirty)) {
        dirty.delete(item);
        if (states.get(item.select) === item) item.sync();
      }
    });
  }

  function schedulePosition() {
    if (!active || positionFrame) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = 0;
      active?.position();
    });
  }

  function normalized(value) {
    return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/\s+/g, ' ');
  }

  class RelaySelect {
    constructor(select) {
      this.select = select;
      this.id = `relay-select-${++sequence}`;
      this.originalTabIndex = select.getAttribute('tabindex');
      this.originalAriaHidden = select.getAttribute('aria-hidden');
      this.abort = new AbortController();
      this.open = false;
      this.activeIndex = -1;
      this.typeBuffer = '';
      this.typeTime = 0;
      this.signature = '';
      this.rows = new Map();
      this.wrapper = element('span', 'relay-select');
      this.name = element('span', 'relay-select-sr');
      this.name.id = `${this.id}-label`;
      this.trigger = element('button', 'relay-select-trigger');
      this.trigger.type = 'button';
      this.trigger.id = `${this.id}-trigger`;
      this.trigger.setAttribute('role', 'combobox');
      this.trigger.setAttribute('aria-haspopup', 'listbox');
      this.trigger.setAttribute('aria-expanded', 'false');
      this.trigger.setAttribute('aria-controls', `${this.id}-listbox`);
      this.trigger.setAttribute('aria-labelledby', this.name.id);
      this.value = element('span', 'relay-select-value');
      this.value.dir = 'auto';
      this.trigger.append(this.value, icon('m7 10 5 5 5-5', 'relay-select-chevron'));
      this.popup = element('div', 'relay-select-popup');
      this.popup.id = `${this.id}-listbox`;
      this.popup.hidden = true;
      this.popup.setAttribute('role', 'listbox');
      this.popup.setAttribute('aria-labelledby', this.name.id);
      if (supportsPopover) this.popup.setAttribute('popover', 'manual');
      select.before(this.wrapper);
      this.wrapper.append(select, this.name, this.trigger);
      select.classList.add('relay-select-native');
      select.tabIndex = -1;
      select.setAttribute('aria-hidden', 'true');

      const listen = (node, event, handler, options = {}) => node.addEventListener(event, handler, { ...options, signal: this.abort.signal });
      listen(this.trigger, 'click', () => this.open ? this.close() : this.show());
      listen(this.trigger, 'keydown', event => this.keydown(event));
      listen(select, 'change', () => this.sync());
      listen(select, 'input', () => this.sync());
      listen(select, 'focus', () => this.focus());
      listen(select, 'click', event => { event.preventDefault(); this.focus(); });
      listen(select, 'invalid', event => {
        event.preventDefault();
        this.invalid = true;
        this.sync();
        this.focus();
      });
      listen(this.popup, 'pointerdown', event => {
        if (event.button === 0 && event.target.closest('[role="option"]')) event.preventDefault();
      });
      listen(this.popup, 'pointermove', event => {
        if (event.pointerType === 'touch') return;
        const row = event.target.closest('[data-option-index]');
        if (row && row.getAttribute('aria-disabled') !== 'true') this.highlight(Number(row.dataset.optionIndex), false);
      });
      listen(this.popup, 'click', event => {
        const row = event.target.closest('[data-option-index]');
        if (row) this.choose(Number(row.dataset.optionIndex));
      });
      listen(this.popup, 'toggle', event => {
        // A queued close event may arrive after this same popover has reopened.
        if (event.newState === 'closed' && this.open && !this.popup.matches(':popover-open')) this.close(false);
      });
      this.observer = new MutationObserver(() => schedule(this));
      this.observer.observe(select, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['disabled', 'selected', 'value', 'label', 'hidden', 'required', 'multiple', 'size', 'dir', 'title', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-description', 'aria-errormessage', 'aria-required', 'aria-invalid'] });
      if (typeof ResizeObserver === 'function') {
        this.resizeObserver = new ResizeObserver(schedulePosition);
        this.resizeObserver.observe(this.trigger);
      }
      this.sync();
    }

    sync() {
      const select = this.select;
      if (!select.isConnected || select.parentElement !== this.wrapper || select.multiple || select.size > 1) {
        this.destroy();
        if (select.isConnected) enhance(select);
        return;
      }
      this.options = Array.from(select.options).map((option, index) => ({
        index, label: option.label, value: option.value,
        disabled: option.disabled || (option.parentElement.tagName === 'OPTGROUP' && option.parentElement.disabled),
        hidden: option.hidden || (option.parentElement.tagName === 'OPTGROUP' && option.parentElement.hidden),
        group: option.parentElement.tagName === 'OPTGROUP' ? option.parentElement.label : null,
      }));
      this.enabled = this.options.filter(option => !option.hidden && !option.disabled);
      this.trigger.disabled = select.matches(':disabled');
      this.trigger.setAttribute('aria-disabled', String(this.trigger.disabled || !this.enabled.length));
      this.trigger.tabIndex = this.originalTabIndex === null ? 0 : Number(this.originalTabIndex);
      this.wrapper.hidden = select.hidden;
      this.trigger.setAttribute('aria-required', select.getAttribute('aria-required') || String(select.required));
      this.trigger.setAttribute('aria-invalid', select.getAttribute('aria-invalid') || String(Boolean(this.invalid && !select.validity.valid)));
      for (const attribute of ['aria-describedby', 'aria-description', 'aria-errormessage']) {
        const value = select.getAttribute(attribute);
        if (value) this.trigger.setAttribute(attribute, value);
        else this.trigger.removeAttribute(attribute);
      }
      const name = accessibleName(select);
      if (this.name.textContent !== name) this.name.textContent = name;
      const selected = this.options[select.selectedIndex];
      const value = selected?.label || select.dataset.placeholder || (this.options.length ? 'انتخاب کنید' : 'گزینه‌ای وجود ندارد');
      if (this.value.textContent !== value) this.value.textContent = value;
      this.trigger.title = select.title || value;
      this.trigger.dataset.placeholder = String(!selected || selected.value === '');
      const signature = JSON.stringify(this.options);
      if (signature !== this.signature) {
        this.signature = signature;
        this.render();
      }
      for (const [index, row] of this.rows) row.setAttribute('aria-selected', String(index === select.selectedIndex));
      if (this.open) {
        if (this.trigger.disabled || !this.enabled.length || this.wrapper.hidden) this.close(false);
        else {
          if (!this.enabled.some(option => option.index === this.activeIndex)) this.highlight(this.enabled[0]?.index ?? -1);
          this.position();
        }
      }
    }

    render() {
      const scrollTop = this.popup.scrollTop;
      this.rows.clear();
      const fragment = document.createDocumentFragment();
      let group = null;
      let container = fragment;
      for (const option of this.options) {
        if (option.hidden) continue;
        if (option.group !== group) {
          group = option.group;
          container = fragment;
          if (group !== null) {
            container = element('div', 'relay-select-group');
            container.setAttribute('role', 'group');
            container.setAttribute('aria-label', group);
            const heading = element('div', 'relay-select-group-label', group);
            heading.setAttribute('aria-hidden', 'true');
            container.append(heading);
            fragment.append(container);
          }
        }
        const row = element('div', 'relay-select-option');
        row.id = `${this.id}-option-${option.index}`;
        row.dataset.optionIndex = String(option.index);
        row.setAttribute('role', 'option');
        row.setAttribute('aria-disabled', String(option.disabled));
        row.setAttribute('aria-selected', String(option.index === this.select.selectedIndex));
        const text = element('span', 'relay-select-option-text', option.label || '\u00a0');
        text.dir = 'auto';
        row.append(text, icon('m5 12 4 4L19 6', 'relay-select-check'));
        container.append(row);
        this.rows.set(option.index, row);
      }
      this.popup.replaceChildren(fragment);
      this.popup.scrollTop = scrollTop;
      this.highlight(this.activeIndex, false);
    }

    focus() {
      if (this.trigger.isConnected && !this.trigger.disabled && this.trigger.getClientRects().length) this.trigger.focus({ preventScroll: true });
    }

    show(edge) {
      this.sync();
      if (this.trigger.disabled || !this.enabled.length || this.wrapper.hidden || !this.trigger.getClientRects().length) return;
      if (active && active !== this) active.close(false);
      this.dialog = this.select.closest('dialog');
      (this.dialog || document.body).append(this.popup);
      this.popup.dir = getComputedStyle(this.select).direction;
      this.popup.hidden = false;
      this.popup.classList.add('is-open');
      this.open = true;
      active = this;
      if (supportsPopover) this.popup.showPopover();
      this.trigger.setAttribute('aria-expanded', 'true');
      const selected = this.enabled.find(option => option.index === this.select.selectedIndex);
      const option = edge === 'first' ? this.enabled[0] : edge === 'last' ? this.enabled.at(-1) : selected || this.enabled[0];
      this.position();
      this.highlight(option?.index ?? -1);
      this.focus();
    }

    close(restoreFocus = false) {
      if (!this.open) return;
      this.open = false;
      if (active === this) active = null;
      this.trigger.setAttribute('aria-expanded', 'false');
      this.trigger.removeAttribute('aria-activedescendant');
      if (supportsPopover && this.popup.matches(':popover-open')) this.popup.hidePopover();
      this.popup.hidden = true;
      this.popup.classList.remove('is-open');
      this.typeBuffer = '';
      if (restoreFocus) this.focus();
    }

    highlight(index, scroll = true) {
      this.activeIndex = index;
      for (const [optionIndex, row] of this.rows) row.dataset.active = String(optionIndex === index);
      const row = this.rows.get(index);
      if (this.open && row) {
        this.trigger.setAttribute('aria-activedescendant', row.id);
        if (scroll) {
          const item = row.getBoundingClientRect();
          const list = this.popup.getBoundingClientRect();
          if (item.top < list.top + 5) this.popup.scrollTop += item.top - list.top - 5;
          else if (item.bottom > list.bottom - 5) this.popup.scrollTop += item.bottom - list.bottom + 5;
        }
      } else this.trigger.removeAttribute('aria-activedescendant');
    }

    choose(index, close = true) {
      if (!this.enabled.some(option => option.index === index) || this.select.matches(':disabled')) return;
      const changed = this.select.selectedIndex !== index;
      this.select.selectedIndex = index;
      this.sync();
      if (close) this.close(true);
      if (changed) {
        this.select.dispatchEvent(new Event('input', { bubbles: true }));
        this.select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    keydown(event) {
      if (this.trigger.disabled || event.ctrlKey || event.metaKey) return;
      if (event.altKey && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          event.preventDefault();
          if (event.altKey && event.key === 'ArrowUp') { this.close(true); return; }
          if (!this.open) { this.show(); return; }
          const index = this.enabled.findIndex(option => option.index === this.activeIndex);
          const next = Math.min(this.enabled.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
          this.highlight(this.enabled[next]?.index ?? -1);
          return;
        }
        case 'Home':
        case 'End':
          event.preventDefault();
          if (!this.open) this.show(event.key === 'Home' ? 'first' : 'last');
          else this.highlight((event.key === 'Home' ? this.enabled[0] : this.enabled.at(-1))?.index ?? -1);
          return;
        case 'Enter':
        case ' ':
          if (event.key === ' ' && this.typeBuffer && Date.now() - this.typeTime < 700) break;
          event.preventDefault();
          if (this.open) this.choose(this.activeIndex);
          else this.show();
          return;
        case 'Escape':
          if (this.open) { event.preventDefault(); event.stopPropagation(); this.close(true); }
          return;
        case 'Tab':
          if (this.open) this.choose(this.activeIndex, false);
          this.close(false);
          return;
      }
      if (event.key.length === 1 && !event.altKey) {
        event.preventDefault();
        this.typeahead(event.key);
      }
    }

    typeahead(key) {
      const now = Date.now();
      this.typeBuffer = (now - this.typeTime > 700 ? '' : this.typeBuffer) + normalized(key);
      this.typeTime = now;
      const repeated = Array.from(this.typeBuffer).every(character => character === this.typeBuffer[0]);
      const query = repeated ? this.typeBuffer[0] : this.typeBuffer;
      const current = this.open ? this.activeIndex : this.select.selectedIndex;
      const start = this.enabled.findIndex(option => option.index === current);
      for (let offset = query.length === 1 ? 1 : 0; offset < this.enabled.length + (query.length === 1 ? 1 : 0); offset++) {
        const base = query.length === 1 ? start : Math.max(0, start);
        const option = this.enabled[(base + offset + this.enabled.length) % this.enabled.length];
        if (option && normalized(option.label).trimStart().startsWith(query)) {
          if (this.open) this.highlight(option.index);
          else this.choose(option.index, false);
          return;
        }
      }
    }

    position() {
      if (!this.open) return;
      const rect = this.trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft || 0) + 8;
      const topEdge = (viewport?.offsetTop || 0) + 8;
      const rightEdge = leftEdge + (viewport?.width || document.documentElement.clientWidth) - 16;
      const bottomEdge = topEdge + (viewport?.height || window.innerHeight) - 16;
      if (!this.trigger.getClientRects().length || !rect.width || rect.bottom < topEdge || rect.top > bottomEdge || this.select.closest('[inert]')) {
        this.close(false);
        return;
      }
      const width = Math.max(0, Math.min(Math.max(rect.width, 180), rightEdge - leftEdge));
      this.popup.style.width = `${width}px`;
      this.popup.style.maxHeight = `${Math.max(0, Math.min(320, bottomEdge - topEdge))}px`;
      const desired = Math.min(this.popup.scrollHeight + 2, 320);
      const below = Math.max(0, bottomEdge - rect.bottom - 6);
      const above = Math.max(0, rect.top - topEdge - 6);
      const upwards = below < desired && above > below;
      this.popup.style.maxHeight = `${Math.min(320, upwards ? above : below)}px`;
      const height = this.popup.offsetHeight;
      const aligned = this.popup.dir === 'rtl' ? rect.right - width : rect.left;
      this.popup.style.left = `${Math.max(leftEdge, Math.min(aligned, rightEdge - width))}px`;
      this.popup.style.top = `${Math.max(topEdge, Math.min(upwards ? rect.top - height - 6 : rect.bottom + 6, bottomEdge - height))}px`;
      this.popup.dataset.side = upwards ? 'top' : 'bottom';
    }

    destroy() {
      this.close(false);
      this.abort.abort();
      this.observer.disconnect();
      this.resizeObserver?.disconnect();
      states.delete(this.select);
      dirty.delete(this);
      this.popup.remove();
      this.select.classList.remove('relay-select-native');
      for (const [attribute, value] of [['tabindex', this.originalTabIndex], ['aria-hidden', this.originalAriaHidden]]) {
        if (value === null) this.select.removeAttribute(attribute);
        else this.select.setAttribute(attribute, value);
      }
      if (this.select.parentElement === this.wrapper) this.wrapper.before(this.select);
      this.wrapper.remove();
    }
  }

  function enhance(select) {
    if (!(select instanceof HTMLSelectElement) || !select.isConnected || select.multiple || select.size > 1) return;
    if (!states.has(select)) states.set(select, new RelaySelect(select));
  }

  function sync(select) {
    enhance(select);
    states.get(select)?.sync();
  }

  function syncAll() {
    document.querySelectorAll('select').forEach(enhance);
    for (const state of Array.from(states.values())) state.sync();
  }

  function start() {
    syncAll();
    new MutationObserver(records => {
      let prune = false;
      for (const record of records) {
        if (record.type === 'childList') {
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.matches('select')) enhance(node);
            node.querySelectorAll('select').forEach(enhance);
          }
          if (record.removedNodes.length) prune = true;
        } else if (record.type === 'attributes') {
          const target = record.target;
          if (target instanceof HTMLSelectElement) enhance(target);
          if (target instanceof HTMLFieldSetElement || target instanceof HTMLSelectElement) {
            for (const state of states.values()) if (target === state.select || target.contains(state.select)) schedule(state);
          }
          schedulePosition();
        }
      }
      if (prune) for (const state of Array.from(states.values())) {
        if (!state.select.isConnected || state.select.parentElement !== state.wrapper) state.sync();
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'open', 'inert', 'dir', 'multiple', 'size'] });
    document.addEventListener('pointerdown', event => {
      if (active && !active.wrapper.contains(event.target) && !active.popup.contains(event.target)) active.close(false);
    }, true);
    document.addEventListener('focusin', event => {
      if (active && !active.wrapper.contains(event.target) && !active.popup.contains(event.target)) active.close(false);
    });
    document.addEventListener('reset', event => setTimeout(() => {
      if (event.defaultPrevented) return;
      for (const state of states.values()) if (state.select.form === event.target) state.invalid = false;
      syncAll();
    }, 0));
    document.addEventListener('cancel', event => {
      if (active && event.target === active.dialog) { event.preventDefault(); active.close(true); }
    }, true);
    window.addEventListener('resize', schedulePosition);
    document.addEventListener('scroll', event => {
      if (active && !active.popup.contains(event.target)) schedulePosition();
    }, true);
    window.visualViewport?.addEventListener('resize', schedulePosition);
    window.visualViewport?.addEventListener('scroll', schedulePosition);
  }

  window.RelaySelect = Object.freeze({ sync, syncAll });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
