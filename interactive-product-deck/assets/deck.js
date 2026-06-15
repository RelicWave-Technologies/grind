/* Citation Engine deck — shared top nav, injected into every page.
   Set <main data-page="..."> to highlight the active link. */
(function () {
  const LINKS = [
    { href: 'index.html',            label: 'Overview',          page: 'overview' },
    { href: 'ai-mode.html',          label: 'AI Mode, live',     page: 'aimode', dot: 'blue' },
    { href: 'question-machine.html', label: 'The Question Machine', page: 'qm' },
    { href: 'ai-eye.html',           label: 'The AI Eye',        page: 'eye' },
    { href: 'connect.html',          label: 'How they connect',  page: 'connect' },
  ];

  const active = (document.querySelector('main[data-page]') || {}).dataset?.page || '';

  const mark = `<span class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/></svg></span>`;

  const links = LINKS.map(l => {
    const isActive = l.page === active ? ' active' : '';
    const dot = l.dot ? `<span class="nd ${l.dot}"></span>` : '';
    return `<a href="${l.href}" class="${isActive.trim()}">${dot}${l.label}</a>`;
  }).join('');

  const nav = document.createElement('nav');
  nav.className = 'topnav';
  nav.innerHTML = `<div class="nav-inner">
    <a class="nav-brand" href="index.html">${mark}<span>Citation Engine</span><span class="tag">by EMIAC</span></a>
    <div class="nav-links">${links}</div>
  </div>`;

  document.body.insertBefore(nav, document.body.firstChild);
})();
