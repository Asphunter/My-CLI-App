(() => {
  const root = document.documentElement;
  const stream = document.querySelector('#messageStream');
  const composerForm = document.querySelector('#composerForm');
  const composerInput = document.querySelector('#composerInput');
  const settingsPopover = document.querySelector('#settingsPopover');
  const changesPanel = document.querySelector('#changesPanel');
  const showChangesButton = document.querySelector('#showChangesButton');
  const toast = document.querySelector('#toast');
  const storageKey = 'min-reader-settings';
  let toastTimer;

  const showToast = (message) => {
    toast.textContent = message;
    toast.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2200);
  };

  const setReaderSetting = (name, value) => {
    root.style.setProperty(name, value);
    const settings = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
    settings[name] = value;
    window.localStorage.setItem(storageKey, JSON.stringify(settings));
  };

  const restoreSettings = () => {
    const settings = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
    if (settings['--font-size']) {
      root.style.setProperty('--font-size', settings['--font-size']);
      document.querySelector('#fontSizeRange').value = parseInt(settings['--font-size'], 10);
      document.querySelector('#fontSizeValue').textContent = settings['--font-size'];
    }
    if (settings['--line-height']) {
      root.style.setProperty('--line-height', settings['--line-height']);
      const lineValue = Number(settings['--line-height']);
      document.querySelector('#lineHeightRange').value = Math.round(lineValue * 100);
      document.querySelector('#lineHeightValue').textContent = lineValue.toFixed(2);
    }
  };

  restoreSettings();

  document.querySelector('#densityButton').addEventListener('click', () => {
    settingsPopover.hidden = !settingsPopover.hidden;
  });

  document.addEventListener('click', (event) => {
    if (!settingsPopover.hidden && !settingsPopover.contains(event.target) && !event.target.closest('#densityButton')) {
      settingsPopover.hidden = true;
    }
  });

  document.querySelector('#fontSizeRange').addEventListener('input', (event) => {
    const value = `${event.target.value}px`;
    document.querySelector('#fontSizeValue').textContent = value;
    setReaderSetting('--font-size', value);
  });

  document.querySelector('#lineHeightRange').addEventListener('input', (event) => {
    const value = (Number(event.target.value) / 100).toFixed(2);
    document.querySelector('#lineHeightValue').textContent = value;
    setReaderSetting('--line-height', value);
  });

  document.querySelector('#resetSettings').addEventListener('click', () => {
    window.localStorage.removeItem(storageKey);
    root.style.setProperty('--font-size', '13px');
    root.style.setProperty('--line-height', '1.45');
    document.querySelector('#fontSizeRange').value = 13;
    document.querySelector('#fontSizeValue').textContent = '13 px';
    document.querySelector('#lineHeightRange').value = 145;
    document.querySelector('#lineHeightValue').textContent = '1.45';
    showToast('Olvasási beállítások visszaállítva');
  });

  document.querySelectorAll('.project-row').forEach((button) => {
    button.addEventListener('click', () => {
      const group = button.closest('.project-group');
      const isOpen = group.classList.toggle('is-open');
      button.setAttribute('aria-expanded', String(isOpen));
      button.querySelector('.chevron').textContent = isOpen ? '⌄' : '›';
    });
  });

  document.querySelectorAll('.conversation-row').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.conversation-row').forEach((row) => row.classList.remove('is-active'));
      button.classList.add('is-active');
      document.querySelector('#conversationTitle').textContent = button.dataset.title;
      const project = button.closest('.project-group').dataset.project;
      document.querySelector('#activeProject').textContent = project;
      showToast(`Megnyitva: ${button.dataset.title}`);
    });
  });

  const addUserMessage = (text) => {
    const article = document.createElement('article');
    article.className = 'message user-message';
    article.innerHTML = `<div class="message-meta"><span class="avatar user-avatar">D</span><span>Te</span><time>most</time></div><div class="message-body"><p></p></div>`;
    article.querySelector('p').textContent = text;
    stream.querySelector('.typing-row').before(article);
  };

  composerInput.addEventListener('input', () => {
    composerInput.style.height = 'auto';
    composerInput.style.height = `${Math.min(composerInput.scrollHeight, 130)}px`;
  });

  composerInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      composerForm.requestSubmit();
    }
  });

  composerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const message = composerInput.value.trim();
    if (!message) return;
    addUserMessage(message);
    composerInput.value = '';
    composerInput.style.height = 'auto';
    stream.scrollTop = stream.scrollHeight;
    showToast('Üzenet hozzáadva · AI-adapter még nincs bekötve');
  });

  document.querySelector('#clearConversation').addEventListener('click', () => {
    const messages = stream.querySelectorAll('.message');
    messages.forEach((message, index) => { if (index > 0) message.remove(); });
    showToast('Új, üres beszélgetés indult');
  });

  document.querySelector('#collapseChanges').addEventListener('click', () => {
    changesPanel.hidden = true;
    showChangesButton.hidden = false;
  });

  showChangesButton.addEventListener('click', () => {
    changesPanel.hidden = false;
    showChangesButton.hidden = true;
  });

  document.querySelector('#applyButton').addEventListener('click', () => {
    showToast('A diff megnyitása a helyi CLI-adapter feladata lesz');
  });

  const commandOverlay = document.querySelector('#commandOverlay');
  const commandInput = document.querySelector('#commandInput');
  const openCommands = () => {
    commandOverlay.hidden = false;
    commandInput.value = '';
    window.setTimeout(() => commandInput.focus(), 0);
  };
  const closeCommands = () => { commandOverlay.hidden = true; };
  document.querySelector('#commandButton').addEventListener('click', openCommands);
  commandOverlay.addEventListener('click', (event) => { if (event.target === commandOverlay) closeCommands(); });
  document.querySelectorAll('[data-command]').forEach((button) => {
    button.addEventListener('click', () => {
      const command = button.dataset.command;
      closeCommands();
      if (command === 'Olvasási beállítások') settingsPopover.hidden = false;
      if (command === 'Kódváltozások megnyitása') { changesPanel.hidden = false; showChangesButton.hidden = true; }
      if (command === 'Új beszélgetés') document.querySelector('#clearConversation').click();
      showToast(command);
    });
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommands(); }
    if (event.key === 'Escape') { closeCommands(); settingsPopover.hidden = true; }
  });

  document.querySelector('#newProjectButton').addEventListener('click', () => showToast('Új projekt létrehozása hamarosan'));
})();
